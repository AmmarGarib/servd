// The fiscal document of an on-account bill (owner 2026-10-13, H14).
//
// An order charged to a named corporate client (CustomerAccountCharge, its own
// company's) names the client as the buyer — legal name, NTN, STRN, CNIC,
// address. 'on_account' is the CASH class (the CA's default, lib/pricing
// tenderOf): payment mode 'cash', SRB modeOfPay 'Cash' when every tender is
// cash or on account, FBR PaymentMode 2 when any is; a whole-order return of
// an all-on-account sale defaults to 'on_account'.
//
// Two companies: a charge row of company B never makes B's client the buyer
// on A's order.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prisma, mkCompany, mkUser, mkOrder, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'
import { buildFiscalSaleTx, buildRefundPayload, paymentModeOf, toFbrInvoiceFields, toSrbInvoiceFields, totalsCheck } from '../src/connectors/fiscal/payload.js'
import { DEFAULT_FISCAL_SETTINGS } from '../src/connectors/config.js'

let A: Company, B: Company
let adminA: Who, adminB: Who
let clientA: string, clientB: string

const build = (orderId: string) =>
  prisma.$transaction((tx) => buildFiscalSaleTx(tx, orderId, `doc_${randomBytes(4).toString('hex')}`, DEFAULT_FISCAL_SETTINGS))

/** A completed till bill (Kheer + 15 % GST) settled by `payments`. */
async function bill(co: Company, payments: Array<{ method: 'cash' | 'card' | 'on_account'; amountCents: number }>, customer?: { name: string; ntn?: string }) {
  const id = await mkOrder(co, {
    items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }],
    taxCents: 16_500, taxRatePct: 15, totalCents: 126_500,
    payments: payments.filter((p) => p.method !== 'on_account') as Array<{ method: 'cash' | 'card'; amountCents: number }>,
    ...(customer && { customer }),
  })
  for (const p of payments.filter((x) => x.method === 'on_account')) {
    await prisma.payment.create({
      data: { orderId: id, method: 'on_account', amountCents: p.amountCents, status: 'paid', gatewayRef: 'OA-0001' },
    })
  }
  return id
}

async function charge(co: Company, accountId: string, orderId: string, chargedById: string, amountCents = 126_500) {
  const pay = await prisma.payment.findFirstOrThrow({ where: { orderId, method: 'on_account' } })
  await prisma.customerAccountCharge.create({
    data: { tenantId: co.tenantId, accountId, orderId, paymentId: pay.id, conceptId: co.conceptId, amountCents, chargedById },
  })
}

beforeAll(async () => {
  A = await mkCompany('foa-a', { srbPosId: 7101, fbrPosId: 7102 })
  B = await mkCompany('foa-b', { srbPosId: 7201 })
  adminA = await mkUser('foaAdminA', 'admin', A.tenantId)
  adminB = await mkUser('foaAdminB', 'admin', B.tenantId)
  clientA = (await prisma.customerAccount.create({
    data: {
      tenantId: A.tenantId, number: 'OA-0001', legalName: 'Acme Engineering (Pvt) Ltd', ntn: '7654321-0', strn: '17-00-1234-567-89',
      cnic: '42101-1234567-1', address: 'Plot 4, Korangi Industrial Area', status: 'active', createdById: adminA.id,
    },
  })).id
  clientB = (await prisma.customerAccount.create({
    data: { tenantId: B.tenantId, number: 'OA-0001', legalName: 'Beta Traders', ntn: '9999999-9', status: 'active', createdById: adminB.id },
  })).id
}, 60_000)

afterAll(() => {
  resetConnectorCache()
})

describe('on-account: the client is the buyer, the tender is the cash class', () => {
  it('paymentModeOf: on_account is cash; with card it is mixed', () => {
    expect(paymentModeOf(['on_account'])).toBe('cash')
    expect(paymentModeOf(['on_account', 'cash'])).toBe('cash')
    expect(paymentModeOf(['on_account', 'card'])).toBe('mixed')
  })

  it('an all-on-account bill: buyer = the client, mode cash, SRB Cash, FBR 2; a whole-order return goes back on account', async () => {
    const id = await bill(A, [{ method: 'on_account', amountCents: 126_500 }], { name: 'Walk-in', ntn: '1111111-1' })
    await charge(A, clientA, id, adminA.id)
    const b = await build(id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    expect(b.payload.buyer).toEqual({
      legalName: 'Acme Engineering (Pvt) Ltd', ntn: '7654321-0', strn: '17-00-1234-567-89',
      cnic: '42101-1234567-1', address: 'Plot 4, Korangi Industrial Area',
    })
    expect(b.payload.payment).toEqual({ mode: 'cash', tenders: [{ method: 'on_account', amountCents: 126_500 }] })
    const srb = toSrbInvoiceFields(b.payload)
    expect(srb).toMatchObject({ modeOfPay: 'Cash', consumerName: 'Acme Engineering (Pvt) Ltd', consumerNTN: '7654321-0' })
    const fbr = toFbrInvoiceFields(b.payload)
    expect(fbr).toMatchObject({ PaymentMode: 2, BuyerNTN: '7654321-0', BuyerCNIC: '42101-1234567-1', BuyerName: 'Acme Engineering (Pvt) Ltd' })

    const ret = buildRefundPayload(b.payload, { documentId: 'r-oa', refundAmountCents: 126_500, issuedAt: new Date(), original: null })
    expect(ret.payment).toEqual({ mode: 'cash', tenders: [{ method: 'on_account', amountCents: 126_500 }] })
    expect(ret.buyer).toEqual(b.payload.buyer)
    expect(totalsCheck(ret).ok).toBe(true)
  })

  it('on account with cash: SRB Cash, FBR 2; with card: SRB Card, FBR 2 (any on-account is the cash class)', async () => {
    const withCash = await bill(A, [{ method: 'cash', amountCents: 26_500 }, { method: 'on_account', amountCents: 100_000 }])
    await charge(A, clientA, withCash, adminA.id, 100_000)
    const c = await build(withCash)
    expect(c.payload.payment.mode).toBe('cash')
    expect(toSrbInvoiceFields(c.payload).modeOfPay).toBe('Cash')
    expect(toFbrInvoiceFields(c.payload).PaymentMode).toBe(2)

    const withCard = await bill(A, [{ method: 'card', amountCents: 26_500 }, { method: 'on_account', amountCents: 100_000 }])
    await charge(A, clientA, withCard, adminA.id, 100_000)
    const k = await build(withCard)
    expect(k.payload.payment.mode).toBe('mixed')
    expect(toSrbInvoiceFields(k.payload).modeOfPay).toBe('Card')
    expect(toFbrInvoiceFields(k.payload).PaymentMode).toBe(2)
    // A mixed sale's whole-order return keeps the old default (cash).
    expect(buildRefundPayload(k.payload, { documentId: 'r-mix', refundAmountCents: 126_500, issuedAt: new Date(), original: null }).payment.tenders[0]!.method).toBe('cash')
  })

  it('no charge row: the customer rule is unchanged', async () => {
    const id = await bill(A, [{ method: 'cash', amountCents: 126_500 }], { name: 'Hassan', ntn: '2222222-2' })
    const b = await build(id)
    expect(b.payload.buyer).toEqual({ legalName: 'Hassan', ntn: '2222222-2' })
    expect(toSrbInvoiceFields(b.payload).modeOfPay).toBe('Cash')
  })

  it('two companies: B\'s charge row on A\'s order never names B\'s client', async () => {
    const id = await bill(A, [{ method: 'on_account', amountCents: 126_500 }])
    await charge(B, clientB, id, adminB.id)
    const b = await build(id)
    expect(b.payload.buyer).toBeNull()
    expect(JSON.stringify(b.payload)).not.toContain('Beta Traders')
  })
})
