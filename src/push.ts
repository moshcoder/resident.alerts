/**
 * Web push to devices. No accounts and no email: a device that turned alerts
 * on is the only place an alert goes.
 *
 * A subscription the push service says is gone (404/410) is deleted at once;
 * one that keeps failing for other reasons is dropped after 20 failures.
 */
import webpush from 'web-push'
import type { Device, Store } from './db.js'

export type PushConfig = { publicKey: string; privateKey: string; subject: string } | null
export type Message = { title: string; body: string; url: string; tag: string; urgent?: boolean }

export function pushConfig(env: Record<string, string | undefined> = process.env): PushConfig {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? 'mailto:alerts@pit.world' }
}

export type Pusher = { enabled: boolean; publicKey: string; send: (d: Device, m: Message) => Promise<boolean> }

export function createPusher(cfg: PushConfig, store: Store, sender: typeof webpush.sendNotification = webpush.sendNotification.bind(webpush)): Pusher {
  if (!cfg) return { enabled: false, publicKey: '', send: async () => false }
  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey)
  return {
    enabled: true,
    publicKey: cfg.publicKey,
    async send(d, m) {
      try {
        await sender({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify(m), { TTL: m.urgent ? 3600 : 1800, urgency: m.urgent ? 'high' : 'normal', topic: m.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(-32) })
        store.pushed(d.id, true)
        return true
      } catch (e: any) {
        const code = Number(e?.statusCode ?? 0)
        if (code === 404 || code === 410 || d.fails >= 20) store.deleteDevice(d.endpoint)
        else store.pushed(d.id, false)
        return false
      }
    },
  }
}
