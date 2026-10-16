// Company-less suppliers → GS Foods, once (owner, 2026-10-16: "All to GS
// Foods"). procurement/companylessSuppliers.ts.
//   - not exactly one company named 'GS Foods' (none, two; a head office of
//     that name does not count) → nothing changes, no marker
//   - a plain supplier (deleted ones too) moves to GS Foods with its bills,
//     payments and POs; its company-less goods receipts are stamped; a buyer
//     from another company is cleared; its opening balance posts in GS Foods;
//     one audit row each
//   - a supplier with records in ANOTHER company (an item, a ledger entry for
//     its bill) is skipped and flagged in GS Foods, never moved; a ledger entry
//     already in GS Foods is no conflict; a system supplier GS Foods already
//     has is skipped; ledger entries are never moved
//   - idempotent: the marker stops a second run; a re-run without it moves
//     nothing twice and raises no second flag
//   - /health detail carries counts only
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import {
  assignCompanylessSuppliers, companylessSupplierHealth, SUPPLIER_UNASSIGNED_KIND,
} from '../src/modules/procurement/companylessSuppliers.js'

const P = `cls${Date.now()}`
const TARGET = `GS Foods ${P}`
const MARKER = `test.companylessSuppliers.${P}`
let G: string        // the target ("GS Foods")
let V: string        // another company
let keeper: string
let buyerV: string
const s: Record<string, string> = {}
const bill: Record<string, string> = {}

async function supplier(key: string, data: Record<string, unknown> = {}) {
  s[key] = (await prisma.supplier.create({ data: { name: `${P} ${key}`, ...data } })).id
  return s[key]!
}

beforeAll(async () => {
  G = (await prisma.tenant.create({ data: { name: TARGET, slug: `${P}-g` } })).id
  V = (await prisma.tenant.create({ data: { name: `Viva ${P}`, slug: `${P}-v` } })).id
  for (const t of [G, V]) await ensureChartOfAccounts(t)
  keeper = (await prisma.user.create({ data: { name: 'k', email: `k.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId: G } })).id
  buyerV = (await prisma.user.create({ data: { name: 'b', email: `b.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: 'fnb_manager', isActive: true, accountStatus: 'active', tenantId: V } })).id

  // plain: a bill (never posted), a payment, a company-less receipt, an
  // opening balance and a buyer from company V.
  await supplier('plain', { openingBalanceCents: 50_000, assignedStaffId: buyerV })
  bill.plain = (await prisma.supplierBill.create({ data: { supplierId: s.plain!, billNumber: 'B-1', billDate: new Date(), dueDate: new Date() } })).id
  await prisma.supplierPayment.create({ data: { supplierId: s.plain!, method: 'cash', amountCents: 1_000 } })
  await prisma.goodsReceipt.create({ data: { supplierId: s.plain!, receivedById: keeper } })
  // deleted: moves too
  await supplier('deleted', { deletedAt: new Date() })
  // itemInV: an item of company V names it → skipped
  await supplier('itemInV')
  await prisma.inventoryItem.create({ data: { name: `${P} flour`, unit: 'kg', tenantId: V, supplierId: s.itemInV! } })
  // ledgerInV: its bill was posted in company V → skipped
  await supplier('ledgerInV')
  bill.ledgerInV = (await prisma.supplierBill.create({ data: { supplierId: s.ledgerInV!, billNumber: 'B-2', billDate: new Date(), dueDate: new Date() } })).id
  await postJournalEntry({ tenantId: V, sourceType: 'supplier.bill', sourceId: bill.ledgerInV!, description: 'Legacy bill', lines: [
    { accountCode: '6010', type: 'debit', amountCents: 7_000 }, { accountCode: '2010', type: 'credit', amountCents: 7_000 },
  ] })
  // ledgerInG: its bill was posted in GS Foods → moves (no conflict)
  await supplier('ledgerInG')
  bill.ledgerInG = (await prisma.supplierBill.create({ data: { supplierId: s.ledgerInG!, billNumber: 'B-3', billDate: new Date(), dueDate: new Date() } })).id
  await postJournalEntry({ tenantId: G, sourceType: 'supplier.bill', sourceId: bill.ledgerInG!, description: 'Legacy bill', lines: [
    { accountCode: '6010', type: 'debit', amountCents: 3_000 }, { accountCode: '2010', type: 'credit', amountCents: 3_000 },
  ] })
  // system: GS Foods already has its own cash_purchases supplier → skipped
  await prisma.supplier.create({ data: { name: `${P} G cash`, tenantId: G, systemKind: `cash_${P}` } })
  await supplier('system', { systemKind: `cash_${P}` })
  // alreadyV: has a company → untouched
  await supplier('alreadyV', { tenantId: V })
}, 60_000)

afterAll(async () => {
  await prisma.setting.deleteMany({ where: { key: { startsWith: MARKER } } })
})

const ours = () => Object.values(s)

describe('the target company must be exactly one', () => {
  it('none of that name → nothing changes, no marker', async () => {
    const r = await assignCompanylessSuppliers({ targetName: `Nobody ${P}`, markerKey: `${MARKER}.none`, supplierIds: ours() })
    expect(r.status).toBe('no_target')
    expect(r.targetCount).toBe(0)
    expect(await prisma.supplier.count({ where: { id: { in: ours() }, tenantId: null } })).toBe(7)
    expect(await prisma.setting.findUnique({ where: { key: `${MARKER}.none` } })).toBeNull()
  })

  it('two companies named \'GS Foods\' (the real name) → nothing changes, no marker', async () => {
    await prisma.tenant.create({ data: { name: 'GS Foods', slug: `${P}-gs1` } })
    await prisma.tenant.create({ data: { name: 'GS Foods', slug: `${P}-gs2` } })
    const r = await assignCompanylessSuppliers({ markerKey: `${MARKER}.two`, supplierIds: ours() })
    expect(r.status).toBe('no_target')
    expect(r.targetCount).toBeGreaterThanOrEqual(2)
    expect(await prisma.supplier.count({ where: { id: { in: ours() }, tenantId: null } })).toBe(7)
    expect(await prisma.setting.findUnique({ where: { key: `${MARKER}.two` } })).toBeNull()
  })

  it('a head office of the same name does not count as a second target', async () => {
    const name = `HO twin ${P}`
    const co = (await prisma.tenant.create({ data: { name, slug: `${P}-hc` } })).id
    await prisma.tenant.create({ data: { name, slug: `${P}-ho`, kind: 'head_office' } })
    const lone = (await prisma.supplier.create({ data: { name: `${P} lone` } })).id
    const r = await assignCompanylessSuppliers({ targetName: name, markerKey: `${MARKER}.ho`, supplierIds: [lone] })
    expect(r.status).toBe('done')
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: lone } })).tenantId).toBe(co)
  })
})

describe('the assignment', () => {
  let r: Awaited<ReturnType<typeof assignCompanylessSuppliers>>
  let entriesBefore: Array<{ id: string; tenantId: string | null }>

  beforeAll(async () => {
    entriesBefore = await prisma.journalEntry.findMany({ where: { tenantId: { in: [G, V] } }, select: { id: true, tenantId: true } })
    r = await assignCompanylessSuppliers({ targetName: TARGET, markerKey: MARKER, supplierIds: ours() })
  })

  it('moves plain, deleted and ledger-in-GS suppliers; skips the conflicts', async () => {
    expect(r.status).toBe('done')
    expect(new Set(r.assigned)).toEqual(new Set([s.plain, s.deleted, s.ledgerInG]))
    expect(new Map(r.skipped.map((x) => [x.supplierId, x.reason]))).toEqual(new Map([
      [s.itemInV, 'other_company_records'],
      [s.ledgerInV, 'other_company_records'],
      [s.system, 'system_supplier_exists'],
    ]))
    const rows = await prisma.supplier.findMany({ where: { id: { in: ours() } }, select: { id: true, tenantId: true } })
    const t = new Map(rows.map((x) => [x.id, x.tenantId]))
    expect(t.get(s.plain!)).toBe(G)
    expect(t.get(s.deleted!)).toBe(G)
    expect(t.get(s.ledgerInG!)).toBe(G)
    expect(t.get(s.itemInV!)).toBeNull()
    expect(t.get(s.ledgerInV!)).toBeNull()
    expect(t.get(s.system!)).toBeNull()
    expect(t.get(s.alreadyV!)).toBe(V)
    expect(await prisma.setting.findUnique({ where: { key: MARKER } })).not.toBeNull()
  })

  it('what moves with it: receipts stamped, foreign buyer cleared, bills now in GS Foods\' AP', async () => {
    expect(await prisma.goodsReceipt.count({ where: { supplierId: s.plain!, tenantId: G } })).toBe(1)
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: s.plain! } })).assignedStaffId).toBeNull()
    expect(await prisma.supplierBill.count({ where: { supplier: { tenantId: G }, id: bill.plain! } })).toBe(1)
    expect(await prisma.supplierBill.count({ where: { supplier: { tenantId: V }, id: bill.plain! } })).toBe(0)
    // The skipped supplier's item stays in V (items are never re-companied).
    expect(await prisma.inventoryItem.count({ where: { supplierId: s.itemInV!, tenantId: V } })).toBe(1)
  })

  it('the opening balance posts in GS Foods only (Dr 3010 / Cr 2010)', async () => {
    const je = await prisma.journalEntry.findMany({ where: { reference: { startsWith: `supplier.opening:${s.plain}:` } }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(je).toHaveLength(1)
    expect(je[0]!.tenantId).toBe(G)
    const ap = je[0]!.lines.find((l) => l.account.code === '2010')!
    expect(ap.type).toBe('credit')
    expect(Number(ap.amountCents)).toBe(50_000)
  })

  it('ledger entries are never moved or re-stamped', async () => {
    const after = await prisma.journalEntry.findMany({ where: { id: { in: entriesBefore.map((e) => e.id) } }, select: { id: true, tenantId: true } })
    expect(new Map(after.map((e) => [e.id, e.tenantId]))).toEqual(new Map(entriesBefore.map((e) => [e.id, e.tenantId])))
    const vBill = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `supplier.bill:${bill.ledgerInV}` } })
    expect(vBill.tenantId).toBe(V)
  })

  it('audited per moved supplier (actor system, counts); the skipped are flagged in GS Foods', async () => {
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'supplier.company_assigned', entityId: s.plain! } })
    expect(a.tenantId).toBe(G)
    expect(a.userId).toBeNull()
    const m = a.metadata as { actor: string; buyerCleared: boolean; receiptsStamped: number; bills: number; billsWithoutEntry: number }
    expect(m).toMatchObject({ actor: 'system', buyerCleared: true, receiptsStamped: 1, bills: 1, billsWithoutEntry: 1 })
    const flags = await prisma.exceptionFlag.findMany({ where: { kind: SUPPLIER_UNASSIGNED_KIND, entityId: { in: [s.itemInV!, s.ledgerInV!, s.system!] } } })
    expect(flags).toHaveLength(3)
    for (const f of flags) {
      expect(f.tenantId).toBe(G)
      // Never names the other company.
      expect(f.description).not.toContain('Viva')
    }
  })

  it('idempotent: the marker stops a second run', async () => {
    const again = await assignCompanylessSuppliers({ targetName: TARGET, markerKey: MARKER, supplierIds: ours() })
    expect(again.status).toBe('already')
    expect(again.assigned).toEqual([])
  })

  it('a re-run without the marker moves nothing twice, posts nothing twice and raises no second flag', async () => {
    const again = await assignCompanylessSuppliers({ targetName: TARGET, markerKey: `${MARKER}.rerun`, supplierIds: ours() })
    expect(again.status).toBe('done')
    expect(again.assigned).toEqual([])
    expect(again.skipped).toHaveLength(3)
    expect(await prisma.auditLog.count({ where: { action: 'supplier.company_assigned', entityId: { in: ours() } } })).toBe(3)
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: `supplier.opening:${s.plain}:` } } })).toBe(1)
    expect(await prisma.exceptionFlag.count({ where: { kind: SUPPLIER_UNASSIGNED_KIND, entityId: { in: [s.itemInV!, s.ledgerInV!, s.system!] } } })).toBe(3)
  })

  it('/health: counts only, never a name', async () => {
    const h = await companylessSupplierHealth()
    expect(['ok', 'warn']).toContain(h.status)
    if (h.detail) {
      expect(h.detail).not.toContain(TARGET)
      expect(h.detail).not.toContain(P)
      expect(h.detail).toMatch(/^\d+ supplier\(s\) with no company/)
    }
  })
})
