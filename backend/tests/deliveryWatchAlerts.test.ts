// The watchdog must not cry wolf: one slow answer from the gateway used to
// send "down", "back up", "down" inside a minute, once per login.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const sent = vi.hoisted(() => ({ emails: [] as Array<{ to: string; subject: string }> }))
vi.mock('../src/lib/mailer.js', () => ({
  emailConfigured: async () => true,
  sendEmail: async (m: { to: string; subject: string }) => { sent.emails.push({ to: m.to, subject: m.subject }) },
}))

import { serviceClient as prisma } from '../src/lib/prisma.js'
import { runDeliveryWatch, DELIVERY_STATE_KEY } from '../src/workers/deliveryWatch.js'
import { invalidateWhatsappConfig, WA_URL_KEY, WA_KEY_KEY } from '../src/lib/whatsapp.js'

const INBOX = `watchdog.${Date.now()}@gsfoods.pk`
const mine = () => sent.emails.filter((e) => e.to.toLowerCase() === INBOX)

function gateway(state: string | null) {
  vi.stubGlobal('fetch', vi.fn(async () => (state === null
    ? { ok: false, json: async () => ({}) }
    : { ok: true, json: async () => ({ status: 'ok', clients: { abc123: state } }) })) as unknown as typeof fetch)
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  sent.emails.length = 0
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY, DELIVERY_STATE_KEY] } } })
  await prisma.setting.create({ data: { key: WA_URL_KEY, value: 'https://gw.example/webhook/abc123/send' } })
  await prisma.setting.create({ data: { key: WA_KEY_KEY, value: 'sk-test' } })
  invalidateWhatsappConfig()
  if (!(await prisma.user.findFirst({ where: { email: INBOX } }))) {
    await prisma.user.create({ data: { name: 'Watchdog CEO', email: INBOX, password: 'x', role: 'admin' } })
  }
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.user.deleteMany({ where: { email: INBOX } })
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY, DELIVERY_STATE_KEY] } } })
})

describe('delivery watchdog alerts', () => {
  it('a single bad run sends nothing, and the next good run sends nothing either', async () => {
    gateway('INITIALIZING')
    await runDeliveryWatch()
    gateway('READY')
    await runDeliveryWatch()
    expect(mine()).toHaveLength(0)
  })

  it('two bad runs in a row send ONE alert; more bad runs send no more', async () => {
    gateway(null)
    await runDeliveryWatch()
    await runDeliveryWatch()
    await runDeliveryWatch()
    expect(mine().map((e) => e.subject)).toEqual(['servd: customer signup is down'])
  })

  it('recovery after a real alert sends one all-clear', async () => {
    gateway('INITIALIZING')
    await runDeliveryWatch()
    await runDeliveryWatch()
    gateway('READY')
    await runDeliveryWatch()
    await runDeliveryWatch()
    expect(mine().map((e) => e.subject)).toEqual(['servd: customer signup is down', 'servd: customer signup is back up'])
  })
})
