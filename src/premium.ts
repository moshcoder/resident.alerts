/**
 * Premium: one CoinPay payment ($4.99 by default), good for life.
 *
 * There are no accounts, so Premium is a key. It is made when checkout starts,
 * goes back to the buyer on CoinPay's success page, and only works once the
 * payment settles. The browser keeps it; paste it on another device to carry it
 * over. We store a hash of the key, never the key.
 *
 * Same money rules as our other apps: the payment is written down before the
 * buyer leaves, the webhook is verified over the raw bytes, and only a settled
 * status grants.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Store } from './db.js'

export type CoinPay = { baseUrl: string; apiKey: string; businessId: string; webhookSecret: string }
export type PremiumConfig = { coinpay: CoinPay | null; chains: string[]; cents: number; comp: Set<string> }

/** What free and Premium devices may do. */
export const FREE = { places: 1, km: 5, hours: 24 }
export const PREMIUM = { places: 25, km: 80, hours: 24 * 30 }
export type Limits = typeof FREE

// What the resident.alerts CoinPay business can be paid in (coinpay-onboard lists them).
export const DEFAULT_CHAINS = ['USDC_SOL', 'USDC_BASE', 'USDC_POL', 'USDC_ETH', 'BTC', 'ETH', 'SOL', 'POL', 'DOGE', 'XRP']
export const CHAIN_LABELS: Record<string, string> = {
  USDC_POL: 'USDC on Polygon', USDC_SOL: 'USDC on Solana', USDC_ETH: 'USDC on Ethereum', USDC_BASE: 'USDC on Base', USDT_POL: 'USDT on Polygon',
  BTC: 'Bitcoin', ETH: 'Ether', SOL: 'Solana', POL: 'Polygon', DOGE: 'Dogecoin', BCH: 'Bitcoin Cash', XRP: 'XRP', ADA: 'Cardano', BNB: 'BNB',
}

export const hashKey = (key: string) => createHash('sha256').update(`resident.alerts:premium:${key.trim()}`).digest('hex')
export const newKey = () => `ra_${randomBytes(18).toString('base64url')}`
export const KEY_SHAPE = /^ra_[A-Za-z0-9_-]{20,40}$/

export function premiumConfig(env: Record<string, string | undefined> = process.env): PremiumConfig {
  const chains = (env.COINPAY_CHAINS ?? '').split(/[\s,]+/).filter(Boolean)
  return {
    coinpay:
      env.COINPAY_API_KEY && env.COINPAY_BUSINESS_ID
        ? {
            baseUrl: (env.COINPAY_API_URL ?? 'https://coinpayportal.com').replace(/\/+$/, '').replace(/\/api$/, ''),
            apiKey: env.COINPAY_API_KEY,
            businessId: env.COINPAY_BUSINESS_ID,
            webhookSecret: env.COINPAY_WEBHOOK_SECRET ?? '',
          }
        : null,
    chains: chains.length ? chains : DEFAULT_CHAINS,
    cents: Math.round(Number(env.PREMIUM_USD ?? 4.99) * 100),
    // Keys given away (admins, friends): hashes are compared, so the raw keys can live in the vault.
    comp: new Set((env.PREMIUM_COMP_KEYS ?? '').split(/[\s,]+/).filter(Boolean).map(hashKey)),
  }
}

export const price = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`

export function isPremium(cfg: PremiumConfig, store: Store, key: unknown): boolean {
  if (typeof key !== 'string' || !KEY_SHAPE.test(key.trim())) return false
  const h = hashKey(key)
  return cfg.comp.has(h) || store.licensePaid(h)
}
export const limitsFor = (cfg: PremiumConfig, store: Store, key: unknown): Limits => (isPremium(cfg, store, key) ? PREMIUM : FREE)

/** Start a Premium checkout; returns CoinPay's page and the key the buyer will get. */
export async function startPremium(cfg: PremiumConfig, store: Store, args: { chain: string; successUrl: (key: string) => string; cancelUrl: string }, fetcher: typeof fetch = fetch): Promise<{ checkoutUrl: string; ref: string; key: string }> {
  if (!cfg.coinpay) throw new Error('payments are not set up on this server yet')
  if (!cfg.chains.includes(args.chain)) throw new Error('pick a currency from the list')
  const key = newKey()
  const res = await fetcher(`${cfg.coinpay.baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.coinpay.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      business_id: cfg.coinpay.businessId,
      amount: cfg.cents / 100,
      currency: 'USD',
      blockchain: args.chain,
      payment_method: 'crypto',
      description: 'resident.alerts Premium (lifetime)',
      metadata: { product: 'premium-lifetime' },
      success_url: args.successUrl(key),
      cancel_url: args.cancelUrl,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`CoinPay said ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as any
  // { success, payment: {...} }: the id is nested, not body.id.
  const payment = body?.payment ?? body
  const ref = payment?.id ?? payment?.payment_id
  if (!ref) throw new Error('CoinPay returned no payment reference')
  // Written before the buyer leaves: a webhook can beat the redirect.
  store.recordPayment({ ref: String(ref), amount_cents: cfg.cents, chain: args.chain, raw: body, license_hash: hashKey(key) })
  return { checkoutUrl: `${cfg.coinpay.baseUrl}/pay/${ref}`, ref: String(ref), key }
}

/** `t=<unix>,v1=<hex hmac of "t.rawBody">`, within five minutes. */
export function verifyWebhook(secret: string, rawBody: string, header: string | null | undefined, nowSeconds = Date.now() / 1000): boolean {
  if (!secret || !header) return false
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((s) => s.trim())))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSeconds - t) > 300) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex'), 'hex')
  const given = Buffer.from(String(parts.v1), 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export const SETTLED = new Set(['paid', 'completed', 'confirmed', 'forwarded', 'succeeded', 'settled'])

/** The live webhook is { id: "evt_…", type, data: { payment_id, status, metadata } }; the top-level id is the event. */
export function readWebhook(payload: any): { ref: string | null; status: string } {
  const data = payload?.data ?? payload
  return { ref: data?.payment_id ?? data?.id ?? null, status: String(data?.status ?? '').toLowerCase() }
}
