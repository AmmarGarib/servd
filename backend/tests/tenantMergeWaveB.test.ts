// Combining companies (POST /tenants/merge) — the finance wave B tables.
//
//   - food cost on FIFO lots: stock lots and movements, GRNI matches, goods
//     receipts, waste logs, counts and prep batches move;
//   - card payouts (settlements and their claimed days) move;
//   - receivables move with their bad-debt write-offs and evidence; a
//     colliding invoice number gets '-<source slug>';
//   - petty cash: boxes, movements, cash requests (renumbered after the
//     target's, the printed number keeping its digits + '-<source slug>'),
//     their attachments, settlements and spend lines move;
//   - PARKED (owner, 2026-10-13): on-account clients and strikes / bans are
//     not in the fixtures and not moved;
//   - refused, nothing written: inter-company activity (422
//     MERGE_HAS_INTERCOMPANY — a lineless pair account alone is dropped and the
//     merge goes ahead), different fiscal year ends both closed across a year
//     end (422 FY_END_MISMATCH), the same card-payout day claimed in both
//     (422 MERGE_CARD_SETTLEMENT_CLASH);
//   - a CEO of only one of the two companies gets 404.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let seq = 0
let ceo: Who

interface Co { id: string; slug: string; conceptId: string; locationId: string }
async function company(name: string, extra: { fiscalYearEndMonth?: number } = {}): Promise<Co> {
  const slug = `tmw-${name.toLowerCase()}-${++seq}-${RUN}`
  const id = (await prisma.tenant.create({ data: { name: `Merge ${name}`, slug, ...extra } })).id
  await ensureChartOfAccounts(id)
  await prisma.tenantMember.create({ data: { tenantId: id, userId: ceo.id } })
  const conceptId = (await prisma.concept.create({ data: { name: `Merge ${name} ${seq}`, slug: `tmw-b-${seq}-${RUN}`, type: 'restaurant', tenantId: id } })).id
  const locationId = (await prisma.location.create({ data: { slug: `tmw-l-${seq}-${RUN}`, name: `Outlet ${seq}`, tenantId: id } })).id
  return { id, slug, conceptId, locationId }
}
const merge = (who: Who, src: string, dst: string) =>
  app.inject({ method: 'POST', url: '/tenants/merge', headers: { authorization: `Bearer ${who.token}` }, payload: { sourceId: src, targetId: dst } })
const isDeleted = async (id: string) => !!(await prisma.tenant.findUniqueOrThrow({ where: { id } })).deletedAt

beforeAll(async () => {
  ceo = await mkUser('tmw-ceo', 'admin', null)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await prisma.account.updateMany({ where: { controlledBy: 'intercompany', tenant: { slug: { endsWith: RUN } } }, data: { controlledBy: null, counterpartyTenantId: null } })
  await app?.close()
})

describe('the finance wave B tables move', () => {
  const ids: Record<string, string> = {}
  let S: Co
  let D: Co

  beforeAll(async () => {
    S = await company('Source')
    D = await company('Target')
    const keeper = await mkUser('tmw-keeper', 'finance', S.id)

    // Food cost on lots.
    const item = await prisma.inventoryItem.create({ data: { tenantId: S.id, name: 'Flour', unit: 'kg', category: 'dry_goods' } })
    ids.lot = (await prisma.stockLot.create({
      data: { tenantId: S.id, inventoryItemId: item.id, sourceType: 'count_gain', sourceId: 'cl-1', costClass: 'food', receivedAt: new Date(), qtyIn: 10, remainingQty: 10, unitCostCents: 1_000, valueInCents: 10_000, remainingValueCents: 10_000 },
    })).id
    ids.movement = (await prisma.stockMovement.create({
      data: { tenantId: S.id, inventoryItemId: item.id, lotId: ids.lot, kind: 'count_gain', qty: 10, valueCents: 10_000, unitCostCents: 1_000, costClass: 'food', sourceType: 'physical_count_line', sourceId: 'cl-1', occurredAt: new Date() },
    })).id
    const supplier = await prisma.supplier.create({ data: { name: `Mill ${RUN}`, tenantId: S.id } })
    const bill = await prisma.supplierBill.create({ data: { supplierId: supplier.id, billNumber: 'B-1', billDate: new Date(), dueDate: new Date() } })
    const billLine = await prisma.supplierBillLine.create({ data: { billId: bill.id, description: 'Flour', quantity: 5, unitCostCents: 1_000, lineTotalCents: 5_000 } })
    ids.grni = (await prisma.grniMatch.create({ data: { tenantId: S.id, billId: bill.id, billLineId: billLine.id, qty: 5, billedUnitCostCents: 1_000, grniCents: 5_000 } })).id
    ids.receipt = (await prisma.goodsReceipt.create({ data: { tenantId: S.id, supplierId: supplier.id, receivedById: keeper.id } })).id
    ids.waste = (await prisma.wasteLog.create({ data: { tenantId: S.id, inventoryItemId: item.id, quantity: 1, unit: 'kg', reason: 'spoilage' } })).id
    ids.count = (await prisma.physicalCount.create({ data: { tenantId: S.id, countedById: keeper.id } })).id
    ids.prep = (await prisma.prepBatch.create({ data: { tenantId: S.id, itemName: 'Dough', inputs: [], actualYieldQty: 1, staffId: keeper.id } })).id

    // Card payouts.
    const bank = await prisma.bankAccount.create({ data: { tenantId: S.id, name: 'Source bank', accountCode: '1020' } })
    const settlement = await prisma.cardSettlement.create({
      data: { tenantId: S.id, bankAccountId: bank.id, statementLineId: `sl-${RUN}`, grossCents: 100_000, feeCents: 2_000, netCents: 98_000, dayFrom: '2026-09-01', dayTo: '2026-09-01', status: 'auto' },
    })
    ids.cardSettlement = settlement.id
    ids.cardDay = (await prisma.cardSettlementDay.create({ data: { tenantId: S.id, settlementId: settlement.id, day: '2026-09-01', grossCents: 100_000 } })).id

    // Receivables and a bad-debt write-off with its evidence; the target already has AR-2026-0001.
    const inv = await prisma.receivableInvoice.create({
      data: { tenantId: S.id, conceptId: S.conceptId, number: 'AR-2026-0001', customerName: 'Client', issueDate: new Date('2026-08-01'), dueDate: new Date('2026-08-31'), description: 'Catering', amountCents: 50_000 },
    })
    ids.invoice = inv.id
    ids.invoiceTarget = (await prisma.receivableInvoice.create({
      data: { tenantId: D.id, number: 'AR-2026-0001', customerName: 'Other client', issueDate: new Date('2026-08-01'), dueDate: new Date('2026-08-31'), description: 'Event', amountCents: 20_000 },
    })).id
    ids.invoice2 = (await prisma.receivableInvoice.create({
      data: { tenantId: S.id, number: 'AR-2026-0002', customerName: 'Client', issueDate: new Date('2026-08-02'), dueDate: new Date('2026-09-01'), description: 'Catering 2', amountCents: 10_000 },
    })).id
    ids.payment = (await prisma.receivablePayment.create({ data: { tenantId: S.id, invoiceId: inv.id, amountCents: 5_000, receivedAt: new Date(), method: 'bank' } as never })).id
    const wo = await prisma.receivableWriteOff.create({ data: { tenantId: S.id, invoiceId: inv.id, amountCents: 45_000, reason: 'Client closed down for good', requestedById: keeper.id } })
    ids.writeOff = wo.id
    ids.writeOffFile = (await prisma.receivableWriteOffAttachment.create({
      data: { tenantId: S.id, writeOffId: wo.id, fileName: 'letter.pdf', mime: 'application/pdf', sizeBytes: 4, data: Buffer.from('%PDF'), uploadedById: keeper.id },
    })).id

    // Petty cash and cash requests; the target already has CV-00001.
    const box = await prisma.pettyCashBox.create({ data: { tenantId: S.id, name: 'Front desk', custodianId: keeper.id, floatCents: 10_000 } })
    ids.box = box.id
    ids.movementPc = (await prisma.pettyCashMovement.create({ data: { tenantId: S.id, boxId: box.id, type: 'spend', amountCents: -1_000, reason: 'Milk', createdById: keeper.id } })).id
    const mkVoucher = (tenantId: string, n: number) => prisma.cashVoucher.create({
      data: { tenantId, seq: n, number: `CV-0000${n}`, voucherDate: new Date(), payeeName: 'Runner', purpose: 'Market run', amountCents: 2_000, preparedById: keeper.id, status: 'disbursed', boxId: tenantId === S.id ? box.id : null },
    })
    ids.v1 = (await mkVoucher(S.id, 1)).id
    ids.v2 = (await mkVoucher(S.id, 2)).id
    ids.vTarget = (await mkVoucher(D.id, 1)).id
    ids.voucherFile = (await prisma.cashVoucherAttachment.create({ data: { tenantId: S.id, voucherId: ids.v1, mime: 'image/png', sizeBytes: 4, data: Buffer.from('PNG!'), uploadedById: keeper.id } })).id
    const settlementCv = await prisma.cashVoucherSettlement.create({ data: { tenantId: S.id, voucherId: ids.v1, seq: 1, totalCents: 2_000, submittedById: keeper.id } })
    ids.cvSettlement = settlementCv.id
    ids.spendLine = (await prisma.pettyCashSpendLine.create({
      data: { tenantId: S.id, settlementId: settlementCv.id, kind: 'expense', accountCode: '6030', amountCents: 2_000, description: 'Market run' },
    })).id
  })

  it('a CEO of only one of the two companies gets 404 — nothing moves', async () => {
    const onlyS = await mkUser('tmw-ceo-s', 'admin', S.id)
    expect((await merge(onlyS, S.id, D.id)).statusCode).toBe(404)
    expect(await isDeleted(S.id)).toBe(false)
  })

  it('everything moves to the target; numbers stay unique per company', async () => {
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ invoiceNumbersRenamed: 1, cashRequestsRenumbered: 2 })
    const t = async (model: string, id: string) =>
      ((await (prisma as unknown as Record<string, { findUniqueOrThrow(a: unknown): Promise<{ tenantId: string | null }> }>)[model]!.findUniqueOrThrow({ where: { id } })).tenantId)
    const moved: Array<[string, string]> = [
      ['stockLot', ids.lot!], ['stockMovement', ids.movement!], ['grniMatch', ids.grni!], ['goodsReceipt', ids.receipt!], ['wasteLog', ids.waste!],
      ['physicalCount', ids.count!], ['prepBatch', ids.prep!], ['cardSettlement', ids.cardSettlement!], ['cardSettlementDay', ids.cardDay!],
      ['receivableInvoice', ids.invoice!], ['receivableInvoice', ids.invoice2!], ['receivablePayment', ids.payment!], ['receivableWriteOff', ids.writeOff!],
      ['receivableWriteOffAttachment', ids.writeOffFile!], ['pettyCashBox', ids.box!], ['pettyCashMovement', ids.movementPc!], ['cashVoucher', ids.v1!],
      ['cashVoucher', ids.v2!], ['cashVoucherAttachment', ids.voucherFile!], ['cashVoucherSettlement', ids.cvSettlement!], ['pettyCashSpendLine', ids.spendLine!],
    ]
    for (const [model, id] of moved) expect(await t(model, id), model).toBe(D.id)

    // The colliding invoice number is suffixed; the other keeps its number.
    expect((await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: ids.invoice } })).number).toBe(`AR-2026-0001-${S.slug}`)
    expect((await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: ids.invoice2 } })).number).toBe('AR-2026-0002')
    expect((await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: ids.invoiceTarget } })).number).toBe('AR-2026-0001')
    // Cash requests continue after the target's.
    const vs = await prisma.cashVoucher.findMany({ where: { tenantId: D.id }, orderBy: { seq: 'asc' }, select: { id: true, seq: true, number: true } })
    expect(vs).toEqual([
      { id: ids.vTarget, seq: 1, number: 'CV-00001' },
      { id: ids.v1, seq: 2, number: `CV-00001-${S.slug}` },
      { id: ids.v2, seq: 3, number: `CV-00002-${S.slug}` },
    ])
    expect(await isDeleted(S.id)).toBe(true)
  })
})

describe('feedback and the contact inbox move (SEO round 1)', () => {
  it('a contact message (no brand) and a brand feedback row follow the merge', async () => {
    const S = await company('FbSource')
    const D = await company('FbTarget')
    const contact = await prisma.feedbackEntry.create({
      data: { tenantId: S.id, kind: 'contact', comment: 'Catering for 40?', contactName: 'Ayesha', replyEmail: 'a@example.com', topic: 'catering', source: 'contact_page' },
    })
    const brand = await prisma.feedbackEntry.create({ data: { tenantId: S.id, conceptId: S.conceptId, kind: 'nps', score: 9 } })
    const theirs = await prisma.feedbackEntry.create({ data: { tenantId: D.id, kind: 'contact', comment: 'Hello', topic: 'other' } })
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode, res.body).toBe(200)
    for (const id of [contact.id, brand.id, theirs.id]) {
      expect((await prisma.feedbackEntry.findUniqueOrThrow({ where: { id } })).tenantId).toBe(D.id)
    }
    expect(await prisma.feedbackEntry.count({ where: { tenantId: S.id } })).toBe(0)
    expect(await isDeleted(S.id)).toBe(true)
  })
})

describe('merges the books cannot absorb are refused (422), nothing written', () => {
  it('inter-company activity → MERGE_HAS_INTERCOMPANY', async () => {
    const S = await company('IcSource')
    const D = await company('IcTarget')
    const transfer = await prisma.intercompanyTransfer.create({
      data: { tenantId: S.id, counterpartyTenantId: D.id, kind: 'charge', status: 'submitted', amountCents: 1_000, entryDate: new Date(), memo: 'Shared staff', preparedById: ceo.id },
    })
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('MERGE_HAS_INTERCOMPANY')
    expect(await isDeleted(S.id)).toBe(false)
    expect(await prisma.concept.count({ where: { id: S.conceptId, tenantId: S.id } })).toBe(1)
    await prisma.intercompanyTransfer.delete({ where: { id: transfer.id } })

    // A pair account WITH entries refuses too …
    const pair = async (a: Co, b: Co) => [
      await prisma.account.create({ data: { tenantId: a.id, code: '1450', name: 'Due from other', type: 'asset', controlledBy: 'intercompany', counterpartyTenantId: b.id } }),
      await prisma.account.create({ data: { tenantId: a.id, code: '2150', name: 'Due to other', type: 'liability', controlledBy: 'intercompany', counterpartyTenantId: b.id } }),
    ]
    await pair(S, D)
    await postJournalEntry({ tenantId: S.id, sourceType: 'ic.transfer', sourceId: `t-${RUN}`, description: 'IC', entryDate: new Date(), postedBy: 'test', lines: [
      { accountCode: '1450', type: 'debit', amountCents: 500 }, { accountCode: '2150', type: 'credit', amountCents: 500 },
    ] })
    expect((await merge(ceo, S.id, D.id)).json().error.code).toBe('MERGE_HAS_INTERCOMPANY')
    expect(await isDeleted(S.id)).toBe(false)

    // … ones with no entries are lazy: dropped (both sides of the pair), and the merge goes ahead.
    const S2 = await company('IcSource2')
    const D2 = await company('IcTarget2')
    const lazy = [...await pair(S2, D2), ...await pair(D2, S2)]
    const ok = await merge(ceo, S2.id, D2.id)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await prisma.account.count({ where: { id: { in: lazy.map((a) => a.id) } } })).toBe(0)
  })

  it('a shared-fleet rate between them → MERGE_HAS_INTERCOMPANY', async () => {
    const S = await company('FleetSource')
    const D = await company('FleetTarget')
    const ag = await prisma.fleetAgreement.create({ data: { providerTenantId: D.id, clientTenantId: S.id, createdById: ceo.id } })
    await prisma.fleetRate.create({ data: { tenantId: D.id, clientTenantId: S.id, agreementId: ag.id, fromPeriod: '2026-01', ratePerTripCents: 1_000, setById: ceo.id } })
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('MERGE_HAS_INTERCOMPANY')
    expect(await isDeleted(S.id)).toBe(false)
  })

  it('different fiscal year ends, both closed across a year end → FY_END_MISMATCH', async () => {
    const S = await company('FySource', { fiscalYearEndMonth: 6 })
    const D = await company('FyTarget', { fiscalYearEndMonth: 12 })
    const book = async (tenantId: string, at: string, through: string) => {
      await postJournalEntry({ tenantId, sourceType: 'test.opening', sourceId: `${tenantId}-${at}`, description: 'Opening', entryDate: new Date(at), postedBy: 'test', lines: [
        { accountCode: '1010', type: 'debit', amountCents: 100 }, { accountCode: '3010', type: 'credit', amountCents: 100 },
      ] })
      await prisma.periodLock.create({ data: { tenantId, lockedThrough: new Date(through), lockedBy: ceo.id } })
    }
    await book(S.id, '2025-05-10T07:00:00Z', '2025-08-31T18:59:59Z')   // across 30 June 2025
    await book(D.id, '2024-11-10T07:00:00Z', '2025-01-31T18:59:59Z')   // across 31 December 2024
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('FY_END_MISMATCH')
    expect(await isDeleted(S.id)).toBe(false)
  })

  it('the same card-payout day claimed in both → MERGE_CARD_SETTLEMENT_CLASH', async () => {
    const S = await company('CardSource')
    const D = await company('CardTarget')
    for (const co of [S, D]) {
      const bank = await prisma.bankAccount.create({ data: { tenantId: co.id, name: `Bank ${co.slug}`, accountCode: '1020' } })
      const st = await prisma.cardSettlement.create({
        data: { tenantId: co.id, bankAccountId: bank.id, statementLineId: `sl-${co.slug}`, grossCents: 1_000, feeCents: 20, netCents: 980, dayFrom: '2026-09-05', dayTo: '2026-09-05', status: 'auto' },
      })
      await prisma.cardSettlementDay.create({ data: { tenantId: co.id, settlementId: st.id, day: '2026-09-05', grossCents: 1_000 } })
    }
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('MERGE_CARD_SETTLEMENT_CLASH')
    expect(await prisma.cardSettlement.count({ where: { tenantId: S.id } })).toBe(1)
  })
})

// Final gate (2026-10-14): what the merge used to strand or crash on.
//   - a system supplier ('cash_purchases', one per company) in both: the
//     target's absorbs the source's and its receipts (was a 500 on the unique key);
//   - open posting_failed flags follow their documents, so the target's backfill
//     re-posts them;
//   - tax payments move; a challan for the same authority and month in both is
//     refused (MERGE_TAX_PAYMENT_CLASH);
//   - deposit drops, gift cards, loyalty and wallets (a customer with one in
//     each keeps the target's, balances added), HR employees (a colliding code
//     gets '-<source slug>') move; a payroll month both ran is refused
//     (MERGE_HR_CLASH);
//   - different year ends with only the SOURCE closed across one is refused
//     (FY_END_MISMATCH) — its closed years would be re-presented.
describe('final gate: money, tax, flags and HR move; clashes are refused', () => {
  it('a system supplier in both: the target\'s absorbs the source\'s and its receipts', async () => {
    const S = await company('SysSource')
    const D = await company('SysTarget')
    const keeper = await mkUser('tmw-sys-keeper', 'finance', S.id)
    const sup = async (co: Co) => prisma.supplier.create({ data: { tenantId: co.id, name: 'Cash purchases', systemKind: 'cash_purchases' } })
    const sSys = await sup(S)
    const dSys = await sup(D)
    const r1 = await prisma.goodsReceipt.create({ data: { tenantId: S.id, supplierId: sSys.id, receivedById: keeper.id } })
    const r2 = await prisma.goodsReceipt.create({ data: { tenantId: D.id, supplierId: dSys.id, receivedById: keeper.id } })
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().systemSuppliersAbsorbed).toBe(1)
    const sys = await prisma.supplier.findMany({ where: { tenantId: D.id, systemKind: 'cash_purchases' }, select: { id: true } })
    expect(sys).toEqual([{ id: dSys.id }])
    expect(await prisma.supplier.count({ where: { id: sSys.id } })).toBe(0)
    for (const r of [r1, r2]) {
      expect(await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: r.id }, select: { supplierId: true, tenantId: true } }))
        .toEqual({ supplierId: dSys.id, tenantId: D.id })
    }
  })

  it('an open posting_failed flag follows its waste log; the target\'s backfill re-posts it', async () => {
    const { flagPostingFailed } = await import('../src/modules/accounting/journal.js')
    const { backfillUnpostedOrders } = await import('../src/modules/reconciliation/backfillOrders.js')
    const S = await company('FlagSource')
    const D = await company('FlagTarget')
    const item = await prisma.inventoryItem.create({ data: { tenantId: S.id, name: 'Cream', unit: 'l', category: 'dairy' } })
    const log = await prisma.wasteLog.create({ data: { tenantId: S.id, inventoryItemId: item.id, quantity: 2, unit: 'l', reason: 'spoilage', estimatedCostCents: 50_000, recordedAt: new Date() } })
    await flagPostingFailed({ tenantId: S.id, sourceType: 'inventory.waste', sourceId: log.id, entityType: 'WasteLog', entityId: log.id, reason: 'PERIOD_LOCKED: test', title: 'Waste did not reach the ledger', amountCents: 50_000 })
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode, res.body).toBe(200)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { entityType: 'WasteLog', entityId: log.id }, select: { tenantId: true, status: true } })
    expect(flag).toEqual({ tenantId: D.id, status: 'open' })
    const dry = await backfillUnpostedOrders({ tenantIds: [D.id], dryRun: true })
    expect(dry.rows.filter((r) => r.id === log.id).map((r) => `${r.kind}:${r.outcome}`)).toEqual(['inventory.waste:would_post'])
    await backfillUnpostedOrders({ tenantIds: [D.id], dryRun: false, postedBy: ceo.id })
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `inventory.waste:${log.id}` }, select: { tenantId: true } })
    expect(je.tenantId).toBe(D.id)
  })

  it('tax payments move; the same authority and month in both → MERGE_TAX_PAYMENT_CLASH', async () => {
    const S = await company('TaxSource')
    const D = await company('TaxTarget')
    const pay = (co: Co, authority: string, from: string) => prisma.salesTaxPayment.create({
      data: { tenantId: co.id, authority, periodFrom: new Date(from), periodTo: new Date(new Date(from).getTime() + 30 * 86_400_000), paidAt: new Date(), paidCents: 1_000 },
    })
    const sOnly = await pay(S, 'fbr', '2026-07-31T19:00:00Z')        // August
    await pay(S, 'srb', '2026-08-31T19:00:00Z')                       // September, both
    await pay(D, 'srb', '2026-08-31T19:00:00Z')
    const refused = await merge(ceo, S.id, D.id)
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('MERGE_TAX_PAYMENT_CLASH')
    expect(refused.json().error.details.clashes).toEqual([{ authority: 'srb', month: '2026-09' }])
    expect(await isDeleted(S.id)).toBe(false)
    await prisma.salesTaxPayment.deleteMany({ where: { tenantId: S.id, authority: 'srb' } })
    const ok = await merge(ceo, S.id, D.id)
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.salesTaxPayment.findUniqueOrThrow({ where: { id: sOnly.id } })).tenantId).toBe(D.id)
  })

  it('deposit drops, gift cards, loyalty, wallets and HR move; balances of one customer combine', async () => {
    const S = await company('MoneySource')
    const D = await company('MoneyTarget')
    const cashier = await mkUser('tmw-money-cashier', 'cashier', S.id)
    const drop = await prisma.depositDrop.create({ data: { tenantId: S.id, amountCents: 10_000, expectedCents: 10_000, varianceCents: 0, droppedById: cashier.id } })
    const card = await prisma.giftCard.create({ data: { tenantId: S.id, code: `TMW-${RUN}-${++seq}`, issuedAmountCents: 5_000, balanceCents: 5_000 } })
    const both = await prisma.customer.create({ data: { name: 'Both', phone: `+92300${Date.now().toString().slice(-7)}` } })
    const onlyS = await prisma.customer.create({ data: { name: 'Only S', phone: `+92301${Date.now().toString().slice(-7)}` } })
    const sAcct = await prisma.loyaltyAccount.create({ data: { tenantId: S.id, customerId: both.id, pointsBalance: 30, lifetimePoints: 50, stampCounts: { a: 2 } } })
    const dAcct = await prisma.loyaltyAccount.create({ data: { tenantId: D.id, customerId: both.id, pointsBalance: 10, lifetimePoints: 20, stampCounts: { a: 1, b: 4 } } })
    const sTx = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: sAcct.id, type: 'earn', pointsDelta: 30 } })
    const soloAcct = await prisma.loyaltyAccount.create({ data: { tenantId: S.id, customerId: onlyS.id, pointsBalance: 7 } })
    await prisma.customerWallet.create({ data: { tenantId: S.id, customerId: both.id, balanceCents: 2_500 } })
    const dWallet = await prisma.customerWallet.create({ data: { tenantId: D.id, customerId: both.id, balanceCents: 1_000 } })
    const wTx = await prisma.walletTransaction.create({ data: { tenantId: S.id, customerId: both.id, type: 'topup', amountCents: 2_500, balanceAfter: 2_500 } })
    const emp = await prisma.hrEmployee.create({ data: { tenantId: S.id, employeeCode: 'GSF-0001', fullName: 'Source person' } })
    await prisma.hrEmployee.create({ data: { tenantId: D.id, employeeCode: 'GSF-0001', fullName: 'Target person' } })
    const run = await prisma.hrPayrollRun.create({ data: { tenantId: S.id, period: '2026-08', settings: {} } })
    const slip = await prisma.hrPayslip.create({
      data: { tenantId: S.id, runId: run.id, employeeId: emp.id, inputs: {}, lines: [], grossCents: 1, earningsCents: 1, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 1 },
    })
    // A payroll month both ran is refused …
    const dRun = await prisma.hrPayrollRun.create({ data: { tenantId: D.id, period: '2026-08', settings: {} } })
    const refused = await merge(ceo, S.id, D.id)
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('MERGE_HR_CLASH')
    expect(refused.json().error.details.payrollMonthsInBoth).toEqual(['2026-08'])
    await prisma.hrPayrollRun.delete({ where: { id: dRun.id } })

    // … otherwise everything moves.
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ loyaltyAccountsCombined: 1, walletsCombined: 1, employeeCodesRenamed: 1 })
    expect((await prisma.depositDrop.findUniqueOrThrow({ where: { id: drop.id } })).tenantId).toBe(D.id)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).tenantId).toBe(D.id)
    expect(await prisma.loyaltyAccount.count({ where: { id: sAcct.id } })).toBe(0)
    expect(await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: dAcct.id }, select: { pointsBalance: true, lifetimePoints: true, stampCounts: true } }))
      .toEqual({ pointsBalance: 40, lifetimePoints: 70, stampCounts: { a: 3, b: 4 } })
    expect((await prisma.loyaltyTransaction.findUniqueOrThrow({ where: { id: sTx.id } })).loyaltyAccountId).toBe(dAcct.id)
    expect((await prisma.loyaltyAccount.findUniqueOrThrow({ where: { id: soloAcct.id } })).tenantId).toBe(D.id)
    expect(await prisma.customerWallet.findMany({ where: { customerId: both.id }, select: { id: true, tenantId: true, balanceCents: true } }))
      .toEqual([{ id: dWallet.id, tenantId: D.id, balanceCents: 3_500 }])
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: wTx.id } })).tenantId).toBe(D.id)
    expect(await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.id }, select: { tenantId: true, employeeCode: true } }))
      .toEqual({ tenantId: D.id, employeeCode: `GSF-0001-${S.slug}` })
    expect((await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: run.id } })).tenantId).toBe(D.id)
    expect((await prisma.hrPayslip.findUniqueOrThrow({ where: { id: slip.id } })).tenantId).toBe(D.id)
  })

  it('different year ends, only the source closed across one → FY_END_MISMATCH', async () => {
    const S = await company('Fy1Source', { fiscalYearEndMonth: 6 })
    const D = await company('Fy1Target', { fiscalYearEndMonth: 12 })
    const book = async (tenantId: string, at: string, through: string) => {
      await postJournalEntry({ tenantId, sourceType: 'test.opening', sourceId: `${tenantId}-${at}`, description: 'Opening', entryDate: new Date(at), postedBy: 'test', lines: [
        { accountCode: '1010', type: 'debit', amountCents: 100 }, { accountCode: '3010', type: 'credit', amountCents: 100 },
      ] })
      await prisma.periodLock.create({ data: { tenantId, lockedThrough: new Date(through), lockedBy: ceo.id } })
    }
    await book(S.id, '2026-05-10T07:00:00Z', '2026-08-31T18:59:59Z')   // across 30 June 2026
    await book(D.id, '2026-01-15T07:00:00Z', '2026-09-30T18:59:59Z')   // not across 31 December
    const res = await merge(ceo, S.id, D.id)
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('FY_END_MISMATCH')
    expect(res.json().error.details.closedYearsOf).toBe('source')
    expect(await isDeleted(S.id)).toBe(false)
  })
})
