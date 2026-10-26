/**
 * Tips. Every feature is free, so money is optional: a crypto tip through
 * CoinPay pays for the box and the geocoding. Nothing unlocks; nothing is
 * withheld from people who don't pay.
 *
 * Same rules as our paid apps: the payment is written down before the visitor
 * leaves, the webhook is verified over the raw bytes, and only a settled status
 * counts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Store } from './db.js'

export type CoinPay = { baseUrl: string; apiKey: string; businessId: string; webhookSecret: string }
export const TIP_AMOUNTS = [3, 10, 25, 100]
export const DEFAULT_CHAINS = ['USDC_SOL', 'USDC_POL', 'USDC_ETH', 'BTC', 'ETH', 'SOL', 'POL', 'DOGE', 'LTC']
export const CHAIN_LABELS: Record<string, string> = {
  USDC_POL: 'USDC on Polygon', USDC_SOL: 'USDC on Solana', USDC_ETH: 'USDC on Ethereum', USDT_POL: 'USDT on Polygon',
  BTC: 'Bitcoin', ETH: 'Ether', SOL: 'Solana', POL: 'Polygon', DOGE: 'Dogecoin', LTC: 'Litecoin', BCH: 'Bitcoin Cash', XRP: 'XRP', ADA: 'Cardano', BNB: 'BNB',
}

export function coinpayConfig(env: Record<string, string | undefined> = process.env): { coinpay: CoinPay | null; chains: string[] } {
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
  }
}

/** Start a crypto tip; returns CoinPay's checkout page. */
export async function startTip(
  cfg: { coinpay: CoinPay | null; chains: string[] },
  store: Store,
  args: { dollars: number; chain: string; successUrl: string; cancelUrl: string },
  fetcher: typeof fetch = fetch,
): Promise<{ checkoutUrl: string; ref: string }> {
  if (!cfg.coinpay) throw new Error('tips are not set up on this server yet')
  if (!cfg.chains.includes(args.chain)) throw new Error('pick a currency from the list')
  if (!TIP_AMOUNTS.includes(args.dollars)) throw new Error('pick an amount')
  const res = await fetcher(`${cfg.coinpay.baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.coinpay.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      business_id: cfg.coinpay.businessId,
      amount: args.dollars,
      currency: 'USD',
      blockchain: args.chain,
      payment_method: 'crypto',
      description: `resident.alerts tip ($${args.dollars})`,
      metadata: { kind: 'tip' },
      success_url: args.successUrl,
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
  store.recordPayment({ ref: String(ref), amount_cents: args.dollars * 100, chain: args.chain, raw: body })
  return { checkoutUrl: `${cfg.coinpay.baseUrl}/pay/${ref}`, ref: String(ref) }
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
