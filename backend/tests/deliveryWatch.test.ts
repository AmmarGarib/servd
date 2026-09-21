// The delivery watchdog: does it name the right cause, and the right fix?
//
// An alert that only says "signup is down" is not worth sending — the operator
// already knows something is wrong, that is why they are reading it. The value
// is in distinguishing the three faults, because each has a different
// thirty-second remedy and they are indistinguishable from the symptom.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { probeDelivery } from '../src/workers/deliveryWatch.js'
import { invalidateWhatsappConfig, WA_URL_KEY, WA_KEY_KEY } from '../src/lib/whatsapp.js'

const URL_OK = 'https://gw.example/webhook/abc123/send'

async function setGateway(url: string | null) {
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
  if (url !== null) {
    await prisma.setting.create({ data: { key: WA_URL_KEY, value: url } })
    await prisma.setting.create({ data: { key: WA_KEY_KEY, value: 'sk-test' } })
  }
  invalidateWhatsappConfig()
}

function mockGatewayHealth(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok, json: async () => body,
  })) as unknown as typeof fetch)
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  delete process.env['WHATSAPP_API_URL']
  delete process.env['WHATSAPP_API_KEY']
  await setGateway(null)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.setting.deleteMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
})

describe('naming the fault', () => {
  it('says unconfigured when there is no gateway at all', async () => {
    const s = await probeDelivery()
    expect(s.ok).toBe(false)
    expect(s.cause).toBe('unconfigured')
    expect(s.fix).toContain('Configuration')
  })

  it('says session_dropped when the client is not linked', async () => {
    // The commonest real fault: the phone went offline or WhatsApp logged the
    // device out. The fix is a QR scan, and nothing else will do.
    await setGateway(URL_OK)
    mockGatewayHealth({ status: 'ok', clients: { abc123: 'INITIALIZING' } })
    const s = await probeDelivery()
    expect(s.cause).toBe('session_dropped')
    expect(s.fix.toLowerCase()).toContain('qr')
  })

  it('says bad_key when the app is not on the gateway any more', async () => {
    await setGateway(URL_OK)
    mockGatewayHealth({ status: 'ok', clients: { somethingelse: 'READY' } })
    const s = await probeDelivery()
    expect(s.cause).toBe('bad_key')
  })

  it('says gateway_unreachable when the host does not answer', async () => {
    await setGateway(URL_OK)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    const s = await probeDelivery()
    expect(s.cause).toBe('gateway_unreachable')
    // This is the one the operator cannot fix from servd, and the message must
    // say so rather than sending them to a settings page that will not help.
    expect(s.fix.toLowerCase()).toContain('gateway')
  })

  it('reports ok when the session is live', async () => {
    await setGateway(URL_OK)
    mockGatewayHealth({ status: 'ok', clients: { abc123: 'READY' } })
    const s = await probeDelivery()
    expect(s.ok).toBe(true)
    expect(s.cause).toBe('ok')
  })

  it('does not send a message to prove it works', async () => {
    // A watchdog that texts somebody every ten minutes is its own outage.
    await setGateway(URL_OK)
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ clients: { abc123: 'READY' } }) }))
    vi.stubGlobal('fetch', f as unknown as typeof fetch)
    await probeDelivery()
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0]![0])).toContain('/health')
  })

  it('always carries a fix, whatever the fault', async () => {
    await setGateway(URL_OK)
    mockGatewayHealth({ status: 'ok', clients: { abc123: 'INITIALIZING' } })
    const s = await probeDelivery()
    expect(s.fix.length).toBeGreaterThan(20)
    expect(s.detail.length).toBeGreaterThan(20)
  })
})
