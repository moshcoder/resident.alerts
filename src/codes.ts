/**
 * Credit codes and invites.
 *
 * A credit code (@profullstack/redeem-credits) grants the unit `premium`: one
 * code with amount 1 is lifetime Premium, the same thing $4.99 buys. When a
 * premium credit lands on an account it is applied the way a purchase is: a
 * settled $0 row in `payments` for that account (chain "credit-code"), so
 * Premium has one source of truth and moves with the account on a merge.
 *
 * Invites (@profullstack/affiliates): three per person, each link works once.
 * Premium is lifetime-only and there is nothing smaller to give, so an invite
 * gives nobody anything beyond the invite itself: it is a way in, from someone
 * who thought of you, and we remember who brought whom. Affiliate links
 * (?ref=) are remembered first-touch for the same reason.
 */
import { Affiliates, sqliteStore as affiliateStore } from '@profullstack/affiliates'
import { Credits, sqliteStore } from '@profullstack/redeem-credits'
import type { Accounts, User } from './accounts.js'
import type { Store } from './db.js'
import type { PremiumConfig } from './premium.js'

export const PREMIUM_UNIT = 'premium'
/** Invite links each person can hand out. Scarce on purpose: an invite should mean something. */
export const INVITES_PER_PERSON = 3
export const INVITE_CODE = /^[A-Za-z0-9-]{6,40}$/
export const REF_CODE = /^[A-Za-z0-9-]{4,40}$/

export class CodeError extends Error {}

const WHY: Record<string, string> = {
  invalid: 'That code is not valid.',
  expired: 'That code has expired.',
  used_up: 'That code has been used.',
  already_redeemed: 'You already redeemed that code.',
  revoked: 'That code was withdrawn.',
}

export class Codes {
  readonly credits: Credits
  readonly affiliates: Affiliates
  constructor(
    readonly store: Store,
    readonly accounts: Accounts,
    readonly premium: PremiumConfig,
    /** Premium just switched on for this account (its webhooks hear `premium.activated`). */
    readonly onPremium?: (u: User) => void,
  ) {
    this.credits = new Credits(sqliteStore(store.db as never))
    this.affiliates = new Affiliates(affiliateStore(store.db as never), { defaultQuota: INVITES_PER_PERSON })
  }

  /**
   * Turn premium credits on the account into Premium, the way a purchase does.
   * Credits can also arrive outside a redemption (the redeem-credits CLI's
   * `grant`), so the account page calls this first. True if it switched on.
   */
  async applyPremium(u: User): Promise<boolean> {
    if (this.accounts.premium(this.premium, u)) return false
    if ((await this.credits.balance(u.id, PREMIUM_UNIT)) < 1) return false
    const spent = await this.credits.spend(u.id, PREMIUM_UNIT, 1, 'lifetime Premium switched on')
    if (!spent.ok) return false
    const ref = `credit:${u.id}:${Date.now()}`
    this.store.recordPayment({ ref, amount_cents: 0, chain: 'credit-code', raw: { source: 'redeem-credits' }, user_id: u.id })
    this.store.settlePayment(ref, 'credit', { source: 'redeem-credits' }, true)
    this.onPremium?.(u)
    return true
  }

  /** Redeem a credit code for the signed-in person; the message to show them. */
  async redeem(u: User, input: unknown): Promise<string> {
    const code = String(input ?? '').trim()
    if (!code) throw new CodeError('Type the code first.')
    // Someone who already has Premium keeps the code usable for a friend.
    if (this.accounts.premium(this.premium, u)) throw new CodeError('You already have Premium. Pass the code on to someone who does not.')
    const r = await this.credits.redeem(code, u.id)
    if (!r.ok) throw new CodeError(WHY[r.reason] ?? 'That code did not work.')
    if (r.grant.unit !== PREMIUM_UNIT) return `Added ${r.grant.amount} ${r.grant.unit}.`
    return (await this.applyPremium(u)) ? 'Code redeemed: Premium is on your account, for life.' : 'Code redeemed.'
  }

  /** A new account signed up through an invite: spend it and remember who invited whom. */
  async acceptInvite(code: string, u: User): Promise<{ ok: boolean; reason?: string; inviterId?: string }> {
    const r = await this.affiliates.redeemInvite(code, u.id)
    return r.ok ? { ok: true, inviterId: r.inviterId } : { ok: false, reason: r.reason }
  }

  async invitesView(u: User, origin: string) {
    return {
      quota: await this.affiliates.quota(u.id),
      invites: await this.affiliates.invites(u.id),
      affiliate: `${origin}/?ref=${await this.affiliates.affiliateCode(u.id)}`,
    }
  }
}
