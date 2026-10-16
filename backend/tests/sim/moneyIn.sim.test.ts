// The simulated month — MONEY IN (finance readiness plan §4a item 7, and the
// money-in accounts of "Ledger results to check"). Its own world on the shared
// harness (tests/sim/harness.ts — its header is the API); everything goes
// through the real API as the people who do it, except the two nightly sweeps
// (gift-card expiry, loyalty expiry), whose worker bodies are called directly.
//
//   receivables (A, finance)  INV-1 to a corporate client for the SRB brand
//               (PKR 100,000 + 13,000 SRB): a card receipt is refused (H50);
//               a receipt without a reference is refused; part-payments by
//               bank transfer, cash and bank deposit, each with its reference;
//               the client withholds income tax (1330) and sales tax (1335);
//               a credit note; a cheque that bounces (reversed). INV-2 (FBR
//               brand, no tax): finance requests a bad-debt write-off with
//               evidence, the CEO approves (finance cannot), then part of it
//               is recovered by cheque.
//   gift cards (A)  finance sells GC-1 (bank transfer, ref), the CEO gives a
//               promotional card (finance and the F&B manager — no gift_cards
//               module — cannot), finance cannot void a live
//               card; GC-1 pays a storefront order (online redeem); a second
//               order is placed on it; both cards pass their expiry → the
//               nightly sweep books breakage (sold → 4200, promotional → 6060);
//               the open order is cancelled → its value comes back onto the
//               EXPIRED card → finance settles it as a refund by bank transfer.
//   wallets     finance records a PAID top-up (bank deposit, ref) — goodwill is
//               refused to finance, a card tender is refused; the customer
//               pays storefront orders with the wallet (A and B; one of B's is
//               still in the kitchen at midnight on the 31st).
//   loyalty (A) points earned on a pickup paid in cash at the counter (30 Sept,
//               then October; a wallet- or card-paid bill earns none — MI-2),
//               redeemed at checkout, a redemption given back by a cancel, the
//               point value doubled on 15 Oct by the CEO (H48: today's value),
//               points older than the expiry setting expired by the nightly
//               sweep — first in, first out (MI-3, fixed here).
//   inter-company  the CEO submits a charge A → B (PKR 25,000 accounting fees)
//               and approves it; B settles it by bank transfer with a
//               reference; a rider of A carries B's wallet-paid delivery under
//               a FleetAgreement at PKR 150 a trip, charged after month end.
// Month end (per company): every entry balanced and the TB balances; 1110 =
// open invoices; 2050 = wallet balances; 2060 = outstanding points × today's
// value; 2080 zero difference (gift-card books check); A's Due from B = B's
// Due to A; B gets 404 on A's invoices, write-offs, cards and wallets.
//
// Defects: MI-3 FIXED in this change (workers/loyaltyExpiration.ts expired points
// already spent — FIFO now; the 31 Oct step is its regression). Open, at the
// end of the file (it.fails): MI-1 (no revaluation of 2060 when the point value
// changes), MI-4 (wallet tie-out ignores wallet spent on open orders).
// Observation MI-2 (owner decision): wallet / gift-card paid bills earn no points.
// Runtime ≈ 30 s. Requires a disposable database ("test" in DATABASE_URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  startSim, ok, errCode, pdfFile,
  type Sim, type SimCompany, type SimBrand,
} from './harness.js'

let sim: Sim
let seq = 0
const ref = (p: string) => `${p}-${String(1000 + ++seq)}`

const evidence = () => { const f = pdfFile('collection-letter.pdf'); return { fileName: f.fileName, mime: f.mime, data: f.dataBase64 } }

// ─── What the simulation expects (built as it goes) ─────────────────────────
const st: {
  custA?: string; custB?: string
  inv1?: string; inv2?: string; chequePaymentId?: string; writeOffId?: string
  gc1?: { id: string; code: string }; promo?: { id: string; code: string }; gcOrderOpen?: string
  loyaltyOrders: string[]; redeemCancelOrder?: string
  icCharge?: string; icSettle?: string; fleetOrder?: string; agreementId?: string; openWalletOrderB?: string
} = { loyaltyOrders: [] }

beforeAll(async () => { sim = await startSim() }, 180_000)
afterAll(async () => { await sim?.close() })

// ─── Storefront helpers ─────────────────────────────────────────────────────

async function storefrontOrder(customerId: string, brand: SimBrand, opts: {
  type?: 'pickup' | 'delivery'; gateway?: 'cash' | 'wallet'; giftCardCode?: string; points?: number; qty?: number
} = {}) {
  const r = ok(await sim.asCustomer(customerId).post('/storefront/orders', {
    conceptSlug: brand.slug, type: opts.type ?? 'pickup',
    ...(opts.type === 'delivery' && { deliveryAddress: 'House 12, Block 4, Clifton', deliveryLat: 24.8150, deliveryLng: 67.0350 }),
    items: [{ menuItemId: brand.items.main.id, quantity: opts.qty ?? 1 }, { menuItemId: brand.items.drink.id, quantity: 1 }],
    paymentGateway: opts.gateway ?? 'cash',
    ...(opts.giftCardCode && { giftCardCode: opts.giftCardCode }),
    ...(opts.points && { loyaltyPointsToRedeem: opts.points }),
  }), [200, 201])
  return r as { id: string; totalCents: number; giftCardAppliedCents: number; giftCardError: unknown; walletAmountCents: number; loyaltyPointsRedeemed: number; loyaltyDiscountCents: number }
}

/** A pickup ordered online: the kitchen makes it, expo hands it over (completion). */
async function handOver(co: SimCompany, orderId: string) {
  const mgr = sim.as(co.manager, co)
  for (const status of ['preparing', 'ready', 'completed']) ok(await mgr.patch(`/orders/${orderId}/status`, { status }), 200)
  await sim.settle()
}

/** The customer pays a pickup's cash at the counter: a till is opened, the payment settled, the till counted and closed. */
async function payAtCounter(co: SimCompany, orderId: string) {
  const p = await sim.prisma.payment.findFirstOrThrow({ where: { orderId, status: 'pending', method: 'cash' } })
  const c = sim.as(co.cashier, co)
  const shift = ok(await c.post('/pos/shifts/open', { openingFloatCents: 500_000 }), 201)
  ok(await c.post(`/pos/payments/${p.id}/settle`, { shiftId: shift.id, tenderedCents: p.amountCents }), [200, 201])
  const z = ok(await sim.as(co.manager, co).get(`/pos/shifts/${shift.id}/zreport`), 200)
  const expected = (z.expectedCashCents ?? z.expectedCents ?? z.drawer?.expectedCents ?? z.cash?.expectedCents) as number
  ok(await c.post(`/pos/shifts/${shift.id}/close`, { closingFloatCents: expected }), 200)
  await sim.settle()
}

const pending = async (orderId: string) =>
  (await sim.prisma.payment.aggregate({ where: { orderId, status: 'pending' }, _sum: { amountCents: true } }))._sum.amountCents ?? 0

// Becomes a customer of the company (an order at one of its brands), then the order is cancelled.
async function becomeCustomer(co: SimCompany, name: string, phone: string) {
  const id = await sim.mkCustomer(name, phone)
  const o = await storefrontOrder(id, co.brands.srb)
  ok(await sim.as(co.manager, co).post(`/orders/${o.id}/cancel`, { reason: 'Customer changed their mind' }), 200)
  return id
}

// ─── 30 September: customers, wallets, the first points ────────────────────

describe('money in — the simulated month', () => {
  it('30 Sept: finance records PAID wallet top-ups (goodwill and card refused); the customer pays with the wallet and earns points', async () => {
    const { A, B } = sim
    sim.clock.at('2026-09-30', '11:00')
    st.custA = await becomeCustomer(A, 'Sana Money-In', '923331230001')
    st.custB = await becomeCustomer(B, 'Bilal Money-In', '923331230002')
    const finA = sim.as(A.finance, A)

    // goodwill is a manager's call
    const gw = await finA.post('/wallet/topup', { customerId: st.custA, amountCents: 100_000, kind: 'goodwill' })
    expect(gw.statusCode, gw.body).toBe(403)
    expect(errCode(gw)).toBe('GOODWILL_MANAGERS_ONLY')
    // a card is never a back-office receipt (H50)
    const card = await finA.post('/wallet/topup', { customerId: st.custA, amountCents: 100_000, kind: 'paid', tender: 'card', paymentRef: ref('CARD') })
    expect([400, 422], card.body).toContain(card.statusCode)
    // the reference is required
    const noRef = await finA.post('/wallet/topup', { customerId: st.custA, amountCents: 100_000, kind: 'paid', tender: 'cash' })
    expect(noRef.statusCode, noRef.body).toBe(422)
    expect(errCode(noRef)).toBe('PAYMENT_REFERENCE_REQUIRED')
    // two banks and none named → which one?
    const which = await finA.post('/wallet/topup', { customerId: st.custA, amountCents: 100_000, kind: 'paid', tender: 'bank_deposit', paymentRef: ref('DEP') })
    expect(which.statusCode, which.body).toBe(422)
    expect(errCode(which)).toBe('BANK_ACCOUNT_REQUIRED')
    const t = ok(await finA.post('/wallet/topup', { customerId: st.custA, amountCents: 1_000_000, kind: 'paid', tender: 'bank_deposit', paymentRef: ref('DEP'), bankAccountId: A.banks.main.id }), 201)
    expect(t.newBalance).toBe(1_000_000)
    // B's customer: cash into B's safe
    ok(await sim.as(B.finance, B).post('/wallet/topup', { customerId: st.custB, amountCents: 500_000, kind: 'paid', tender: 'cash', paymentRef: ref('CSH') }), 201)
    // A's finance cannot credit B's customer (never ordered at A)
    expect((await finA.post('/wallet/topup', { customerId: st.custB, amountCents: 100_000, kind: 'paid', tender: 'cash', paymentRef: ref('CSH') })).statusCode).toBe(404)

    // The money is where it was received: Dr the bank / 1010, Cr 2050.
    expect(await sim.ledger.balanceOf(A, A.banks.main.code)).toBe(1_000_000)
    expect(-(await sim.ledger.balanceOf(A, '2050'))).toBe(1_000_000)
    expect(await sim.ledger.balanceOf(B, '1010')).toBe(500_000)
    expect(-(await sim.ledger.balanceOf(B, '2050'))).toBe(500_000)

    // A wallet-paid pickup (the wallet as the method), completed the same day.
    sim.clock.at('2026-09-30', '12:00')
    const o = await storefrontOrder(st.custA!, A.brands.srb, { gateway: 'wallet' })
    expect(o.walletAmountCents).toBeGreaterThan(0)
    expect(await pending(o.id), 'a wallet-paid order owes nothing').toBe(0)
    await handOver(A, o.id)
    expect(-(await sim.ledger.balanceOf(A, '2050')), '2050 down by the wallet spend at the sale').toBe(1_000_000 - o.walletAmountCents)
    // OBSERVATION MI-2 (owner decision): a bill paid from the wallet (or a gift card) earns no
    // points — Order.totalCents is stored net of the wallet / card share and the earn reads it
    // (loyalty/service.ts awardOrderPoints). Paid top-ups are customer money.
    expect(await sim.prisma.loyaltyTransaction.count({ where: { orderId: o.id, type: 'earn' } })).toBe(0)

    // A pickup paid in cash at the counter earns points (1 a rupee), on 30 Sept.
    sim.clock.at('2026-09-30', '13:00')
    const c = await storefrontOrder(st.custA!, A.brands.srb, { qty: 2 })
    await payAtCounter(A, c.id)
    await handOver(A, c.id)
    st.loyaltyOrders.push(c.id)
    const earn = await sim.prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: c.id, type: 'earn' } })
    const total = (await sim.prisma.order.findUniqueOrThrow({ where: { id: c.id } })).totalCents
    expect(earn.pointsDelta).toBe(Math.floor(total / 100))
    const [je] = await sim.ledger.entriesBySource(A, `loyalty.earn:${earn.id}`)
    expect(je!.lines.map((l) => `${l.code} ${l.type} ${l.cents}`).sort(), 'earn: Dr 6060 / Cr 2060 at PKR 0.10').toEqual([`2060 credit ${earn.pointsDelta * 10}`, `6060 debit ${earn.pointsDelta * 10}`])
  })

  it('2–3 Oct: INV-1 raised; gift cards sold by finance (card refused), a promotional card by a manager; GC-1 redeemed online', async () => {
    const { A } = sim
    const fin = sim.as(A.finance, A)
    sim.clock.at('2026-10-02', '10:00')
    const inv = ok(await fin.post('/accounting/receivables', {
      customerName: 'Karachi Events (Pvt) Ltd', customerNtn: '1234567-8', conceptId: A.brands.srb.id,
      issueDate: '2026-10-02', dueDate: '2026-11-01', description: 'Catering — corporate lunch, 200 covers',
      amountCents: 10_000_000, taxCents: 1_300_000, revenueAccountCode: '4090',
    }), 201)
    st.inv1 = inv.id
    const [issue] = await sim.ledger.entriesBySource(A, `receivable.issue:${inv.id}`)
    expect(issue!.lines.map((l) => `${l.code} ${l.type} ${l.cents}`).sort()).toEqual(['1110 debit 11300000', '2032 credit 1300000', '4090 credit 10000000'])

    sim.clock.at('2026-10-02', '15:00')
    const expiresAt = new Date('2026-10-20T23:00:00+05:00').toISOString()
    const card = await fin.post('/gift-cards', { kind: 'sold', issuedAmountCents: 500_000, paymentMethod: 'card', paymentRef: ref('CRD'), expiresAt })
    expect([400, 422], card.body).toContain(card.statusCode)
    const noRef = await fin.post('/gift-cards', { kind: 'sold', issuedAmountCents: 500_000, paymentMethod: 'cash', expiresAt })
    expect(errCode(noRef), noRef.body).toBe('PAYMENT_REFERENCE_REQUIRED')
    const gc = ok(await fin.post('/gift-cards', { kind: 'sold', issuedAmountCents: 500_000, paymentMethod: 'bank_transfer', bankAccountId: A.banks.main.id, paymentRef: ref('IBFT'), expiresAt, recipientName: 'Sana' }), 201)
    st.gc1 = { id: gc.id, code: (await sim.prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })).code }
    const [gi] = await sim.ledger.entriesBySource(A, `giftcard.issue:${gc.id}`)
    expect(gi!.lines.map((l) => `${l.code} ${l.type} ${l.cents}`).sort()).toEqual([`${A.banks.main.code} debit 500000`, '2080 credit 500000'])
    // finance cannot give a promotional card; a manager can (Dr 6060)
    expect((await fin.post('/gift-cards', { kind: 'promotional', issuedAmountCents: 100_000, reason: 'Influencer visit', expiresAt })).statusCode).toBe(403)
    // fnb_manager holds no gift_cards module (Finance workspace): the CEO gives it
    expect((await sim.as(A.manager, A).post('/gift-cards', { kind: 'promotional', issuedAmountCents: 100_000, reason: 'Influencer visit', expiresAt })).statusCode).toBe(403)
    const promo = ok(await sim.as(sim.ceo, A).post('/gift-cards', { kind: 'promotional', issuedAmountCents: 100_000, reason: 'Influencer visit', expiresAt }), 201)
    st.promo = { id: promo.id, code: promo.code }
    const [pi] = await sim.ledger.entriesBySource(A, `giftcard.issue:${promo.id}`)
    expect(pi!.lines.map((l) => `${l.code} ${l.type} ${l.cents}`).sort()).toEqual(['2080 credit 100000', '6060 debit 100000'])
    // finance never voids a live card
    const v = await fin.post(`/gift-cards/${gc.id}/void`, { reason: 'Customer asked', disposition: 'refund', refundMethod: 'bank_transfer', bankAccountId: A.banks.main.id })
    expect(v.statusCode, v.body).toBe(403)
    expect(errCode(v)).toBe('VOID_NEEDS_MANAGER')

    // GC-1 pays a pickup online, in full
    sim.clock.at('2026-10-03', '13:00')
    const o = await storefrontOrder(st.custA!, A.brands.srb, { giftCardCode: st.gc1.code })
    expect(o.giftCardError).toBeNull()
    expect(o.giftCardAppliedCents).toBeGreaterThan(0)
    expect(await pending(o.id), 'the card covered the bill').toBe(0)
    await handOver(A, o.id)
    const after = await sim.prisma.giftCard.findUniqueOrThrow({ where: { id: gc.id } })
    expect(after.balanceCents).toBe(500_000 - o.giftCardAppliedCents)
    expect(-(await sim.ledger.balanceOf(A, '2080')), '2080 = sold + promo − redeemed').toBe(600_000 - o.giftCardAppliedCents)
  })

  it('5–12 Oct: INV-1 — card refused, receipts with references, income tax + sales tax withheld, a credit note; loyalty redeemed at checkout; a cheque', async () => {
    const { A } = sim
    const fin = sim.as(A.finance, A)
    const inv = { id: st.inv1! }
    sim.clock.at('2026-10-05', '11:00')
    const card = await fin.post(`/accounting/receivables/${inv.id}/payments`, { amountCents: 100_000, receivedAt: '2026-10-05', method: 'card', reference: ref('CRD') })
    expect([400, 422], card.body).toContain(card.statusCode)
    const noRef = await fin.post(`/accounting/receivables/${inv.id}/payments`, { amountCents: 100_000, receivedAt: '2026-10-05', method: 'cash' })
    expect(noRef.statusCode, noRef.body).toBe(422)
    expect(errCode(noRef)).toBe('PAYMENT_REFERENCE_REQUIRED')
    const which = await fin.post(`/accounting/receivables/${inv.id}/payments`, { amountCents: 100_000, receivedAt: '2026-10-05', method: 'bank_transfer', reference: ref('IBFT') })
    expect(errCode(which), which.body).toBe('BANK_ACCOUNT_REQUIRED')
    ok(await fin.post(`/accounting/receivables/${inv.id}/payments`, { amountCents: 5_000_000, receivedAt: '2026-10-05', method: 'bank_transfer', bankAccountId: A.banks.main.id, reference: ref('IBFT') }), 201)
    ok(await fin.post(`/accounting/receivables/${inv.id}/payments`, { amountCents: 100_000, receivedAt: '2026-10-05', method: 'cash', reference: ref('CRV') }), 201)
    ok(await fin.post(`/accounting/receivables/${inv.id}/payments`, { amountCents: 200_000, receivedAt: '2026-10-06', method: 'bank_deposit', bankAccountId: A.banks.second.id, reference: ref('DSLIP') }), 201)
    const over = await fin.post(`/accounting/receivables/${inv.id}/payments`, { amountCents: 9_000_000, receivedAt: '2026-10-06', method: 'cash', reference: ref('CRV') })
    expect(errCode(over), over.body).toBe('OVERPAYMENT')

    // income tax withheld (s.153) → 1330; sales tax withheld (H13) → 1335 for SRB
    sim.clock.at('2026-10-08', '11:00')
    ok(await fin.post(`/accounting/receivables/${inv.id}/withholding`, { kind: 'income_tax', amountCents: 400_000, certificateNo: 'WHT-153-001', date: '2026-10-08' }), 201)
    ok(await fin.post(`/accounting/receivables/${inv.id}/withholding`, { kind: 'sales_tax', amountCents: 260_000, certificateNo: 'STW-001', date: '2026-10-08' }), 201)
    const stw = await sim.prisma.receivablePayment.findFirstOrThrow({ where: { invoiceId: inv.id, method: 'st_withheld' } })
    expect(stw.taxAuthority).toBe('srb')

    // a credit note: ten covers short, with its tax
    sim.clock.at('2026-10-10', '11:00')
    ok(await fin.post(`/accounting/receivables/${inv.id}/credit-notes`, { amountCents: 500_000, taxCents: 65_000, reason: 'Ten covers short at the event', date: '2026-10-10' }), 201)

    // loyalty: 100 points redeemed at checkout (PKR 0.10 a point)
    sim.clock.at('2026-10-10', '13:00')
    const o = await storefrontOrder(st.custA!, A.brands.srb, { points: 100 })
    expect(o.loyaltyPointsRedeemed).toBe(100)
    expect(o.loyaltyDiscountCents, '100 points at PKR 0.10').toBe(1_000)
    await payAtCounter(A, o.id)
    await handOver(A, o.id)
    st.loyaltyOrders.push(o.id)
    const redeem = await sim.ledger.entriesBySource(A, 'loyalty.redeem:')
    expect(redeem.length).toBe(1)
    expect(redeem[0]!.lines.find((l) => l.code === '2060')!.cents).toBe(1_000)

    // a cheque
    sim.clock.at('2026-10-12', '11:00')
    ok(await fin.post(`/accounting/receivables/${inv.id}/payments`, { amountCents: 2_000_000, receivedAt: '2026-10-12', method: 'cheque', bankAccountId: A.banks.main.id, reference: ref('CHQ') }), 201)
    st.chequePaymentId = (await sim.prisma.receivablePayment.findFirstOrThrow({ where: { invoiceId: inv.id, method: 'cheque' } })).id
  })

  it('15–16 Oct: the point value changed (H48); the cheque bounces; INV-2 raised; a redemption reversed by a cancel', async () => {
    const { A } = sim
    const fin = sim.as(A.finance, A)
    sim.clock.at('2026-10-15', '09:00')
    ok(await sim.as(sim.ceo, A).patch('/loyalty/settings', { 'loyalty.point_value_cents': 20 }), 200)

    sim.clock.at('2026-10-15', '11:00')
    ok(await fin.post(`/accounting/receivables/${st.inv1}/payments/${st.chequePaymentId}/reverse`, { reason: 'Cheque returned unpaid — insufficient funds', date: '2026-10-15' }), 200)
    const row = await sim.prisma.receivableInvoice.findUniqueOrThrow({ where: { id: st.inv1 } })
    const { balanceOf } = await import('../../src/modules/receivables/ledger.js')
    // 113,000 − 53,000 received − 4,000 − 2,600 withheld − 5,650 credited (the cheque bounced) = 47,750
    expect(balanceOf(row)).toBe(4_775_000)
    expect(row.status).toBe('partial')
    expect(await sim.ledger.balanceOf(A, '1330')).toBe(400_000)
    expect(await sim.ledger.balanceOf(A, '1335')).toBe(260_000)
    const ar2032 = (await sim.ledger.entriesBySource(A, 'receivable.')).flatMap((e) => e.lines).filter((l) => l.code === '2032')
      .reduce((t, l) => t + (l.type === 'credit' ? l.cents : -l.cents), 0)
    expect(ar2032, '2032 from receivables = invoiced SRB tax − credited (withholding goes to 1335, not 2032)').toBe(1_300_000 - 65_000)

    sim.clock.at('2026-10-16', '10:00')
    const inv2 = ok(await fin.post('/accounting/receivables', {
      customerName: 'Defunct Traders', conceptId: A.brands.fbr.id,
      issueDate: '2026-10-01', dueDate: '2026-10-08', description: 'Platters for a launch', amountCents: 3_000_000, revenueAccountCode: '4090',
    }), 201)
    st.inv2 = inv2.id

    // 100 points redeemed at today's value (PKR 0.20), then the order is cancelled — the points come back
    sim.clock.at('2026-10-16', '13:00')
    const mid = (await sim.prisma.loyaltyAccount.findFirstOrThrow({ where: { customerId: st.custA, tenantId: A.tenantId } })).pointsBalance
    const o2 = await storefrontOrder(st.custA!, A.brands.srb, { points: 100 })
    expect(o2.loyaltyDiscountCents, '100 points at today\'s value PKR 0.20').toBe(2_000)
    await sim.settle()
    ok(await sim.as(A.manager, A).post(`/orders/${o2.id}/cancel`, { reason: 'Kitchen could not make it' }), 200)
    await sim.settle()
    st.redeemCancelOrder = o2.id
    const back = (await sim.prisma.loyaltyAccount.findFirstOrThrow({ where: { customerId: st.custA, tenantId: A.tenantId } })).pointsBalance
    expect(back, 'the redeemed points are given back').toBe(mid)
    const r2 = await sim.ledger.entriesBySource(A, 'loyalty.redeem')
    const net2060 = r2.flatMap((e) => e.lines).filter((l) => l.code === '2060').reduce((t, l) => t + (l.type === 'debit' ? l.cents : -l.cents), 0)
    expect(net2060, 'only the 10 Oct redemption is still discharged').toBe(1_000)
  })

  it('19–22 Oct: an open order on GC-1; a bad debt requested and approved by the CEO; both cards expire (4200 / 6060); the order is cancelled, finance settles the expired card', async () => {
    const { A } = sim
    const fin = sim.as(A.finance, A)
    sim.clock.at('2026-10-19', '13:00')
    const card0 = await sim.prisma.giftCard.findUniqueOrThrow({ where: { id: st.gc1!.id } })
    const o = await storefrontOrder(st.custA!, A.brands.fbr, { giftCardCode: st.gc1!.code })
    expect(o.giftCardAppliedCents).toBeGreaterThan(0)
    expect(o.giftCardAppliedCents, 'the order leaves value on the card').toBeLessThan(card0.balanceCents)
    st.gcOrderOpen = o.id
    const left = card0.balanceCents - o.giftCardAppliedCents

    // 20 Oct: finance asks for INV-2 to be written off
    sim.clock.at('2026-10-20', '10:00')
    const noEv = await fin.post('/accounting/receivables/write-offs', { invoiceId: st.inv2, amountCents: 3_000_000, reason: 'Client closed down, no assets' })
    expect(noEv.statusCode).toBe(400)
    const w = ok(await fin.post('/accounting/receivables/write-offs', { invoiceId: st.inv2, amountCents: 3_000_000, reason: 'Client closed down, no assets — collection agency note attached', evidence: [evidence()] }), 201)
    st.writeOffId = w.id
    expect(w.status).toBe('requested')
    expect((await sim.ledger.entriesBySource(A, 'receivable.write_off:')).length, 'nothing books before the CEO').toBe(0)
    expect((await fin.post(`/accounting/receivables/write-offs/${w.id}/approve`, {})).statusCode, 'finance cannot approve').toBe(403)

    // 21 Oct 00:10 — the nightly gift-card expiry sweep (workers/giftCardExpiry.ts body)
    sim.clock.at('2026-10-21', '00:10')
    const { expireDueGiftCards } = await import('../../src/modules/giftCards/books.js')
    await expireDueGiftCards(A.tenantId, new Date())
    const exp = await sim.prisma.giftCard.findUniqueOrThrow({ where: { id: st.gc1!.id } })
    expect(exp.status).toBe('expired')
    expect(exp.breakageCents, 'breakage = what the card held at expiry').toBe(left)
    expect(-(await sim.ledger.balanceOf(A, '4200')), 'sold card breakage → 4200').toBe(left)
    const promo = await sim.prisma.giftCard.findUniqueOrThrow({ where: { id: st.promo!.id } })
    expect(promo.status).toBe('expired')
    expect(promo.breakageCents).toBe(100_000)
    const [pe] = await sim.ledger.entriesBySource(A, `giftcard.expire:${st.promo!.id}`)
    expect(pe!.lines.find((l) => l.type === 'credit')!.code, 'promotional value back to 6060').toBe('6060')

    sim.clock.at('2026-10-21', '09:00')
    ok(await sim.as(sim.ceo, A).post(`/accounting/receivables/write-offs/${w.id}/approve`, { note: 'Agreed — agency confirms closure' }), 200)
    expect(await sim.ledger.balanceOf(A, '6160')).toBe(3_000_000)

    // 22 Oct — the open order is cancelled: its value comes back onto the EXPIRED card
    sim.clock.at('2026-10-22', '11:00')
    ok(await sim.as(A.manager, A).post(`/orders/${o.id}/cancel`, { reason: 'Customer never collected' }), 200)
    await sim.settle()
    const held = await sim.prisma.giftCard.findUniqueOrThrow({ where: { id: st.gc1!.id } })
    expect(held.status).toBe('expired')
    expect(held.balanceCents).toBe(o.giftCardAppliedCents)
    const check = ok(await fin.get('/gift-cards/reconcile'), 200)
    const mine = (check.companies as Array<{ tenantId: string; expiredHoldingValue: { cents: number } }>).find((c) => c.tenantId === A.tenantId)!
    expect(mine.expiredHoldingValue.cents).toBe(o.giftCardAppliedCents)
    // keeping a sold card's money is the CEO's (H11); finance refunds it to the customer's bank
    expect(errCode(await fin.post(`/gift-cards/${held.id}/void`, { reason: 'Keep it', disposition: 'forfeit' }))).toBe('FORFEIT_NEEDS_CEO')
    const bankBefore = await sim.ledger.balanceOf(A, A.banks.main.code)
    const s = ok(await fin.post(`/gift-cards/${held.id}/void`, { reason: 'Refund the value of the cancelled order to Sana', disposition: 'refund', refundMethod: 'bank_transfer', bankAccountId: A.banks.main.id }), 200)
    expect(s.postedCents).toBe(o.giftCardAppliedCents)
    expect(await sim.ledger.balanceOf(A, A.banks.main.code)).toBe(bankBefore - o.giftCardAppliedCents)
    const again = await fin.post(`/gift-cards/${held.id}/void`, { reason: 'again please', disposition: 'refund', refundMethod: 'bank_transfer', bankAccountId: A.banks.main.id })
    expect(errCode(again), again.body).toMatch(/GIFTCARD_ALREADY_VOIDED|NOTHING_TO_SETTLE/)
  })

  it('23–28 Oct: a charge from A to B approved by the CEO; a bad-debt recovery by cheque; B settles part of the charge by bank transfer', async () => {
    const { A, B } = sim
    sim.clock.at('2026-10-23', '10:00')
    const charge = {
      kind: 'charge', debtorTenantId: B.tenantId, creditorTenantId: A.tenantId, amountCents: 2_500_000, entryDate: '2026-10-23',
      memo: 'Shared accounting fees, October', debtorAccountCode: '6110', creditorAccountCode: '6110',
    }
    // finance of A alone is not a member of B
    const solo = await sim.as(A.finance, A).post('/accounting/intercompany/transfers', charge)
    expect([403, 404, 422], solo.body).toContain(solo.statusCode)
    const ceo = sim.as(sim.ceo, A)
    const c = ok(await ceo.post('/accounting/intercompany/transfers', charge), 201)
    expect(c.status).toBe('submitted')
    st.icCharge = c.id
    ok(await ceo.post(`/accounting/intercompany/transfers/${c.id}/approve`, { note: 'Agreed split' }), 200)
    expect(-(await sim.ledger.balanceOf(A, '6110', '2026-10-31')), 'A recovers the cost').toBe(2_500_000)
    expect(await sim.ledger.balanceOf(B, '6110', '2026-10-31'), 'B bears it').toBe(2_500_000)

    // the written-off client pays PKR 10,000 after all
    sim.clock.at('2026-10-25', '12:00')
    const fin = sim.as(A.finance, A)
    const w = st.writeOffId!
    const noRef = await fin.post(`/accounting/receivables/write-offs/${w}/recover`, { amountCents: 1_000_000, receivedAt: '2026-10-25', method: 'cheque', bankAccountId: A.banks.main.id })
    expect(errCode(noRef), noRef.body).toBe('PAYMENT_REFERENCE_REQUIRED')
    const card = await fin.post(`/accounting/receivables/write-offs/${w}/recover`, { amountCents: 1_000_000, receivedAt: '2026-10-25', method: 'card', reference: ref('CRD') })
    expect([400, 422], card.body).toContain(card.statusCode)
    ok(await fin.post(`/accounting/receivables/write-offs/${w}/recover`, { amountCents: 1_000_000, receivedAt: '2026-10-25', method: 'cheque', bankAccountId: A.banks.main.id, reference: ref('CHQ') }), 201)
    expect(await sim.ledger.balanceOf(A, '6160'), 'bad debts net of the recovery').toBe(2_000_000)
    const { balanceOf } = await import('../../src/modules/receivables/ledger.js')
    expect(balanceOf(await sim.prisma.receivableInvoice.findUniqueOrThrow({ where: { id: st.inv2 } })), 'a written-off invoice owes nothing').toBe(0)

    sim.clock.at('2026-10-28', '10:00')
    const settle = {
      kind: 'settlement', debtorTenantId: B.tenantId, creditorTenantId: A.tenantId, amountCents: 1_500_000, entryDate: '2026-10-28',
      memo: 'Part settlement of October fees', method: 'bank_transfer', debtorBankAccountId: B.banks.main.id, creditorBankAccountId: A.banks.main.id,
    }
    expect(errCode(await ceo.post('/accounting/intercompany/transfers', settle))).toBe('PAYMENT_REFERENCE_REQUIRED')
    const over = await ceo.post('/accounting/intercompany/transfers', { ...settle, amountCents: 9_000_000, bankReference: ref('IBFT') })
    expect(errCode(over), over.body).toBe('SETTLEMENT_OVER_BALANCE')
    const s = ok(await ceo.post('/accounting/intercompany/transfers', { ...settle, bankReference: ref('IBFT') }), 201)
    st.icSettle = s.id
    ok(await ceo.post(`/accounting/intercompany/transfers/${s.id}/approve`, {}), 200)
  })

  it('29 Oct: a rider of A carries B\'s wallet-paid delivery under a fleet agreement (B: wallet payment on the storefront)', async () => {
    const { A, B } = sim
    sim.clock.at('2026-10-29', '12:00')
    const ag = ok(await sim.as(sim.ceo, A).put('/riders/fleet/agreements', { providerTenantId: A.tenantId, clientTenantId: B.tenantId, isActive: true }), 200)
    st.agreementId = (ag.id ?? ag.agreement?.id) as string
    expect(st.agreementId).toBeTruthy()
    ok(await sim.as(sim.ceo, A).put(`/accounting/intercompany/fleet/${st.agreementId}/rate`, { ratePerTripCents: 15_000, fromPeriod: '2026-10', note: 'PKR 150 a trip' }), 200)

    const o = await storefrontOrder(st.custB!, B.brands.srb, { type: 'delivery', gateway: 'wallet' })
    expect(o.walletAmountCents).toBeGreaterThan(0)
    expect(await pending(o.id)).toBe(0)
    st.fleetOrder = o.id
    const mgr = sim.as(B.manager, B)
    for (const status of ['preparing', 'ready']) ok(await mgr.patch(`/orders/${o.id}/status`, { status }), 200)
    // the shared fleet's dispatcher belongs to both companies (B's manager alone cannot see A's rider)
    expect((await mgr.post(`/dispatch/orders/${o.id}/assign`, { riderId: A.riderId })).statusCode).toBe(404)
    ok(await sim.as(sim.ceo, B).post(`/dispatch/orders/${o.id}/assign`, { riderId: A.riderId }), 200)
    const rider = sim.asRider(A.riderId)
    ok(await rider.post('/rider/shift', { online: true }), 200)
    for (const step of ['accept', 'picked-up', 'arrived']) ok(await rider.post(`/rider/jobs/${o.id}/${step}`, {}), 200)
    const { deliveryOtp } = await sim.prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { deliveryOtp: true } })
    ok(await rider.post(`/rider/jobs/${o.id}/deliver`, { otp: deliveryOtp }), 200)
    ok(await rider.post('/rider/shift', { online: false }), 200)
    await sim.settle()
    const done = await sim.prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(done.status).toBe('completed')
    const ev = await sim.prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'picked_up' } })
    expect([ev.tenantId, ev.riderTenantId]).toEqual([B.tenantId, A.tenantId])
  })

  it('31 Oct: loyalty points older than the expiry setting expire (the nightly sweep)', async () => {
    const { A } = sim
    sim.clock.at('2026-10-31', '13:00')
    ok(await sim.as(sim.ceo, A).patch('/loyalty/settings', { 'loyalty.expiry_months': 1 }), 200)
    const before = (await sim.prisma.loyaltyAccount.findFirstOrThrow({ where: { customerId: st.custA, tenantId: A.tenantId } })).pointsBalance
    const sepEarn = await sim.prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: st.loyaltyOrders[0], type: 'earn' } })
    const { runExpirationSweep } = await import('../../src/workers/loyaltyExpiration.js')
    await runExpirationSweep()
    const expired = await sim.prisma.loyaltyTransaction.findMany({ where: { type: 'expire', loyaltyAccount: { tenantId: A.tenantId } } })
    // FIFO: the 100 points redeemed on 10 Oct came out of the 30 Sept earn (the 16 Oct
    // redemption was given back), so 30 Sept's points less 100 expire — never newer points.
    expect(expired.map((e) => e.pointsDelta), '30 Sept points still unspent expire').toEqual([-(sepEarn.pointsDelta - 100)])
    const after = (await sim.prisma.loyaltyAccount.findFirstOrThrow({ where: { customerId: st.custA, tenantId: A.tenantId } })).pointsBalance
    expect(after).toBe(before - (sepEarn.pointsDelta - 100))
    const [je] = await sim.ledger.entriesBySource(A, `loyalty.expire:${expired[0]!.id}`)
    expect(je!.lines.find((l) => l.code === '2060')!.cents, 'the expiry is booked at today\'s value (PKR 0.20)').toBe((sepEarn.pointsDelta - 100) * 20)

    // 31 Oct 21:00 — B's customer orders a pickup with the wallet; it is still in the kitchen at midnight.
    sim.clock.at('2026-10-31', '21:00')
    const open = await storefrontOrder(st.custB!, sim.B.brands.srb, { gateway: 'wallet' })
    expect(open.walletAmountCents).toBeGreaterThan(0)
    st.openWalletOrderB = open.id
  })

  it('1 Nov: the CEO charges October\'s shared fleet — one trip at PKR 150 (B Dr 6035 / A Cr 6990)', async () => {
    const { A, B } = sim
    sim.clock.at('2026-11-01', '09:00')
    const r = ok(await sim.as(sim.ceo, A).post('/accounting/intercompany/fleet/charge', { month: '2026-10', agreementId: st.agreementId }), 200)
    expect(r.charged, JSON.stringify(r)).toBe(1)
    expect(r.results[0].trips).toBe(1)
    expect(r.results[0].amountCents).toBe(15_000)
    expect(await sim.ledger.balanceOf(B, '6035', '2026-10-31')).toBe(15_000)
    expect(-(await sim.ledger.balanceOf(A, '6990', '2026-10-31'))).toBe(15_000)
    // idempotent
    const again = ok(await sim.as(sim.ceo, A).post('/accounting/intercompany/fleet/charge', { month: '2026-10', agreementId: st.agreementId }), 200)
    expect(again.charged).toBe(0)
  })
})

// ─── Month end ──────────────────────────────────────────────────────────────

describe('month end — the money-in accounts tie', () => {
  for (const key of ['A', 'B'] as const) {
    it(`${key}: every entry balanced, the TB balances (one net figure per account, no zero rows)`, async () => {
      const co = sim[key]
      await sim.ledger.assertBalanced(co)
      const tb = await sim.ledger.trialBalance(co, '2026-10-31')
      expect(tb.debitCents).toBe(tb.creditCents)
      for (const r of tb.rows) {
        expect(Number(r.debitCents) === 0 || Number(r.creditCents) === 0, `${r.code} shows both columns`).toBe(true)
        expect(Number(r.debitCents) + Number(r.creditCents), `${r.code} is a zero row`).toBeGreaterThan(0)
      }
    })

    it(`${key}: 2050 wallets = the customers' wallet balances; 2080 gift cards: zero difference`, async () => {
      const co = sim[key]
      const w = await sim.prisma.customerWallet.aggregate({ where: { tenantId: co.tenantId }, _sum: { balanceCents: true } })
      // The wallet is taken at checkout; 2050 comes down when the sale is booked (completion).
      const inKitchen = await sim.prisma.order.aggregate({ where: { concept: { tenantId: co.tenantId }, status: { notIn: ['completed', 'cancelled'] }, walletAmountCents: { gt: 0 } }, _sum: { walletAmountCents: true } })
      expect(Number(inKitchen._sum.walletAmountCents ?? 0) > 0, 'B has a wallet-paid order still open at the close').toBe(key === 'B')
      expect(-(await sim.ledger.balanceOf(co, '2050', '2026-10-31')), '2050 = Σ wallet balances + wallet spent on orders not yet booked')
        .toBe(Number(w._sum.balanceCents ?? 0) + Number(inKitchen._sum.walletAmountCents ?? 0))
      const { giftCardBooksCheck } = await import('../../src/modules/giftCards/books.js')
      const g = await giftCardBooksCheck(co.tenantId, co.name)
      expect(g.differenceCents || 0, JSON.stringify(g)).toBe(0)
      expect(g.unexplainedCents || 0).toBe(0)
    })
  }

  it('the tie-out screen (finance): A\'s 2050 and 2080 rows clean; B\'s 2060 and 2080 rows clean', async () => {
    for (const [co, codes] of [[sim.A, ['2050', '2080']], [sim.B, ['2060', '2080']]] as const) {
      const r = ok(await sim.as(co.finance, co).get('/accounting/intercompany/tie-out?asOf=2026-10-31'), 200)
      const rows = (r.companies as Array<{ tenantId: string; tieOut: { rows: Array<{ code: string; differenceCents: number }> } }>)
        .find((c) => c.tenantId === co.tenantId)!.tieOut.rows
      for (const code of codes) expect(rows.find((x) => x.code === code)!.differenceCents || 0, `${co.key} ${code}: ${JSON.stringify(rows)}`).toBe(0)
    }
  })

  it('A: 1110 = what the open invoices still owe', async () => {
    const { A } = sim
    const { balanceOf, LIVE_KINDS } = await import('../../src/modules/receivables/ledger.js')
    const rows = await sim.prisma.receivableInvoice.findMany({ where: { tenantId: A.tenantId, kind: { in: [...LIVE_KINDS] }, status: { not: 'void' } } })
    const open = rows.reduce((t, r) => t + balanceOf(r), 0)
    expect(open).toBe(4_775_000)
    expect(await sim.ledger.balanceOf(A, '1110', '2026-10-31'), '1110 = open invoices').toBe(open)
  })

  it('A and B: the inter-company accounts agree — A\'s Due from B = B\'s Due to A (charge 25,000 + fleet 150 − settled 15,000)', async () => {
    const { A, B } = sim
    const owed = 2_500_000 + 15_000 - 1_500_000
    const dueFrom = await sim.prisma.account.findFirstOrThrow({ where: { tenantId: A.tenantId, counterpartyTenantId: B.tenantId, code: { gte: '1450', lte: '1499' } } })
    const dueTo = await sim.prisma.account.findFirstOrThrow({ where: { tenantId: B.tenantId, counterpartyTenantId: A.tenantId, code: { gte: '2150', lte: '2199' } } })
    expect(await sim.ledger.balanceOf(A, dueFrom.code, '2026-10-31')).toBe(owed)
    expect(-(await sim.ledger.balanceOf(B, dueTo.code, '2026-10-31'))).toBe(owed)
    // nothing the other way
    expect(await sim.prisma.account.count({ where: { tenantId: A.tenantId, counterpartyTenantId: B.tenantId, code: { gte: '2150', lte: '2199' } } })).toBeLessThanOrEqual(1)
    const bal = ok(await sim.as(sim.ceo, A).get('/accounting/intercompany/balances?asOf=2026-10-31'), 200)
    expect(JSON.stringify(bal)).toContain(String(owed))
  })

  it('A: 2060 loyalty — every posting at the point value of its day; earned − redeemed − expired = the account balances', async () => {
    const { A } = sim
    const tx = await sim.prisma.loyaltyTransaction.findMany({ where: { loyaltyAccount: { tenantId: A.tenantId } } })
    const pts = tx.reduce((s, t) => s + t.pointsDelta, 0)
    const bal = await sim.prisma.loyaltyAccount.aggregate({ where: { tenantId: A.tenantId }, _sum: { pointsBalance: true } })
    expect(pts, 'Σ loyalty transactions = account balances').toBe(Number(bal._sum.pointsBalance ?? 0))
    // each entry is points × the company's value on the day it was posted (10 before 15 Oct, 20 from it)
    const change = new Date('2026-10-15T09:00:00+05:00')
    for (const t of tx) {
      const kind = t.type === 'earn' ? 'loyalty.earn' : t.type === 'redeem' ? 'loyalty.redeem' : t.type === 'expire' ? 'loyalty.expire' : null
      if (!kind) continue
      const [e] = await sim.ledger.entriesBySource(A, `${kind}:${t.id}`)
      if (!e) continue
      const v = t.createdAt < change ? 10 : 20
      expect(e.lines.find((l) => l.code === '2060')!.cents, `${kind} ${t.pointsDelta} pts on ${t.createdAt.toISOString()}`).toBe(Math.abs(t.pointsDelta) * v)
    }
  })

  it('company separation: B gets 404 on A\'s invoices, write-offs, gift cards and wallets', async () => {
    const { A, B } = sim
    const finB = sim.as(B.finance, B)
    expect((await finB.post(`/accounting/receivables/${st.inv1}/payments`, { amountCents: 100, receivedAt: '2026-10-31', method: 'cash', reference: ref('X') })).statusCode).toBe(404)
    expect((await finB.post(`/accounting/receivables/${st.inv1}/credit-notes`, { amountCents: 100, reason: 'cross-company', date: '2026-10-31' })).statusCode).toBe(404)
    expect((await finB.post(`/accounting/receivables/${st.inv1}/withholding`, { kind: 'income_tax', amountCents: 100, date: '2026-10-31' })).statusCode).toBe(404)
    expect((await finB.post(`/accounting/receivables/write-offs/${st.writeOffId}/recover`, { amountCents: 100, receivedAt: '2026-10-31', method: 'cash', reference: ref('X') })).statusCode).toBe(404)
    const list = ok(await finB.get('/accounting/receivables'), 200)
    expect(JSON.stringify(list)).not.toContain(st.inv1)
    expect((await finB.get(`/gift-cards/${st.gc1!.id}/redemptions`)).statusCode).toBe(404)
    expect((await finB.post(`/gift-cards/${st.promo!.id}/void`, { reason: 'cross-company', disposition: 'forfeit' })).statusCode).toBe(404)
    expect((await finB.get(`/wallet/customers/${st.custA}`)).statusCode).toBe(404)
    expect((await finB.post('/wallet/topup', { customerId: st.custA, amountCents: 100, kind: 'paid', tender: 'cash', paymentRef: ref('X') })).statusCode).toBe(404)
    // B's books carry nothing of A's documents
    const crossed = await sim.prisma.journalEntry.count({ where: { tenantId: B.tenantId, OR: [{ reference: { contains: st.inv1! } }, { reference: { contains: st.gc1!.id } }] } })
    expect(crossed).toBe(0)
    void A
  })
})

// ─── Known defects (open) ───────────────────────────────────────────────────

describe('known defects found by the simulation (open)', () => {
  // DEFECT MI-1 (open, needs an owner / CA word on the revaluation account):
  // H48 keeps loyalty points at TODAY's value, and every posting does use the
  // value of its day (checked above) — but nothing revalues the points already
  // outstanding when the value changes (PATCH /loyalty/settings writes the
  // setting only; modules/loyalty/settings.ts saveCompanyLoyaltySettings). So
  // after the 15 Oct change from PKR 0.10 to 0.20, 2060 holds the points earned
  // before at 0.10 while the tie-out (intercompany/legacy.ts controlTieOut,
  // loyaltySubledgerAt = points × today's value) and every later redemption use
  // 0.20: 2060 is short by (points outstanding at the change) × 0.10, the
  // tie-out row 2060 is not clean, and redemptions of old points push 2060
  // toward a debit. Fix: on a point-value change, post one revaluation entry
  // per company (Dr 6060 / Cr 2060 on a rise, the reverse on a fall) for the
  // points outstanding at that instant, under a lock against concurrent
  // earns / redemptions. When fixed, drop `.fails`.
  // DEFECT MI-4 (open): the wallet tie-out (intercompany/legacy.ts walletSubledgerAt, used by
  // GET /accounting/intercompany/tie-out and the month-close check control_tieout) compares 2050
  // with the wallet balances only. A wallet is debited at checkout but 2050 comes down when the
  // sale is booked, so any wallet-paid order still open at the cut-off (B's 21:00 pickup on 31 Oct)
  // shows as a "real difference to find" — the gift-card check explains the same timing
  // (awaitingSale), the wallet row does not. Fix: add the wallet spent on orders whose sale is not
  // booked by asOf (as giftCardBooksCheck does) to the subledger figure. When fixed, drop `.fails`.
  it.fails('MI-4: B\'s 2050 tie-out row is clean at 31 Oct with a wallet-paid order still in the kitchen', async () => {
    const { B } = sim
    const r = ok(await sim.as(B.finance, B).get('/accounting/intercompany/tie-out?asOf=2026-10-31'), 200)
    const row = (r.companies as Array<{ tenantId: string; tieOut: { rows: Array<{ code: string; differenceCents: number }> } }>)
      .find((c) => c.tenantId === B.tenantId)!.tieOut.rows.find((x) => x.code === '2050')!
    expect(row.differenceCents, JSON.stringify(row)).toBe(0)
  })

  it.fails('MI-1: 2060 = outstanding points × today\'s point value (the tie-out is clean)', async () => {
    const { A } = sim
    const r = ok(await sim.as(A.finance, A).get('/accounting/intercompany/tie-out?asOf=2026-10-31'), 200)
    const row = (r.companies as Array<{ tenantId: string; tieOut: { rows: Array<{ code: string; differenceCents: number; ledgerCents: number; subledgerCents: number }> } }>)
      .find((c) => c.tenantId === A.tenantId)!.tieOut.rows.find((x) => x.code === '2060')!
    expect(row.differenceCents, JSON.stringify(row)).toBe(0)
  })
})
