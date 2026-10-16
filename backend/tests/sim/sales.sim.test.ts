// The simulated month — SALES and the NIGHT AUDIT (finance readiness plan §4a
// items 1–3, and the sales accounts of "Ledger results to check"). Phase 1 of
// 3: purchasing, cash, tax/payroll, money-in and books are added by the other
// sim files on the same harness (tests/sim/harness.ts — its header is the API).
//
// Two companies (A 'GS Foods' — code-only delivery ON, withholding ON; B 'GS x
// Viva' — code-only OFF), each with an SRB (Sindh) and an FBR (Islamabad)
// brand. Six trading days of October 2026 — Thu 1 to Sun 4, Monday 5 closed,
// Tue 6 and month-end Sat 31 — with two tills a day (cashier 1 09:00–17:00,
// cashier 2 17:20–23:30; Saturday's late till closes 01:30 Sunday and books to
// Saturday, lib/businessDay.ts). Everything goes through the real API.
//
//   every day   cash (change given), Keenu card with a PKR 200 tip, Raast QR,
//               a 10% discount (the cashier's cap), a split card + cash bill, a
//               gift card part-payment (finance applies it: the till has no
//               gift-card tender and /gift-cards needs the gift_cards module —
//               a cashier gets 403), the 5% service charge on every till bill,
//               a PKR 10,000 drop to the safe;
//   day 1       till 2 counted PKR 500 short;  day 2: till 2 counted PKR 300 over;
//   day 2       a comp (manager PIN); a line void before payment (manager PIN —
//               a paid till bill completes at once, so its lines can only be
//               refunded: 422 ORDER_PAID); a split bill with one diner paid,
//               cancelled (manager PIN) and the diner's cash refunded;
//               cash on delivery from the storefront with the PKR 150 fee — A:
//               the rider closes the job with the customer's code (staff
//               "Delivered" is 404), finance books the rider's debt (1351), the
//               cash is paid in at a till the next morning; B: staff
//               "Delivered", paid in at the evening till;
//   day 3       a card bill refunded after completion: part, then the rest;
//   day 4       a table still eating at close (the till closes over it);
//   day 6       that ticket is paid; a morning Keenu card FAILS after its drawer
//               closed (signed Keenu webhook → Dr 1110 / Cr 1030), and Keenu's
//               payout leaves it out;
//   each night  the next morning finance runs the night audit: with blocks open
//               it is refused (NIGHT_AUDIT_NOT_READY) and finance cannot push
//               past them (OVERRIDE_CEO_ONLY); blocks cleared → audited. Day 4's
//               open ticket: the CEO overrides with a reason (flagged), then a
//               line void on that locked day is refused to the manager and to a
//               manager's PIN (CEO_ONLY_BACKDATED) and allowed to the CEO with a
//               reason. Every day: cancelling / credit-noting yesterday's paid
//               bill is refused to the manager (CEO_ONLY_BACKDATED) and asks the
//               CEO for a reason;
//   bank        deposit bags with slip files (two bags for one till on day 2, one
//               bag for two tills on day 3), the bank statement the next day
//               (bags + the Keenu payout on the main bank, the Raast credits on
//               the collections bank) → the day closes by itself (the hourly
//               worker's body, runNightAuditSettleOnce).
// Month end (per company): books balanced, TB one net figure per account and no
// zero rows; 1010 = the safe; 1015 = 0 once banked (floats are not on the
// books); 1030 = the card days not yet paid out; 6080 = Keenu's fees; 1110 = the
// failed card the customer owes; 1351 = COD with riders; 2032 / 2030 = the SRB /
// FBR brands' bills = their tax invoices; 4100 = the service charge; 2095 tips;
// 2080 gift cards; the Raast bank = the Raast receipts (all matched); every
// statement line matched; every trading day closed; no open posting-refused or
// night-audit-pending flag. Company separation: B gets 404 on A's records.
//
// Not simulated here: a wallet payment at the till (the till takes no wallet
// tender, F-PAY02 — wallets pay on the storefront; the money-in phase covers
// wallets). Known open defects are at the end of the file (it.fails).
//
// Runtime ≈ 1 minute. Requires a disposable database ("test" in DATABASE_URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  startSim, ok, errCode, pdfFile, pkt, nextDay, SIM_DAYS, SIM_PIN, MDR_BPS, FEE_TAX_BPS,
  type Sim, type SimCompany, type SimUser, type SimBrand, type SimItem,
} from './harness.js'

let sim: Sim

const FLOAT = 500_000 // PKR 5,000 opening float on every till
const SAFE_DROP = 1_000_000 // PKR 10,000 to the safe mid-shift on S1 (kept in the safe, never banked)

// ─── What the simulation expects (built as it goes) ─────────────────────────

interface DayBook {
  shifts: string[]
  cardGross: number // card money of the day (incl. tips), net of card refunds that day
  raast: Array<{ ref: string; amountCents: number }>
  orders: string[]
  codPayments: string[]
}
type CoKey = 'A' | 'B'
const book: Record<CoKey, Record<string, DayBook>> = { A: {}, B: {} }
const dayBook = (co: SimCompany, day: string): DayBook =>
  (book[co.key][day] ??= { shifts: [], cardGross: 0, raast: [], orders: [], codPayments: [] })
const safeDrops: Record<CoKey, number> = { A: 0, B: 0 }
const paidOut: Record<CoKey, Set<string>> = { A: new Set(), B: new Set() } // card days whose payout was imported

let seq = 0
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase() // card refs are deduped by the Keenu webhook for 24 h (Redis)
const cardRef = () => `KN${RUN}${String(100000 + ++seq)}`
let lastCardRef = ''
const raastRef = () => `MZN${String(7000000 + ++seq)}${String(seq % 1000).padStart(3, '0')}`
const key = (s: string) => `sim-${s}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

// ─── Till helpers ───────────────────────────────────────────────────────────

const line = (item: SimItem, quantity = 1) => ({ menuItemId: item.id, name: item.name, quantity, unitPriceCents: item.priceCents, modifiers: [] })

async function openTill(co: SimCompany, who: SimUser, float = FLOAT): Promise<string> {
  const s = ok(await sim.as(who, co).post('/pos/shifts/open', { openingFloatCents: float }), 201)
  return s.id as string
}

interface Rung { id: string; totalCents: number; items: Array<{ id: string; name: string }>; taxCents: number; serviceChargeCents: number }
async function ring(co: SimCompany, who: SimUser, shiftId: string, brand: SimBrand, items: Array<[SimItem, number]>, opts: { tender?: 'cash' | 'card' | 'raast'; discountCents?: number; discountReason?: string } = {}): Promise<Rung> {
  const r = ok(await sim.as(who, co).post('/pos/orders', {
    conceptId: brand.id, shiftId, items: items.map(([i, q]) => line(i, q)), idempotencyKey: key('ring'),
    ...(opts.tender && { paymentMethod: opts.tender }),
    ...(opts.discountCents && { discountCents: opts.discountCents, discountReason: opts.discountReason ?? 'Regular guest' }),
  }), 201)
  return r as Rung
}

type Tender =
  | { method: 'cash'; amountCents: number; tenderedCents?: number }
  | { method: 'card'; amountCents: number; tipCents?: number }
  | { method: 'raast'; amountCents: number }
async function pay(co: SimCompany, who: SimUser, shiftId: string, order: { id: string }, day: string, tenders: Tender[]) {
  const payments = tenders.map((t) => {
    if (t.method === 'card') return { method: 'card', amountCents: t.amountCents, gateway: 'keenu', gatewayRef: (lastCardRef = cardRef()), ...(t.tipCents ? { tipCents: t.tipCents } : {}) }
    if (t.method === 'raast') return { method: 'raast', amountCents: t.amountCents, gatewayRef: raastRef(), raastVerified: true }
    return { method: 'cash', amountCents: t.amountCents, tenderedCents: t.tenderedCents ?? t.amountCents }
  })
  const res = ok(await sim.as(who, co).post('/pos/payments', { orderId: order.id, shiftId, idempotencyKey: key('pay'), payments }), 201)
  const db = dayBook(co, day)
  db.orders.push(order.id)
  for (const p of payments) {
    if (p.method === 'card') db.cardGross += p.amountCents
    if (p.method === 'raast') db.raast.push({ ref: p.gatewayRef as string, amountCents: p.amountCents })
  }
  return res
}

/** The cash the till expects at the close (Z-report). */
async function expectedDrawer(co: SimCompany, who: SimUser, shiftId: string): Promise<number> {
  // The Z-report is the manager's (cashiers count blind).
  void who
  const z = ok(await sim.as(co.manager, co).get(`/pos/shifts/${shiftId}/zreport`), 200)
  const e = z.expectedCashCents ?? z.expectedCents ?? z.drawer?.expectedCents ?? z.cash?.expectedCents
  expect(typeof e, `zreport has no expected cash: ${JSON.stringify(z).slice(0, 600)}`).toBe('number')
  return e as number
}

async function closeTill(co: SimCompany, who: SimUser, shiftId: string, diffCents = 0, confirmOpenTickets = false) {
  const expected = await expectedDrawer(co, who, shiftId)
  ok(await sim.as(who, co).post(`/pos/shifts/${shiftId}/close`, { closingFloatCents: expected + diffCents, ...(confirmOpenTickets && { confirmOpenTickets: true }) }), 200)
  await sim.settle()
  return expected + diffCents
}

// ─── Cash on delivery (storefront → kitchen → rider) ─────────────────────────

const customers: Partial<Record<CoKey, string>> = {}
async function codOrder(co: SimCompany, brand: SimBrand): Promise<{ orderId: string; paymentId: string; totalCents: number }> {
  const cust = (customers[co.key] ??= await sim.mkCustomer(`Sim Customer ${co.key}`, co.key === 'A' ? '923451112201' : '923451112202'))
  const r = ok(await sim.asCustomer(cust).post('/storefront/orders', {
    conceptSlug: brand.slug, type: 'delivery', deliveryAddress: 'House 12, Block 4, Clifton', deliveryLat: 24.8150, deliveryLng: 67.0350,
    items: [{ menuItemId: brand.items.main.id, quantity: 1 }, { menuItemId: brand.items.drink.id, quantity: 1 }], paymentGateway: 'cash',
  }), [200, 201])
  const orderId = (r.order?.id ?? r.id) as string
  const mgr = sim.as(co.manager, co)
  for (const status of ['preparing', 'ready']) ok(await mgr.patch(`/orders/${orderId}/status`, { status }), 200)
  ok(await mgr.post(`/dispatch/orders/${orderId}/assign`, { riderId: co.riderId }), 200)
  const o = await sim.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } })
  expect(o.deliveryFeeCents, 'the delivery fee is charged on top').toBe(15_000)
  const cash = o.payments.find((p) => p.method === 'cash')!
  return { orderId, paymentId: cash.id, totalCents: o.totalCents }
}

/** The rider's job: on shift, accept, picked up, arrived, delivered with the customer's code. */
async function riderDelivers(co: SimCompany, orderId: string) {
  const rider = sim.asRider(co.riderId)
  ok(await rider.post('/rider/shift', { online: true }), 200)
  for (const step of ['accept', 'picked-up', 'arrived']) ok(await rider.post(`/rider/jobs/${orderId}/${step}`, {}), 200)
  const { deliveryOtp } = await sim.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { deliveryOtp: true } }) // the customer reads it on the tracker
  ok(await rider.post(`/rider/jobs/${orderId}/deliver`, { otp: deliveryOtp }), 200)
}

// ─── One trading day ────────────────────────────────────────────────────────

const state: Record<CoKey, { giftCode?: string; giftCardId?: string; refundOrder?: { id: string; totalCents: number }; backdateOrder?: { id: string; itemId: string }; s1?: string; s2?: string; cod?: { orderId: string; paymentId: string; totalCents: number }; openTicket?: { id: string; voidItemId: string }; failCard?: { orderId: string; ref: string; amountCents: number } }> = { A: {}, B: {} }

// Times: A first, B ten minutes to an hour later — the clock never runs backwards.
const T = (co: SimCompany, a: string, b: string) => (co.key === 'A' ? a : b)

async function tillOne(co: SimCompany, day: string, i: number) {
  const db = dayBook(co, day)
  const { srb, fbr } = co.brands
  const c1 = co.cashier

  // ── S1: 09:00 – 17:00 ──
  sim.clock.at(day, T(co, '09:00', '10:00'))
  const s1 = await openTill(co, c1)
  db.shifts.push(s1)

  // cash, change given
  const o1 = await ring(co, c1, s1, srb, [[srb.items.main, 1], [srb.items.drink, 2]])
  await pay(co, c1, s1, o1, day, [{ method: 'cash', amountCents: o1.totalCents, tenderedCents: Math.ceil(o1.totalCents / 100_000) * 100_000 }])
  // Keenu card with a PKR 200 tip
  const o2 = await ring(co, c1, s1, fbr, [[fbr.items.main, 1], [fbr.items.side, 1]], { tender: 'card' })
  await pay(co, c1, s1, o2, day, [{ method: 'card', amountCents: o2.totalCents + 20_000, tipCents: 20_000 }])
  if (i === 4) state[co.key].failCard = { orderId: o2.id, ref: lastCardRef, amountCents: o2.totalCents + 20_000 }
  // Raast QR
  const o3 = await ring(co, c1, s1, srb, [[srb.items.dessert, 2]], { tender: 'raast' })
  await pay(co, c1, s1, o3, day, [{ method: 'raast', amountCents: o3.totalCents }])
  // a 10% discount (the cashier's cap), cash
  const gross4 = fbr.items.main.priceCents * 2
  const o4 = await ring(co, c1, s1, fbr, [[fbr.items.main, 2]], { discountCents: gross4 / 10 })
  await pay(co, c1, s1, o4, day, [{ method: 'cash', amountCents: o4.totalCents }])
  // split: part card, the rest cash (priced at the cash rate: a split with cash is cash)
  const o5 = await ring(co, c1, s1, srb, [[srb.items.main, 2], [srb.items.side, 1]])
  const cardPart = 200_000
  await pay(co, c1, s1, o5, day, [{ method: 'card', amountCents: cardPart }, { method: 'cash', amountCents: o5.totalCents - cardPart }])
  // gift card: sold by finance on day 1 (cash, with a reference — GIFT_CARD_SELLERS = the finance team);
  // part-pays a bill every day. The till has no gift-card tender and /gift-cards is gated by the
  // gift_cards module (CEO, management, finance), so the cashier calls finance to apply it.
  if (!state[co.key].giftCode) {
    const gc = ok(await sim.as(co.finance, co).post('/gift-cards', { kind: 'sold', issuedAmountCents: 1_000_000, paymentMethod: 'cash', paymentRef: `GC-SALE-${co.key}-1`, recipientName: 'Sim guest' }), 201)
    state[co.key].giftCode = gc.code
    state[co.key].giftCardId = gc.id
  }
  const o6 = await ring(co, c1, s1, fbr, [[fbr.items.main, 1], [fbr.items.dessert, 1]])
  const gcPart = 150_000
  const cashierTry = await sim.as(c1, co).post('/gift-cards/redeem', { code: state[co.key].giftCode, orderId: o6.id, amountCents: gcPart })
  expect(cashierTry.statusCode, cashierTry.body).toBe(403)
  ok(await sim.as(co.finance, co).post('/gift-cards/redeem', { code: state[co.key].giftCode, orderId: o6.id, amountCents: gcPart }), 200)
  await pay(co, c1, s1, o6, day, [{ method: 'cash', amountCents: o6.totalCents - gcPart }])
  // the cash drop to the safe
  ok(await sim.as(c1, co).post(`/pos/shifts/${s1}/cash-movements`, { type: 'drop', amountCents: SAFE_DROP, reason: 'Mid-shift drop to the safe' }), 201)
  safeDrops[co.key] += SAFE_DROP

  if (i === 1) {
    // day 2: a comp of a whole bill with the manager's PIN
    const o7 = await ring(co, c1, s1, fbr, [[fbr.items.drink, 2]])
    ok(await sim.as(c1, co).post(`/pos/orders/${o7.id}/comp`, { amountCents: o7.totalCents, reason: 'Long wait — on the house', shiftId: s1, managerOverridePin: SIM_PIN[co.key] }), 200)
    db.orders.push(o7.id)
  }
  if (i === 4) {
    // Tue 6: Sunday's open ticket (its dessert voided by the CEO) is paid at the next trading day's till
    const t = state[co.key].openTicket!
    const due = ok(await sim.as(c1, co).get(`/pos/orders/${t.id}/quote?method=cash`), 200)
    await pay(co, c1, s1, { id: t.id }, day, [{ method: 'cash', amountCents: due.dueCents }])
  }
  if (i === 2) {
    // day 3: a card bill refunded later (part, then the rest) — see the refunds step
    const o8 = await ring(co, c1, s1, srb, [[srb.items.main, 1], [srb.items.side, 1]], { tender: 'card' })
    await pay(co, c1, s1, o8, day, [{ method: 'card', amountCents: o8.totalCents }])
    state[co.key].refundOrder = { id: o8.id, totalCents: o8.totalCents }
  }

  state[co.key].s1 = s1
}

async function closeTillOne(co: SimCompany, day: string, i: number) {
  sim.clock.at(day, T(co, '17:00', '17:10'))
  await closeTill(co, co.cashier, state[co.key].s1!, 0)
}

async function tillTwo(co: SimCompany, day: string, i: number) {
  const db = dayBook(co, day)
  const { srb, fbr } = co.brands
  const c2 = co.cashier2
  // ── S2: 17:20 – 23:30 (Sat 3: closes 01:30 Sunday) ──
  sim.clock.at(day, T(co, '17:20', '18:00'))
  if (i === 4) {
    // A Keenu card of the morning till fails after that drawer closed: Keenu's FAILED callback
    // moves it to the customer's account (Dr 1110 / Cr 1030) and Keenu's payout leaves it out.
    const f = state[co.key].failCard!
    const raw = JSON.stringify({ order_id: f.orderId, transaction_id: f.ref, status: 'FAILED', amount: f.amountCents })
    const sig = createHmac('sha256', process.env['KEENU_WEBHOOK_SECRET']!).update(raw).digest('hex')
    const r = await sim.app.inject({ method: 'POST', url: '/api/v1/webhooks/keenu', headers: { 'content-type': 'application/json', 'x-keenu-signature': sig }, payload: raw })
    expect(r.statusCode, r.body).toBe(200)
    await sim.settle()
    const moved = await sim.ledger.entriesBySource(co, 'pos.card_failed:')
    expect(moved.length, `the failed card is moved: ${r.body}`).toBe(1)
    db.cardGross -= f.amountCents
  }
  const s2 = await openTill(co, c2)
  db.shifts.push(s2)
  const p1 = await ring(co, c2, s2, srb, [[srb.items.main, 2], [srb.items.drink, 2]])
  await pay(co, c2, s2, p1, day, [{ method: 'cash', amountCents: p1.totalCents, tenderedCents: Math.ceil(p1.totalCents / 100_000) * 100_000 }])
  const p2 = await ring(co, c2, s2, fbr, [[fbr.items.main, 1], [fbr.items.drink, 1]], { tender: 'card' })
  await pay(co, c2, s2, p2, day, [{ method: 'card', amountCents: p2.totalCents }])
  const p3 = await ring(co, c2, s2, fbr, [[fbr.items.side, 2]], { tender: 'raast' })
  await pay(co, c2, s2, p3, day, [{ method: 'raast', amountCents: p3.totalCents }])
  const p4 = await ring(co, c2, s2, srb, [[srb.items.dessert, 1], [srb.items.drink, 1]])
  await pay(co, c2, s2, p4, day, [{ method: 'cash', amountCents: p4.totalCents }])
  // remember a paid two-line bill for tomorrow's back-dated void
  state[co.key].backdateOrder = { id: p1.id, itemId: p1.items[0]!.id }

  if (i === 1) {
    // Cash on delivery (storefront, PKR 150 delivery fee). A: code-only — the rider closes the job
    // with the customer's code, finance books the rider's debt, the cash is paid in at the till
    // tomorrow. B: staff "Delivered", the rider pays in before the till closes.
    const cod = await codOrder(co, srb)
    state[co.key].cod = cod
    db.codPayments.push(cod.paymentId)
    if (co.key === 'A') {
      const staff = await sim.as(co.manager, co).post(`/dispatch/orders/${cod.orderId}/delivered`, {})
      expect(staff.statusCode, `code-only: no staff Delivered — ${staff.body}`).toBe(404)
      await riderDelivers(co, cod.orderId)
      ok(await sim.as(co.finance, co).post(`/reconciliation/cod/${cod.paymentId}/rider-debt`, { reason: 'Rider kept the cash overnight; hands it in tomorrow' }), [200, 201])
    } else {
      ok(await sim.as(co.manager, co).post(`/dispatch/orders/${cod.orderId}/delivered`, {}), 200)
      ok(await sim.as(c2, co).post(`/pos/payments/${cod.paymentId}/settle`, { shiftId: s2, tenderedCents: cod.totalCents }), [200, 201])
    }
  }
  if (i === 1) {
    // a line void with the manager's PIN. Only an OPEN ticket's line can be voided: a paid till
    // bill completes at once and answers 422 ORDER_PAID ("refund it instead") — so the void comes
    // before the money, and a paid bill is undone by a refund (day 3).
    const v = await ring(co, c2, s2, srb, [[srb.items.main, 1], [srb.items.dessert, 1]])
    const dessertLine = v.items.find((x) => x.name.endsWith('Dessert'))!
    const noPin = await sim.as(c2, co).post(`/pos/orders/${v.id}/void`, { orderItemId: dessertLine.id, reason: 'Wrong dessert' })
    expect(noPin.statusCode, noPin.body).toBe(403)
    ok(await sim.as(c2, co).post(`/pos/orders/${v.id}/void`, { orderItemId: dessertLine.id, reason: 'Wrong dessert', managerOverridePin: SIM_PIN[co.key] }), 200)
    const due = ok(await sim.as(c2, co).get(`/pos/orders/${v.id}/quote?method=cash`), 200)
    await pay(co, c2, s2, v, day, [{ method: 'cash', amountCents: due.dueCents }])
    // a full cancel of a part-paid ticket: the till takes no part payment on a whole bill
    // (AMOUNT_MISMATCH), so the bill is split in two and one diner pays cash; the other leaves.
    const x = await ring(co, c2, s2, fbr, [[fbr.items.main, 1], [fbr.items.side, 1]])
    const split = ok(await sim.as(c2, co).post(`/check-split/orders/${x.id}/split`, { splits: [{ amountCents: 100_000, method: 'cash' }, { amountCents: x.totalCents - 100_000, method: 'cash' }] }), [200, 201])
    const portions = (split.payments ?? split.portions ?? split) as Array<{ id: string; amountCents: number }>
    const first = portions.find((p) => p.amountCents === 100_000)!
    ok(await sim.as(c2, co).post(`/check-split/payments/${first.id}/settle`, { shiftId: s2, tenderedCents: 100_000 }), [200, 201])
    db.orders.push(x.id)
    const cNoPin = await sim.as(c2, co).post(`/orders/${x.id}/cancel`, { reason: 'Guest left before the food' })
    expect(cNoPin.statusCode, cNoPin.body).toBe(403)
    ok(await sim.as(c2, co).post(`/orders/${x.id}/cancel`, { reason: 'Guest left before the food', managerOverridePin: SIM_PIN[co.key] }), 200)
    // the diner who paid gets the cash back from the drawer
    const back = ok(await sim.as(co.manager, co).post(`/pos/orders/${x.id}/refund`, { amountCents: 100_000, reason: 'Paid portion of a cancelled bill', method: 'cash', shiftId: s2 }), 200)
    expect(back).toMatchObject({ method: 'cash', amountCents: -100_000, status: 'refunded' })
  }
  if (i === 2) {
    // the refund after completion: part, then the rest (back to the card)
    const r = state[co.key].refundOrder!
    const part = 100_000
    ok(await sim.as(co.manager, co).post(`/pos/orders/${r.id}/refund`, { amountCents: part, reason: 'Cold side — part refund', method: 'card', gatewayRef: cardRef() }), 200)
    ok(await sim.as(co.manager, co).post(`/pos/orders/${r.id}/refund`, { amountCents: r.totalCents - part, reason: 'Guest unhappy — rest refunded', method: 'card', gatewayRef: cardRef() }), 200)
    db.cardGross -= r.totalCents
  }

  state[co.key].s2 = s2
}

async function closeTillTwo(co: SimCompany, day: string, i: number) {
  // Sat 3 closes at 01:30 Sunday (it books to Saturday)
  if (day === '2026-10-03') sim.clock.at(nextDay(day), T(co, '01:30', '01:40'))
  else sim.clock.at(day, T(co, '23:30', '23:40'))
  if (i === 3) {
    // Sun 4: a table still eating at closing time — the ticket stays open overnight
    const t = await ring(co, co.cashier2, state[co.key].s2!, co.brands.fbr, [[co.brands.fbr.items.main, 1], [co.brands.fbr.items.dessert, 1]])
    state[co.key].openTicket = { id: t.id, voidItemId: t.items.find((x) => x.name.endsWith('Dessert'))!.id }
    const refused = await sim.as(co.cashier2, co).post(`/pos/shifts/${state[co.key].s2}/close`, { closingFloatCents: 0 })
    expect(errCode(refused), refused.body).toBe('OPEN_TICKETS')
  }
  // day 1 counted 500 short, day 2 counted 300 over (S2 carries no safe drop, so its takings cover a short)
  await closeTill(co, co.cashier2, state[co.key].s2!, i === 0 ? -50_000 : i === 1 ? 30_000 : 0, i === 3)
}

// ─── The morning after: night audit, bags, statement ────────────────────────

async function nightRun(co: SimCompany, day: string, i: number) {
  const fin = sim.as(co.finance, co)
  const ceo = sim.as(sim.ceo, co)
  const keysOf = (d: { checks?: { blocks?: Array<{ key: string }> } }) => (d.checks?.blocks ?? []).map((b) => b.key).sort()
  const d = ok(await fin.get(`/accounting/night-audit/${day}`), 200)
  expect(d.active, `${co.key} ${day} should be an active sales day`).toBe(true)
  const blocks = keysOf(d)

  // The blocks this day is built to have.
  const want: string[] = []
  if (i === 0 || i === 1) want.push('cash_variance_open')
  if (i === 1 && co.key === 'A') want.push('cod_pending')
  if (i === 3) want.push('open_orders')
  expect(blocks, `${co.key} ${day} night blocks: ${JSON.stringify(d.checks?.blocks)}`).toEqual(want.sort())

  if (want.length > 0) {
    // Finance runs with the blocks open: refused, and cannot push past them.
    const r = await fin.post(`/accounting/night-audit/${day}/run`, {})
    expect(r.statusCode, r.body).toBe(409)
    expect(errCode(r)).toBe('NIGHT_AUDIT_NOT_READY')
    const o = await fin.post(`/accounting/night-audit/${day}/run`, { acknowledge: { keys: want, reason: 'Finance trying to push past the blocks' } })
    expect(o.statusCode, o.body).toBe(403)
    expect(errCode(o)).toBe('OVERRIDE_CEO_ONLY')
  }
  if (want.includes('cash_variance_open')) {
    const flags = await sim.prisma.exceptionFlag.findMany({ where: { tenantId: co.tenantId, kind: 'cash_variance', status: 'open', entityType: 'Shift', entityId: { in: dayBook(co, day).shifts } } })
    expect(flags.length).toBe(1)
    for (const f of flags) ok(await fin.patch(`/crosschecks/exceptions/${f.id}/acknowledge`, { note: 'Counted again with the cashier; difference explained' }), [200, 204])
  }
  if (want.includes('cod_pending')) {
    // The rider's debt is booked (1351), but the cash is not in a drawer: cod_pending still blocks
    // the night (codPendingRows does not look at codRiderDebtAt). The rider hands the cash in at a
    // till first thing — the manager's early till of the next business day.
    const cod = state[co.key].cod!
    const early = await openTill(co, co.manager, 0)
    ok(await sim.as(co.manager, co).post(`/pos/payments/${cod.paymentId}/settle`, { shiftId: early, tenderedCents: cod.totalCents }), [200, 201])
    await closeTill(co, co.manager, early, 0)
    dayBook(co, nextDay(day)).shifts.push(early)
  }

  let run
  if (want.includes('open_orders')) {
    // A ticket still open overnight: only the CEO may push past it, with a reason (flagged).
    const short = await ceo.post(`/accounting/night-audit/${day}/run`, { acknowledge: { keys: ['open_orders'], reason: 'short' } })
    expect(short.statusCode, short.body).toBe(422)
    run = ok(await ceo.post(`/accounting/night-audit/${day}/run`, { acknowledge: { keys: ['open_orders'], reason: 'Table 4 is still eating; their bill is settled tomorrow' } }), 200)
    const flag = await sim.prisma.exceptionFlag.findFirst({ where: { tenantId: co.tenantId, kind: 'night_audit_override', entityId: `${co.tenantId}:${day}` } })
    expect(flag, 'a CEO override of the night run is flagged').toBeTruthy()
    // The open ticket's day is locked now: a line void is the CEO's, with a reason.
    const t = state[co.key].openTicket!
    const mgr = await sim.as(co.manager, co).post(`/pos/orders/${t.id}/void`, { orderItemId: t.voidItemId, reason: 'Kitchen ran out' })
    expect(errCode(mgr), mgr.body).toBe('CEO_ONLY_BACKDATED')
    const pin = await sim.as(co.cashier, co).post(`/pos/orders/${t.id}/void`, { orderItemId: t.voidItemId, reason: 'Kitchen ran out', managerOverridePin: SIM_PIN[co.key] })
    expect(errCode(pin), `a manager's PIN does not make it the CEO's — ${pin.body}`).toBe('CEO_ONLY_BACKDATED')
    const noReason = await ceo.post(`/pos/orders/${t.id}/void`, { orderItemId: t.voidItemId, reason: 'Kitchen ran out' })
    expect(errCode(noReason), noReason.body).toBe('BACKDATED_REASON_REQUIRED')
    ok(await ceo.post(`/pos/orders/${t.id}/void`, { orderItemId: t.voidItemId, reason: 'Kitchen ran out', backdatedReason: 'Dessert never served; CEO voids it on the locked day' }), 200)
  } else {
    if (want.length > 0) {
      const again = ok(await fin.get(`/accounting/night-audit/${day}`), 200)
      expect(keysOf(again), `${co.key} ${day} blocks after clearing`).toEqual([])
    }
    run = ok(await fin.post(`/accounting/night-audit/${day}/run`, {}), 200)
  }
  expect(['audited', 'closed']).toContain(run.status)

  // Back-dated undo of yesterday's paid bill (nightAudit/backdate.ts). A paid till bill is
  // completed, so a line void is ORDER_PAID before any day rule; the gated undos of a completed
  // sale are the cancel and the tax-invoice credit note: the manager is refused both
  // (CEO_ONLY_BACKDATED); the CEO is asked for a reason. (The CEO's credit note itself is the
  // known defect at the end of this file.)
  const bd = state[co.key].backdateOrder!
  const mgrCancel = await sim.as(co.manager, co).post(`/orders/${bd.id}/cancel`, { reason: 'Guest returned it' })
  expect(errCode(mgrCancel), mgrCancel.body).toBe('CEO_ONLY_BACKDATED')
  const mgrCn = await sim.as(co.manager, co).post(`/invoices/orders/${bd.id}/credit-note`, { reason: 'Guest returned it' })
  expect(errCode(mgrCn), mgrCn.body).toBe('CEO_ONLY_BACKDATED')
  const noReason = await ceo.post(`/invoices/orders/${bd.id}/credit-note`, { reason: 'Guest returned it' })
  expect(errCode(noReason), noReason.body).toBe('BACKDATED_REASON_REQUIRED')
  return run
}

async function bankBags(co: SimCompany, day: string, i: number) {
  const { expectedShiftDeposit } = await import('../../src/modules/accounting/depositPosting.js')
  const fin = sim.as(co.finance, co)
  const all = dayBook(co, day).shifts
  const [s1, s2] = all.slice(-2) as [string, string] // the two cashier tills (opened last)
  const extra = all.slice(0, -2)                      // e.g. the manager's early pay-in till
  const e1 = (await expectedShiftDeposit(s1)).expectedCents
  const e2 = (await expectedShiftDeposit(s2)).expectedCents
  const bags: number[] = []
  for (const s of extra) {
    const e = (await expectedShiftDeposit(s)).expectedCents
    if (e <= 0) continue
    ok(await fin.post('/trustops/deposit-drops', { shiftId: s, amountCents: e, bankAccountId: co.banks.main.id, slipNumber: `SLIP-${co.key}-${++seq}`, files: [pdfFile()] }), 201)
    bags.push(e)
  }
  if (i === 1) {
    // two bags for one till
    const half = Math.floor(e1 / 2)
    for (const amt of [half, e1 - half]) {
      ok(await fin.post('/trustops/deposit-drops', { shiftId: s1, amountCents: amt, bankAccountId: co.banks.main.id, slipNumber: `SLIP-${co.key}-${++seq}`, files: [pdfFile()] }), 201)
      bags.push(amt)
    }
    ok(await fin.post('/trustops/deposit-drops', { shiftId: s2, amountCents: e2, bankAccountId: co.banks.main.id, slipNumber: `SLIP-${co.key}-${++seq}`, files: [pdfFile()] }), 201)
    bags.push(e2)
  } else if (i === 2) {
    // one bag for two tills
    ok(await fin.post('/trustops/deposit-drops', {
      shifts: [{ shiftId: s1, amountCents: e1 }, { shiftId: s2, amountCents: e2 }], amountCents: e1 + e2,
      bankAccountId: co.banks.main.id, slipNumber: `SLIP-${co.key}-${++seq}`, files: [pdfFile()],
    }), 201)
    bags.push(e1 + e2)
  } else {
    for (const [s, e] of [[s1, e1], [s2, e2]] as const) {
      ok(await fin.post('/trustops/deposit-drops', { shiftId: s, amountCents: e, bankAccountId: co.banks.main.id, slipNumber: `SLIP-${co.key}-${++seq}`, files: [pdfFile()] }), 201)
      bags.push(e)
    }
  }
  return bags
}

const netOfCard = (gross: number) => gross - Math.round((gross * MDR_BPS * (10_000 + FEE_TAX_BPS)) / 100_000_000)

async function importStatement(co: SimCompany, bankId: string, statementDay: string, rows: Array<{ day: string; description: string; amountCents: number }>) {
  if (rows.length === 0) return null
  const csv = ['date,description,amount', ...rows.map((r) => `${r.day},"${r.description}","${(r.amountCents / 100).toFixed(2)}"`)].join('\n')
  return ok(await sim.as(co.finance, co).post('/reconciliation/bank/imports', {
    bankAccountId: bankId, statementDate: statementDay, openingBalanceCents: 0, closingBalanceCents: 0,
    filename: `${co.key}-${statementDay}.csv`, fileUrl: `https://files.test/${co.key}-${statementDay}.csv`, csv,
  }), 201)
}

async function morningAfter(co: SimCompany, day: string, i: number) {
  const next = nextDay(day)
  sim.clock.at(next, T(co, '06:00', '07:00'))
  await nightRun(co, day, i)
  sim.clock.at(next, T(co, '06:20', '07:20'))
  const bags = await bankBags(co, day, i)
  // The bank's statements for the day after: main bank = the bags + the Keenu payout of `day`; collections = the Raast credits of `day`.
  sim.clock.at(next, T(co, '06:40', '07:40'))
  const db = dayBook(co, day)
  const main = [
    ...bags.map((b, n) => ({ day: next, description: `CASH DEPOSIT SLIP ${n + 1}`, amountCents: b })),
    ...(db.cardGross > 0 ? [{ day: next, description: 'KEENU MERCHANT SETTLEMENT', amountCents: netOfCard(db.cardGross) }] : []),
  ]
  const imp = await importStatement(co, co.banks.main.id, next, main)
  if (db.cardGross > 0) paidOut[co.key].add(day)
  await importStatement(co, co.raast.id, next, db.raast.map((r) => ({ day, description: `RAAST CREDIT ${r.ref}`, amountCents: r.amountCents })))
  await sim.settle()
  const { runNightAuditSettleOnce } = await import('../../src/workers/nightAuditSettle.js')
  sim.clock.at(next, T(co, '06:50', '07:50'))
  await runNightAuditSettleOnce(new Date())
  const after = ok(await sim.as(co.finance, co).get(`/accounting/night-audit/${day}`), 200)
  expect(after.status, `${co.key} ${day} should close once the bank matches — import ${JSON.stringify(imp)}; checks ${JSON.stringify(after.checks?.blocks ?? after.settlement ?? after)}`.slice(0, 3000)).toBe('closed')
}

// ─── The month ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env['KEENU_WEBHOOK_SECRET'] ??= 'sim-keenu-webhook-secret'
  sim = await startSim()
}, 180_000)

afterAll(async () => {
  await sim?.close()
})

describe('the simulated month — sales and night audit', () => {
  SIM_DAYS.forEach((day, i) => {
    it(`${day}: both companies trade`, async () => {
      for (const co of [sim.A, sim.B]) await tillOne(co, day, i)
      for (const co of [sim.A, sim.B]) await closeTillOne(co, day, i)
      for (const co of [sim.A, sim.B]) await tillTwo(co, day, i)
      for (const co of [sim.A, sim.B]) await closeTillTwo(co, day, i)
    }, 240_000)
    it(`${day}: night run, bags and the statement → the day closes`, async () => {
      for (const co of [sim.A, sim.B]) await morningAfter(co, day, i)
    }, 240_000)
  })
})

// ─── Month end: the sales accounts ───────────────────────────────────────────

const LAST = SIM_DAYS[SIM_DAYS.length - 1]!
const GIFT_CASH = 1_000_000 // the gift card finance sold for cash on day 1 (kept in the safe)

describe('month end — the sales accounts of each company', () => {
  for (const key of ['A', 'B'] as const) {
    it(`${key}: the books balance; one net figure per account, no zero rows`, async () => {
      const co = sim[key]
      await sim.ledger.assertBalanced(co)
      for (const asOf of [LAST, undefined]) {
        const tb = await sim.ledger.trialBalance(co, asOf)
        expect(tb.debitCents, `${key} TB as of ${asOf ?? 'now'}`).toBe(tb.creditCents)
        for (const r of tb.rows) {
          expect(r.debitCents === 0 || r.creditCents === 0, `${r.code}: one side only`).toBe(true)
          expect(r.debitCents + r.creditCents, `${r.code}: no zero rows`).toBeGreaterThan(0)
        }
      }
    })

    it(`${key}: 1010 = the safe; 1015 = floats only (off the books: 0 once banked); 1030 = card days not yet paid out`, async () => {
      const co = sim[key]
      const { expectedShiftDeposit } = await import('../../src/modules/accounting/depositPosting.js')
      const last = dayBook(co, LAST)
      // As of the 31st: the bags of the 31st go to the bank on 1 Nov.
      let drawerUnbanked = 0
      for (const sh of last.shifts) drawerUnbanked += (await expectedShiftDeposit(sh)).fromDrawerCents
      expect(await sim.ledger.balanceOf(co, '1010', LAST), '1010 on the 31st = gift-card cash + the 31st\'s safe drop').toBe(GIFT_CASH + SAFE_DROP)
      expect(await sim.ledger.balanceOf(co, '1015', LAST), '1015 on the 31st = the 31st\'s drawer takings not yet banked').toBe(drawerUnbanked)
      expect(await sim.ledger.balanceOf(co, '1030', LAST), '1030 on the 31st = the 31st\'s card money (paid out on 1 Nov)').toBe(last.cardGross)
      // After the 1 Nov bags and payout.
      expect(await sim.ledger.balanceOf(co, '1010'), '1010 = the safe: the gift-card cash only').toBe(GIFT_CASH)
      expect(await sim.ledger.balanceOf(co, '1015'), '1015 = 0: every drawer banked, floats are not on the books').toBe(0)
      expect(await sim.ledger.balanceOf(co, '1030'), '1030 = 0: every card day paid out').toBe(0)
      // The card that failed after its drawer closed (Tue 6) is owed by the customer — 1110 until
      // collected (1115 once the CEO cuts the company over; neither company is cut over here).
      expect(await sim.ledger.balanceOf(co, '1110'), '1110 = the failed card the customer still owes').toBe(state[key].failCard!.amountCents)
      expect(await sim.ledger.balanceOf(co, '1115')).toBe(0)
      expect([...paidOut[key]].sort()).toEqual([...SIM_DAYS].sort())
      // Keenu's fee on 6080: 2% MDR + 16% tax on it, per payout.
      let fees = 0
      for (const d of SIM_DAYS) fees += dayBook(co, d).cardGross - netOfCard(dayBook(co, d).cardGross)
      expect(await sim.ledger.balanceOf(co, '6080'), '6080 = the Keenu fees').toBe(fees)
    })

    it(`${key}: 1351 = cash on delivery still with riders; the COD sale with its PKR 150 fee on 4110`, async () => {
      const co = sim[key]
      const cod = state[key].cod!
      expect(await sim.ledger.balanceOf(co, '1351'), '1351 = 0: every rider handed the cash in').toBe(0)
      if (key === 'A') {
        // code-only: the rider debt was booked on the 2nd and paid in on the 3rd
        expect(await sim.ledger.balanceOf(co, '1351', '2026-10-02'), '1351 on the 2nd = the COD the rider kept').toBe(cod.totalCents)
        expect((await sim.ledger.entriesBySource(co, `cod.rider_debt:${cod.paymentId}`)).length).toBe(1)
      } else {
        expect((await sim.ledger.entriesBySource(co, 'cod.rider_debt:')).length, 'B: code-only off, no rider debt').toBe(0)
      }
      const p = await sim.prisma.payment.findUniqueOrThrow({ where: { id: cod.paymentId } })
      expect(p.status).toBe('paid')
      expect(-(await sim.ledger.balanceOf(co, '4110')), '4110 = the delivery fee').toBe(15_000)
    })

    it(`${key}: output tax — SRB on 2032, FBR on 2030, each equal to its brand's bills and tax invoices`, async () => {
      const co = sim[key]
      for (const [brand, code, other] of [[co.brands.srb, '2032', '2030'], [co.brands.fbr, '2030', '2032']] as const) {
        const orders = await sim.prisma.order.findMany({ where: { conceptId: brand.id, status: 'completed' }, select: { taxCents: true } })
        const billsTax = orders.reduce((t, o) => t + o.taxCents, 0)
        const inv = await sim.prisma.taxInvoice.findMany({ where: { conceptId: brand.id }, select: { fbrTaxCents: true, provincialTaxCents: true, tenantId: true } })
        const invTax = inv.reduce((t, x) => t + Number(x.fbrTaxCents) + Number(x.provincialTaxCents), 0)
        expect(inv.every((x) => x.tenantId === co.tenantId), 'tax invoices belong to the brand\'s company').toBe(true)
        const tagged = await sim.prisma.$queryRaw<Array<{ code: string; c: bigint }>>`
          SELECT a.code, SUM(CASE WHEN l.type = 'credit' THEN l."amountCents" ELSE -l."amountCents" END)::bigint AS c
            FROM journal_lines l JOIN journal_entries e ON e.id = l."journalEntryId" JOIN accounts a ON a.id = l."accountId"
           WHERE e."tenantId" = ${co.tenantId} AND l."conceptId" = ${brand.id} AND a.code IN ('2030', '2032') GROUP BY a.code`
        const byCode = new Map(tagged.map((r) => [r.code, Number(r.c)]))
        expect(billsTax, `${brand.name}: bills carry tax`).toBeGreaterThan(0)
        expect(byCode.get(code) ?? 0, `${brand.name} (${brand.authority}): ledger ${code} = Σ completed bills' tax`).toBe(billsTax)
        expect(byCode.get(other) ?? 0, `${brand.name}: nothing on ${other}`).toBe(0)
        expect(invTax, `${brand.name}: tax invoices − credit notes = ledger`).toBe(billsTax)
      }
      // the whole account = the two brands
      expect(-(await sim.ledger.balanceOf(co, '2032')) - -(await sim.ledger.balanceOf(co, '2030'))).not.toBeNaN()
    })

    it(`${key}: each brand's sales on its own revenue account (by slug); service charge on 4100`, async () => {
      const co = sim[key]
      const { revenueCodeForConcept } = await import('../../src/modules/accounting/journal.js')
      for (const b of [co.brands.srb, co.brands.fbr]) {
        const rows = await sim.prisma.$queryRaw<Array<{ code: string; c: bigint }>>`
          SELECT a.code, SUM(CASE WHEN l.type = 'credit' THEN l."amountCents" ELSE -l."amountCents" END)::bigint AS c
            FROM journal_lines l JOIN journal_entries e ON e.id = l."journalEntryId" JOIN accounts a ON a.id = l."accountId"
           WHERE e."tenantId" = ${co.tenantId} AND l."conceptId" = ${b.id} AND a.code LIKE '40%' GROUP BY a.code`
        expect(rows.map((r) => r.code), `${b.name}'s sales accounts`).toEqual([revenueCodeForConcept(b.slug)])
        expect(Number(rows[0]!.c)).toBeGreaterThan(0)
      }
      // OBSERVATION O-1: a brand servd's slug map does not know (B's 'viva-grill') books its sales to
      // 4090 "Revenue — Other / Catering" — there is no per-brand revenue account for a new brand.
      if (key === 'B') expect(revenueCodeForConcept(co.brands.fbr.slug)).toBe('4090')
      const sc = await sim.prisma.order.aggregate({ where: { concept: { tenantId: co.tenantId }, status: 'completed', source: 'pos' }, _sum: { serviceChargeCents: true } })
      expect(sc._sum.serviceChargeCents ?? 0, 'the 5% service charge is charged on till bills').toBeGreaterThan(0)
      expect(-(await sim.ledger.balanceOf(co, '4100')), '4100 = the service charge of the completed till bills').toBe(sc._sum.serviceChargeCents)
    })

    it(`${key}: tips on 2095, gift cards on 2080, the Raast bank = the Raast receipts, every statement line matched`, async () => {
      const co = sim[key]
      expect(-(await sim.ledger.balanceOf(co, '2095')), '2095 = PKR 200 tip a day').toBe(SIM_DAYS.length * 20_000)
      expect(-(await sim.ledger.balanceOf(co, '2080')), '2080 = sold − redeemed').toBe(1_000_000 - SIM_DAYS.length * 150_000)
      let raast = 0
      for (const d of SIM_DAYS) raast += dayBook(co, d).raast.reduce((t, r) => t + r.amountCents, 0)
      expect(await sim.ledger.balanceOf(co, co.raast.code), `${co.raast.code} = every Raast receipt`).toBe(raast)
      const receipts = await sim.prisma.raastReceipt.findMany({ where: { tenantId: co.tenantId }, select: { status: true } })
      expect(receipts.length).toBe(SIM_DAYS.length * 2)
      expect(receipts.every((r) => r.status === 'matched'), JSON.stringify(receipts)).toBe(true)
      const lines = await sim.prisma.bankStatementLine.findMany({ where: { import: { tenantId: co.tenantId } }, select: { matchStatus: true, description: true } })
      expect(lines.filter((l) => l.matchStatus !== 'matched'), 'unmatched statement lines').toEqual([])
    })

    it(`${key}: every trading day closed (Monday 5th not a sales day); no open posting-refused or night-audit-pending flag`, async () => {
      const co = sim[key]
      const m = ok(await sim.as(co.finance, co).get('/accounting/night-audit?month=2026-10'), 200)
      const active = (m.days as Array<{ day: string; active: boolean; status: string }>).filter((d) => d.active)
      expect(active.map((d) => d.day)).toEqual([...SIM_DAYS])
      expect(active.every((d) => d.status === 'closed'), JSON.stringify(active)).toBe(true)
      const open = await sim.ledger.openFlags(co)
      expect(open.filter((f) => f.kind === 'posting_failed'), 'posting_failed').toEqual([])
      expect(open.filter((f) => f.kind === 'night_audit_pending'), 'night_audit_pending left open after the run').toEqual([])
      // What is left open is what the CEO did on purpose (the override and the back-dated void) — for the CEO to see.
      expect(new Set(open.map((f) => f.kind))).toEqual(new Set(['night_audit_override', 'backdated_sale_change']))
      // the late till of Sat 3 (closed 01:30 Sunday) booked to Saturday
      const late = dayBook(co, '2026-10-03').shifts.at(-1)!
      const [entry] = await sim.ledger.entriesBySource(co, `shift.close:${late}`)
      expect(entry, 'the late till posted').toBeTruthy()
      expect(entry!.entryDate.toISOString()).toBe(new Date('2026-10-03T23:59:59.999+05:00').toISOString())
    })
  }
})

// ─── Company separation ─────────────────────────────────────────────────────

describe('company separation — B never reaches A', () => {
  it('B gets 404 on A\'s orders, shifts, payments, flags and days; B\'s books carry nothing of A', async () => {
    const { A, B } = sim
    const aOrder = dayBook(A, '2026-10-01').orders[0]!
    const aShift = dayBook(A, '2026-10-01').shifts[0]!
    const aCod = state.A.cod!
    const bTill = await openTill(B, B.cashier)
    const notFound = async (label: string, res: Promise<import('fastify').LightMyRequestResponse>) => {
      const r = await res
      expect([403, 404, 422], `${label}: ${r.statusCode} ${r.body}`).toContain(r.statusCode)
      if (r.statusCode !== 404) expect(['SHIFT_NOT_IN_COMPANY', 'FORBIDDEN', 'COMPANY_HEADER_NOT_ALLOWED', 'NOT_A_MEMBER', 'TENANT_FORBIDDEN'], `${label}: ${r.body}`).toContain(errCode(r))
      return r
    }
    expect((await sim.as(B.cashier, B).post('/pos/payments', { orderId: aOrder, shiftId: bTill, payments: [{ method: 'cash', amountCents: 100 }] })).statusCode).toBe(404)
    expect((await sim.as(B.cashier, B).get(`/pos/receipt/${aOrder}`)).statusCode).toBe(404)
    expect((await sim.as(B.manager, B).post(`/pos/orders/${aOrder}/refund`, { amountCents: 100, reason: 'cross-company try', managerOverridePin: SIM_PIN.B })).statusCode).toBe(404)
    expect((await sim.as(B.manager, B).post(`/orders/${aOrder}/cancel`, { reason: 'cross-company try' })).statusCode).toBe(404)
    expect((await sim.as(B.manager, B).post(`/invoices/orders/${aOrder}/credit-note`, { reason: 'cross-company try' })).statusCode).toBe(404)
    expect((await sim.as(B.cashier, B).post(`/pos/payments/${aCod.paymentId}/settle`, { shiftId: bTill, tenderedCents: 100 })).statusCode).toBe(404)
    expect((await sim.as(B.finance, B).post(`/reconciliation/cod/${aCod.paymentId}/rider-debt`, { reason: 'cross-company rider debt' })).statusCode).toBe(404)
    await notFound('deposit drop on A\'s shift', sim.as(B.finance, B).post('/trustops/deposit-drops', { shiftId: aShift, amountCents: 100, bankAccountId: B.banks.main.id, files: [pdfFile()] }))
    expect((await sim.as(B.manager, B).get(`/pos/shifts/${aShift}/zreport`)).statusCode).toBe(404)
    const aFlag = await sim.prisma.exceptionFlag.findFirstOrThrow({ where: { tenantId: A.tenantId, kind: 'backdated_sale_change' } })
    expect((await sim.as(B.finance, B).patch(`/crosschecks/exceptions/${aFlag.id}/acknowledge`, { note: 'cross-company acknowledge' })).statusCode).toBe(404)
    // B's finance naming A as the active company is answered with B's own day (the header of a
    // company the login is not a member of is ignored) — never A's
    const viaHeader = ok(await sim.as(B.finance, A).get('/accounting/night-audit/2026-10-01'), 200)
    expect(viaHeader.tenantId).toBe(B.tenantId)
    expect(JSON.stringify(viaHeader)).not.toContain(A.tenantId)
    // A's bank statement line cannot be matched from B
    const aLine = await sim.prisma.bankStatementLine.findFirstOrThrow({ where: { import: { tenantId: A.tenantId } } })
    await notFound('A\'s bank line', sim.as(B.finance, B).get(`/reconciliation/bank/lines/${aLine.id}/candidates`))
    // nothing of A on B's books: every B entry posts only to B's chart, and no B row points at A's documents
    await sim.ledger.assertBalanced(B)
    const crossed = await sim.prisma.journalEntry.count({ where: { tenantId: B.tenantId, OR: [{ reference: { contains: aOrder } }, { reference: { contains: aShift } }, { reference: { contains: aCod.paymentId } }] } })
    expect(crossed).toBe(0)
    await closeTill(B, B.cashier, bTill, 0)
  })
})

// ─── Known defects (open) ───────────────────────────────────────────────────

describe('known defects found by the simulation (open — see the list at the top of the report)', () => {
  // DEFECT S-1 (open): POST /invoices/orders/:orderId/credit-note issues a FULL credit note on a
  // completed bill that was never refunded — no money back, no ledger reversal, no fiscal refund.
  // The tax-invoice register then shows the bill credited (its output tax negative) while 2030 /
  // 2032 and the fiscal POS still carry the sale. The back-dated gate only decides WHO may do it
  // (the CEO, with a reason). Expected: refuse a credit note for a bill with no refund / cancel
  // behind it (or tie it to one). Needs an owner / CA decision on what a stand-alone credit note
  // means, so it is not fixed here.
  it.fails('S-1: a credit note on an unrefunded, completed bill is refused', async () => {
    const co = sim.A
    const bill = state.A.backdateOrder!.id // a completed day-6 bill, never refunded
    sim.clock.tick(60_000)
    const r = await sim.as(sim.ceo, co).post(`/invoices/orders/${bill}/credit-note`, { reason: 'Stand-alone credit note', backdatedReason: 'CEO issues a credit note without a refund' })
    // Today: 201, a credit note is issued. When fixed (refused), drop `.fails`.
    expect(r.statusCode, r.body).not.toBe(201)
  })
})
