// Raast QR — bank SMS intake and matching (spec §6.2–6.5, §9 A; amendments
// M2, M3, M4, S2). Two companies: a device of B never feeds A, an SMS of B
// never settles A's intent, A's till room alone hears about A.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, ringKheer, mkRaastAccount, TEST_SECRET_KEY,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { setTillEmitSpy } from '../src/lib/ws.js'
import { compileTemplate, isIgnored, normalizeSender, parseAmountCents, parseSms, matchTemplate } from '../src/connectors/raast/sms.js'
import { processAlert } from '../src/connectors/raast/intake.js'
import { resetSmsAuthThrottle, maskSmsTokenInUrl } from '../src/modules/connectors/webhookRoutes.js'
import { processPayment, quoteOrderForTender } from '../src/modules/pos/service.js'
import type { RaastTemplate } from '../src/connectors/types.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
const u: Record<string, Who> = {}
let accA: { bankAccountId: string; ledgerCode: string }
let accB: { bankAccountId: string; ledgerCode: string }
let drawerA: string
let tokenA = ''
let tokenB = ''
let prevKey: string | undefined
const emits: Array<{ rooms: string[]; event: string; payload: Record<string, unknown> }> = []

const TPL_CREDIT: RaastTemplate = { id: 'tpl-c', label: 'Credit', kind: 'credit', template: 'PKR {amount} received in A/C {account} from {payer} via Raast. Ref {ref} on {date} {time}.', active: true }
const TPL_DEBIT: RaastTemplate = { id: 'tpl-d', label: 'Debit', kind: 'debit', template: 'PKR {amount} sent from A/C {account} to {payer}. Ref {ref}.', active: true }

/** "DD-MM-YYYY HH:mm" in Pakistan time, `minutesAgo` before now. */
function pktStamp(minutesAgo = 0): string {
  const t = new Date(Date.now() - minutesAgo * 60_000 + 5 * 3_600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getUTCDate())}-${p(t.getUTCMonth() + 1)}-${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}
const pkr = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })
const creditSms = (cents: number, ref: string, minutesAgo = 0, payer = 'ALI KHAN') =>
  `PKR ${pkr(cents)} received in A/C ****1234 from ${payer} via Raast. Ref ${ref} on ${pktStamp(minutesAgo)}.`

let seq = 0
async function sendSms(token: string, text: string, from = 'MEEZANBNK', extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST', url: '/webhooks/pos/sms', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ from, text, receivedAt: Date.now() + (seq++), ...extra }),
  })
}

/** Wait until the alert leaves received / processing (the webhook processes it after replying). */
async function settled(id: string) {
  for (let i = 0; i < 200; i++) {
    const a = await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id } })
    if (a.status !== 'received' && a.status !== 'processing') return a
    if (a.status === 'received' && i > 5) await processAlert(id)
    await new Promise((r) => setTimeout(r, 25))
  }
  return prisma.bankSmsAlert.findUniqueOrThrow({ where: { id } })
}

async function newIntent(who: Who, co: Company, drawer: string, orderId?: string) {
  const id = orderId ?? (await ringKheer(app, who, co)).id
  const due = (await quoteOrderForTender(id, 'raast')).dueCents
  const r = await call(who, 'POST', '/pos/raast/intents', { orderId: id, shiftId: drawer, expectedDueCents: due, idempotencyKey: `int-${id}` })
  if (r.statusCode !== 201) throw new Error(`intent ${r.statusCode} ${r.body}`)
  return { orderId: id, due, intent: r.json() as { id: string; status: string; amountCents: number } }
}

async function cashierRaast(who: Who, orderId: string, drawer: string, ref: string, amountCents?: number) {
  const due = amountCents ?? (await quoteOrderForTender(orderId, 'raast')).dueCents
  return processPayment({
    orderId, shiftId: drawer, actorId: who.id, idempotencyKey: `cash-${orderId}-${ref}`,
    payments: [{ method: 'raast', amountCents: due, gatewayRef: ref, raast: { via: 'cashier', cashierVerified: true } }],
  })
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  setFiscalKicker(async () => {})
  setTillEmitSpy((rooms, event, payload) => { emits.push({ rooms, event, payload }) })
  A = await mkCompany('rsms-a')
  B = await mkCompany('rsms-b')
  accA = await mkRaastAccount(A)
  accB = await mkRaastAccount(B)
  u['cashierA'] = await mkUser('cashierA', 'cashier', A.tenantId)
  u['itA'] = await mkUser('itA', 'it', A.tenantId)
  u['itB'] = await mkUser('itB', 'it', B.tenantId)
  u['cashierB'] = await mkUser('cashierB', 'cashier', B.tenantId)
  app = await buildApp()
  call = caller(app)
  drawerA = await openDrawer(A, u['cashierA']!)
  const settingsOf = (acc: string) => ({
    templates: [TPL_CREDIT, TPL_DEBIT],
    senders: [{ id: 'snd-1', senderId: 'MEEZANBNK', bankAccountId: acc, templateIds: ['tpl-c', 'tpl-d'], active: true }],
  })
  await setConnector(A.tenantId, 'raast', { enabled: true, settings: settingsOf(accA.bankAccountId) })
  await setConnector(B.tenantId, 'raast', { enabled: true, settings: settingsOf(accB.bankAccountId) })
  const dA = await call(u['itA']!, 'POST', '/connectors/raast/devices', { label: 'Counter A' })
  const dB = await call(u['itB']!, 'POST', '/connectors/raast/devices', { label: 'Counter B' })
  expect(dA.statusCode, dA.body).toBe(201)
  tokenA = dA.json().token
  tokenB = dB.json().token
}, 60_000)

afterAll(async () => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  setFiscalKicker(null)
  setTillEmitSpy(null)
  resetConnectorCache()
  await app.close()
})

beforeEach(() => {
  emits.length = 0
  resetSmsAuthThrottle()
})

// ─── Pure parser ────────────────────────────────────────────────────────────

describe('sms parser (pure)', () => {
  it('normalises senders: phones to 92…, short codes upper-case without punctuation', () => {
    expect(normalizeSender('+92 300 1234567')).toBe('923001234567')
    expect(normalizeSender('03001234567')).toBe('923001234567')
    expect(normalizeSender('0092-300-1234567')).toBe('923001234567')
    expect(normalizeSender('Meezan-Bnk')).toBe('MEEZANBNK')
  })

  it('ignore keywords are whole words, any case', () => {
    const kw = ['OTP', 'PIN', 'one time']
    expect(isIgnored('Your OTP is 1234', kw)).toBe(true)
    expect(isIgnored('your pin: 4455', kw)).toBe(true)
    expect(isIgnored('use this One  Time code', kw)).toBe(true)
    expect(isIgnored('PKR 100 received from PINKY', kw)).toBe(false)
  })

  it('amounts: commas, decimals, INT4 cap', () => {
    expect(parseAmountCents('1,188.00')).toBe(118_800)
    expect(parseAmountCents('1188.5')).toBe(118_850)
    expect(parseAmountCents('0')).toBeNull()
    expect(parseAmountCents('99,999,999.00')).toBeNull()
  })

  it('templates are a DSL: required placeholders, no unknown ones, bounded wildcards', () => {
    expect(compileTemplate({ kind: 'credit', template: 'PKR {amount} received' }).problems.join()).toMatch(/\{ref\}/)
    expect(compileTemplate({ kind: 'debit', template: 'PKR {amount} sent' }).ok).toBe(true)
    expect(compileTemplate({ kind: 'credit', template: 'PKR {amount} {ref} {foo}' }).problems.join()).toMatch(/unknown placeholder/)
    expect(compileTemplate({ kind: 'credit', template: '{*} {amount} {*} {ref} {*} {payer}' }).problems.join()).toMatch(/at most 3/)
    // Regex characters in the literal text are literal.
    expect(compileTemplate({ kind: 'credit', template: 'Rs.(x) {amount} [ref] {ref}' }).ok).toBe(true)
  })

  it('parses a credit SMS (PKT time), and only a whole-body match counts', () => {
    const now = new Date()
    const p = parseSms(creditSms(118_800, 'FT-2610-88123'), [TPL_CREDIT], { now })
    expect(p).toMatchObject({ kind: 'credit', amountCents: 118_800, bankRef: 'FT261088123', accountLast4: '1234', payer: 'ALI KHAN', occurredAtSource: 'sms' })
    expect(Math.abs(p!.occurredAt.getTime() - now.getTime())).toBeLessThan(61_000)
    expect(parseSms(`${creditSms(118_800, 'FT261088123')} Extra trailing text`, [TPL_CREDIT], { now })).toBeNull()
  })

  it('a time outside [now − 24 h, now + 5 min] is not believed: the forwarder time (else now) is used', () => {
    const now = new Date()
    const rec = new Date(now.getTime() - 30_000)
    const p = parseSms(creditSms(5_000, 'AB1234567', 3 * 24 * 60), [TPL_CREDIT], { now, receivedAt: rec })
    expect(p?.occurredAtSource).toBe('forwarder')
    expect(p?.occurredAt.getTime()).toBe(rec.getTime())
  })

  it('matchTemplate reports the fields and problems for the tester', () => {
    const m = matchTemplate('PKR abc received in A/C 1 from X via Raast. Ref 1 on 1-1-2026 10:00.', TPL_CREDIT)
    expect(m.parsed).toBeNull()
  })
})

// ─── Device endpoint ────────────────────────────────────────────────────────

describe('POST /webhooks/pos/sms — device auth (S2)', () => {
  it('no token, a malformed one or an unknown one → 401 with no detail', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/webhooks/pos/sms', payload: { from: 'MEEZANBNK', text: 'x' } })
    expect(r1.statusCode).toBe(401)
    expect((await sendSms('sms_nothex', 'x')).statusCode).toBe(401)
    expect((await sendSms(`sms_${'a'.repeat(64)}`, 'x')).statusCode).toBe(401)
  })

  it('an inactive device → 401', async () => {
    const d = await prisma.bankSmsDevice.findFirstOrThrow({ where: { tenantId: A.tenantId } })
    await prisma.bankSmsDevice.update({ where: { id: d.id }, data: { active: false } })
    expect((await sendSms(tokenA, 'hello')).statusCode).toBe(401)
    await prisma.bankSmsDevice.update({ where: { id: d.id }, data: { active: true } })
  })

  it('the path-token fallback only works when the device allows it', async () => {
    const url = `/webhooks/pos/sms/${tokenA}`
    const body = { from: 'SOMEONE', text: 'hello' }
    expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(401)
    const d = await prisma.bankSmsDevice.findFirstOrThrow({ where: { tenantId: A.tenantId } })
    await prisma.bankSmsDevice.update({ where: { id: d.id }, data: { allowPathToken: true } })
    const ok = await app.inject({ method: 'POST', url, payload: body })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ ignored: true })
    await prisma.bankSmsDevice.update({ where: { id: d.id }, data: { allowPathToken: false } })
    expect(maskSmsTokenInUrl(`/api/v1/webhooks/pos/sms/${tokenA}?x=1`)).toBe('/api/v1/webhooks/pos/sms/[REDACTED]?x=1')
  })

  it('an address that keeps failing is throttled (429) — failures only, never a valid device (RV-FRAUD-5)', async () => {
    for (let i = 0; i < 20; i++) await sendSms(`sms_${'b'.repeat(64)}`, 'x')
    expect((await sendSms(`sms_${'c'.repeat(64)}`, 'x')).statusCode).toBe(429)
    expect((await sendSms('garbage', 'x')).statusCode).toBe(429)
    // A working counter phone behind the same address still gets through.
    expect((await sendSms(tokenA, 'hello')).statusCode).toBe(200)
    resetSmsAuthThrottle()
  })

  it('two companies: B\'s rotated token failing 20 times never locks out A\'s device on the same address (RV-CO-1)', async () => {
    const dB = await prisma.bankSmsDevice.findFirstOrThrow({ where: { tenantId: B.tenantId } })
    const rot = await call(u['itB']!, 'POST', `/connectors/raast/devices/${dB.id}/rotate`, {})
    expect(rot.statusCode, rot.body).toBe(200)
    const oldB = tokenB
    tokenB = rot.json().token
    for (let i = 0; i < 20; i++) expect([401, 429]).toContain((await sendSms(oldB, 'x')).statusCode)
    expect((await sendSms(oldB, 'x')).statusCode).toBe(429)
    expect((await sendSms(tokenA, 'hello')).statusCode).toBe(200)
    expect((await sendSms(tokenB, 'hello')).statusCode).toBe(200)
    resetSmsAuthThrottle()
  })
})

describe('intake: only listed bank senders are stored', () => {
  it('an unlisted sender is counted on the device, never stored', async () => {
    const before = await prisma.bankSmsAlert.count()
    const d0 = await prisma.bankSmsDevice.findFirstOrThrow({ where: { tenantId: A.tenantId } })
    const r = await sendSms(tokenA, 'Your parcel is on its way', '+92 300 1112223')
    expect(r.json()).toEqual({ ignored: true, reason: 'sender_not_listed' })
    expect(await prisma.bankSmsAlert.count()).toBe(before)
    const d1 = await prisma.bankSmsDevice.findUniqueOrThrow({ where: { id: d0.id } })
    expect(d1.ignoredCount).toBe(d0.ignoredCount + 1)
    expect(d1.lastSeenAt).not.toBeNull()
  })

  it('an OTP from a listed sender is never stored', async () => {
    const before = await prisma.bankSmsAlert.count()
    const r = await sendSms(tokenA, 'Your OTP for Raast is 445566. Do not share.')
    expect(r.json()).toEqual({ ignored: true, reason: 'keyword' })
    expect(await prisma.bankSmsAlert.count()).toBe(before)
    const all = await prisma.bankSmsAlert.findMany({ select: { body: true } })
    expect(all.some((a) => a.body?.includes('445566'))).toBe(false)
  })

  it('the same SMS (same text, same second) twice → duplicate', async () => {
    const payload = JSON.stringify({ from: 'MEEZANBNK', text: 'Hello from the bank', receivedAt: '2026-10-12T10:00:00.000Z' })
    const h = { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }
    const r1 = await app.inject({ method: 'POST', url: '/webhooks/pos/sms', headers: h, payload })
    const r2 = await app.inject({ method: 'POST', url: '/webhooks/pos/sms', headers: h, payload })
    expect(r1.json()).toHaveProperty('ok', true)
    expect(r2.json()).toEqual({ duplicate: true })
  })

  it('form-encoded bodies work too', async () => {
    const r = await app.inject({
      method: 'POST', url: '/webhooks/pos/sms',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `sender=MEEZANBNK&message=${encodeURIComponent('A form-encoded bank message')}&timestamp=${Date.now()}`,
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveProperty('ok', true)
  })
})

describe('processAlert', () => {
  it('an SMS no template understands → unparsed, ONE open flag per sender (count refreshed)', async () => {
    const r1 = await sendSms(tokenA, 'Dear customer, your statement is ready (1)')
    const r2 = await sendSms(tokenA, 'Dear customer, your statement is ready (2)')
    expect((await settled(r1.json().id)).status).toBe('unparsed')
    expect((await settled(r2.json().id)).status).toBe('unparsed')
    const flags = await prisma.exceptionFlag.findMany({ where: { tenantId: A.tenantId, kind: 'raast_sms_unparsed' } })
    expect(flags).toHaveLength(1)
    expect((flags[0]!.metadata as { count: number }).count).toBeGreaterThanOrEqual(2)
  })

  it('SMS matching OFF → parsed but "off", never matched', async () => {
    await setConnector(A.tenantId, 'raast', { enabled: false })
    const r = await sendSms(tokenA, creditSms(4_200, 'OFF4455667'))
    const a = await settled(r.json().id)
    expect(a.status).toBe('off')
    expect(a).toMatchObject({ kind: 'credit', bankRef: 'OFF4455667', bankAccountId: accA.bankAccountId })
    expect(Number(a.amountCents)).toBe(4_200)
    await setConnector(A.tenantId, 'raast', { enabled: true })
  })

  it('ON and exactly one awaiting intent → settled (order completed, receipt provisional) and only A\'s till hears', async () => {
    const { orderId, intent } = await newIntent(u['cashierA']!, A, drawerA)
    emits.length = 0
    const r = await sendSms(tokenA, creditSms(intent.amountCents, 'SET1234567'))
    const a = await settled(r.json().id)
    expect(a.status).toBe('matched')
    const rc = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: intent.id } })
    expect(rc).toMatchObject({ status: 'provisional', confirmedVia: 'sms', smsAlertId: a.id, bankRef: 'SET1234567', tenantId: A.tenantId, settlingUntil: null })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } })
    expect(order.status).toBe('completed')
    expect(order.payments.filter((p) => p.status === 'paid' && p.method === 'raast')).toHaveLength(1)
    expect(emits.length).toBeGreaterThan(0)
    for (const e of emits) expect(e.rooms).toEqual([`tenant:${A.tenantId}:till`])
  })

  it('the same transfer reported twice → one payment, the second SMS is a duplicate', async () => {
    const { orderId, intent } = await newIntent(u['cashierA']!, A, drawerA)
    const a1 = await settled((await sendSms(tokenA, creditSms(intent.amountCents, 'TWICE12345'))).json().id)
    const a2 = await settled((await sendSms(tokenA, creditSms(intent.amountCents, 'TWICE-12345'), 'MEEZANBNK', { receivedAt: Date.now() + 5000 })).json().id)
    expect(a1.status).toBe('matched')
    expect(a2.status).toBe('duplicate')
    expect(await prisma.payment.count({ where: { orderId, method: 'raast', status: 'paid' } })).toBe(1)
  })

  it('two awaiting intents for the same amount → ambiguous (never a guess)', async () => {
    const i1 = await newIntent(u['cashierA']!, A, drawerA)
    const i2 = await newIntent(u['cashierA']!, A, drawerA)
    const a = await settled((await sendSms(tokenA, creditSms(i1.intent.amountCents, 'AMB1234567'))).json().id)
    expect(a.status).toBe('ambiguous')
    expect(a.candidateIds.sort()).toEqual([i1.intent.id, i2.intent.id].sort())
    for (const i of [i1, i2]) expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: i.intent.id } })).status).toBe('awaiting')
    await prisma.raastReceipt.updateMany({ where: { id: { in: [i1.intent.id, i2.intent.id] } }, data: { status: 'cancelled' } })
  })

  it('no intent for the amount → unmatched (emitted to A\'s till only)', async () => {
    emits.length = 0
    const a = await settled((await sendSms(tokenA, creditSms(77_700, 'NONE123456'))).json().id)
    expect(a.status).toBe('unmatched')
    const ev = emits.filter((e) => e.event === 'raast:alert')
    expect(ev.length).toBeGreaterThan(0)
    for (const e of ev) expect(e.rooms).toEqual([`tenant:${A.tenantId}:till`])
  })

  it('B\'s bank SMS never settles A\'s intent', async () => {
    const { intent } = await newIntent(u['cashierA']!, A, drawerA)
    const a = await settled((await sendSms(tokenB, creditSms(intent.amountCents, 'BCO1234567'))).json().id)
    expect(a.tenantId).toBe(B.tenantId)
    expect(a.status).toBe('unmatched')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('awaiting')
    await prisma.raastReceipt.update({ where: { id: intent.id }, data: { status: 'cancelled' } })
  })

  it('cashier typed the reference first, then the SMS → confirmed (receipt stays provisional)', async () => {
    const order = await ringKheer(app, u['cashierA']!, A)
    await cashierRaast(u['cashierA']!, order.id, drawerA, 'CASH1234567')
    const rc0 = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: order.id } })
    expect(rc0).toMatchObject({ status: 'provisional', confirmedVia: 'cashier', smsAlertId: null })
    const a = await settled((await sendSms(tokenA, creditSms(rc0.amountCents, 'CASH1234567'))).json().id)
    expect(a.status).toBe('confirmed')
    const rc = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: rc0.id } })
    expect(rc).toMatchObject({ status: 'provisional', smsAlertId: a.id })
    expect(rc.smsConfirmedAt).not.toBeNull()
  })

  it('cashier reference + an SMS with the same reference but a different amount → needs_attention + flag', async () => {
    const order = await ringKheer(app, u['cashierA']!, A)
    await cashierRaast(u['cashierA']!, order.id, drawerA, 'DIFF1234567')
    const rc0 = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: order.id } })
    const a = await settled((await sendSms(tokenA, creditSms(rc0.amountCents - 10_000, 'DIFF1234567'))).json().id)
    expect(a.status).toBe('needs_attention')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: rc0.id } })).status).toBe('provisional')
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, kind: 'raast_needs_attention', entityId: a.id } })).toBe(1)
  })

  it('a debit SMS → "debit", flagged for finance, and its reference can never pay a bill (M4)', async () => {
    const r = await sendSms(tokenA, 'PKR 5,000.00 sent from A/C ****1234 to SUPPLIER CO. Ref DEB1234567.')
    const a = await settled(r.json().id)
    expect(a).toMatchObject({ status: 'debit', kind: 'debit', claimedRef: 'DEB1234567' })
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, kind: 'raast_debit_alert', entityId: a.id } })).toBe(1)
    const order = await ringKheer(app, u['cashierA']!, A)
    await expect(cashierRaast(u['cashierA']!, order.id, drawerA, 'DEB1234567')).rejects.toMatchObject({ code: 'RAAST_REF_DISMISSED' })
  })

  it('an SMS on another of the company\'s accounts never confirms a receipt (M4)', async () => {
    const acc2 = await mkRaastAccount(A, { code: '1022', isDefault: false })
    await setConnector(A.tenantId, 'raast', {
      settings: {
        templates: [TPL_CREDIT, TPL_DEBIT],
        senders: [
          { id: 'snd-1', senderId: 'MEEZANBNK', bankAccountId: accA.bankAccountId, templateIds: ['tpl-c', 'tpl-d'], active: true },
          { id: 'snd-2', senderId: 'HBLBANK', bankAccountId: acc2.bankAccountId, templateIds: ['tpl-c'], active: true },
        ],
      },
    })
    const order = await ringKheer(app, u['cashierA']!, A)
    await cashierRaast(u['cashierA']!, order.id, drawerA, 'OTHERACC123')
    const rc = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: order.id } })
    const a = await settled((await sendSms(tokenA, creditSms(rc.amountCents, 'OTHERACC123'), 'HBL-BANK')).json().id)
    expect(a.bankAccountId).toBe(acc2.bankAccountId)
    expect(a.status).toBe('needs_attention')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: rc.id } })).smsAlertId).toBeNull()
  })
})
