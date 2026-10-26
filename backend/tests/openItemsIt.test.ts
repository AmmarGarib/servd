// Open items, IT (owner, 2026-10-26): Sentry scrub / no-op, and the WhatsApp
// gateway bell notices on top of the existing delivery watchdog.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.mock('../src/lib/mailer.js', () => ({ emailConfigured: async () => false, sendEmail: async () => {} }))

import { serviceClient as prisma } from '../src/lib/prisma.js'
import { runDeliveryWatch, DELIVERY_STATE_KEY } from '../src/workers/deliveryWatch.js'
import { invalidateWhatsappConfig, WA_URL_KEY, WA_KEY_KEY } from '../src/lib/whatsapp.js'
import { flushNotifications } from '../src/lib/staffNotify.js'
import { scrubEvent, scrubString, initErrorTracking, captureServerError, errorTrackingActive } from '../src/lib/errorTracking.js'

const tag = `it${Date.now()}`
const ids: { tenants: string[]; users: string[] } = { tenants: [], users: [] }

function gateway(state: string | null) {
  vi.stubGlobal('fetch', vi.fn(async () => (state === null
    ? { ok: false, json: async () => ({}) }
    : { ok: true, json: async () => ({ status: 'ok', clients: { abc123: state } }) })) as unknown as typeof fetch)
}
const mine = (userId: string) => prisma.staffNotification.findMany({ where: { userId, kind: 'integration.alert' }, orderBy: { createdAt: 'asc' } })

let A: string, B: string, ceoA: string, itB: string, itNoCompany: string, chefA: string

beforeEach(async () => {
  vi.unstubAllGlobals()
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY, DELIVERY_STATE_KEY] } } })
  await prisma.setting.create({ data: { key: WA_URL_KEY, value: 'https://gw.example/webhook/abc123/send' } })
  await prisma.setting.create({ data: { key: WA_KEY_KEY, value: 'sk-test' } })
  invalidateWhatsappConfig()
  await prisma.staffNotification.deleteMany({ where: { userId: { in: ids.users } } })
  if (!A) {
    const ta = await prisma.tenant.create({ data: { name: `${tag} A`, slug: `${tag}-a` } })
    const tb = await prisma.tenant.create({ data: { name: `${tag} B`, slug: `${tag}-b` } })
    A = ta.id; B = tb.id; ids.tenants.push(A, B)
    const mk = async (role: 'admin' | 'it' | 'fnb_manager', n: string, tenantId: string | null) => {
      const u = await prisma.user.create({ data: { name: `${tag} ${n}`, email: `${tag}.${n}@gsfoods.pk`, password: 'x', role, tenantId } })
      ids.users.push(u.id); return u.id
    }
    ceoA = await mk('admin', 'ceo', A)
    itB = await mk('it', 'itb', B)
    itNoCompany = await mk('it', 'itnone', null)
    chefA = await mk('fnb_manager', 'chef', A)
  }
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.staffNotification.deleteMany({ where: { userId: { in: ids.users } } })
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } })
  await prisma.tenant.deleteMany({ where: { id: { in: ids.tenants } } })
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY, DELIVERY_STATE_KEY] } } })
})

describe('gateway bell', () => {
  it('one bad run: no bell. Two: ONE down notice per CEO / IT login under their own company. Recovery: one up notice', async () => {
    gateway(null)
    await runDeliveryWatch(); await flushNotifications()
    expect(await mine(ceoA)).toHaveLength(0)
    await runDeliveryWatch(); await runDeliveryWatch(); await flushNotifications()
    const a = await mine(ceoA)
    expect(a).toHaveLength(1)
    expect(a[0]!.tenantId).toBe(A)
    expect(a[0]!.severity).toBe('critical')
    const b = await mine(itB)
    expect(b).toHaveLength(1)
    expect(b[0]!.tenantId).toBe(B)          // company B's IT hears it under B, never A
    expect(await mine(itNoCompany)).toHaveLength(0) // no company: the bell cannot hold it
    expect(await mine(chefA)).toHaveLength(0)       // other roles never

    gateway('READY')
    await runDeliveryWatch(); await runDeliveryWatch(); await flushNotifications()
    const after = await mine(ceoA)
    expect(after.map((n) => n.severity)).toEqual(['critical', 'success'])
    // the recovery is announced once
    expect((await mine(itB))).toHaveLength(2)
  })

  it('a fault that never reached an alert sends no all-clear', async () => {
    gateway('INITIALIZING'); await runDeliveryWatch()
    gateway('READY'); await runDeliveryWatch(); await flushNotifications()
    expect(await mine(ceoA)).toHaveLength(0)
  })
})

describe('error tracking', () => {
  it('is a no-op without SENTRY_DSN_API', () => {
    delete process.env['SENTRY_DSN_API']
    expect(initErrorTracking()).toBe(false)
    expect(errorTrackingActive()).toBe(false)
    expect(() => captureServerError(new Error('x'))).not.toThrow()
  })

  it('scrubs bodies, headers, cookies, user, phone and email', () => {
    expect(scrubString('call +92 300 1234567 or a.b@c.pk')).toBe('call [redacted] or [redacted]')
    const ev = scrubEvent({
      type: undefined,
      message: 'fail for 03001234567',
      request: { url: 'https://api.servd.pk/x?phone=03001234567', data: { phone: '1' }, headers: { authorization: 'Bearer t' }, cookies: { s: '1' }, query_string: 'phone=1' },
      user: { email: 'a@b.pk' },
      exception: { values: [{ value: 'bad a@b.pk' }] },
      breadcrumbs: [{ message: 'to 03001234567', data: { k: 1 } }],
    } as never)
    expect(ev.request).toEqual({ url: 'https://api.servd.pk/x' })
    expect(ev.user).toBeUndefined()
    expect(ev.message).not.toMatch(/\d{8}/)
    expect(ev.exception!.values![0]!.value).toBe('bad [redacted]')
    expect(ev.breadcrumbs![0]!.data).toBeUndefined()
  })
})
