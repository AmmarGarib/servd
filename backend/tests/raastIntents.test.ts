// Raast QR at the till — intents, confirm / cancel / expiry, bank alerts
// attach / dismiss / reference fix (spec §6.6, §9 A; amendments M2, M3, S1).
// Two companies: B's cashier gets 404 on A's orders, intents and alerts; a
// drawer of the other company is 422; A's till room alone hears about A.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, ringKheer, mkRaastAccount, TEST_SECRET_KEY,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { setTillEmitSpy } from '../src/lib/ws.js'
import { processAlert } from '../src/connectors/raast/intake.js'
import { settleClaimed, creditOfAlert } from '../src/connectors/raast/match.js'
import { expireRaastIntents } from '../src/connectors/raast/intents.js'
import { assertShiftHasNoActiveCharges } from '../src/connectors/terminal/guard.js'
import { processPayment, quoteOrderForTender } from '../src/modules/pos/service.js'
import type { RaastTemplate } from '../src/connectors/types.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company, C: Company
const u: Record<string, Who> = {}
let accA: { bankAccountId: string; ledgerCode: string }
let drawerA: string, drawerA2: string, drawerB: string, drawerC: string
let deviceA: string
let prevKey: string | undefined
const emits: Array<{ rooms: string[]; event: string; payload: Record<string, unknown> }> = []

const TPL: RaastTemplate = { id: 'tpl-c', label: 'Credit', kind: 'credit', template: 'PKR {amount} received in A/C {account} from {payer} via Raast. Ref {ref} on {date} {time}.', active: true }

function pktStamp(minutesAgo = 0): string {
  const t = new Date(Date.now() - minutesAgo * 60_000 + 5 * 3_600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getUTCDate())}-${p(t.getUTCMonth() + 1)}-${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
}
const pkr = (cents: number) => (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })
const creditSms = (cents: number, ref: string, minutesAgo = 0) =>
  `PKR ${pkr(cents)} received in A/C ****1234 from ALI KHAN via Raast. Ref ${ref} on ${pktStamp(minutesAgo)}.`

/** Store a bank SMS for A's device straight away and process it (no webhook timing). */
let seq = 0
async function smsA(text: string): Promise<string> {
  const a = await prisma.bankSmsAlert.create({
    data: { tenantId: A.tenantId, deviceId: deviceA, sender: 'MEEZANBNK', bodyHash: `h-${seq++}-${Date.now()}`, body: text, receivedAt: new Date(), status: 'received' },
  })
  await processAlert(a.id)
  return a.id
}

async function ring(who: Who = u['cashierA']!, co: Company = A) {
  const o = await ringKheer(app, who, co)
  return { id: o.id, due: (await quoteOrderForTender(o.id, 'raast')).dueCents }
}

/** The bill changes: a line is added (the till re-prices from the lines while nothing is paid). */
async function addWater(orderId: string) {
  await prisma.orderItem.create({ data: { orderId, menuItemId: A.items.water, name: 'Water', quantity: 1, unitPriceCents: 10_000 } })
}

async function postIntent(who: Who, body: Record<string, unknown>) {
  return call(who, 'POST', '/pos/raast/intents', body)
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  setFiscalKicker(async () => {})
  setTillEmitSpy((rooms, event, payload) => { emits.push({ rooms, event, payload }) })
  A = await mkCompany('rint-a')
  B = await mkCompany('rint-b')
  C = await mkCompany('rint-c') // no receiving account
  accA = await mkRaastAccount(A)
  await mkRaastAccount(B)
  u['cashierA'] = await mkUser('cashierA', 'cashier', A.tenantId)
  u['cashierA2'] = await mkUser('cashierA2', 'cashier', A.tenantId)
  u['mgrA'] = await mkUser('mgrA', 'foh_management', A.tenantId)
  u['cashierB'] = await mkUser('cashierB', 'cashier', B.tenantId)
  u['cashierC'] = await mkUser('cashierC', 'cashier', C.tenantId)
  app = await buildApp()
  call = caller(app)
  drawerA = await openDrawer(A, u['cashierA']!)
  drawerA2 = await openDrawer(A, u['cashierA2']!)
  drawerB = await openDrawer(B, u['cashierB']!)
  drawerC = await openDrawer(C, u['cashierC']!)
  const settings = (acc: string) => ({ templates: [TPL], senders: [{ id: 'snd-1', senderId: 'MEEZANBNK', bankAccountId: acc, templateIds: ['tpl-c'], active: true }] })
  await setConnector(A.tenantId, 'raast', { enabled: true, settings: settings(accA.bankAccountId) })
  await setConnector(C.tenantId, 'raast', { enabled: true, settings: {} })
  const conn = await prisma.posConnector.findFirstOrThrow({ where: { tenantId: A.tenantId, kind: 'raast' } })
  deviceA = (await prisma.bankSmsDevice.create({
    data: { tenantId: A.tenantId, connectorId: conn.id, label: 'A', tokenHash: 'test-hash-a', tokenEnc: 'x', tokenHint: 'x', createdById: u['cashierA']!.id },
  })).id
}, 60_000)

afterAll(async () => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  setFiscalKicker(null)
  setTillEmitSpy(null)
  resetConnectorCache()
  await app.close()
})

beforeEach(async () => {
  emits.length = 0
  // Each test starts with no intent waiting in A.
  await prisma.raastReceipt.updateMany({ where: { tenantId: A.tenantId, status: 'awaiting' }, data: { status: 'cancelled', settlingUntil: null } })
})

describe('GET /pos/raast/config', () => {
  it('A\'s drawer → the receiving account, SMS matching, the counter-phone warning', async () => {
    const r = await call(u['cashierA']!, 'GET', `/pos/raast/config?shiftId=${drawerA}&conceptId=${A.conceptId}`)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ available: true, reason: null, smsMatching: true, account: { bankName: 'Meezan' } })
    expect(r.json().warning).toMatch(/counter phone/)
    expect(r.json().warning).toMatch(/screenshot/)
  })

  it('B\'s drawer or B\'s brand from A → 404; a company with no account → NOT_SET_UP', async () => {
    expect((await call(u['cashierA']!, 'GET', `/pos/raast/config?shiftId=${drawerB}`)).statusCode).toBe(404)
    expect((await call(u['cashierA']!, 'GET', `/pos/raast/config?shiftId=${drawerA}&conceptId=${B.conceptId}`)).statusCode).toBe(404)
    const c = await call(u['cashierC']!, 'GET', `/pos/raast/config?shiftId=${drawerC}`)
    expect(c.json()).toMatchObject({ available: false, reason: 'NOT_SET_UP', account: null })
  })
})

describe('POST /pos/raast/intents', () => {
  it('creates an awaiting intent (due at the digital rate + tip), replays the same key, refuses a second', async () => {
    const o = await ring()
    const card = (await quoteOrderForTender(o.id, 'card')).dueCents
    expect(o.due).toBe(card)
    const body = { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, tipCents: 5_000, idempotencyKey: `k-${o.id}` }
    const r1 = await postIntent(u['cashierA']!, body)
    expect(r1.statusCode, r1.body).toBe(201)
    expect(r1.json()).toMatchObject({ status: 'awaiting', amountCents: o.due + 5_000, tipCents: 5_000, dueCents: o.due })
    const row = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r1.json().id } })
    expect(row).toMatchObject({ tenantId: A.tenantId, bankAccountId: accA.bankAccountId, ledgerCode: accA.ledgerCode, shiftId: drawerA })
    const r2 = await postIntent(u['cashierA']!, body)
    expect(r2.statusCode).toBe(200)
    expect(r2.json().id).toBe(r1.json().id)
    const r3 = await postIntent(u['cashierA']!, { ...body, idempotencyKey: `k2-${o.id}` })
    expect(r3.statusCode).toBe(409)
    expect(r3.json().error.code).toBe('RAAST_AWAITING')
    for (const e of emits) expect(e.rooms).toEqual([`tenant:${A.tenantId}:till`])
  })

  it('refusals: wrong amount 409, SMS matching off 409, not set up 422, B on A\'s order 404, B\'s drawer 422', async () => {
    const o = await ring()
    const base = { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `r-${o.id}` }
    const bad = await postIntent(u['cashierA']!, { ...base, expectedDueCents: o.due + 100 })
    expect(bad.statusCode).toBe(409)
    expect(bad.json().error).toMatchObject({ code: 'AMOUNT_MISMATCH', details: { dueCents: o.due } })
    expect((await postIntent(u['cashierB']!, base)).statusCode).toBe(404)
    const foreign = await postIntent(u['cashierA']!, { ...base, shiftId: drawerB })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('SHIFT_NOT_IN_COMPANY')
    const c = await ring(u['cashierC']!, C)
    const ns = await postIntent(u['cashierC']!, { orderId: c.id, shiftId: drawerC, expectedDueCents: c.due, idempotencyKey: `c-${c.id}` })
    expect(ns.statusCode).toBe(422)
    expect(ns.json().error.code).toBe('RAAST_NOT_SET_UP')
    await setConnector(A.tenantId, 'raast', { enabled: false })
    const off = await postIntent(u['cashierA']!, base)
    expect(off.statusCode).toBe(409)
    expect(off.json().error.code).toBe('RAAST_SMS_OFF')
    await setConnector(A.tenantId, 'raast', { enabled: true })
  })

  it('a waiting intent blocks every other tender and the shift close', async () => {
    const o = await ring()
    const r = await postIntent(u['cashierA']!, { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `b-${o.id}` })
    await expect(processPayment({ orderId: o.id, shiftId: drawerA, payments: [{ method: 'cash', amountCents: 200_000, tenderedCents: 200_000 }] }))
      .rejects.toMatchObject({ code: 'RAAST_AWAITING' })
    await expect(assertShiftHasNoActiveCharges(drawerA)).rejects.toMatchObject({ code: 'SHIFT_HAS_AWAITING_RAAST' })
    await call(u['cashierA']!, 'POST', `/pos/raast/intents/${r.json().id}/cancel`, {})
    await expect(assertShiftHasNoActiveCharges(drawerA)).resolves.toBeUndefined()
  })
})

describe('confirm / cancel / expiry', () => {
  it('confirm by hand: reference validated, the tick required, then the bill is paid', async () => {
    const o = await ring()
    const id = (await postIntent(u['cashierA']!, { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `c-${o.id}` })).json().id
    expect((await call(u['cashierA']!, 'POST', `/pos/raast/intents/${id}/confirm`, { bankRef: 'TX1234567' })).statusCode).toBe(400)
    const inv = await call(u['cashierA']!, 'POST', `/pos/raast/intents/${id}/confirm`, { bankRef: '1111111', counterVerified: true })
    expect(inv.statusCode).toBe(422)
    expect(inv.json().error.code).toBe('RAAST_REF_INVALID')
    expect((await call(u['cashierB']!, 'POST', `/pos/raast/intents/${id}/confirm`, { bankRef: 'TX1234567', counterVerified: true })).statusCode).toBe(404)
    const ok = await call(u['cashierA']!, 'POST', `/pos/raast/intents/${id}/confirm`, { bankRef: 'tx-123-4567', counterVerified: true })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().intent).toMatchObject({ status: 'provisional', bankRef: 'TX1234567', confirmedVia: 'cashier' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
  })

  it('cancel: own intent or a manager; awaiting only; idempotent', async () => {
    const o = await ring()
    const id = (await postIntent(u['cashierA']!, { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `x-${o.id}` })).json().id
    expect((await call(u['cashierA2']!, 'POST', `/pos/raast/intents/${id}/cancel`, {})).statusCode).toBe(403)
    expect((await call(u['cashierB']!, 'POST', `/pos/raast/intents/${id}/cancel`, {})).statusCode).toBe(404)
    const r = await call(u['mgrA']!, 'POST', `/pos/raast/intents/${id}/cancel`, { reason: 'customer paid cash' })
    expect(r.json()).toMatchObject({ status: 'cancelled', cancelReason: 'customer paid cash' })
    expect((await call(u['cashierA']!, 'POST', `/pos/raast/intents/${id}/cancel`, {})).json().status).toBe('cancelled')
  })

  it('an intent past its time is cancelled "expired" by the worker — never one an SMS is settling', async () => {
    const o1 = await ring()
    const o2 = await ring()
    const i1 = (await postIntent(u['cashierA']!, { orderId: o1.id, shiftId: drawerA, expectedDueCents: o1.due, idempotencyKey: `e1-${o1.id}` })).json().id
    const i2 = (await postIntent(u['cashierA']!, { orderId: o2.id, shiftId: drawerA, expectedDueCents: o2.due, idempotencyKey: `e2-${o2.id}` })).json().id
    const past = new Date(Date.now() - 60_000)
    await prisma.raastReceipt.update({ where: { id: i1 }, data: { expiresAt: past } })
    await prisma.raastReceipt.update({ where: { id: i2 }, data: { expiresAt: past, settlingUntil: new Date(Date.now() + 60_000) } })
    await expireRaastIntents()
    expect(await prisma.raastReceipt.findUniqueOrThrow({ where: { id: i1 } })).toMatchObject({ status: 'cancelled', cancelReason: 'expired' })
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: i2 } })).status).toBe('awaiting')
  })
})

describe('an SMS that arrived before the intent (S1)', () => {
  it('within the clock skew → the new intent is settled by it', async () => {
    const o = await ring()
    const alertId = await smsA(creditSms(o.due, 'EARLY01234', 0))
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('unmatched')
    const r = await postIntent(u['cashierA']!, { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `s1-${o.id}` })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().status).toBe('provisional')
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('matched')
  })

  it('5 minutes before → never settles it; shown as a possible earlier payment', async () => {
    const o = await ring()
    const alertId = await smsA(creditSms(o.due, 'EARLY56789', 6))
    const r = await postIntent(u['cashierA']!, { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `s2-${o.id}` })
    expect(r.json().status).toBe('awaiting')
    expect(r.json().possibleEarlier.map((p: { alertId: string }) => p.alertId)).toContain(alertId)
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('unmatched')
  })
})

describe('M2 / M3 — the SMS and the cashier at the same moment', () => {
  it('cashier confirm and the SMS together → one payment, the receipt provisional with the SMS linked', async () => {
    for (let i = 0; i < 3; i++) {
      const o = await ring()
      const id = (await postIntent(u['cashierA']!, { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `race-${o.id}` })).json().id
      const ref = `RACE${i}12345`
      const alert = await prisma.bankSmsAlert.create({
        data: { tenantId: A.tenantId, deviceId: deviceA, sender: 'MEEZANBNK', bodyHash: `race-${i}-${Date.now()}`, body: creditSms(o.due, ref), receivedAt: new Date(), status: 'received' },
      })
      await Promise.allSettled([
        call(u['cashierA']!, 'POST', `/pos/raast/intents/${id}/confirm`, { bankRef: ref, counterVerified: true }),
        processAlert(alert.id),
      ])
      if ((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status === 'received') await processAlert(alert.id)
      expect(await prisma.payment.count({ where: { orderId: o.id, method: 'raast', status: 'paid' } })).toBe(1)
      const rc = await prisma.raastReceipt.findUniqueOrThrow({ where: { id } })
      expect(rc.status).toBe('provisional')
      expect(rc.smsAlertId).toBe(alert.id)
      expect(['confirmed', 'matched']).toContain((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status)
    }
  })

  it('a stale SMS settle never demotes a receipt the cashier already paid (re-read under the lock)', async () => {
    const o = await ring()
    const id = (await postIntent(u['cashierA']!, { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `m2-${o.id}` })).json().id
    const stale = await prisma.raastReceipt.findUniqueOrThrow({ where: { id } })
    expect((await call(u['cashierA']!, 'POST', `/pos/raast/intents/${id}/confirm`, { bankRef: 'M2REF12345', counterVerified: true })).statusCode).toBe(200)
    // An SMS with ANOTHER reference had claimed the (then awaiting) intent.
    const alert = await prisma.bankSmsAlert.create({
      data: {
        tenantId: A.tenantId, deviceId: deviceA, sender: 'MEEZANBNK', bodyHash: `m2-${Date.now()}`, body: 'x', receivedAt: new Date(), status: 'processing',
        kind: 'credit', amountCents: o.due, bankRef: 'M2OTHER9876', occurredAt: new Date(), bankAccountId: accA.bankAccountId,
      },
    })
    const outcome = await settleClaimed(stale, alert.id, creditOfAlert(alert), { mode: 'sms', actorId: u['cashierA']!.id })
    expect(outcome).toBe('needs_attention')
    const rc = await prisma.raastReceipt.findUniqueOrThrow({ where: { id } })
    expect(rc).toMatchObject({ status: 'provisional', bankRef: 'M2REF12345' })
    expect(await prisma.payment.count({ where: { orderId: o.id, method: 'raast', status: 'paid' } })).toBe(1)
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe('needs_attention')
  })

  it('the bill changed while the SMS was on its way → the intent needs a person (never paid wrong)', async () => {
    const o = await ring()
    const id = (await postIntent(u['cashierA']!, { orderId: o.id, shiftId: drawerA, expectedDueCents: o.due, idempotencyKey: `chg-${o.id}` })).json().id
    await addWater(o.id)
    const alertId = await smsA(creditSms(o.due, 'CHANGED1234'))
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('needs_attention')
    const rc = await prisma.raastReceipt.findUniqueOrThrow({ where: { id } })
    expect(rc.status).toBe('needs_attention')
    expect(rc.paymentId).toBeNull()
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, kind: 'raast_needs_attention', entityId: id } })).toBe(1)
  })
})

describe('bank alerts at the till', () => {
  it('GET /pos/raast/alerts lists the drawer company\'s open alerts; B\'s drawer is 404 from A', async () => {
    const alertId = await smsA(creditSms(12_300, 'LIST123456'))
    const r = await call(u['cashierA']!, 'GET', `/pos/raast/alerts?shiftId=${drawerA}`)
    expect(r.statusCode).toBe(200)
    expect(r.json().map((a: { id: string }) => a.id)).toContain(alertId)
    expect((await call(u['cashierA']!, 'GET', `/pos/raast/alerts?shiftId=${drawerB}`)).statusCode).toBe(404)
    expect((await call(u['cashierB']!, 'GET', `/pos/raast/alerts?shiftId=${drawerB}`)).json().map((a: { id: string }) => a.id)).not.toContain(alertId)
  })

  it('attach: amount must be the due, B cannot touch it, then the bill is paid and the alert "attached"', async () => {
    const o = await ring()
    const alertId = await smsA(creditSms(o.due, 'ATTACH1234'))
    const wrong = await ring()
    await addWater(wrong.id)
    const w = await call(u['cashierA']!, 'POST', `/pos/raast/alerts/${alertId}/attach`, { orderId: wrong.id, shiftId: drawerA })
    expect(w.statusCode).toBe(422)
    expect(w.json().error.code).toBe('RAAST_AMOUNT_MISMATCH')
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('unmatched')
    expect((await call(u['cashierB']!, 'POST', `/pos/raast/alerts/${alertId}/attach`, { orderId: o.id, shiftId: drawerB })).statusCode).toBe(404)
    const ok = await call(u['cashierA']!, 'POST', `/pos/raast/alerts/${alertId}/attach`, { orderId: o.id, shiftId: drawerA })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().intent.status).toBe('provisional')
    const a = await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })
    expect(a).toMatchObject({ status: 'attached', resolvedById: u['cashierA']!.id })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
    // Used once: it cannot pay a second bill.
    const o2 = await ring()
    expect((await call(u['cashierA']!, 'POST', `/pos/raast/alerts/${alertId}/attach`, { orderId: o2.id, shiftId: drawerA })).statusCode).toBe(409)
  })

  it('attach refused by the till (the order is not open) rolls back: the alert is open again, no receipt left awaiting', async () => {
    const o = await ring()
    const alertId = await smsA(creditSms(o.due, 'ROLLBK1234'))
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
    const r = await call(u['cashierA']!, 'POST', `/pos/raast/alerts/${alertId}/attach`, { orderId: o.id, shiftId: drawerA })
    expect(r.statusCode).toBe(409)
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('unmatched')
    expect(await prisma.raastReceipt.count({ where: { orderId: o.id, status: 'awaiting' } })).toBe(0)
  })

  it('dismiss needs a manager; the reference is then claimed and can never pay a bill (M4)', async () => {
    const alertId = await smsA(creditSms(33_300, 'OWNER12345'))
    const c = await call(u['cashierA']!, 'POST', `/pos/raast/alerts/${alertId}/dismiss`, { reason: 'owner transfer' })
    expect(c.statusCode).toBe(403)
    expect(c.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
    const m = await call(u['mgrA']!, 'POST', `/pos/raast/alerts/${alertId}/dismiss`, { reason: 'owner transfer' })
    expect(m.statusCode, m.body).toBe(200)
    expect(await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).toMatchObject({ status: 'dismissed', claimedRef: 'OWNER12345', resolvedById: u['mgrA']!.id })
    const o = await ring()
    await expect(processPayment({
      orderId: o.id, shiftId: drawerA, actorId: u['cashierA']!.id,
      payments: [{ method: 'raast', amountCents: o.due, gatewayRef: 'OWNER12345', raast: { via: 'cashier', cashierVerified: true } }],
    })).rejects.toMatchObject({ code: 'RAAST_REF_DISMISSED' })
  })

  it('a manager fixes a mistyped reference from the bank alert (payment reference follows)', async () => {
    const o = await ring()
    await setConnector(A.tenantId, 'raast', { enabled: false }) // typed with matching off: no SMS cross-check
    await processPayment({
      orderId: o.id, shiftId: drawerA, actorId: u['cashierA']!.id,
      payments: [{ method: 'raast', amountCents: o.due, gatewayRef: 'TYPO123456', raast: { via: 'cashier', cashierVerified: true } }],
    })
    await setConnector(A.tenantId, 'raast', { enabled: true })
    const rc = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: o.id } })
    const alertId = await smsA(creditSms(o.due, 'REAL123456'))
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('unmatched')
    expect((await call(u['cashierA']!, 'POST', `/pos/raast/alerts/${alertId}/attach`, { receiptId: rc.id })).statusCode).toBe(403)
    const r = await call(u['mgrA']!, 'POST', `/pos/raast/alerts/${alertId}/attach`, { receiptId: rc.id })
    expect(r.statusCode, r.body).toBe(200)
    const fixed = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: rc.id } })
    expect(fixed).toMatchObject({ bankRef: 'REAL123456', smsAlertId: alertId, status: 'provisional' })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: fixed.paymentId! } })).gatewayRef).toBe('REAL123456')
    expect(await prisma.auditLog.count({ where: { action: 'raast.reference.fix', entityId: rc.id } })).toBe(1)
  })
})

// ─── Review fixes (RV-FRAUD-2/3/4, the till's M4 time rule) ─────────────────

describe('review fixes — never guess, never an old credit', () => {
  const clearAlerts = () => prisma.bankSmsAlert.updateMany({
    where: { tenantId: A.tenantId, status: { in: ['unmatched', 'ambiguous', 'needs_attention'] } },
    data: { status: 'duplicate' },
  })
  const backdate = (alertId: string, ms: number) => prisma.bankSmsAlert.update({
    where: { id: alertId }, data: { occurredAt: new Date(Date.now() - ms), receivedAt: new Date(Date.now() - ms) },
  })

  it('RV-FRAUD-2: an SMS that fits a live 15-minute-old intent AND a fresh one is ambiguous — the newer one is never settled', async () => {
    await clearAlerts()
    const o1 = await ring()
    const old = await postIntent(u['cashierA']!, { orderId: o1.id, shiftId: drawerA, expectedDueCents: o1.due, idempotencyKey: `rv2-${o1.id}` })
    expect(old.statusCode, old.body).toBe(201)
    // Still live (30-minute expiry) but created before the 10-minute match window.
    await prisma.raastReceipt.update({ where: { id: old.json().id }, data: { createdAt: new Date(Date.now() - 15 * 60_000) } })
    const o2 = await ring(u['cashierA2']!)
    const fresh = await postIntent(u['cashierA2']!, { orderId: o2.id, shiftId: drawerA2, expectedDueCents: o2.due, idempotencyKey: `rv2-${o2.id}` })
    expect(fresh.json().status).toBe('awaiting')
    expect(o1.due).toBe(o2.due)

    const alertId = await smsA(creditSms(o1.due, 'AMBIG15MIN1'))
    const a = await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })
    expect(a.status).toBe('ambiguous')
    expect([...a.candidateIds].sort()).toEqual([old.json().id, fresh.json().id].sort())
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: old.json().id } })).status).toBe('awaiting')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: fresh.json().id } })).status).toBe('awaiting')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o2.id } })).status).not.toBe('completed')
  })

  it('RV-FRAUD-3: an intent created after the SMS is never settled by it while another live intent equally fits', async () => {
    await clearAlerts()
    const o1 = await ring()
    const o2 = await ring(u['cashierA2']!)
    const alertId = await smsA(creditSms(o1.due, 'TWOTILLS123'))
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('unmatched')
    // Another till's request for the same amount, already waiting.
    const other = await prisma.raastReceipt.create({
      data: {
        tenantId: A.tenantId, orderId: o2.id, conceptId: A.conceptId, shiftId: drawerA2, bankAccountId: accA.bankAccountId, ledgerCode: accA.ledgerCode,
        amountCents: o2.due, tipCents: 0, dueCents: o2.due, status: 'awaiting', expiresAt: new Date(Date.now() + 30 * 60_000),
        idempotencyKey: `rv3-${o2.id}`, createdById: u['cashierA2']!.id,
      },
    })
    const r = await postIntent(u['cashierA']!, { orderId: o1.id, shiftId: drawerA, expectedDueCents: o1.due, idempotencyKey: `rv3-${o1.id}` })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().status).toBe('awaiting')
    const a = await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })
    expect(a.status).toBe('ambiguous')
    expect([...a.candidateIds].sort()).toEqual([r.json().id, other.id].sort())
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('awaiting')
    expect(emits.some((e) => e.event === 'raast:alert' && e.payload['alertId'] === alertId && e.payload['status'] === 'ambiguous')).toBe(true)
  })

  it('RV-FRAUD-4: a 5-day-old unbooked credit cannot be attached to today\'s bill (422 RAAST_ALERT_TOO_OLD), nothing changes', async () => {
    await clearAlerts()
    const o = await ring()
    const alertId = await smsA(creditSms(o.due, 'OLDCRED5551'))
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('unmatched')
    await backdate(alertId, 5 * 86_400_000)
    const r = await call(u['cashierA']!, 'POST', `/pos/raast/alerts/${alertId}/attach`, { orderId: o.id, shiftId: drawerA })
    expect(r.statusCode, r.body).toBe(422)
    expect(r.json().error.code).toBe('RAAST_ALERT_TOO_OLD')
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alertId } })).status).toBe('unmatched')
    expect(await prisma.raastReceipt.count({ where: { orderId: o.id } })).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe('completed')
  })

  it('M4 at the till: a typed reference of a credit from before the bill is refused (409 RAAST_REF_TOO_OLD), SMS matching on or off', async () => {
    await clearAlerts()
    // A: matching ON.
    const o = await ring()
    const alertId = await smsA(creditSms(o.due, 'BORROWED123'))
    await backdate(alertId, 2 * 86_400_000)
    await expect(processPayment({
      orderId: o.id, shiftId: drawerA, actorId: u['cashierA']!.id,
      payments: [{ method: 'raast', amountCents: o.due, gatewayRef: 'BORROWED123', raast: { via: 'cashier', cashierVerified: true } }],
    })).rejects.toMatchObject({ code: 'RAAST_REF_TOO_OLD' })
    expect(await prisma.raastReceipt.count({ where: { orderId: o.id } })).toBe(0)

    // B: matching OFF — an 'off' alert from 3 days ago is just as unborrowable.
    await setConnector(B.tenantId, 'raast', { enabled: false })
    const connB = await prisma.posConnector.findFirstOrThrow({ where: { tenantId: B.tenantId, kind: 'raast' } })
    const devB = await prisma.bankSmsDevice.create({
      data: { tenantId: B.tenantId, connectorId: connB.id, label: 'B', tokenHash: `test-hash-b-${Date.now()}`, tokenEnc: 'x', tokenHint: 'x', createdById: u['cashierB']!.id },
    })
    const accB = await prisma.bankAccount.findFirstOrThrow({ where: { tenantId: B.tenantId, raastDefault: true } })
    const threeDays = new Date(Date.now() - 3 * 86_400_000)
    await prisma.bankSmsAlert.create({
      data: {
        tenantId: B.tenantId, deviceId: devB.id, sender: 'MEEZANBNK', bodyHash: `h-b-${Date.now()}`, body: 'x', receivedAt: threeDays, occurredAt: threeDays,
        kind: 'credit', amountCents: 5_000, bankRef: 'OFFOLD12345', bankAccountId: accB.id, status: 'off',
      },
    })
    const ob = await ring(u['cashierB']!, B)
    await expect(processPayment({
      orderId: ob.id, shiftId: drawerB, actorId: u['cashierB']!.id,
      payments: [{ method: 'raast', amountCents: ob.due, gatewayRef: 'OFFOLD12345', raast: { via: 'cashier', cashierVerified: true } }],
    })).rejects.toMatchObject({ code: 'RAAST_REF_TOO_OLD' })
    // A fresh reference still pays.
    await processPayment({
      orderId: ob.id, shiftId: drawerB, actorId: u['cashierB']!.id,
      payments: [{ method: 'raast', amountCents: ob.due, gatewayRef: 'FRESH123456', raast: { via: 'cashier', cashierVerified: true } }],
    })
    expect((await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: ob.id } })).status).toBe('provisional')
  })
})
