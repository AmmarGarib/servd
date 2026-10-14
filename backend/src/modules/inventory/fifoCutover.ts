// The one-time FIFO cut-over per company (finance wave B, H16 / H17).
//
// Until a company is cut over, its stock is InventoryItem.currentStock at a
// moving-average unitCostCents, goods receipts booked nothing and supplier
// bills debited 1210 directly. ensureFifoCutover(tenantId) converts that
// state ONCE — at boot for every active company, and lazily from
// lib/stockLedger.ts ensureFifoReady before a company's first lot write:
//
//   step 0  (outside the transaction) the former carried-variance catch-up
//           (BK2-RV-2, applyMissedCarriedBillVariances): bills booked before
//           their goods whose carried price difference no receipt applied —
//           applied now, so the moving average is settled before it becomes
//           the cut-over lot cost. Idempotent. A refusal is LOGGED and the
//           cut-over carries on (stock writes must never wait on it); any
//           difference it leaves shows in the pre-FIFO difference (step 4).
//   ONE transaction, under pg_advisory_xact_lock('fifo_cutover:<tenantId>'),
//   with every item of the company locked in id order:
//   step 1  opening lots: one 'fifo_cutover' lot per item with stock
//           (sourceId tenantId) at unitCostCents (null → 0, listed as
//           noCost); a negative or non-numeric stock is set to 0 first and
//           audited; items that already have lots are skipped. Company-less
//           items with stock are never given lots — companyLessStockItems()
//           lists them (/health, the Unassigned worklist).
//   step 2  GoodsReceiptLine.billedQty from the legacy bills: per PO line,
//           Σ quantity of its live bills allocated to its receipt lines oldest
//           first (only rows still at 0); a no-PO receipt line counts as
//           billed (it was settled at the dock). Bill quantity beyond what
//           arrived becomes a 'pending' GrniMatch keyed by its bill line (a
//           re-run finds it and adds nothing).
//   step 3  'inventory.class_reclass:<tenantId>' (drinks and packaging out of
//           1210) and 'procurement.grni_opening:<tenantId>' (Dr 12x0 / Cr 2015
//           received-unbilled at the PO cost; Dr 2015 / Cr 12x0 billed-ahead
//           at the billed price) — accounting/inventoryPosting.ts.
//   step 4  the pre-FIFO difference per class (12x0 GL after step 3 − lot
//           value) stored in Setting 'foodcost.preFifoDiff:<tenantId>' —
//           never posted; the CEO aligns once (postFifoAlign, dry run first).
//   step 5  the marker Setting 'foodcost.fifoCutoverAt:<tenantId>' (ISO).
// A failure rolls steps 1-5 back; the next call retries.

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { INT4_MAX_CENTS, toCents } from '../../lib/money.js'
import { ledgerBalancesByCode } from '../../lib/bankAccounts.js'
import { CLASS_ACCOUNTS, COST_CLASSES, costClassOf, zeroByClass, type CostClass } from '../../lib/inventoryClass.js'
import { addLotTx, fifoCutoverKey, lockItemsTx, lotValuation, readFifoCutoverAt } from '../../lib/stockLedger.js'
import { postClassReclassTx, postGrniOpeningTx } from '../accounting/inventoryPosting.js'
import { ACCT, postJournalEntry } from '../accounting/journal.js'
import { fmtPktDate } from '../accounting/dates.js'

type Tx = Prisma.TransactionClient

const EPS = 1e-9

/** Setting key of a company's stored pre-FIFO difference (JSON Record<CostClass, number>). */
export function preFifoDiffKey(tenantId: string): string {
  return `foodcost.preFifoDiff:${tenantId}`
}

/** When the company was cut over (null = not yet) and its stored pre-FIFO difference. */
export async function readCutover(tenantId: string): Promise<{ at: Date | null; preFifoDiff: Record<CostClass, number> | null }> {
  const at = await readFifoCutoverAt(prisma, tenantId)
  const row = await prisma.setting.findUnique({ where: { key: preFifoDiffKey(tenantId) }, select: { value: true } })
  let preFifoDiff: Record<CostClass, number> | null = null
  if (row) {
    try {
      const raw = JSON.parse(row.value) as Record<string, unknown>
      const out = zeroByClass()
      for (const c of COST_CLASSES) out[c] = typeof raw[c] === 'number' && Number.isFinite(raw[c]) ? Math.round(raw[c] as number) : 0
      preFifoDiff = out
    } catch { preFifoDiff = null }
  }
  return { at, preFifoDiff }
}

/** Items with stock but no company — never given lots (the /health warning and the Unassigned worklist list them). */
export async function companyLessStockItems(): Promise<Array<{ id: string; name: string; unit: string; currentStock: number }>> {
  return prisma.inventoryItem.findMany({
    where: { tenantId: null, currentStock: { gt: 0 }, deletedAt: null },
    select: { id: true, name: true, unit: true, currentStock: true },
    orderBy: { name: 'asc' },
  })
}

/**
 * Cut the company over to FIFO lots (header). Idempotent: once the marker is
 * there it returns { ran: false, at }. Concurrent callers serialise on the
 * advisory lock; the second finds the marker.
 */
export async function ensureFifoCutover(tenantId: string): Promise<{ ran: boolean; at: Date }> {
  if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'A cut-over is per company — none was given', 422)
  const done = await readFifoCutoverAt(prisma, tenantId)
  if (done) return { ran: false, at: done }

  // Step 0 — the legacy carried-variance catch-up (best effort, logged).
  try {
    const r = await applyMissedCarriedBillVariances({ tenantIds: [tenantId], dryRun: false })
    const bad = r.rows.filter((x) => x.outcome === 'error' || x.outcome === 'locked')
    if (bad.length > 0) console.warn(`[fifoCutover] ${tenantId}: carried-variance catch-up left ${bad.length} line(s): ${bad.map((b) => b.detail).join('; ').slice(0, 500)}`)
  } catch (err) {
    console.warn(`[fifoCutover] ${tenantId}: carried-variance catch-up failed — ${(err as Error).message}`)
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fifo_cutover:${tenantId}`}::text))`
    const again = await readFifoCutoverAt(tx, tenantId)
    if (again) return { ran: false, at: again }
    const at = new Date()

    // ── Step 1: opening lots ──
    const items = await tx.inventoryItem.findMany({
      where: { tenantId },
      select: { id: true, name: true, currentStock: true, unitCostCents: true, category: true },
      orderBy: { id: 'asc' },
    })
    await lockItemsTx(tx, items.map((i) => i.id))
    const withLots = new Set((await tx.stockLot.groupBy({ by: ['inventoryItemId'], where: { tenantId } })).map((g) => g.inventoryItemId))
    const lotByClass = zeroByClass()
    const noCost: string[] = []
    const fixed: Array<{ id: string; name: string; was: number }> = []
    for (const it of items) {
      let stock = it.currentStock
      if (!Number.isFinite(stock) || stock < 0) {
        fixed.push({ id: it.id, name: it.name, was: Number.isFinite(stock) ? stock : Number.NaN })
        await tx.inventoryItem.update({ where: { id: it.id }, data: { currentStock: 0 } })
        stock = 0
      }
      if (withLots.has(it.id) || !(stock > EPS)) continue
      let cost = it.unitCostCents
      if (cost == null) { noCost.push(it.id); cost = 0 }
      cost = Math.min(INT4_MAX_CENTS, Math.max(0, Math.round(cost)))
      await addLotTx(tx, {
        tenantId, inventoryItemId: it.id, qty: stock, unitCostCents: cost,
        kind: 'fifo_cutover', lotSourceType: 'fifo_cutover', lotSourceId: tenantId,
        movementSourceType: 'fifo_cutover', movementSourceId: tenantId, receivedAt: at,
      })
      lotByClass[costClassOf(it.category)] += Math.round(stock * cost)
    }
    if (fixed.length > 0) {
      await tx.auditLog.create({
        data: {
          category: 'accounting', tenantId, action: 'inventory.fifo_cutover.stock_reset', entity: 'InventoryItem',
          metadata: { reason: 'negative or non-numeric stock set to 0 before the FIFO cut-over', items: fixed.map((f) => ({ ...f, was: Number.isFinite(f.was) ? f.was : 'NaN' })) } as Prisma.InputJsonValue,
        },
      })
    }

    // ── Step 2: billed quantity per PO line; billed-ahead → pending matches ──
    const received = zeroByClass()
    const billedAhead = zeroByClass()
    const poLines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrder: { supplier: { tenantId } } },
      select: { id: true, inventoryItem: { select: { category: true, tenantId: true } } },
    })
    for (const pl of poLines) {
      if (pl.inventoryItem.tenantId && pl.inventoryItem.tenantId !== tenantId) continue
      const cls = costClassOf(pl.inventoryItem.category)
      const rls = await tx.goodsReceiptLine.findMany({
        where: { poLineId: pl.id, receipt: { receivedAt: { lte: at } } },
        orderBy: [{ receipt: { receivedAt: 'asc' } }, { id: 'asc' }],
        select: { id: true, receivedQty: true, billedQty: true, poUnitCostCents: true, lotUnitCostCents: true },
      })
      const billLines = await tx.supplierBillLine.findMany({
        where: { poLineId: pl.id, bill: { kind: 'bill', status: { not: 'void' }, createdAt: { lt: at }, supplier: { tenantId } } },
        orderBy: [{ bill: { createdAt: 'asc' } }, { id: 'asc' }],
        select: { id: true, billId: true, quantity: true, unitCostCents: true, lineTotalCents: true },
      })
      const legacyBilled = billLines.reduce((s, l) => s + Math.max(0, l.quantity), 0)
      let left = legacyBilled
      let receivedQty = 0
      for (const rl of rls) {
        receivedQty += rl.receivedQty
        let billed = rl.billedQty
        if (billed > EPS) {
          left -= billed
        } else {
          billed = Math.min(rl.receivedQty, Math.max(0, left))
          if (billed > EPS) await tx.goodsReceiptLine.update({ where: { id: rl.id }, data: { billedQty: billed } })
          left -= billed
        }
        const open = rl.receivedQty - billed
        if (open > EPS) received[cls] += Math.round(open * (rl.poUnitCostCents ?? rl.lotUnitCostCents ?? 0))
      }
      // Bill quantity beyond what arrived, oldest bill first covered by receipts.
      let covered = receivedQty
      for (const bl of billLines) {
        const c = Math.min(Math.max(0, bl.quantity), Math.max(0, covered))
        covered -= c
        const ahead = bl.quantity - c
        if (!(ahead > EPS)) continue
        if (await tx.grniMatch.findFirst({ where: { billLineId: bl.id }, select: { id: true } })) continue
        const lineTotal = toCents(bl.lineTotalCents)
        const grni = ahead >= bl.quantity - EPS ? lineTotal : Math.round((lineTotal * ahead) / bl.quantity)
        await tx.grniMatch.create({
          data: {
            tenantId, billId: bl.billId, billLineId: bl.id, receiptLineId: null, poLineId: pl.id, qty: ahead,
            billedUnitCostCents: Math.min(INT4_MAX_CENTS, Math.max(0, toCents(bl.unitCostCents))), grniCents: grni, status: 'pending',
          },
        })
        billedAhead[cls] += grni
      }
    }
    // A receipt without a PO was settled at the dock: billed.
    const supplierIds = (await tx.supplier.findMany({ where: { tenantId }, select: { id: true } })).map((s) => s.id)
    await tx.$executeRaw`
      UPDATE goods_receipt_lines l SET "billedQty" = l."receivedQty"
        FROM goods_receipts r
       WHERE r.id = l."receiptId" AND l."poLineId" IS NULL AND l."billedQty" = 0 AND r."receivedAt" <= ${at}
         AND (r."tenantId" = ${tenantId} OR (r."tenantId" IS NULL AND r."supplierId" = ANY(${supplierIds}::text[])))`

    // ── Step 3: opening entries ──
    await postClassReclassTx(tx, tenantId, { food: 0, beverage: lotByClass.beverage, packaging: lotByClass.packaging })
    await postGrniOpeningTx(tx, tenantId, { received, billedAhead })

    // ── Step 4: the pre-FIFO difference (never posted) ──
    const lots = await lotValuation(tx, tenantId)
    const gl = await ledgerBalancesByCode(tenantId, COST_CLASSES.map((c) => CLASS_ACCOUNTS[c].inv), { db: tx })
    const diff = zeroByClass()
    for (const c of COST_CLASSES) diff[c] = (gl.get(CLASS_ACCOUNTS[c].inv) ?? 0) - lots[c]
    await tx.setting.upsert({
      where: { key: preFifoDiffKey(tenantId) },
      create: { key: preFifoDiffKey(tenantId), value: JSON.stringify(diff) },
      update: { value: JSON.stringify(diff) },
    })
    if (noCost.length > 0) console.warn(`[fifoCutover] ${tenantId}: ${noCost.length} item(s) had no cost — cut over at 0`)

    // ── Step 5: the marker ──
    await tx.setting.upsert({
      where: { key: fifoCutoverKey(tenantId) },
      create: { key: fifoCutoverKey(tenantId), value: at.toISOString() },
      update: { value: at.toISOString() },
    })
    return { ran: true, at }
  }, { timeout: 180_000, maxWait: 30_000 })
}

// ─── Step 0: the legacy carried-variance catch-up (BK2-RV-2) ─────────────────
//
// Moved here from accounting/supplierPosting.ts with the moving-average
// machinery it needs. Before FIFO, a bill booked before its goods carried its
// price variance for the not-yet-received quantity ('supplier.bill.variance'
// audit rows); receiving applied it (RB-3) — but receipts made before that
// release never did. Per PO line of the company's live bills that still carry
// quantity: the received quantity no live bill has matched (at most the
// carried quantity not yet applied) is applied: the share still on hand
// re-averages the item, the rest goes to 5060 / 1210, dated today. Runs only
// while the company is NOT cut over (after it, item cost is the FIFO head).

const VARIANCE_ACTION = 'supplier.bill.variance'
const APPLIED_ACTION  = 'supplier.bill.variance_applied'

interface BillVarianceRecordLine {
  poLineId: string; inventoryItemId: string; billedQty: number; receivedQty: number; varianceCents: number
  absorbedCents: number; onHandAtPosting: number; usedCents: number; carriedQty: number; carriedCents: number
}
interface AppliedRecord {
  poLineId: string; qty: number; targetCents: number; absorbedCents: number; onHand: number
  usedCents?: number; receiptId?: string | null; at?: Date
}

async function varianceRecordsOf(tx: Tx, billIds: string[]) {
  const recorded = new Map<string, BillVarianceRecordLine[]>()
  const applied  = new Map<string, AppliedRecord[]>()
  if (billIds.length === 0) return { recorded, applied }
  const rows = await tx.auditLog.findMany({
    where:   { entity: 'SupplierBill', entityId: { in: billIds }, action: { in: [VARIANCE_ACTION, APPLIED_ACTION] } },
    orderBy: { createdAt: 'asc' },
    select:  { entityId: true, action: true, metadata: true, createdAt: true },
  })
  for (const r of rows) {
    const m = (r.metadata ?? {}) as { lines?: BillVarianceRecordLine[] } & Partial<AppliedRecord>
    if (r.action === VARIANCE_ACTION) recorded.set(r.entityId!, m.lines ?? [])
    else if (m.poLineId) applied.set(r.entityId!, [...(applied.get(r.entityId!) ?? []), { ...(m as AppliedRecord), at: r.createdAt }])
  }
  return { recorded, applied }
}

/** Quantity of an item received strictly after `after`, leaving out `excludeReceiptId`. */
async function receivedSince(tx: Tx, inventoryItemId: string, after: Date, excludeReceiptId: string | null): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ qty: number | null }>>`
    SELECT COALESCE(SUM(l."receivedQty"), 0)::float8 AS qty
      FROM goods_receipt_lines l
      JOIN goods_receipts r ON r.id = l."receiptId"
     WHERE l."inventoryItemId" = ${inventoryItemId}
       AND r."receivedAt" > ${after}
       AND (${excludeReceiptId}::text IS NULL OR r.id <> ${excludeReceiptId}::text)`
  return Math.max(0, Number(rows[0]?.qty ?? 0))
}

/** Quantity of a PO line already matched by live bills (recorded at posting + applied by receipts; a bill with no record counts its billed quantity). */
async function matchedByBills(tx: Tx, poLineId: string): Promise<number> {
  const lines = await tx.supplierBillLine.findMany({
    where:  { poLineId, bill: { kind: 'bill', status: { not: 'void' } } },
    select: { billId: true, quantity: true },
  })
  if (lines.length === 0) return 0
  const { recorded, applied } = await varianceRecordsOf(tx, [...new Set(lines.map((o) => o.billId))])
  let matched = 0
  const counted = new Set<string>()
  for (const o of lines) {
    const rec = recorded.get(o.billId)
    if (!rec) { matched += o.quantity; continue }
    if (counted.has(o.billId)) continue
    counted.add(o.billId)
    matched += rec.filter((l) => l.poLineId === poLineId).reduce((s, l) => s + l.receivedQty, 0)
    matched += (applied.get(o.billId) ?? []).filter((a) => a.poLineId === poLineId).reduce((s, a) => s + a.qty, 0)
  }
  return matched
}

/** Move the value of an item's stock on hand by `targetCents` (moving average). Returns what valuation moved by. */
async function revalueItem(tx: Tx, input: { inventoryItemId: string; poLineId: string; targetCents: number; supplierId: string }): Promise<{ moved: number }> {
  await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${input.inventoryItemId} FOR UPDATE`
  const item = await tx.inventoryItem.findUnique({ where: { id: input.inventoryItemId }, select: { id: true, name: true, currentStock: true, unitCostCents: true } })
  const onHand = Math.max(0, item?.currentStock ?? 0)
  if (!item || item.unitCostCents == null || input.targetCents === 0 || !(onHand > 0)) return { moved: 0 }
  const oldCost = item.unitCostCents
  const newCost = Math.max(0, Math.round((oldCost * onHand + input.targetCents) / onHand))
  if (newCost === oldCost) return { moved: 0 }
  if (!Number.isFinite(newCost) || newCost > INT4_MAX_CENTS) {
    throw new AppError('AMOUNT_TOO_LARGE', `${item.name}'s unit cost after the catch-up would exceed what a unit cost can be`, 422)
  }
  await tx.inventoryItem.update({ where: { id: item.id }, data: { unitCostCents: newCost } })
  await tx.itemPriceHistory.create({
    data: { inventoryItemId: item.id, supplierId: input.supplierId, oldCostCents: oldCost, newCostCents: newCost, source: 'bill_match', poLineId: input.poLineId },
  })
  return { moved: Math.round((newCost - oldCost) * onHand) }
}

/** Apply `quantity` of a PO line's carried bill variance (oldest bill first). Returns what valuation moved by. */
async function applyCarriedTx(tx: Tx, input: { poLineId: string; quantity: number; supplierId: string; onHandQty: number }): Promise<number> {
  const billLines = await tx.supplierBillLine.findMany({
    where:   { poLineId: input.poLineId, bill: { kind: 'bill', status: { not: 'void' } } },
    select:  { billId: true, bill: { select: { billNumber: true, supplier: { select: { tenantId: true } } } } },
    orderBy: { bill: { createdAt: 'asc' } },
  })
  const billIds = [...new Set(billLines.map((b) => b.billId))]
  if (billIds.length === 0) return 0
  const { recorded, applied } = await varianceRecordsOf(tx, billIds)
  const onHandShare = Math.min(Math.max(0, input.onHandQty), input.quantity) / input.quantity
  let left = input.quantity
  let movedCents = 0
  for (const billId of billIds) {
    if (!(left > 0)) break
    const rec = (recorded.get(billId) ?? []).filter((l) => l.poLineId === input.poLineId)
    const done = (applied.get(billId) ?? []).filter((a) => a.poLineId === input.poLineId)
    let doneQty   = done.reduce((s, a) => s + a.qty, 0)
    let doneCents = done.reduce((s, a) => s + a.targetCents, 0)
    for (const line of rec) {
      if (!(left > 0)) break
      if (!(line.carriedQty > 1e-9)) continue
      if (doneQty >= line.carriedQty - 1e-9) { doneQty -= line.carriedQty; doneCents -= line.carriedCents; continue }
      const remainingQty   = line.carriedQty - doneQty
      const remainingCents = line.carriedCents - doneCents
      doneQty = 0; doneCents = 0
      const qty = Math.min(left, remainingQty)
      const targetCents = qty >= remainingQty - 1e-9 ? remainingCents : Math.round(remainingCents * qty / remainingQty)
      left -= qty
      const onHandTarget = onHandShare >= 1 ? targetCents : Math.round(targetCents * onHandShare)
      const { moved: absorbedCents } = await revalueItem(tx, { inventoryItemId: line.inventoryItemId, poLineId: input.poLineId, targetCents: onHandTarget, supplierId: input.supplierId })
      movedCents += absorbedCents
      const usedCents = targetCents - absorbedCents
      const bill = billLines.find((b) => b.billId === billId)?.bill
      const tenantId = bill?.supplier.tenantId ?? null
      const appliedRow = await tx.auditLog.create({
        data: {
          category: 'accounting', tenantId, action: APPLIED_ACTION, entity: 'SupplierBill', entityId: billId,
          metadata: { poLineId: input.poLineId, qty, targetCents, absorbedCents, onHand: input.onHandQty, usedCents, receiptId: null } as Prisma.InputJsonValue,
        },
      })
      if (usedCents !== 0 && tenantId) {
        const memo = `Price difference on bill ${bill?.billNumber ?? billId} for received stock already used`
        await postJournalEntry({
          tenantId, sourceType: 'supplier.bill.variance.receipt', sourceId: appliedRow.id,
          description: `Bill ${bill?.billNumber ?? billId}: price difference on goods received after the bill (FIFO cut-over catch-up)`,
          postedBy: 'system',
          lines: usedCents > 0
            ? [{ accountCode: ACCT.COST_ADJUSTMENT, type: 'debit',  amountCents: usedCents,  memo },
               { accountCode: ACCT.INVENTORY_FOOD,  type: 'credit', amountCents: usedCents,  memo }]
            : [{ accountCode: ACCT.INVENTORY_FOOD,  type: 'debit',  amountCents: -usedCents, memo },
               { accountCode: ACCT.COST_ADJUSTMENT, type: 'credit', amountCents: -usedCents, memo }],
        }, { tx })
      }
    }
  }
  return movedCents
}

export type MissedVarianceOutcome = 'would_apply' | 'applied' | 'locked' | 'error' | 'cut_over'
export interface MissedVarianceRow {
  tenantId: string; poLineId: string; quantity: number; onHandQty: number; movedCents: number | null
  outcome: MissedVarianceOutcome; detail: string; billNumbers: string[]; itemName: string | null
}

/**
 * The catch-up itself (step 0). One company at a time, each PO line in its
 * own transaction under its PO's lock; `dryRun` only reports. A company
 * already cut over is skipped ('cut_over'): its item cost is the FIFO head.
 */
export async function applyMissedCarriedBillVariances(opts: { tenantIds: string[]; dryRun: boolean; now?: Date }): Promise<{
  rows: MissedVarianceRow[]
  summary: { lines: number; quantity: number } & Partial<Record<MissedVarianceOutcome, number>>
}> {
  const rows: MissedVarianceRow[] = []
  const now = opts.now ?? new Date()
  for (const tenantId of opts.tenantIds) {
    if (await readFifoCutoverAt(prisma, tenantId)) continue
    const lock = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
    const lockedNote = lock && now <= lock.lockedThrough
      ? `books are closed through ${fmtPktDate(lock.lockedThrough)} — the catch-up posts dated today; reopen the period to apply it`
      : null
    const live = await prisma.supplierBill.findMany({ where: { kind: 'bill', status: { not: 'void' }, supplier: { tenantId } }, select: { id: true } })
    const { recorded } = await prisma.$transaction((tx) => varianceRecordsOf(tx, live.map((b) => b.id)))
    const poLineIds = new Set<string>()
    for (const lines of recorded.values()) for (const l of lines) if (l.carriedQty > 1e-9) poLineIds.add(l.poLineId)
    for (const poLineId of poLineIds) {
      const measure = async (tx: Tx) => {
        await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = (SELECT "purchaseOrderId" FROM purchase_order_lines WHERE id = ${poLineId}) FOR UPDATE`
        const pl = await tx.purchaseOrderLine.findUnique({
          where:  { id: poLineId },
          select: { quantityReceived: true, inventoryItemId: true, purchaseOrderId: true, purchaseOrder: { select: { supplierId: true } }, inventoryItem: { select: { name: true } } },
        })
        if (!pl) return null
        const billRows = await tx.supplierBillLine.findMany({
          where: { poLineId, bill: { kind: 'bill', status: { not: 'void' }, supplier: { tenantId } } }, select: { billId: true, bill: { select: { billNumber: true } } },
        })
        const billIds = [...new Set(billRows.map((b) => b.billId))]
        const billNumbers = [...new Set(billRows.map((b) => b.bill.billNumber))]
        const { recorded: rec, applied } = await varianceRecordsOf(tx, billIds)
        let carriedLeft = 0
        for (const id of billIds) {
          carriedLeft += (rec.get(id) ?? []).filter((l) => l.poLineId === poLineId).reduce((s, l) => s + l.carriedQty, 0)
          carriedLeft -= (applied.get(id) ?? []).filter((a) => a.poLineId === poLineId).reduce((s, a) => s + a.qty, 0)
        }
        const unmatched = pl.quantityReceived - await matchedByBills(tx, poLineId)
        const quantity  = Math.min(Math.max(0, unmatched), Math.max(0, carriedLeft))
        if (!(quantity > 1e-9)) return null
        const last = await tx.goodsReceipt.findFirst({
          where:   { poId: pl.purchaseOrderId, lines: { some: { inventoryItemId: pl.inventoryItemId } } },
          orderBy: { receivedAt: 'desc' },
          select:  { id: true, receivedAt: true },
        })
        await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${pl.inventoryItemId} FOR UPDATE`
        const item = await tx.inventoryItem.findUnique({ where: { id: pl.inventoryItemId }, select: { currentStock: true } })
        const since = last ? await receivedSince(tx, pl.inventoryItemId, last.receivedAt, last.id) : 0
        const onHandQty = Math.min(quantity, Math.max(0, (item?.currentStock ?? 0) - since))
        return { pl, quantity, onHandQty, billNumbers }
      }
      const base = (m: NonNullable<Awaited<ReturnType<typeof measure>>>) => ({
        tenantId, poLineId, quantity: m.quantity, onHandQty: m.onHandQty, billNumbers: m.billNumbers, itemName: m.pl.inventoryItem?.name ?? null,
      })
      try {
        await prisma.$transaction(async (tx) => {
          const m = await measure(tx)
          if (!m) return
          if (lockedNote) { rows.push({ ...base(m), movedCents: null, outcome: 'locked', detail: lockedNote }); return }
          if (opts.dryRun) { rows.push({ ...base(m), movedCents: null, outcome: 'would_apply', detail: `${m.quantity} received, ${m.onHandQty} still on hand` }); return }
          const movedCents = await applyCarriedTx(tx, { poLineId, quantity: m.quantity, supplierId: m.pl.purchaseOrder.supplierId, onHandQty: m.onHandQty })
          rows.push({ ...base(m), movedCents, outcome: 'applied', detail: `${m.quantity} received, ${m.onHandQty} still on hand` })
        }, { timeout: 30_000 })
      } catch (err) {
        const e = err as { code?: string; message?: string }
        rows.push({
          tenantId, poLineId, quantity: 0, onHandQty: 0, movedCents: null, billNumbers: [], itemName: null,
          outcome: e.code === 'PERIOD_LOCKED' ? 'locked' : 'error', detail: e.message ?? String(err),
        })
      }
    }
  }
  const summary: { lines: number; quantity: number } & Partial<Record<MissedVarianceOutcome, number>> = {
    lines: rows.length, quantity: rows.reduce((s, r) => s + r.quantity, 0),
  }
  for (const r of rows) summary[r.outcome] = (summary[r.outcome] ?? 0) + 1
  return { rows, summary }
}
