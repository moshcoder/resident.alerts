import { describe, expect, test } from 'bun:test'
import { Accounts } from '../src/accounts.js'
import { passUntilFromUserinfo } from '../src/coinpay-oauth.js'
import { Store } from '../src/db.js'

const now = Date.parse('2026-11-07T12:00:00Z')
const until = '2026-12-07T12:00:00.000Z'
const premium = { coinpay: null, chains: ['BTC'], cents: 499, comp: new Set<string>() } as never

describe('Profullstack Pass', () => {
  test('the claim counts only when active === true with a future expires_at', () => {
    expect(passUntilFromUserinfo({ pass: { active: true, expires_at: until } }, now)).toBe(Date.parse(until))
    for (const info of [null, {}, { pass: { active: false } }, { pass: { active: true } }, { pass: { active: 'true', expires_at: until } }, { pass: { active: true, expires_at: 'soon' } }, { pass: { active: true, expires_at: '2026-11-01T00:00:00Z' } }])
      expect(passUntilFromUserinfo(info, now)).toBeNull()
  })

  test('a running pass is Premium until it expires, and never blocks buying lifetime Premium', () => {
    const store = new Store()
    const acc = new Accounts(store.db, Date.now, [])
    const r = acc.signInWithCoinPay({ sub: 'cp-pass', email: null }, null)
    if ('error' in r) throw new Error(r.error)
    expect(acc.premium(premium, r.user)).toBe(false)
    const later = Date.now() + 30 * 86_400_000
    acc.setPassUntil(r.user.id, later)
    expect(acc.passUntil(r.user)).toBe(later)
    expect(acc.premium(premium, r.user)).toBe(true)
    expect(acc.premium(premium, r.user, false)).toBe(false)
    acc.setPassUntil(r.user.id, Date.now() - 1000)
    expect(acc.premium(premium, r.user)).toBe(false)
    acc.setPassUntil(r.user.id, null)
    expect(acc.passUntil(r.user)).toBeNull()
  })
})
