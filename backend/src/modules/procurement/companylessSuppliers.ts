// Company-less suppliers → GS Foods, once (owner, 2026-10-16: "All to GS
// Foods" — "Assign every company-less supplier to GS Foods in one go").
//
// Some old suppliers were set up before Supplier.tenantId was required, so
// every company's supplier ageing (and the PO approvals queue, which admits
// `tenantId: null`) showed them. A supplier's bills, payments, credit notes and
// POs carry NO company of their own — they are the supplier's — so this one
// assignment moves all of them into GS Foods' AP at once.
//
// The run, at API boot (index.ts, before the supplier opening-balance sync):
//   • The target is the ONE company (kind 'company', not deleted) whose name
//     is exactly 'GS Foods'. None, or more than one → nothing is changed, a
//     warning is logged, no marker is written (the next boot tries again) and
//     /health says so as a count.
//   • Marker Setting `procurement.companylessSuppliersAssignedAt` — written
//     once the run has gone through every company-less supplier; later boots
//     do nothing. Each supplier is also moved with a conditional claim
//     (`tenantId IS NULL`, row locked), so two API boxes booting together
//     never move one twice (a skipped one is flagged under the same lock, so
//     never twice either). A supplier whose move throws is left company-less
//     and the others go on; the marker is then NOT written, so the next boot
//     retries what is left (moved ones are no longer candidates).
//   • DELETED suppliers are assigned too: their bills, payments and opening
//     balance still sit in AP history, and a company-less one would keep
//     leaking into every company's lists (and come back company-less if it
//     were ever undeleted).
//   • A supplier with ANY record already in ANOTHER company is SKIPPED and
//     flagged (`supplier_company_unassigned`, in GS Foods — the CEO sees it):
//     an item, goods receipt (or its outlet, its lines' items, their stock
//     lots, petty-cash spend lines and GRNI matches), fixed asset, OpEx
//     category, CapEx project, bank account or petty-cash movement (payments),
//     credit-note application or ledger entry that names the supplier or one
//     of its bills / bill lines / payments / POs / receipts / receipt lines. Moving it
//     would put a bill in GS Foods' AP whose ledger entry is in the other
//     company. The CEO assigns it by hand (Procurement → Suppliers) after
//     deciding which company it is. So is a system supplier (systemKind)
//     when GS Foods already has its own of that kind (one per company).
//   • Ledger entries are NEVER moved or re-stamped. A company-less ledger
//     entry (legacy, tenantId NULL) does not count as "another company" and
//     stays as it is.
//   • Company-less child rows that are the supplier's by definition — its
//     goods receipts (GoodsReceipt.tenantId = the supplier's company) — are
//     stamped GS Foods in the same transaction. Inventory items are NOT: an
//     item's company is its own, never its preferred supplier's (company-less
//     items with stock already show on /health fifoCutover).
//   • A buyer (assignedStaffId) who does not work for GS Foods is cleared —
//     the supplier editor refuses that pairing (STAFF_NOT_IN_COMPANY).
//   • The opening balance follows the supplier: syncOpeningBalanceOrFlag
//     posts it in GS Foods (Dr 3010 / Cr 2010 on its opening date; a closed
//     month raises the usual posting_failed flag for the backfill).
//   • One audit row per moved supplier (`supplier.company_assigned`, actor
//     'system') with the counts of what moved with it, incl. bills that have
//     no ledger entry (they were never posted while the supplier had no
//     company — they now show in GS Foods' ageing and not in its 2010).
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { syncOpeningBalanceOrFlag } from './openingBalance.js'

export const COMPANYLESS_SUPPLIERS_MARKER = 'procurement.companylessSuppliersAssignedAt'
export const COMPANYLESS_SUPPLIERS_TARGET = 'GS Foods'
export const SUPPLIER_UNASSIGNED_KIND = 'supplier_company_unassigned' as const

type Tx = Prisma.TransactionClient

export interface AssignResult {
  /** 'done' = went through; 'already' = marker set; 'no_target' = not exactly one target company. */
  status: 'done' | 'already' | 'no_target'
  targetCount?: number
  assigned: string[]
  skipped: Array<{ supplierId: string; reason: SkipReason }>
  /** Suppliers whose move threw (left company-less; no marker, the next boot retries). */
  failed?: number
}

type SkipReason = 'other_company_records' | 'system_supplier_exists'

interface DocIds {
  bills: string[]
  payments: string[]
  receipts: string[]
  receiptLines: string[]
  /** Every id a ledger reference may name (supplier, bills, bill lines, payments, POs, receipts, receipt lines). */
  ids: string[]
}

/** The ids of a supplier's own documents — what its ledger references name. */
async function documentIds(tx: Tx, supplierId: string): Promise<DocIds> {
  const [bills, payments, pos, receipts] = await Promise.all([
    tx.supplierBill.findMany({ where: { supplierId }, select: { id: true, lines: { select: { id: true } } } }),
    tx.supplierPayment.findMany({ where: { supplierId }, select: { id: true } }),
    tx.purchaseOrder.findMany({ where: { supplierId }, select: { id: true } }),
    tx.goodsReceipt.findMany({ where: { supplierId }, select: { id: true } }),
  ])
  const receiptIds = receipts.map((r) => r.id)
  const receiptLines = receiptIds.length
    ? (await tx.goodsReceiptLine.findMany({ where: { receiptId: { in: receiptIds } }, select: { id: true } })).map((l) => l.id)
    : []
  const billIds = bills.map((b) => b.id)
  const billLineIds = bills.flatMap((b) => b.lines.map((l) => l.id))
  const paymentIds = payments.map((p) => p.id)
  return {
    bills: billIds, payments: paymentIds, receipts: receiptIds, receiptLines,
    ids: [supplierId, ...billIds, ...billLineIds, ...paymentIds, ...pos.map((p) => p.id), ...receiptIds, ...receiptLines],
  }
}

/** Companies other than `target` holding a record of this supplier (empty = safe to move). */
async function otherCompanies(tx: Tx, supplierId: string, target: string, doc: DocIds): Promise<string[]> {
  const { ids, bills: billIds } = doc
  const other = { not: target }   // NULL never matches `not` in SQL — company-less rows don't count
  const found = new Set<string>()
  const add = (rows: Array<{ tenantId: string | null } | null | undefined>) => { for (const r of rows) if (r?.tenantId) found.add(r.tenantId) }

  add(await tx.inventoryItem.findMany({ where: { supplierId, tenantId: other }, select: { tenantId: true }, distinct: ['tenantId'] }))
  add(await tx.goodsReceipt.findMany({ where: { supplierId, tenantId: other }, select: { tenantId: true }, distinct: ['tenantId'] }))
  add(await tx.fixedAsset.findMany({ where: { supplierId, tenantId: other }, select: { tenantId: true }, distinct: ['tenantId'] }))
  add((await tx.opexLine.findMany({ where: { supplierId, category: { tenantId: other } }, select: { category: { select: { tenantId: true } } } })).map((r) => r.category))
  add((await tx.capexLine.findMany({ where: { supplierId, project: { tenantId: other } }, select: { project: { select: { tenantId: true } } } })).map((r) => r.project))
  const bankIds = (await tx.supplierPayment.findMany({ where: { supplierId, bankAccountId: { not: null } }, select: { bankAccountId: true }, distinct: ['bankAccountId'] }))
    .map((p) => p.bankAccountId!).filter(Boolean)
  if (bankIds.length) add(await tx.bankAccount.findMany({ where: { id: { in: bankIds }, tenantId: other }, select: { tenantId: true } }))
  add((await tx.purchaseOrderLine.findMany({ where: { purchaseOrder: { supplierId }, inventoryItem: { tenantId: other } }, select: { inventoryItem: { select: { tenantId: true } } } })).map((r) => r.inventoryItem))
  add((await tx.supplierBillLine.findMany({ where: { bill: { supplierId }, inventoryItem: { tenantId: other } }, select: { inventoryItem: { select: { tenantId: true } } } })).map((r) => r.inventoryItem))
  add((await tx.itemPriceHistory.findMany({ where: { supplierId, inventoryItem: { tenantId: other } }, select: { inventoryItem: { select: { tenantId: true } } } })).map((r) => r.inventoryItem))
  // Receipts: a company-less receipt left at another company's outlet or
  // carrying another company's stock (lines name items by plain id; lots and
  // GRNI matches carry their own company) would be stamped GS Foods wrongly.
  if (doc.receipts.length) {
    const locIds = (await tx.goodsReceipt.findMany({ where: { id: { in: doc.receipts }, locationId: { not: null } }, select: { locationId: true }, distinct: ['locationId'] }))
      .map((r) => r.locationId!).filter(Boolean)
    if (locIds.length) add(await tx.location.findMany({ where: { id: { in: locIds }, tenantId: other }, select: { tenantId: true } }))
  }
  if (doc.receiptLines.length) {
    const itemIds = (await tx.goodsReceiptLine.findMany({ where: { id: { in: doc.receiptLines }, inventoryItemId: { not: null } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] }))
      .map((l) => l.inventoryItemId!).filter(Boolean)
    if (itemIds.length) add(await tx.inventoryItem.findMany({ where: { id: { in: itemIds }, tenantId: other }, select: { tenantId: true }, distinct: ['tenantId'] }))
    add(await tx.stockLot.findMany({ where: { receiptLineId: { in: doc.receiptLines }, tenantId: other }, select: { tenantId: true }, distinct: ['tenantId'] }))
    add(await tx.pettyCashSpendLine.findMany({ where: { receiptLineId: { in: doc.receiptLines }, tenantId: other }, select: { tenantId: true }, distinct: ['tenantId'] }))
  }
  if (billIds.length || doc.receiptLines.length) {
    add(await tx.grniMatch.findMany({
      where: { tenantId: other, OR: [
        ...(billIds.length ? [{ billId: { in: billIds } }] : []),
        ...(doc.receiptLines.length ? [{ receiptLineId: { in: doc.receiptLines } }] : []),
      ] },
      select: { tenantId: true }, distinct: ['tenantId'],
    }))
  }
  if (doc.payments.length) {
    add(await tx.pettyCashMovement.findMany({ where: { supplierPaymentId: { in: doc.payments }, tenantId: other }, select: { tenantId: true }, distinct: ['tenantId'] }))
  }
  if (billIds.length) {
    add(await tx.supplierCreditApplication.findMany({
      where: { tenantId: other, OR: [{ billId: { in: billIds } }, { creditNoteId: { in: billIds } }] },
      select: { tenantId: true }, distinct: ['tenantId'],
    }))
  }
  // Ledger entries naming the supplier or one of its documents (references are
  // `<sourceType>:<id>[:…]`; ids are UUIDs, so a substring match is exact).
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    add(await tx.journalEntry.findMany({
      where: { tenantId: other, OR: chunk.map((id) => ({ reference: { contains: id } })) },
      select: { tenantId: true }, distinct: ['tenantId'],
    }))
  }
  return [...found]
}

/**
 * The one-time assignment. `opts` exist for tests only (an isolated target
 * name / marker / supplier set in a shared test database); boot passes none.
 */
export async function assignCompanylessSuppliers(opts: { targetName?: string; markerKey?: string; supplierIds?: string[] } = {}): Promise<AssignResult> {
  const markerKey = opts.markerKey ?? COMPANYLESS_SUPPLIERS_MARKER
  const targetName = opts.targetName ?? COMPANYLESS_SUPPLIERS_TARGET
  if (await prisma.setting.findUnique({ where: { key: markerKey } })) return { status: 'already', assigned: [], skipped: [] }

  const targets = await prisma.tenant.findMany({
    where: { name: targetName, kind: 'company', deletedAt: null },
    select: { id: true },
  })
  if (targets.length !== 1) {
    console.warn(`[suppliers] company-less supplier assignment not run: ${targets.length} target companies found (expected exactly one) — nothing changed`)
    return { status: 'no_target', targetCount: targets.length, assigned: [], skipped: [] }
  }
  const target = targets[0]!.id

  const candidates = await prisma.supplier.findMany({
    where: { tenantId: null, ...(opts.supplierIds ? { id: { in: opts.supplierIds } } : {}) },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })

  const result: AssignResult = { status: 'done', assigned: [], skipped: [] }
  let failed = 0
  for (const { id } of candidates) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${id} FOR UPDATE`
        const s = await tx.supplier.findUnique({
          where: { id },
          select: { id: true, name: true, tenantId: true, systemKind: true, assignedStaffId: true, openingBalanceCents: true, deletedAt: true },
        })
        if (!s || s.tenantId !== null) return { kind: 'gone' as const }
        // A skipped supplier is flagged under its row lock, so two boxes
        // booting together raise ONE flag (the second waits for the lock, then
        // sees the first's flag).
        const skip = async (reason: SkipReason, otherCount: number) => {
          const open = await tx.exceptionFlag.findFirst({
            where: { kind: SUPPLIER_UNASSIGNED_KIND, entityType: 'Supplier', entityId: id, status: { in: ['open', 'acknowledged'] } },
            select: { id: true },
          })
          if (!open) {
            await tx.exceptionFlag.create({
              data: {
                tenantId: target,
                kind: SUPPLIER_UNASSIGNED_KIND,
                severity: 'medium',
                title: `Supplier ${s.name} still has no company`,
                description: reason === 'system_supplier_exists'
                  ? 'A company-less system supplier was not moved: this company already has its own of that kind. Decide what to do with it by hand.'
                  : 'Not moved to this company in the one-time assignment: it already has records (stock items, receipts, payments or ledger entries) in another servd company. The CEO assigns it by hand in Procurement → Suppliers.',
                entityType: 'Supplier',
                entityId: id,
                metadata: { reason, otherCompanyCount: otherCount },
              },
            })
          }
          return { kind: 'skip' as const, reason }
        }
        if (s.systemKind) {
          const twin = await tx.supplier.findFirst({ where: { tenantId: target, systemKind: s.systemKind }, select: { id: true } })
          if (twin) return skip('system_supplier_exists', 0)
        }
        const doc = await documentIds(tx, id)
        const bills = doc.bills
        const others = await otherCompanies(tx, id, target, doc)
        if (others.length) return skip('other_company_records', others.length)

        // A buyer who does not work for GS Foods is cleared (editor rule).
        let clearBuyer = false
        if (s.assignedStaffId) {
          const works = await tx.user.findFirst({
            where: { id: s.assignedStaffId, OR: [{ tenantId: target }, { tenantMemberships: { some: { tenantId: target } } }] },
            select: { id: true },
          })
          clearBuyer = !works
        }
        const claimed = await tx.supplier.updateMany({
          where: { id, tenantId: null },
          data: { tenantId: target, ...(clearBuyer ? { assignedStaffId: null } : {}) },
        })
        if (claimed.count !== 1) return { kind: 'gone' as const }
        const receipts = await tx.goodsReceipt.updateMany({ where: { supplierId: id, tenantId: null }, data: { tenantId: target } })
        const posted = bills.length
          ? await tx.journalEntry.count({ where: { OR: bills.map((b) => ({ reference: { startsWith: `supplier.bill:${b}` } })) } })
          : 0
        // Payments made while it had no company never posted either; with
        // its unposted bills they show in GS Foods' AP ageing but not in its
        // 2010 until the CEO runs Procurement → Post unposted.
        const paidPosted = doc.payments.length
          ? await tx.journalEntry.count({ where: { reference: { in: doc.payments.map((p) => `supplier.payment:${p}`) } } })
          : 0
        return {
          kind: 'moved' as const, name: s.name, deleted: !!s.deletedAt, clearBuyer,
          receiptsStamped: receipts.count, bills: bills.length, billsWithoutEntry: Math.max(0, bills.length - posted),
          payments: doc.payments.length, paymentsWithoutEntry: Math.max(0, doc.payments.length - paidPosted),
          opening: Number(s.openingBalanceCents) !== 0,
        }
      })

      if (outcome.kind === 'gone') continue
      if (outcome.kind === 'skip') {
        result.skipped.push({ supplierId: id, reason: outcome.reason })
        continue
      }
      result.assigned.push(id)
      await audit({
        category: 'accounting',
        action: 'supplier.company_assigned',
        entity: 'Supplier',
        entityId: id,
        userId: null,
        tenantId: target,
        before: { tenantId: null },
        after: { tenantId: target },
        metadata: {
          actor: 'system', reason: 'owner 2026-10-16: all company-less suppliers to GS Foods',
          deleted: outcome.deleted, buyerCleared: outcome.clearBuyer, receiptsStamped: outcome.receiptsStamped,
          bills: outcome.bills, billsWithoutEntry: outcome.billsWithoutEntry,
          payments: outcome.payments, paymentsWithoutEntry: outcome.paymentsWithoutEntry,
        },
      })
      // The opening balance follows the supplier into GS Foods' ledger (never
      // throws; a refusal is flagged for the backfill).
      if (outcome.opening) await syncOpeningBalanceOrFlag(id)
    } catch (err) {
      // One supplier that cannot be moved never stops the others (and never
      // the boot). It stays company-less, and no marker is written, so the
      // next boot tries it again; everything already moved stays moved.
      failed++
      console.warn(`[suppliers] company-less supplier ${id} not assigned: ${(err as Error).message}`)
    }
  }
  result.failed = failed
  if (failed > 0) return result

  await prisma.setting.upsert({
    where: { key: markerKey },
    create: { key: markerKey, value: new Date().toISOString() },
    update: {},
  })
  return result
}

/** /health (public): counts only — never a company or supplier name. */
export async function companylessSupplierHealth(): Promise<{ status: 'ok' | 'warn'; detail?: string }> {
  const left = await prisma.supplier.count({ where: { tenantId: null } })
  if (left === 0) return { status: 'ok' }
  const ran = await prisma.setting.findUnique({ where: { key: COMPANYLESS_SUPPLIERS_MARKER } })
  if (!ran) {
    const n = await prisma.tenant.count({ where: { name: COMPANYLESS_SUPPLIERS_TARGET, kind: 'company', deletedAt: null } })
    return {
      status: 'warn',
      detail: `${left} supplier(s) with no company; the one-time assignment has not run (${n} matching target compan${n === 1 ? 'y' : 'ies'}, expected exactly 1) — CEO → Companies`,
    }
  }
  return { status: 'warn', detail: `${left} supplier(s) with no company, left for the CEO (records in another company) — Exceptions / Procurement → Suppliers` }
}
