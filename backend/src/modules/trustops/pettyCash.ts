// Petty cash — the pieces shared by the petty-cash routes (routes.ts) and the
// cash vouchers / cash requests (cashVouchers.ts).
//
//   • CASH_KEEPERS / CASH_GUARD — who may run petty cash (see routes.ts for
//     the wave-3 reasoning): the manager tiers plus finance, finance only
//     while it holds the 'accounting' module.
//   • The movement writers — THE only code that writes a PettyCashMovement or
//     moves a box's float. Every one of them goes through writeMovementTx,
//     which stamps the movement (company, source, counter account, bank,
//     drawer, request, brand, transfer ref), writes its spend lines and books
//     it through the ONE poster (accounting/pettyCashPosting.ts
//     postPettyCashMovementTx) — inside the caller's transaction, so a closed
//     period (422 PERIOD_LOCKED) rolls the movement and the float back
//     together:
//       recordPettyCashSpendTx    — a spend (manual, a bill paid in cash, a
//                                   legacy cash request paid: expensed to its
//                                   category, H3; a cash voucher paid since
//                                   2026-10-15: held on 1357 until finance
//                                   verifies its documents). THE one way
//                                   money leaves a box. Its lines may be expense, STOCK (a
//                                   settled goods receipt, Dr 12x0) or CAPEX
//                                   (a CapEx cash payment, Dr 1340).
//       recordPettyCashTopupTx    — a top-up (Garibsons cashier, safe, bank,
//                                   till drawer, change returned on a cash
//                                   request), and a new box's opening float
//       recordPettyCashReturnTx   — cash handed back out of a box (safe, bank,
//                                   Garibsons)
//       recordPettyCashTransferTx — box → box, same company (two movements, no
//                                   entry: both boxes sit on 1011)
//       recordPettyCashCountTx    — a physical count (variance → 8010)
// Float changes are always relative and conditional (`floatCents >= amount`
// for money out), never "set to what we read".
//
// Ledger (H1–H3, accounting/pettyCashPosting.ts has the table): 1011 Petty
// Cash against 2210 Due to Garibsons / 1010 safe / the bank's code / 1015
// drawer / a cash request's paid account (change returned) / 8010 / the spend
// lines' codes (6xxx, 12x0; 1340 through the CapEx payment).

import { randomBytes } from 'node:crypto'
import type { Prisma, PettyCashMovement, UserRole } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import { requireAuth, FINANCE_TEAM, MANAGERS } from '../auth/middleware.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { assertInt4Fits } from '../../lib/money.js'
import { serviceClient } from '../../lib/prisma.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { ensureFifoReady, readFifoCutoverAt } from '../../lib/stockLedger.js'
import { ACCT } from '../accounting/journal.js'
import {
  bookCashLinesTx, cashCounterAccountTx, cashRequestBrandTx, cashRequestPaidAccountTx, postPettyCashMovementTx, resolveSpendLinesTx, spendLineData,
  type ResolvedSpendLine, type SpendLineInput, type TopupSource, type ReturnDestination,
} from '../accounting/pettyCashPosting.js'
import { recordDrawerToBoxTx } from '../pos/drawerToBox.js'

export const CASH_KEEPERS: UserRole[] = FINANCE_TEAM
/** The Module Access half of CASH_GUARD (manager tiers exempt). */
export const CASH_MODULE_GATE = moduleGateForNewRoles(['accounting'])
export const CASH_GUARD = [requireAuth(...CASH_KEEPERS), CASH_MODULE_GATE]

/**
 * True when the signed-in user would pass CASH_GUARD — for routes that also
 * admit someone else (a box's custodian), so they run `requireAuth(ALL_STAFF)`
 * and decide here. Never throws for "no": only a real failure propagates.
 */
export async function passesCashGuard(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser
  if (!su || !CASH_KEEPERS.includes(su.role)) return false
  try {
    await CASH_MODULE_GATE(req)
    return true
  } catch (err) {
    if (err instanceof ForbiddenError) return false
    throw err
  }
}

/**
 * May this login book goods into stock with cash (a stock line on a box spend
 * or a cash-request settlement)? A cash keeper (CASH_GUARD's rule), or a role
 * that holds the inventory module (Module Access: role default/override,
 * + moduleAllow, − moduleDeny).
 */
export async function mayBuyStock(actor: { id: string }): Promise<boolean> {
  const u = await serviceClient.user.findUnique({ where: { id: actor.id }, select: { role: true, moduleAllow: true, moduleDeny: true } })
  if (!u) return false
  const modules = await effectiveModulesForUser(u)
  const keeper = CASH_KEEPERS.includes(u.role) && (MANAGERS.includes(u.role) || modules.has('accounting'))
  return keeper || modules.has('inventory')
}

const pkrWhole = (cents: number) => `PKR ${(cents / 100).toFixed(0)}`

/** 400 INSUFFICIENT_FLOAT — the one wording, for the pre-check and the claim. */
export function insufficientFloatError(spendCents: number, floatCents: number): AppError {
  return new AppError(
    'INSUFFICIENT_FLOAT',
    `This spend of ${pkrWhole(spendCents)} exceeds box float of ${pkrWhole(floatCents)}.`,
    400,
  )
}

/** What a movement row says it is. The API's /movements takes only topup|spend. */
export type PettyCashMovementType = 'topup' | 'spend' | 'reconcile' | 'transfer' | 'return'

interface MovementRow {
  boxId: string
  type: PettyCashMovementType
  /** Signed paisa: + into the box, − out of it. */
  amountCents: number
  category?: string | null
  reason: string
  receiptUrl?: string | null
  vendorName?: string | null
  approvedById?: string | null
  supplierPaymentId?: string | null
  createdById: string
  // ── Petty cash in the ledger (wave B) ──
  source?: string | null
  /** The counter account of the posting (2210 / 1010 / bank / 1015 / a cash request's paid account / 8010 …). */
  accountCode?: string | null
  bankAccountId?: string | null
  shiftId?: string | null
  cashMovementId?: string | null
  cashVoucherId?: string | null
  conceptId?: string | null
  transferRef?: string | null
  /** Expense lines of a spend (already resolved in the box's company). */
  lines?: ResolvedSpendLine[]
}

/**
 * The box's company, or 404 / 422 BOX_HAS_NO_COMPANY — read FIRST by every
 * writer, before any float moves (a company-less box can never be booked).
 */
async function boxCompanyTx(tx: Prisma.TransactionClient, boxId: string): Promise<{ tenantId: string; name: string; conceptId: string | null }> {
  const box = await tx.pettyCashBox.findFirst({ where: { id: boxId, deletedAt: null }, select: { tenantId: true, name: true, conceptId: true } })
  if (!box) throw new NotFoundError('PettyCashBox', boxId)
  if (!box.tenantId) throw new AppError('BOX_HAS_NO_COMPANY', `Petty-cash box "${box.name}" belongs to no company — it cannot be used`, 422)
  return { tenantId: box.tenantId, name: box.name, conceptId: box.conceptId }
}

/**
 * THE one place a petty-cash movement row is written. Every writer below calls
 * it inside its transaction, after the float has moved: the row (stamped with
 * the box's company), its spend lines, then the ledger posting
 * (postPettyCashMovementTx, which stamps journalEntryId).
 */
async function writeMovementTx(tx: Prisma.TransactionClient, row: MovementRow): Promise<PettyCashMovement> {
  assertInt4Fits(row.amountCents, 'A petty-cash movement')
  const { tenantId } = await boxCompanyTx(tx, row.boxId)
  const movement = await tx.pettyCashMovement.create({
    data: {
      boxId: row.boxId,
      tenantId,
      type: row.type,
      amountCents: row.amountCents,
      category: row.category ?? null,
      reason: row.reason,
      receiptUrl: row.receiptUrl ?? null,
      vendorName: row.vendorName ?? null,
      approvedById: row.approvedById ?? null,
      supplierPaymentId: row.supplierPaymentId ?? null,
      createdById: row.createdById,
      source: row.source ?? null,
      accountCode: row.accountCode ?? null,
      bankAccountId: row.bankAccountId ?? null,
      shiftId: row.shiftId ?? null,
      cashMovementId: row.cashMovementId ?? null,
      cashVoucherId: row.cashVoucherId ?? null,
      conceptId: row.conceptId ?? null,
      transferRef: row.transferRef ?? null,
    },
  })
  if (row.lines && row.lines.length > 0) {
    // One at a time, in order, so the lines keep the order they were entered in.
    const lineIds: string[] = []
    for (const l of row.lines) {
      const created = await tx.pettyCashSpendLine.create({ data: { ...spendLineData(tenantId, l), movementId: movement.id }, select: { id: true } })
      lineIds.push(created.id)
    }
    // Stock lines → a settled goods receipt; capex lines → CapEx cash payments (Cr 1011).
    if (row.lines.some((l) => l.kind !== 'expense')) {
      await bookCashLinesTx(tx, {
        tenantId, doc: { kind: 'petty_cash_movement', id: movement.id }, creditCode: ACCT.PETTY_CASH,
        lineIds, occurredAt: movement.createdAt, actorId: row.createdById,
      })
    }
  }
  await postPettyCashMovementTx(tx, movement.id)
  return tx.pettyCashMovement.findUniqueOrThrow({ where: { id: movement.id } })
}

/**
 * Move a box's float by `delta` (signed) and return the new float. Money out
 * only when the float still covers it — checked and applied in ONE conditional
 * update, so two writers racing on the same box can never take it below zero
 * (400 INSUFFICIENT_FLOAT; the caller's transaction rolls back). Relative,
 * never "set to what we read", so a racing writer is never overwritten.
 */
async function moveFloatTx(tx: Prisma.TransactionClient, boxId: string, delta: number): Promise<number> {
  const moved = await tx.pettyCashBox.updateMany({
    where: { id: boxId, deletedAt: null, ...(delta < 0 && { floatCents: { gte: -delta } }) },
    data: { floatCents: { increment: delta } },
  })
  if (moved.count === 0) {
    const current = await tx.pettyCashBox.findFirst({ where: { id: boxId, deletedAt: null }, select: { floatCents: true } })
    if (!current) throw new NotFoundError('PettyCashBox', boxId)
    throw insufficientFloatError(-delta, current.floatCents)
  }
  const after = await tx.pettyCashBox.findUniqueOrThrow({ where: { id: boxId }, select: { floatCents: true } })
  return after.floatCents
}

function assertPositiveAmount(amount: number, what: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError('BAD_AMOUNT', `${what} must be a whole amount above zero`, 400)
  }
  assertInt4Fits(amount, what)
}

export interface PettyCashSpendInput {
  /** The box, already resolved in the caller's company scope. */
  box: { id: string }
  /** What leaves the box, in paisa — positive. Stored negative on the movement. */
  amountCents: number
  category?: string | null
  reason: string
  vendorName?: string | null
  approvedById?: string | null
  createdById: string
  receiptUrl?: string | null
  /** Set when the spend paid a supplier bill (procurement createPaymentTx). */
  supplierPaymentId?: string | null
}

export type SpendNature = 'expense' | 'bill'

export interface PettyCashSpendOptions {
  /**
   * What the spend is:
   *   'expense' — lines (`lines`): expense Dr 6xxx, stock Dr 12x0 (a settled
   *               goods receipt), capex Dr 1340 (its own CapEx payment) /
   *               Cr 1011. A cash request paid is one expense line in its
   *               category (pettyCashPosting.ts cashRequestPayLine, H3).
   *   'bill'    — paid a supplier bill (`supplierPaymentId`; the payment
   *               booked Dr 2010 / Cr 1010, this books Dr 1010 / Cr 1011).
   *   (The 2026-10-15 'voucher_hold' nature — Dr 1357 / Cr 1011 — is
   *   retired, owner 2026-10-16: nothing posts to 1357 any more.)
   * Omitted: 'bill' when supplierPaymentId is set, else 'expense'.
   */
  nature?: SpendNature
  lines?: SpendLineInput[]
  cashVoucherId?: string
  conceptId?: string | null
  /** Who records it — the equipment override is finance / CEO only. */
  actor?: { id: string; role: string }
  /** A cash keeper may book a line to an explicit 6xxx code. */
  allowExplicit?: boolean
  /** May book stock lines; omitted → mayBuyStock(actor ?? createdById). */
  stockAllowed?: boolean
  /** false only for a cash request's pay (its receipts place equipment on CapEx). */
  equipmentCheck?: boolean
}

/**
 * Record a petty-cash spend inside `tx`: validate its lines in the box's
 * company, lower the box's float (conditional — 400 INSUFFICIENT_FLOAT), write
 * the 'spend' movement (its stock lines become a settled goods receipt, its
 * capex lines CapEx cash payments) and book it. THE one way money leaves a
 * box: the manual spend (POST /trustops/petty-cash/movements), a bill paid
 * from a box and a cash request paid all come here. A spend with stock lines
 * needs the company on FIFO lots: the caller runs ensureFifoReady before its
 * transaction (it is run here as a fallback, before anything is written).
 */
export async function recordPettyCashSpendTx(
  tx: Prisma.TransactionClient,
  input: PettyCashSpendInput & PettyCashSpendOptions,
): Promise<{ movementId: string; movement: PettyCashMovement; newFloatCents: number; lines: ResolvedSpendLine[] }> {
  assertPositiveAmount(input.amountCents, 'A petty-cash spend')
  const box = await boxCompanyTx(tx, input.box.id)
  const nature: SpendNature = input.nature ?? (input.supplierPaymentId ? 'bill' : 'expense')
  let lines: ResolvedSpendLine[] = []
  let accountCode: string | null = null
  if (input.conceptId) {
    const c = await tx.concept.findFirst({ where: { id: input.conceptId, tenantId: box.tenantId }, select: { id: true } })
    if (!c) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand is not one of this box\'s company\'s', 422)
  }
  if (nature === 'expense') {
    const actor = input.actor ?? { id: input.createdById, role: '' }
    const wantsStock = (input.lines ?? []).some((l) => l.kind === 'stock')
    lines = await resolveSpendLinesTx(tx, box.tenantId, input.lines ?? [], {
      allowExplicit: input.allowExplicit ?? false,
      actor,
      stockAllowed: wantsStock ? (input.stockAllowed ?? await mayBuyStock(actor)) : false,
      equipmentCheck: input.equipmentCheck,
    })
    const total = lines.reduce((s, l) => s + l.amountCents, 0)
    if (total !== input.amountCents) {
      throw new AppError('LINES_DONT_ADD_UP', `The lines add up to ${pkrWhole(total)}, the spend is ${pkrWhole(input.amountCents)}`, 400)
    }
    // Fallback only — the callers run it before their transaction. Nothing is
    // written yet, so the cut-over's own transaction waits on no lock of ours.
    if (wantsStock && !(await readFifoCutoverAt(tx, box.tenantId))) await ensureFifoReady(box.tenantId)
  } else if (nature === 'bill') {
    if (!input.supplierPaymentId) throw new AppError('BILL_PAYMENT_REQUIRED', 'A bill spend must carry its supplier payment', 400)
    if (input.lines?.some((l) => l.kind === 'stock')) {
      throw new AppError('STOCK_ON_BILL_SPEND', 'A spend that pays a supplier bill brings no goods in — the bill\'s own delivery did', 422)
    }
    if (input.lines?.length) throw new AppError('LINES_ON_BILL', 'A spend that pays a supplier bill has no expense lines', 400)
    accountCode = ACCT.CASH_ON_HAND
  } else {
    throw new AppError('BAD_SPEND_NATURE', `Unknown spend nature "${String(nature)}"`, 400)
  }
  const newFloatCents = await moveFloatTx(tx, input.box.id, -input.amountCents)
  const category = input.category ?? (lines.length === 1 ? lines[0]!.categoryKey : null)
  const movement = await writeMovementTx(tx, {
    boxId: input.box.id,
    type: 'spend',
    amountCents: -input.amountCents,
    category,
    reason: input.reason,
    receiptUrl: input.receiptUrl,
    vendorName: input.vendorName,
    approvedById: input.approvedById,
    supplierPaymentId: input.supplierPaymentId,
    createdById: input.createdById,
    source: 'box',
    accountCode,
    cashVoucherId: input.cashVoucherId ?? null,
    conceptId: input.conceptId ?? null,
    lines,
  })
  return { movementId: movement.id, movement, newFloatCents, lines }
}

export interface PettyCashTopupInput {
  box: { id: string }
  /** What goes into the box, in paisa — positive. */
  amountCents: number
  reason: string
  category?: string | null
  receiptUrl?: string | null
  vendorName?: string | null
  /** The approver whose PIN lifted the box's top-up limit, if any. */
  approvedById?: string | null
  createdById: string
}

/**
 * Record a top-up inside `tx` (also a new box's opening float): resolve where
 * the cash came from in the BOX's company, raise the float, write the 'topup'
 * movement and book it (Dr 1011 / Cr the source):
 *   garibsons → 2210 (H1) · safe → 1010 · bank → the named live linked bank of
 *   the box's company (422 otherwise) · cash_request → the account the
 *   request was paid to (change returned; cashRequestPaidAccountTx) ·
 *   opening → 1010 (H2, source unknown) · till → `shiftId`, an open drawer of
 *   the box's company: a 'payout' CashMovement on it (pos/drawerToBox.ts,
 *   422 SHIFT_NOT_IN_COMPANY / INSUFFICIENT_DRAWER_CASH), booked once as
 *   'pettycash.till_topup:<cashMovementId>' Dr 1011 / Cr 1015.
 */
export async function recordPettyCashTopupTx(
  tx: Prisma.TransactionClient,
  input: PettyCashTopupInput & { source: TopupSource; bankAccountId?: string | null; shiftId?: string | null; cashVoucherId?: string | null },
): Promise<{ movementId: string; movement: PettyCashMovement; newFloatCents: number }> {
  assertPositiveAmount(input.amountCents, 'A petty-cash top-up')
  const box = await boxCompanyTx(tx, input.box.id)
  const current = await tx.pettyCashBox.findFirst({ where: { id: input.box.id, deletedAt: null }, select: { floatCents: true } })
  if (!current) throw new NotFoundError('PettyCashBox', input.box.id)
  assertInt4Fits(current.floatCents + input.amountCents, 'The box\'s float after this top-up')

  let accountCode: string
  let bankAccountId: string | null = null
  let cashMovementId: string | null = null
  let shiftId: string | null = null
  let conceptId: string | null = null
  if (input.source === 'till') {
    if (!input.shiftId) throw new AppError('SHIFT_REQUIRED', 'Pick the open till drawer the cash comes from', 400)
    const drawer = await recordDrawerToBoxTx(tx, {
      shiftId: input.shiftId, tenantId: box.tenantId, amountCents: input.amountCents,
      reason: `${box.name} — ${input.reason}`, createdById: input.createdById,
    })
    accountCode = ACCT.CASH_DRAWER
    cashMovementId = drawer.cashMovementId
    shiftId = input.shiftId
  } else {
    if (input.source !== 'bank' && input.bankAccountId) {
      throw new AppError('BANK_ACCOUNT_NOT_EXPECTED', 'A bank account is only named when the cash comes from a bank', 400)
    }
    if (input.source === 'cash_request') {
      if (!input.cashVoucherId) throw new AppError('CASH_REQUEST_REQUIRED', 'Change returned must name its cash request', 400)
      const v = await tx.cashVoucher.findUnique({ where: { id: input.cashVoucherId }, select: { tenantId: true } })
      if (!v || v.tenantId !== box.tenantId) throw new AppError('BOX_NOT_IN_COMPANY', 'Change goes back to a box of the cash request\'s own company', 422)
      // Back to the account the request was paid to (H3), under the brand
      // the pay was booked to — Dr 1011 / Cr paid both carry it, so the
      // brand's expense nets (cash-brand-mismatch), whatever box takes it.
      accountCode = await cashRequestPaidAccountTx(tx, input.cashVoucherId)
      // 1357 is retired (owner, 2026-10-16): change on a voucher still held there is a manual journal, never a top-up.
      if (accountCode === ACCT.VOUCHERS_AWAITING_DOCS) {
        throw new AppError('USE_JOURNAL', 'This voucher is still held awaiting documents — finance corrects its change with a manual journal', 409)
      }
      conceptId = await cashRequestBrandTx(tx, input.cashVoucherId)
    } else {
      const counter = await cashCounterAccountTx(tx, box.tenantId, input.source, input.bankAccountId)
      accountCode = counter.code
      bankAccountId = counter.bankAccountId
    }
  }
  const newFloatCents = await moveFloatTx(tx, input.box.id, input.amountCents)
  const movement = await writeMovementTx(tx, {
    boxId: input.box.id,
    type: 'topup',
    amountCents: input.amountCents,
    category: input.category,
    reason: input.reason,
    receiptUrl: input.receiptUrl,
    vendorName: input.vendorName,
    approvedById: input.approvedById,
    createdById: input.createdById,
    source: input.source,
    accountCode,
    bankAccountId,
    shiftId,
    cashMovementId,
    cashVoucherId: input.cashVoucherId ?? null,
    conceptId,
  })
  return { movementId: movement.id, movement, newFloatCents }
}

/**
 * Hand cash back out of a box inside `tx` — to the safe (Dr 1010), a bank of
 * the box's company (Dr its code) or the Garibsons cashier (Dr 2210) / Cr
 * 1011. The float is claimed conditionally (400 INSUFFICIENT_FLOAT).
 */
export async function recordPettyCashReturnTx(
  tx: Prisma.TransactionClient,
  input: { boxId: string; amountCents: number; destination: ReturnDestination; bankAccountId?: string | null; reason: string; actorId: string },
): Promise<{ movementId: string; movement: PettyCashMovement; newFloatCents: number }> {
  assertPositiveAmount(input.amountCents, 'Cash returned from a box')
  const box = await boxCompanyTx(tx, input.boxId)
  if (input.destination !== 'bank' && input.bankAccountId) {
    throw new AppError('BANK_ACCOUNT_NOT_EXPECTED', 'A bank account is only named when the cash goes to a bank', 400)
  }
  const counter = await cashCounterAccountTx(tx, box.tenantId, input.destination, input.bankAccountId)
  const newFloatCents = await moveFloatTx(tx, input.boxId, -input.amountCents)
  const movement = await writeMovementTx(tx, {
    boxId: input.boxId,
    type: 'return',
    amountCents: -input.amountCents,
    reason: input.reason,
    createdById: input.actorId,
    source: input.destination,
    accountCode: counter.code,
    bankAccountId: counter.bankAccountId,
  })
  return { movementId: movement.id, movement, newFloatCents }
}

export interface PettyCashTransferInput {
  fromBox: { id: string; name: string; tenantId: string }
  toBox: { id: string; name: string; tenantId: string }
  amountCents: number
  reason: string
  createdById: string
}

export interface PettyCashTransferResult {
  /** The shared reference both movements carry (transferRef, and in their reason): "TRF-…". */
  ref: string
  out: PettyCashMovement
  in: PettyCashMovement
  fromFloatCents: number
  toFloatCents: number
}

/**
 * Move cash from one box to another of the SAME company inside `tx`: two
 * 'transfer' movements (− on the source, + on the destination) carrying one
 * shared reference (transferRef + their reason), the source's float claimed
 * conditionally. Both rows are locked in id order first, so two opposite
 * transfers cannot deadlock. No ledger entry: both boxes sit on 1011.
 */
export async function recordPettyCashTransferTx(
  tx: Prisma.TransactionClient,
  input: PettyCashTransferInput,
): Promise<PettyCashTransferResult> {
  assertPositiveAmount(input.amountCents, 'A petty-cash transfer')
  if (input.fromBox.id === input.toBox.id) throw new AppError('SAME_BOX', 'Pick two different boxes', 400)
  if (input.fromBox.tenantId !== input.toBox.tenantId) {
    throw new AppError('BOX_NOT_IN_COMPANY', 'Both boxes must belong to the same company', 422)
  }
  const ids = [input.fromBox.id, input.toBox.id].sort()
  await tx.$queryRaw`SELECT id FROM petty_cash_boxes WHERE id IN (${ids[0]!}, ${ids[1]!}) ORDER BY id FOR UPDATE`
  const dest = await tx.pettyCashBox.findFirst({ where: { id: input.toBox.id, deletedAt: null }, select: { floatCents: true } })
  if (!dest) throw new NotFoundError('PettyCashBox', input.toBox.id)
  assertInt4Fits(dest.floatCents + input.amountCents, 'The receiving box\'s float after this transfer')

  const ref = `TRF-${randomBytes(4).toString('hex').toUpperCase()}`
  const fromFloatCents = await moveFloatTx(tx, input.fromBox.id, -input.amountCents)
  const out = await writeMovementTx(tx, {
    boxId: input.fromBox.id,
    type: 'transfer',
    amountCents: -input.amountCents,
    reason: `Transfer ${ref} to ${input.toBox.name}: ${input.reason}`,
    createdById: input.createdById,
    source: 'box',
    transferRef: ref,
  })
  const toFloatCents = await moveFloatTx(tx, input.toBox.id, input.amountCents)
  const inbound = await writeMovementTx(tx, {
    boxId: input.toBox.id,
    type: 'transfer',
    amountCents: input.amountCents,
    reason: `Transfer ${ref} from ${input.fromBox.name}: ${input.reason}`,
    createdById: input.createdById,
    source: 'box',
    transferRef: ref,
  })
  return { ref, out, in: inbound, fromFloatCents, toFloatCents }
}

export interface PettyCashCountInput {
  boxId: string
  countedCents: number
  notes?: string | null
  createdById: string
}

/**
 * Record a physical count inside `tx`: the variance (counted − float, against
 * the float AS LOCKED, so a spend landing during the count is never folded
 * into it) is written as a 'reconcile' movement, booked to 8010 (short Dr
 * 8010 / Cr 1011, over the other way, zero nothing), and the float becomes
 * the count. Returns the box as it stood before the count.
 */
export async function recordPettyCashCountTx(
  tx: Prisma.TransactionClient,
  input: PettyCashCountInput,
): Promise<{ movement: PettyCashMovement; box: { id: string; name: string; tenantId: string | null; conceptId: string | null; floatCents: number }; varianceCents: number }> {
  if (!Number.isSafeInteger(input.countedCents) || input.countedCents < 0) {
    throw new AppError('BAD_AMOUNT', 'A count must be a whole amount, zero or more', 400)
  }
  assertInt4Fits(input.countedCents, 'The counted cash')
  await tx.$queryRaw`SELECT id FROM petty_cash_boxes WHERE id = ${input.boxId} FOR UPDATE`
  const box = await tx.pettyCashBox.findFirst({
    where: { id: input.boxId, deletedAt: null },
    select: { id: true, name: true, tenantId: true, conceptId: true, floatCents: true },
  })
  if (!box) throw new NotFoundError('PettyCashBox', input.boxId)
  await boxCompanyTx(tx, box.id)
  const varianceCents = input.countedCents - box.floatCents
  await moveFloatTx(tx, box.id, varianceCents)
  const movement = await writeMovementTx(tx, {
    boxId: box.id,
    type: 'reconcile',
    amountCents: varianceCents,
    reason: input.notes ?? 'Reconciliation',
    createdById: input.createdById,
    accountCode: ACCT.CASH_VARIANCE,
  })
  return { movement, box, varianceCents }
}
