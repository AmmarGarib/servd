// Petty cash in the ledger (finance wave B, 2026-10-14; accountant defaults
// H1–H3). Every rupee in a petty-cash box sits on 1011 Petty Cash, and every
// movement of a box is booked by ONE poster, postPettyCashMovementTx, inside
// the movement's own transaction (trustops/pettyCash.ts writeMovementTx). The
// entry is a pure function of what the movement row stores — its type,
// source, counter account (accountCode) and spend lines — so the live path
// and the history backfill book exactly the same thing.
//
//   top-up      Dr 1011 / Cr the source's account:
//                 garibsons    → 2210 Due to Garibsons (H1: GS Foods holds no
//                                cash; the Garibsons cashier funds the boxes)
//                 safe         → 1010 Cash on hand
//                 bank         → that bank's chart code (lib/bankAccounts.ts
//                                moneyAccountCode — live, linked, same company)
//                 cash_request → the account the cash request was PAID to
//                                (cashRequestPaidAccountTx): change handed back
//                 opening      → 1010 (H2: an opening of unknown source)
//               'pettycash.topup:<movementId>'
//   till top-up Dr 1011 / Cr 1015 Drawer — 'pettycash.till_topup:<cashMovementId>',
//               keyed on the drawer's 'payout' CashMovement (pos/drawerToBox.ts)
//               so the shift close's ':<movementId>' rule never books it again.
//   return      Dr 1010 | bank code | 2210 / Cr 1011 — 'pettycash.return:<id>'
//   spend       lines: Dr each EXPENSE line's code (6xxx; 5010–5030 only on a
//               history-backfill pick) and each STOCK line's class account
//               (1210 / 1220 / 1230 — the goods came in as a settled receipt,
//               inventory/cashPurchase.ts), brand = line ?? movement ?? box /
//               Cr 1011 for their total. A CAPEX line is booked by its own
//               CapEx payment ('capex.payment:<id>' Dr 1340 / Cr 1011,
//               financePlanning/capexPosting.ts) and left out here;
//               a bill-paying spend: Dr 1010 / Cr 1011 (procurement
//               createPaymentTx books Dr 2010 / Cr 1010 in the same tx);
//               a lineless spend with a stored counter account (only a legacy
//               row already booked as an advance on 1355 — the history
//               backfill now expenses an old-flow voucher's spend, H3).
//               'pettycash.spend:<id>'
//   reconcile   short Dr 8010 / Cr 1011, over Dr 1011 / Cr 8010, zero nothing.
//   transfer    nothing — both boxes sit on 1011.
//
// Cash requests (H3, Hasnain 2026-10-14: "expense at payment; receipts kept for
// the file"): paying a request is a spend with ONE expense line in the
// request's category — Dr <category's 6xxx> / Cr 1011 — so the money is
// expensed the moment it leaves the box. cashRequestPayLine decides that line
// and cashRequestPaidAccountTx reads back where the money landed: the ONE
// switch point of the policy. Receipts are evidence and book nothing; a
// settlement (postCashVoucherSettlementTx) only RECLASSES what the receipts
// show out of the paid account: 'cashvoucher.settle:<settlementId>'
//   another expense category  Dr <its 6xxx> / Cr <paid account>
//   a stock line              Dr 12x0 / Cr <paid account> (the settled receipt)
//   a capex line              its own CapEx payment Dr 1340 / Cr <paid account>
//   the same category         nothing (the pay already booked it)
// Change handed back is a 'cash_request' top-up: Dr 1011 / Cr <paid account>.
// An old-flow voucher's spend is booked by the history backfill like any pay:
// one expense line in the voucher's category (H3). Only a row already booked
// as an advance (lineless, 1355) reads back 1355 as its paid account.
//
// The posting goes through syncSourcePosting, so a finance reclass of a spend
// line reverses the live entry (today) and reposts it on the live entry's own
// date; a replay is a no-op. The movement's journalEntryId is (re-)stamped
// after every posting — the page's "Booked" badge.
//
// History: backfillPettyCash (POST /reconciliation/backfill-petty-cash, the
// CEO) books what was in the boxes before this: each box's opening (float −
// Σ movements, computed with the box locked) and every unbooked movement,
// placed by owner decision 6 (placeAndPost). Tie-out: pettyCashTieOut.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertInt4Fits } from '../../lib/money.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { ledgerBalancesByCode, moneyAccountCode } from '../../lib/bankAccounts.js'
import { ACCT, postJournalEntry, withLateNote, type JournalLineInput, type RepostOptions } from './journal.js'
import { syncSourcePosting, type SyncOutcome } from './sourcePosting.js'
import { expenseCodeForCategoryName, payoutCategory, resolveSpendAccount } from './expenseCategories.js'
import { fmtPktDate } from './dates.js'
import { assertNotEquipmentLine } from '../fixedAssets/classes.js'
import { liveRevision } from './sourcePosting.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'
import { CLASS_ACCOUNTS, costClassOf } from '../../lib/inventoryClass.js'

type Tx = Prisma.TransactionClient

/**
 * Where cash put into a box came from, by source (H1 switch point: change
 * `garibsons` here and every top-up from the Garibsons cashier follows).
 */
export const FUNDING_ACCOUNT: { garibsons: string; safe: string } = {
  garibsons: ACCT.DUE_TO_GARIBSONS,
  safe: ACCT.CASH_ON_HAND,
}

export type TopupSource = 'garibsons' | 'safe' | 'bank' | 'till' | 'cash_request' | 'opening'
export type ReturnDestination = 'safe' | 'bank' | 'garibsons'

const SOURCE_LABEL: Record<string, string> = {
  garibsons: 'the Garibsons cashier (2210)',
  safe: 'the safe (1010)',
  bank: 'a bank account',
  till: 'a till drawer (1015)',
  cash_request: 'change returned on a cash request',
  opening: 'the safe (1010, source not recorded)',
}

/**
 * The counter account of a top-up or a return, in `tenantId`'s chart. A bank
 * goes through the one resolver (named account: live, linked, this company's,
 * else 422; none named: the company's only bank, 1020 when it has none).
 * 'till' is not resolved here — the drawer move (pos/drawerToBox.ts) is — and
 * neither is 'cash_request': change returned goes back to the account the
 * request was paid to (cashRequestPaidAccountTx), which needs the request.
 */
export async function cashCounterAccountTx(
  tx: Tx | typeof prisma,
  tenantId: string,
  source: Exclude<TopupSource, 'till'> | ReturnDestination,
  bankAccountId?: string | null,
): Promise<{ code: string; bankAccountId: string | null }> {
  switch (source) {
    case 'garibsons': return { code: FUNDING_ACCOUNT.garibsons, bankAccountId: null }
    case 'safe':
    case 'opening': return { code: FUNDING_ACCOUNT.safe, bankAccountId: null }
    case 'cash_request':
      throw new AppError('CASH_REQUEST_REQUIRED', 'Change returned must name its cash request', 400)
    case 'bank': return moneyAccountCode(tx, tenantId, { method: 'bank', bankAccountId: bankAccountId ?? null })
  }
}

// ─── Spend lines ─────────────────────────────────────────────────────────────

/** A spend line as a client sends it — on a box spend or a cash-request settlement. */
export interface SpendLineInput {
  kind?: 'expense' | 'stock' | 'capex'
  categoryKey?: string | null
  /** Explicit 6xxx — cash keepers only. */
  accountCode?: string | null
  amountCents: number
  conceptId?: string | null
  locationId?: string | null
  /** Optional on a stock line (the item's name). */
  description: string
  /** The line looks like equipment but is not (finance / CEO, reason ≥ 10). */
  notEquipment?: boolean
  notEquipmentReason?: string | null
  // stock
  inventoryItemId?: string | null
  quantity?: number | null
  /** The unit the quantity was bought in (default the item's own unit). */
  unit?: string | null
  // capex
  capexLineId?: string | null
}

export interface ResolvedSpendLine {
  kind: 'expense' | 'stock' | 'capex'
  categoryKey: string | null
  /** expense: 6xxx · stock: the item's class account (1210 / 1220 / 1230) · capex: 1340. */
  accountCode: string
  amountCents: number
  conceptId: string | null
  locationId: string | null
  description: string
  /** True when the equipment check was overridden — the caller audits it and raises 'equipment_override'. */
  equipmentOverride: boolean
  overrideReason: string | null
  inventoryItemId: string | null
  quantity: number | null
  unit: string | null
  capexLineId: string | null
}

export const MAX_SPEND_LINES = 20

/**
 * Validate a spend's lines in `tenantId` (the box's / request's company):
 *   • expense: the account through resolveSpendAccount (a key, or an explicit
 *     6xxx when `allowExplicit`; a 'cogs' key only when `allowCogs` — the
 *     history backfill — else 422 USE_STOCK_LINE), and the description
 *     through assertNotEquipmentLine (422 USE_CAPEX; the override is finance /
 *     CEO only) unless `equipmentCheck` is false;
 *   • stock (403 STOCK_LINES_NOT_ALLOWED unless `stockAllowed` — a cash keeper
 *     or a role with the inventory module): an item of THIS company (422
 *     ITEM_NOT_IN_COMPANY), a quantity above zero, a unit that converts to the
 *     item's own (422 UNIT_MISMATCH); booked to the item's class account;
 *   • capex: a CapEx line of THIS company's project (422
 *     CAPEX_LINE_NOT_IN_COMPANY); booked to 1340 by its own CapEx payment;
 *   • a brand or outlet of another company → 422 CONCEPT_NOT_IN_COMPANY /
 *     LOCATION_NOT_IN_COMPANY.
 */
export async function resolveSpendLinesTx(
  tx: Tx,
  tenantId: string,
  inputs: SpendLineInput[],
  o: { allowExplicit: boolean; actor: { id: string; role: string }; allowCogs?: boolean; stockAllowed?: boolean; equipmentCheck?: boolean },
): Promise<ResolvedSpendLine[]> {
  if (inputs.length === 0) throw new AppError('SPEND_LINES_REQUIRED', 'Say what the money was spent on', 400)
  if (inputs.length > MAX_SPEND_LINES) throw new AppError('TOO_MANY_LINES', `At most ${MAX_SPEND_LINES} lines per spend`, 400)
  const out: ResolvedSpendLine[] = []
  for (const line of inputs) {
    const kind = line.kind ?? 'expense'
    if (kind !== 'expense' && kind !== 'stock' && kind !== 'capex') {
      throw new AppError('BAD_LINE_KIND', `Unknown line kind "${String(kind)}"`, 400)
    }
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents <= 0) {
      throw new AppError('BAD_AMOUNT', 'Each line must be a whole amount above zero', 400)
    }
    assertInt4Fits(line.amountCents, 'A spend line')
    if (line.conceptId) {
      const c = await tx.concept.findFirst({ where: { id: line.conceptId, tenantId }, select: { id: true } })
      if (!c) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand is not one of this company\'s', 422)
    }
    if (line.locationId) {
      const l = await tx.location.findFirst({ where: { id: line.locationId, tenantId }, select: { id: true } })
      if (!l) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That outlet is not one of this company\'s', 422)
    }
    const base = {
      amountCents: line.amountCents,
      conceptId: line.conceptId ?? null,
      locationId: line.locationId ?? null,
      equipmentOverride: false,
      overrideReason: null,
      inventoryItemId: null,
      quantity: null,
      unit: null,
      capexLineId: null,
    }

    if (kind === 'stock') {
      if (!o.stockAllowed) {
        throw new AppError('STOCK_LINES_NOT_ALLOWED', 'Only a manager, finance or someone who runs the stock can book goods into stock', 403)
      }
      if (!line.inventoryItemId) throw new AppError('ITEM_REQUIRED', 'Pick the stock item that was bought', 400)
      const item = await tx.inventoryItem.findFirst({
        where: { id: line.inventoryItemId, tenantId, deletedAt: null },
        select: { id: true, name: true, unit: true, category: true },
      })
      if (!item) throw new AppError('ITEM_NOT_IN_COMPANY', 'That stock item is not one of this company\'s', 422)
      const qty = line.quantity ?? NaN
      if (!Number.isFinite(qty) || !(qty > 0)) throw new AppError('INVALID_QTY', `${item.name}: the quantity must be more than zero`, 400)
      const unit = (line.unit ?? '').trim() || item.unit
      const converted = toPurchaseUnits(qty, unit, item.unit)
      if (converted == null || !(converted > 0)) {
        throw new AppError('UNIT_MISMATCH', `${item.name} is counted in ${item.unit} — ${unit} cannot be converted to it`, 422)
      }
      out.push({
        ...base,
        kind: 'stock',
        categoryKey: null,
        accountCode: CLASS_ACCOUNTS[costClassOf(item.category)].inv,
        description: ((line.description ?? '').trim() || item.name).slice(0, 200),
        inventoryItemId: item.id,
        quantity: qty,
        unit,
      })
      continue
    }

    const description = (line.description ?? '').trim()
    if (!description) throw new AppError('LINE_DESCRIPTION_REQUIRED', 'Each line needs a description', 400)

    if (kind === 'capex') {
      if (!line.capexLineId) throw new AppError('CAPEX_LINE_REQUIRED', 'Pick the CapEx item this equipment was bought for', 400)
      const cl = await tx.capexLine.findFirst({
        where: { id: line.capexLineId, project: { tenantId, deletedAt: null } },
        select: { id: true },
      })
      if (!cl) throw new AppError('CAPEX_LINE_NOT_IN_COMPANY', 'That CapEx line does not belong to this company', 422)
      out.push({ ...base, kind: 'capex', categoryKey: null, accountCode: ACCT.SUPPLIER_ADVANCES, description: description.slice(0, 200), capexLineId: cl.id })
      continue
    }

    const acct = await resolveSpendAccount(tx, tenantId, { categoryKey: line.categoryKey, accountCode: line.accountCode }, {
      allowExplicit: o.allowExplicit, allowCogs: o.allowCogs,
    })
    const eq = o.equipmentCheck === false
      ? { overridden: false }
      : assertNotEquipmentLine({
        description, expenseAccountCode: acct.code, notEquipment: line.notEquipment, notEquipmentReason: line.notEquipmentReason ?? null,
      }, o.actor)
    out.push({
      ...base,
      kind: 'expense',
      categoryKey: acct.categoryKey,
      accountCode: acct.code,
      description: description.slice(0, 200),
      equipmentOverride: eq.overridden,
      overrideReason: eq.overridden ? (line.notEquipmentReason ?? '').trim() : null,
    })
  }
  return out
}

/** The spend-line columns of a resolved line (box spend: movementId; settlement: settlementId). */
export function spendLineData(tenantId: string, l: ResolvedSpendLine): Omit<Prisma.PettyCashSpendLineUncheckedCreateInput, 'movementId' | 'settlementId'> {
  return {
    tenantId, kind: l.kind, categoryKey: l.categoryKey, accountCode: l.accountCode, amountCents: l.amountCents,
    conceptId: l.conceptId, locationId: l.locationId, description: l.description,
    inventoryItemId: l.inventoryItemId, quantity: l.quantity, unit: l.unit, capexLineId: l.capexLineId,
  }
}

/**
 * The account a CapEx cash payment credits. recordCapexPaymentFromCashTx
 * takes 1011 (a box), a cash request's paid 6xxx (H3: expense at payment —
 * the CapEx payment moves the equipment straight out of it: Dr 1340 /
 * Cr <paid 6xxx>, tagged with the request's brand) or 1355 (a legacy
 * advance). Anything else (a legacy request whose pay was booked somewhere
 * unexpected) is bridged: the CapEx payment credits 1011 and the
 * settlement's own entry moves it on (Dr 1011 / Cr <paid>), so the two net
 * to Dr 1340 / Cr <paid> and 1011 is untouched.
 */
export function capexCashCreditFor(paidCode: string): { creditCode: string; bridged: boolean } {
  if (paidCode === ACCT.PETTY_CASH || paidCode === ACCT.CASH_ADVANCES || /^6\d{3}$/.test(paidCode)) {
    return { creditCode: paidCode, bridged: false }
  }
  return { creditCode: ACCT.PETTY_CASH, bridged: true }
}

/**
 * Bring a cash document's stock and capex lines onto their registers, inside
 * its transaction, AFTER its spend lines are written and BEFORE it is posted:
 *   • stock lines → ONE settled goods receipt from the company's 'Cash
 *     purchases' supplier (inventory/cashPurchase.ts recordCashPurchaseStockTx;
 *     the caller ran ensureFifoReady before opening the transaction), each
 *     spend line stamped with its receiptLineId (its class account checked);
 *   • capex lines → one paid CapEx payment each (financePlanning/capexPosting.ts
 *     recordCapexPaymentFromCashTx, credited per capexCashCreditFor), each
 *     spend line stamped with its capexPaymentId (unique per company: one
 *     payment per line, a replay returns it).
 * Posts nothing itself for stock (the document's entry carries Dr 12x0).
 */
export async function bookCashLinesTx(tx: Tx, a: {
  tenantId: string
  doc: { kind: 'petty_cash_movement' | 'cash_voucher_settlement'; id: string }
  /** The account the cash document credits (1011 a box; the paid account for a settlement). */
  creditCode: string
  lineIds: string[]
  occurredAt: Date
  actorId: string
}): Promise<void> {
  if (a.lineIds.length === 0) return
  const rows = await tx.pettyCashSpendLine.findMany({ where: { id: { in: a.lineIds }, tenantId: a.tenantId }, orderBy: { createdAt: 'asc' } })
  const order = new Map(a.lineIds.map((id, i) => [id, i]))
  rows.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0))
  const stock = rows.filter((r) => r.kind === 'stock')
  if (stock.length > 0) {
    const { recordCashPurchaseStockTx } = await import('../inventory/cashPurchase.js')
    const locations = new Set(stock.map((r) => r.locationId ?? ''))
    const got = await recordCashPurchaseStockTx(tx, {
      tenantId: a.tenantId,
      settledBy: { kind: a.doc.kind, id: a.doc.id, creditAccountCode: a.creditCode },
      lines: stock.map((r) => ({ spendLineId: r.id, inventoryItemId: r.inventoryItemId!, qty: r.quantity ?? 0, unit: r.unit ?? '', totalCents: r.amountCents })),
      locationId: locations.size === 1 ? (stock[0]!.locationId ?? null) : null,
      occurredAt: a.occurredAt,
      actorId: a.actorId,
    })
    for (const l of got.lines) {
      const row = stock.find((r) => r.id === l.spendLineId)!
      if (l.accountCode !== row.accountCode || l.valueCents !== row.amountCents) {
        throw new AppError('STOCK_LINE_MISMATCH', `The stock receipt booked ${l.accountCode} ${l.valueCents}, the line says ${row.accountCode} ${row.amountCents}`, 500)
      }
      await tx.pettyCashSpendLine.update({ where: { id: row.id }, data: { receiptLineId: l.receiptLineId } })
    }
  }
  const capex = rows.filter((r) => r.kind === 'capex')
  if (capex.length > 0) {
    const { recordCapexPaymentFromCashTx } = await import('../financePlanning/capexPosting.js')
    const { creditCode } = capexCashCreditFor(a.creditCode)
    // A credit out of the request's paid 6xxx carries the brand its pay was
    // booked to (cashRequestPayLine: the request's conceptId), as the
    // settlement's own Cr <paid> does — the brand's expense nets to zero.
    let creditConceptId: string | null = null
    if (/^6\d{3}$/.test(creditCode) && a.doc.kind === 'cash_voucher_settlement') {
      const st = await tx.cashVoucherSettlement.findUnique({ where: { id: a.doc.id }, select: { voucher: { select: { conceptId: true } } } })
      creditConceptId = st?.voucher.conceptId ?? null
    }
    for (const r of capex) {
      const paid = await recordCapexPaymentFromCashTx(tx, {
        tenantId: a.tenantId, lineId: r.capexLineId!, spendLineId: r.id, amountCents: r.amountCents,
        paidAt: a.occurredAt, creditCode, creditConceptId, actorId: a.actorId,
      })
      await tx.pettyCashSpendLine.update({ where: { id: r.id }, data: { capexPaymentId: paid.capexPaymentId } })
    }
  }
}

// ─── The one poster ─────────────────────────────────────────────────────────

type MovementForPosting = Prisma.PettyCashMovementGetPayload<{
  include: { box: { select: { id: true; name: true; tenantId: true; conceptId: true } }; lines: true }
}>

interface PlannedEntry {
  sourceType: string
  sourceId: string
  description: string
  lines: JournalLineInput[]
}

function needsClassification(m: { id: string; type: string }): AppError {
  return new AppError(
    'MOVEMENT_NOT_CLASSIFIED',
    `Petty-cash ${m.type} ${m.id.slice(0, 8)} has no source or account yet — book it from Reconciliation → Backfill (petty-cash history)`,
    422,
  )
}

async function planEntry(tx: Tx, m: MovementForPosting): Promise<PlannedEntry | null> {
  const amount = Math.abs(m.amountCents)
  const concept = m.conceptId ?? m.box.conceptId ?? null
  const memo = `Petty cash ${m.box.name}: ${m.reason}`.slice(0, 250)
  const voucher = m.cashVoucherId
    ? await tx.cashVoucher.findUnique({ where: { id: m.cashVoucherId }, select: { number: true, payeeName: true } })
    : null
  const pc = ACCT.PETTY_CASH
  const pair = (debit: string, credit: string, dMemo = memo, cMemo = memo): JournalLineInput[] => [
    { accountCode: debit, type: 'debit', amountCents: amount, memo: dMemo, conceptId: concept },
    { accountCode: credit, type: 'credit', amountCents: amount, memo: cMemo, conceptId: concept },
  ]
  if (amount === 0) return null

  switch (m.type) {
    case 'topup': {
      if (!m.accountCode) throw needsClassification(m)
      const lineMemo = m.source === 'cash_request' && voucher ? `${voucher.number} change returned` : memo
      if (m.source === 'till') {
        if (!m.cashMovementId) throw needsClassification(m)
        return {
          sourceType: 'pettycash.till_topup', sourceId: m.cashMovementId,
          description: `Petty cash top-up from the till — ${m.box.name}`,
          lines: pair(pc, m.accountCode, lineMemo, lineMemo),
        }
      }
      return {
        sourceType: 'pettycash.topup', sourceId: m.id,
        description: `Petty cash top-up — ${m.box.name}${m.source ? ` (from ${SOURCE_LABEL[m.source] ?? m.source})` : ''}`,
        lines: pair(pc, m.accountCode, lineMemo, lineMemo),
      }
    }
    case 'return': {
      if (!m.accountCode) throw needsClassification(m)
      return {
        sourceType: 'pettycash.return', sourceId: m.id,
        description: `Cash returned from petty cash — ${m.box.name}`,
        lines: pair(m.accountCode, pc),
      }
    }
    case 'spend': {
      if (m.lines.length > 0) {
        const total = m.lines.reduce((s, l) => s + l.amountCents, 0)
        if (total !== amount) {
          throw new AppError('LINES_DONT_ADD_UP', `The lines add up to ${total}, the spend is ${amount}`, 422)
        }
        // A capex line is booked by its own CapEx payment (Dr 1340 / Cr 1011).
        const own = m.lines.filter((l) => l.kind !== 'capex')
        const ownTotal = own.reduce((s, l) => s + l.amountCents, 0)
        if (ownTotal === 0) return null
        return {
          sourceType: 'pettycash.spend', sourceId: m.id,
          description: `${voucher ? `Cash request ${voucher.number} paid` : 'Petty cash spend'} — ${m.box.name}: ${m.reason}`.slice(0, 250),
          lines: [
            ...own.map((l): JournalLineInput => ({
              accountCode: l.accountCode, type: 'debit', amountCents: l.amountCents,
              memo: `Petty cash ${m.box.name}: ${l.description}`.slice(0, 250),
              conceptId: l.conceptId ?? concept,
            })),
            { accountCode: pc, type: 'credit', amountCents: ownTotal, memo, conceptId: concept },
          ],
        }
      }
      if (!m.accountCode) throw needsClassification(m)
      const advance = m.accountCode === ACCT.CASH_ADVANCES
      const dMemo = advance && voucher ? `${voucher.number} advance to ${voucher.payeeName}`.slice(0, 250) : memo
      return {
        sourceType: 'pettycash.spend', sourceId: m.id,
        description: advance
          ? `Cash advance from petty cash — ${m.box.name}${voucher ? ` (${voucher.number})` : ''}`
          : `Petty cash spend — ${m.box.name}: ${m.reason}`.slice(0, 250),
        lines: pair(m.accountCode, pc, dMemo, dMemo),
      }
    }
    case 'reconcile': {
      const code = m.accountCode ?? ACCT.CASH_VARIANCE
      return {
        sourceType: 'pettycash.reconcile', sourceId: m.id,
        description: `Petty cash count — ${m.box.name} ${m.amountCents > 0 ? 'over' : 'short'}`,
        lines: m.amountCents > 0 ? pair(pc, code) : pair(code, pc),
      }
    }
    case 'transfer': {
      // Box to box: both sides sit on 1011 — nothing. Only a one-sided legacy
      // transfer the history backfill resolved (a pick stored its counter
      // account) is booked, like a top-up (in) or a return (out).
      if (!m.accountCode) return null
      return {
        sourceType: 'pettycash.transfer', sourceId: m.id,
        description: `Petty cash legacy transfer — ${m.box.name}`,
        lines: m.amountCents > 0 ? pair(pc, m.accountCode) : pair(m.accountCode, pc),
      }
    }
    default:
      throw new AppError('UNKNOWN_MOVEMENT_TYPE', `Unknown petty-cash movement type "${m.type}"`, 422)
  }
}

/**
 * Once a cash request has receipts booked or change returned against the
 * account it was paid to, that account is fixed: moving the pay to another
 * account would leave the settlements crediting the old one. 409
 * CASH_REQUEST_PAID_FIXED — move money with a settlement line instead.
 */
async function assertPayUnchangedTx(tx: Tx, tenantId: string, voucherId: string, plan: PlannedEntry): Promise<void> {
  const v = await tx.cashVoucher.findUnique({ where: { id: voucherId }, select: { number: true, settledCents: true, returnedCents: true } })
  if (!v || v.settledCents + v.returnedCents === 0) return
  const { live } = await liveRevision(tenantId, plan.sourceType, plan.sourceId, tx)
  if (!live) return
  const debits = (lines: Array<{ accountCode: string; type: string }>) =>
    lines.filter((l) => l.type === 'debit').map((l) => l.accountCode).sort().join(',')
  if (debits(live.lines) !== debits(plan.lines)) {
    throw new AppError(
      'CASH_REQUEST_PAID_FIXED',
      `Cash request ${v.number} already has receipts or change booked against the account it was paid to — move the money with a settlement line instead`,
      409,
    )
  }
}

/**
 * Book petty-cash movement `movementId` inside `tx`, in its BOX's company
 * (422 BOX_HAS_NO_COMPANY when the box has none). Idempotent: a replay finds
 * the live entry unchanged; a changed movement (a reclassed line) reverses it
 * and reposts. `opts` (the history backfill) dates it in the open month with a
 * note naming the original date. Stamps the movement's journalEntryId.
 * A posting into a closed month is 422 PERIOD_LOCKED and rolls the caller's
 * transaction back (the float and the movement with it).
 */
export async function postPettyCashMovementTx(
  tx: Tx,
  movementId: string,
  opts: RepostOptions = {},
): Promise<{ entryId: string | null; outcome: SyncOutcome | 'no_entry' }> {
  const m = await tx.pettyCashMovement.findUnique({
    where: { id: movementId },
    include: { box: { select: { id: true, name: true, tenantId: true, conceptId: true } }, lines: { orderBy: { createdAt: 'asc' } } },
  })
  if (!m) throw new NotFoundError('PettyCashMovement', movementId)
  const tenantId = m.box.tenantId
  if (!tenantId) throw new AppError('BOX_HAS_NO_COMPANY', `Petty-cash box "${m.box.name}" belongs to no company — it cannot be booked`, 422)
  const plan = await planEntry(tx, m)
  if (!plan) {
    // A spend whose every line is equipment: its CapEx payments carry the
    // books — stamp the first one's entry so the movement reads 'Booked'.
    const capexPaymentId = m.lines.find((l) => l.kind === 'capex' && l.capexPaymentId)?.capexPaymentId
    if (capexPaymentId) {
      const { live } = await liveRevision(tenantId, 'capex.payment', capexPaymentId, tx)
      if (live && live.entryId !== m.journalEntryId) await tx.pettyCashMovement.update({ where: { id: m.id }, data: { journalEntryId: live.entryId } })
      if (live) return { entryId: live.entryId, outcome: 'unchanged' }
    }
    return { entryId: null, outcome: 'no_entry' }
  }
  await assertTemplateAccounts(tx, tenantId, plan.lines.map((l) => l.accountCode))
  if (m.type === 'spend' && m.cashVoucherId && m.journalEntryId) await assertPayUnchangedTx(tx, tenantId, m.cashVoucherId, plan)
  const noted = withLateNote(plan.description, plan.lines, opts.memoNote)
  const r = await syncSourcePosting({
    tenantId,
    sourceType: plan.sourceType,
    id: plan.sourceId,
    desired: { description: noted.description, entryDate: opts.entryDate ?? m.createdAt, lines: noted.lines },
    postedBy: opts.postedBy ?? m.createdById,
    reason: `Petty-cash movement ${m.id} changed`,
    tx,
  }, { keepLiveDate: !opts.entryDate })
  if (r.entryId !== m.journalEntryId) {
    await tx.pettyCashMovement.update({ where: { id: m.id }, data: { journalEntryId: r.entryId } })
  }
  return { entryId: r.entryId, outcome: r.outcome }
}

// ─── Cash requests (H3) ─────────────────────────────────────────────────────

/** The entry key prefix of a cash-request settlement: 'cashvoucher.settle:<settlementId>'. */
export const CASH_REQUEST_SETTLE_SOURCE = 'cashvoucher.settle'

/** A request's category as stored (CashVoucher.category): a PAYOUT key, or an explicit 6xxx a cash keeper picked. */
export function categoryRefOf(category: string | null | undefined): { categoryKey: string | null; accountCode: string | null } {
  const c = (category ?? '').trim()
  if (!c) return { categoryKey: null, accountCode: null }
  return /^\d{4}$/.test(c) ? { categoryKey: null, accountCode: c } : { categoryKey: c, accountCode: null }
}

/**
 * THE booking of a cash request's payment (H3, Hasnain 2026-10-14: "expense
 * at payment; receipts kept for the file"): ONE expense line of the whole
 * amount in the request's category, so the pay books Dr <category's 6xxx> /
 * Cr 1011 at once. 422 CATEGORY_REQUIRED when the request names none (a
 * keeper sets it before it is paid). This and cashRequestPaidAccountTx are
 * the one switch point: a later policy (e.g. an advance on a balance-sheet
 * account) changes these two and nothing else reads the policy.
 */
export function cashRequestPayLine(v: { number: string; purpose: string; category: string | null; amountCents: number; conceptId: string | null }): SpendLineInput {
  const ref = categoryRefOf(v.category)
  if (!ref.categoryKey && !ref.accountCode) {
    throw new AppError('CATEGORY_REQUIRED', `Cash request ${v.number} names no expense category — finance sets it before it is paid`, 422)
  }
  return { kind: 'expense', ...ref, amountCents: v.amountCents, conceptId: v.conceptId, description: `${v.number}: ${v.purpose}`.slice(0, 200) }
}

/**
 * THE account a paid cash request's money sits on — what its settlements
 * reclass out of and what change handed back credits. Read back from what the
 * pay actually booked: the pay movement's one expense line (H3 — the history
 * backfill books an old-flow voucher's spend that way too), or, for a legacy
 * row already booked as an advance, its counter account (1355). 409 PAYMENT_NOT_BOOKED while the pay is not on the books
 * (book the petty-cash history first); 409 VOUCHER_NOT_PAID before it is paid.
 */
export async function cashRequestPaidAccountTx(tx: Tx | typeof prisma, voucherId: string): Promise<string> {
  const v = await tx.cashVoucher.findUnique({ where: { id: voucherId }, select: { number: true, pettyCashMovementId: true } })
  if (!v) throw new NotFoundError('CashVoucher', voucherId)
  if (!v.pettyCashMovementId) throw new AppError('VOUCHER_NOT_PAID', `Cash request ${v.number} has not been paid`, 409)
  const m = await tx.pettyCashMovement.findUnique({
    where: { id: v.pettyCashMovementId },
    select: { accountCode: true, journalEntryId: true, lines: { select: { kind: true, accountCode: true } } },
  })
  if (m && m.lines.length === 1 && m.lines[0]!.kind === 'expense') return m.lines[0]!.accountCode
  if (m && m.lines.length === 0 && m.accountCode && m.journalEntryId) return m.accountCode
  throw new AppError(
    'PAYMENT_NOT_BOOKED',
    `The payment of cash request ${v.number} is not on the books yet — book the petty-cash history (Reconciliation → Backfill) first`,
    409,
  )
}

/**
 * Book cash-request settlement `settlementId` inside `tx`, in the request's
 * company: ONE entry 'cashvoucher.settle:<settlementId>' that moves what the
 * receipts show out of the account the request was paid to (P):
 *   an expense line in another account → Dr its 6xxx / Cr P;
 *   a stock line → Dr its class account (12x0) / Cr P (the settled receipt
 *     was written by bookCashLinesTx; it posts nothing itself);
 *   a capex line → its own CapEx payment (Dr 1340 / Cr P); only when that
 *     payment had to be bridged through 1011 (capexCashCreditFor), Dr 1011 /
 *     Cr P here;
 *   an expense line in P itself → nothing (the pay already booked it).
 * No entry at all when every line stays in P (entryId null). Idempotent; a
 * reclassed line reverses the live entry and reposts it on its own date.
 */
export async function postCashVoucherSettlementTx(
  tx: Tx,
  settlementId: string,
  opts: RepostOptions = {},
): Promise<{ entryId: string | null }> {
  const st = await tx.cashVoucherSettlement.findUnique({
    where: { id: settlementId },
    include: {
      lines: { orderBy: { createdAt: 'asc' } },
      voucher: { select: { id: true, tenantId: true, number: true, payeeName: true, conceptId: true } },
    },
  })
  if (!st) throw new NotFoundError('CashVoucherSettlement', settlementId)
  const tenantId = st.voucher.tenantId
  const paid = await cashRequestPaidAccountTx(tx, st.voucherId)
  const concept = st.voucher.conceptId
  const memo = `${st.voucher.number} receipts (${st.voucher.payeeName})`.slice(0, 250)
  const lines: JournalLineInput[] = []
  let credit = 0
  let bridge = 0
  for (const l of st.lines) {
    if (l.kind === 'capex') {
      if (capexCashCreditFor(paid).bridged) bridge += l.amountCents
      continue
    }
    if (l.kind === 'expense' && l.accountCode === paid) continue
    lines.push({
      accountCode: l.accountCode, type: 'debit', amountCents: l.amountCents,
      memo: `${st.voucher.number}: ${l.description}`.slice(0, 250), conceptId: l.conceptId ?? concept,
    })
    credit += l.amountCents
  }
  if (bridge > 0) {
    lines.push({ accountCode: ACCT.PETTY_CASH, type: 'debit', amountCents: bridge, memo: `${st.voucher.number}: equipment moved to CapEx`, conceptId: concept })
    credit += bridge
  }
  if (credit > 0) lines.push({ accountCode: paid, type: 'credit', amountCents: credit, memo, conceptId: concept })
  let desired: { description: string; entryDate: Date; lines: JournalLineInput[] } | null = null
  if (credit > 0) {
    await assertTemplateAccounts(tx, tenantId, lines.map((l) => l.accountCode))
    const noted = withLateNote(`Cash request ${st.voucher.number} — receipts ${st.seq} (moved out of ${paid})`, lines, opts.memoNote)
    desired = { description: noted.description, entryDate: opts.entryDate ?? st.createdAt, lines: noted.lines }
  }
  const r = await syncSourcePosting({
    tenantId,
    sourceType: CASH_REQUEST_SETTLE_SOURCE,
    id: st.id,
    desired,
    postedBy: opts.postedBy ?? st.submittedById,
    reason: `Cash request ${st.voucher.number} settlement ${st.seq} changed`,
    tx,
  }, { keepLiveDate: !opts.entryDate })
  return { entryId: r.entryId }
}

// ─── Tie-out ────────────────────────────────────────────────────────────────

export interface PettyCashTieOutRow {
  tenantId: string
  floatsCents: number
  ledger1011Cents: number
  openAdvancesCents: number
  ledger1355Cents: number
  unbookedMovements: number
  /** Boxes whose float is not explained by their movements and has no opening entry (the history backfill books them). */
  boxesWithoutOpening: number
  ok: boolean
}

/**
 * Per company: Σ box floats against the 1011 balance, open legacy cash
 * advances (disbursed vouchers booked as an advance: amount − settled −
 * returned − converted) against 1355,
 * and the movements not yet on the books. `ok` only when all three agree.
 */
export async function pettyCashTieOut(tenantIds: string[]): Promise<PettyCashTieOutRow[]> {
  const out: PettyCashTieOutRow[] = []
  for (const tenantId of tenantIds) {
    const boxes = await prisma.pettyCashBox.findMany({ where: { tenantId }, select: { id: true, floatCents: true } })
    const floatsCents = boxes.reduce((s, b) => s + b.floatCents, 0)
    const ledger = await ledgerBalancesByCode(tenantId, [ACCT.PETTY_CASH, ACCT.CASH_ADVANCES])
    // Only a legacy voucher the history backfill booked as an advance sits on
    // 1355 (its pay movement is lineless, counter account 1355); a cash
    // request paid since H3 was expensed when paid and owes 1355 nothing.
    const vouchers = await prisma.cashVoucher.findMany({
      where: { tenantId, status: 'disbursed', pettyCashMovementId: { not: null } },
      select: { amountCents: true, settledCents: true, returnedCents: true, convertedCents: true, pettyCashMovementId: true },
    })
    const advanceMoves = vouchers.length
      ? new Set((await prisma.pettyCashMovement.findMany({
        where: { id: { in: vouchers.map((v) => v.pettyCashMovementId!) }, accountCode: ACCT.CASH_ADVANCES, lines: { none: {} } },
        select: { id: true },
      })).map((m) => m.id))
      : new Set<string>()
    const openAdvancesCents = vouchers
      .filter((v) => advanceMoves.has(v.pettyCashMovementId!))
      .reduce((s, v) => s + Math.max(0, v.amountCents - v.settledCents - v.returnedCents - v.convertedCents), 0)
    const unbookedMovements = await prisma.pettyCashMovement.count({
      where: { box: { tenantId }, journalEntryId: null, amountCents: { not: 0 }, NOT: { type: 'transfer', accountCode: null } },
    })
    let boxesWithoutOpening = 0
    if (boxes.length > 0) {
      const sums = await prisma.pettyCashMovement.groupBy({ by: ['boxId'], where: { boxId: { in: boxes.map((b) => b.id) } }, _sum: { amountCents: true } })
      const sumOf = new Map(sums.map((s) => [s.boxId, s._sum.amountCents ?? 0]))
      const gaps = boxes.filter((b) => b.floatCents - (sumOf.get(b.id) ?? 0) !== 0)
      if (gaps.length > 0) {
        const opened = await prisma.journalEntry.findMany({
          where: { tenantId, reference: { in: gaps.map((b) => `pettycash.opening:${b.id}`) } },
          select: { reference: true },
        })
        boxesWithoutOpening = gaps.length - opened.length
      }
    }
    const ledger1011Cents = ledger.get(ACCT.PETTY_CASH) ?? 0
    const ledger1355Cents = ledger.get(ACCT.CASH_ADVANCES) ?? 0
    out.push({
      tenantId, floatsCents, ledger1011Cents, openAdvancesCents, ledger1355Cents, unbookedMovements, boxesWithoutOpening,
      ok: floatsCents === ledger1011Cents && openAdvancesCents === ledger1355Cents && unbookedMovements === 0 && boxesWithoutOpening === 0,
    })
  }
  return out
}

// ─── History backfill ───────────────────────────────────────────────────────

/** A finance pick for one movement the backfill could not classify. */
export interface PickInput {
  categoryKey?: string
  accountCode?: string
  /** A one-sided legacy transfer INTO a box, or a top-up: where the cash came from. */
  source?: 'safe' | 'garibsons' | 'bank'
  /** A one-sided legacy transfer OUT of a box, or a return: where it went. */
  destination?: 'safe' | 'garibsons' | 'bank'
  bankAccountId?: string
}

export interface BackfillRow {
  kind: 'opening' | 'topup' | 'spend' | 'reconcile' | 'transfer' | 'return' | 'cash_on_hand'
  /** The movement id (the box id for an opening, the company id for cash_on_hand). */
  id: string
  boxId: string | null
  boxName: string | null
  tenantId: string
  /** The date it is (or would be) posted on. */
  date: string | null
  amountCents: number
  /** The account the entry takes the other side to (the expense for a spend). */
  accountCode: string | null
  // would_post | would_post_into_current_month | posted | posted_into_current_month | needs_category
  // | needs_review | locked | already_posted | error | info | warning
  outcome: string
  detail: string
}

/** What the backfill writes on a movement before it is posted (the picks are stored first). */
interface Fill {
  source?: string
  accountCode?: string
  bankAccountId?: string | null
  cashVoucherId?: string
  line?: { categoryKey: string | null; accountCode: string; amountCents: number; description: string }
}

const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
const TRF_RE = /TRF-[0-9A-F]{8}/

/**
 * Book the petty-cash history of `tenantIds` (owner decision 6 placement:
 * each item on its own date while that month is open, else today with a note
 * naming the original date; nothing when the books are closed through today):
 *   • each box's opening (float − Σ movements, computed inside the posting
 *     transaction with the box row locked) — 'pettycash.opening:<boxId>',
 *     Dr 1011 / Cr the company's historic source (H2 default safe 1010;
 *     'garibsons' → 2210);
 *   • every unbooked movement, through postPettyCashMovementTx after storing
 *     what it was missing: a top-up with no source → the historic source; a
 *     spend that paid a bill → Dr 1010; a spend a cash voucher made → ONE
 *     expense line in the voucher's category (H3: expensed when paid, never
 *     1355; needs_category until a pick when it names none); other
 *     spends by their PAYOUT key or category name (expenseCodeForCategoryName),
 *     else needs_category until a pick; counts → 8010; paired transfers →
 *     nothing (not listed); one-sided legacy transfers → needs_review until a
 *     pick names the source / destination.
 * A dry run writes nothing. Re-runs find nothing (journalEntryId / the
 * opening key). One row per company says what 1010 would be after the run
 * and warns when it goes negative (GS Foods holds no cash — Garibsons is the
 * alternative).
 */
export async function backfillPettyCash(a: {
  tenantIds: string[]
  dryRun: boolean
  postedBy: string
  historicTopupSource: Record<string, 'safe' | 'garibsons'>
  picks?: Record<string, PickInput>
}): Promise<BackfillRow[]> {
  const { placeAndPost } = await import('../reconciliation/backfillOrders.js')
  const rows: BackfillRow[] = []
  const picks = a.picks ?? {}
  const reposter = {
    entityType: 'PettyCashMovement',
    title: 'Petty-cash movement not in the books',
    nothingToPost: new Set<string>(['nothing_to_post']),
    load: async () => null,
  }
  const lockedThrough = async (tenantId: string) =>
    (await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } }))?.lockedThrough ?? null

  for (const tenantId of a.tenantIds) {
    const historic = a.historicTopupSource[tenantId] ?? 'safe'
    const histCode = FUNDING_ACCOUNT[historic]
    const companyRows: BackfillRow[] = []
    // Net effect on 1010 of the rows this run posts (for the warning row).
    let cashOnHandDelta = 0
    const touch1010 = (code: string | null | undefined, debit: boolean, cents: number) => {
      if (code === ACCT.CASH_ON_HAND) cashOnHandDelta += debit ? cents : -cents
    }
    const willPost = (o: string) => o.startsWith('would_post') || o.startsWith('posted')

    // ── 1. Box openings ──────────────────────────────────────────────────
    const boxes = await prisma.pettyCashBox.findMany({
      where: { tenantId },
      select: { id: true, name: true, floatCents: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
    if (boxes.length > 0) {
      const sums = await prisma.pettyCashMovement.groupBy({ by: ['boxId'], where: { boxId: { in: boxes.map((b) => b.id) } }, _sum: { amountCents: true } })
      const sumOf = new Map(sums.map((s) => [s.boxId, s._sum.amountCents ?? 0]))
      const opened = new Set((await prisma.journalEntry.findMany({
        where: { tenantId, reference: { in: boxes.map((b) => `pettycash.opening:${b.id}`) } },
        select: { reference: true },
      })).map((e) => e.reference!.slice('pettycash.opening:'.length)))
      for (const box of boxes) {
        const opening = box.floatCents - (sumOf.get(box.id) ?? 0)
        if (opening === 0 || opened.has(box.id)) continue
        const what = `Opening float of ${box.name}: ${pkr(opening)} in the box before servd recorded it — source assumed ${SOURCE_LABEL[historic]}`
          + (opening < 0 ? ' (the float is BELOW its recorded movements — count the box)' : '')
        const placed = await placeAndPost({
          tenantId, date: box.createdAt, orderId: null, what, amountCents: Math.abs(opening),
          post: (o) => postBoxOpening(box.id, tenantId, histCode, o),
        }, tenantId, reposter, { dryRun: a.dryRun, postedBy: a.postedBy, lockedThrough })
        if (willPost(placed.outcome)) touch1010(histCode, opening < 0, Math.abs(opening))
        companyRows.push({
          kind: 'opening', id: box.id, boxId: box.id, boxName: box.name, tenantId, date: placed.date,
          amountCents: opening, accountCode: histCode, outcome: placed.outcome, detail: placed.detail,
        })
      }
    }

    // ── 2. Unbooked movements ────────────────────────────────────────────
    const movements = await prisma.pettyCashMovement.findMany({
      where: { box: { tenantId }, journalEntryId: null, amountCents: { not: 0 } },
      include: { box: { select: { id: true, name: true } }, lines: { select: { id: true } } },
      orderBy: { createdAt: 'asc' },
    })
    const vouchers = movements.length
      ? await prisma.cashVoucher.findMany({
        where: { tenantId, OR: [{ pettyCashMovementId: { in: movements.map((m) => m.id) } }, { id: { in: movements.map((m) => m.cashVoucherId).filter((x): x is string => !!x) } }] },
        select: { id: true, number: true, payeeName: true, category: true, pettyCashMovementId: true },
      })
      : []
    const voucherOf = (m: { id: string; cashVoucherId: string | null }) =>
      vouchers.find((v) => v.pettyCashMovementId === m.id || (m.cashVoucherId && v.id === m.cashVoucherId)) ?? null
    const transferRows = movements.some((m) => m.type === 'transfer')
      ? await prisma.pettyCashMovement.findMany({ where: { box: { tenantId }, type: 'transfer' }, select: { id: true, reason: true, transferRef: true, amountCents: true } })
      : []
    const refOf = (m: { reason: string; transferRef: string | null }) => m.transferRef ?? TRF_RE.exec(m.reason)?.[0] ?? null

    for (const m of movements) {
      const base = { kind: m.type as BackfillRow['kind'], id: m.id, boxId: m.boxId, boxName: m.box.name, tenantId, amountCents: m.amountCents }
      const pick = picks[m.id]
      let fill: Fill = {}
      let note = ''
      try {
        if (m.type === 'topup') {
          if (!m.accountCode) {
            if (pick?.source) {
              const c = await cashCounterAccountTx(prisma, tenantId, pick.source, pick.bankAccountId)
              fill = { source: pick.source, accountCode: c.code, bankAccountId: c.bankAccountId }
              note = `source picked: ${SOURCE_LABEL[pick.source] ?? pick.source}`
            } else {
              fill = { source: historic, accountCode: histCode }
              note = `source not recorded — assumed ${SOURCE_LABEL[historic]}`
            }
          }
        } else if (m.type === 'spend') {
          if (m.lines.length === 0 && !m.accountCode) {
            const v = voucherOf(m)
            if (m.supplierPaymentId) {
              fill = { accountCode: ACCT.CASH_ON_HAND }
              note = 'paid a supplier bill (the payment booked Dr 2010 / Cr 1010) — moves the cash from 1011 to 1010'
            } else if (v) {
              // H3 (Hasnain 2026-10-14): a cash request is expensed when it is
              // paid — never parked on 1355. An old-flow voucher's spend is the
              // final payment and carries the voucher's category (the old
              // disburse wrote it on the movement): ONE expense line in it, so
              // cashRequestPaidAccountTx reads that 6xxx as the paid account.
              const resolved = await classifyVoucherSpend(tenantId, m, v, pick)
              if (!resolved) {
                companyRows.push({
                  ...base, date: m.createdAt.toISOString(), accountCode: null, outcome: 'needs_category',
                  detail: `${v.number} (${v.payeeName}): ${m.reason}${m.category || v.category ? ` (${m.category || v.category})` : ''} — pick the expense category it was paid for`,
                })
                continue
              }
              fill = { cashVoucherId: v.id, line: { categoryKey: resolved.categoryKey, accountCode: resolved.code, amountCents: Math.abs(m.amountCents), description: m.reason.slice(0, 200) } }
              note = `${v.number}: expensed when paid (H3) — ${resolved.how}`
            } else {
              const resolved = await classifySpend(tenantId, m, pick)
              if (!resolved) {
                companyRows.push({ ...base, date: m.createdAt.toISOString(), accountCode: null, outcome: 'needs_category', detail: `${m.reason}${m.category ? ` (${m.category})` : ''} — pick a category` })
                continue
              }
              fill = { line: { categoryKey: resolved.categoryKey, accountCode: resolved.code, amountCents: Math.abs(m.amountCents), description: m.reason.slice(0, 200) } }
              note = resolved.how
            }
          }
        } else if (m.type === 'reconcile') {
          if (!m.accountCode) fill = { accountCode: ACCT.CASH_VARIANCE }
        } else if (m.type === 'transfer') {
          if (!m.accountCode) {
            const ref = refOf(m)
            const paired = !!ref && transferRows.some((t) => t.id !== m.id && refOf(t) === ref && t.amountCents === -m.amountCents)
            if (paired) continue // both boxes sit on 1011 — nothing to book, nothing to list
            const side = m.amountCents > 0 ? pick?.source : pick?.destination
            if (!side) {
              companyRows.push({
                ...base, date: m.createdAt.toISOString(), accountCode: null, outcome: 'needs_review',
                detail: `${m.reason} — a transfer with no other side; pick where the cash ${m.amountCents > 0 ? 'came from' : 'went'}`,
              })
              continue
            }
            const c = await cashCounterAccountTx(prisma, tenantId, side, pick?.bankAccountId)
            fill = { source: side, accountCode: c.code, bankAccountId: c.bankAccountId }
            note = `one-sided transfer: ${m.amountCents > 0 ? 'from' : 'to'} ${SOURCE_LABEL[side] ?? side}`
          }
        } else if (m.type === 'return') {
          if (!m.accountCode) {
            if (!pick?.destination) {
              companyRows.push({ ...base, date: m.createdAt.toISOString(), accountCode: null, outcome: 'needs_review', detail: `${m.reason} — pick where the cash went` })
              continue
            }
            const c = await cashCounterAccountTx(prisma, tenantId, pick.destination, pick.bankAccountId)
            fill = { source: pick.destination, accountCode: c.code, bankAccountId: c.bankAccountId }
          }
        }
      } catch (err) {
        companyRows.push({ ...base, date: m.createdAt.toISOString(), accountCode: null, outcome: 'error', detail: (err as Error).message })
        continue
      }

      const counter = fill.line?.accountCode ?? fill.accountCode ?? m.accountCode ?? null
      const what = `${m.type} ${pkr(Math.abs(m.amountCents))} — ${m.box.name}: ${m.reason}${note ? ` (${note})` : ''}`
      const placed = await placeAndPost({
        tenantId, date: m.createdAt, orderId: null, what, amountCents: Math.abs(m.amountCents),
        post: (o) => postHistoricMovement(m.id, tenantId, fill, o),
      }, tenantId, reposter, { dryRun: a.dryRun, postedBy: a.postedBy, lockedThrough })
      if (willPost(placed.outcome) && counter) {
        // Dr 1011 when cash came in (top-up, count over, transfer in), else Cr.
        const intoBox = m.amountCents > 0
        touch1010(counter, !intoBox, Math.abs(m.amountCents))
      }
      companyRows.push({ ...base, date: placed.date, accountCode: counter, outcome: placed.outcome, detail: placed.detail })
    }

    // ── 3. What 1010 Cash on hand looks like after this run ──────────────
    if (cashOnHandDelta !== 0) {
      const now = (await ledgerBalancesByCode(tenantId, [ACCT.CASH_ON_HAND])).get(ACCT.CASH_ON_HAND) ?? 0
      const after = a.dryRun ? now + cashOnHandDelta : now
      companyRows.push({
        kind: 'cash_on_hand', id: tenantId, boxId: null, boxName: null, tenantId, date: null, amountCents: after, accountCode: ACCT.CASH_ON_HAND,
        outcome: after < 0 ? 'warning' : 'info',
        detail: after < 0
          ? `1010 Cash on hand ${a.dryRun ? 'would be' : 'is now'} ${pkr(after)} — GS Foods holds no cash. Run it with the historic source set to the Garibsons cashier (2210) instead.`
          : `1010 Cash on hand ${a.dryRun ? 'would be' : 'is now'} ${pkr(after)}.`,
      })
    }
    rows.push(...companyRows)
  }
  return rows
}

/** A spend's account from a pick, its PAYOUT key or its category / reason words; null → needs_category. */
async function classifySpend(
  tenantId: string,
  m: { category: string | null; reason: string },
  pick: PickInput | undefined,
): Promise<{ code: string; categoryKey: string | null; how: string } | null> {
  if (pick?.categoryKey || pick?.accountCode) {
    const r = await resolveSpendAccount(prisma, tenantId, { categoryKey: pick.categoryKey, accountCode: pick.accountCode }, { allowExplicit: true, allowCogs: true })
    return { ...r, how: `picked: ${r.code}` }
  }
  const cat = payoutCategory(m.category)
  if (cat) {
    const r = await resolveSpendAccount(prisma, tenantId, { categoryKey: cat.key }, { allowExplicit: false, allowCogs: true })
    return { ...r, how: `category ${cat.label} → ${r.code}` }
  }
  const code = expenseCodeForCategoryName(m.category) ?? expenseCodeForCategoryName(m.reason)
  if (!code) return null
  const acct = await prisma.account.findFirst({ where: { tenantId, code, isActive: true }, select: { id: true } })
  if (!acct) return null
  return { code, categoryKey: null, how: `from the words "${m.category ?? m.reason}" → ${code}` }
}

/**
 * An old-flow cash voucher's spend (H3: expensed when paid): a finance pick
 * first, then the voucher's own category as stored (a PAYOUT key or an
 * explicit account a keeper picked — on the movement, else on the voucher),
 * then the category / reason words; null → needs_category.
 */
async function classifyVoucherSpend(
  tenantId: string,
  m: { category: string | null; reason: string },
  v: { category: string | null },
  pick: PickInput | undefined,
): Promise<{ code: string; categoryKey: string | null; how: string } | null> {
  if (pick?.categoryKey || pick?.accountCode) return classifySpend(tenantId, m, pick)
  for (const category of [m.category, v.category]) {
    const ref = categoryRefOf(category)
    if (!ref.categoryKey && !ref.accountCode) continue
    try {
      const r = await resolveSpendAccount(prisma, tenantId, ref, { allowExplicit: true, allowCogs: true })
      return { ...r, how: `the request's category ${category} → ${r.code}` }
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      // An unknown key or a code missing from the chart: try the words below.
    }
  }
  return classifySpend(tenantId, { category: m.category ?? v.category, reason: m.reason }, undefined)
}

/** The opening of one box, computed with the box locked (critic: never from a stale read). */
async function postBoxOpening(
  boxId: string, tenantId: string, counterCode: string, o: RepostOptions,
): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM petty_cash_boxes WHERE id = ${boxId} FOR UPDATE`
    const box = await tx.pettyCashBox.findUniqueOrThrow({ where: { id: boxId }, select: { name: true, floatCents: true, createdAt: true, conceptId: true } })
    const sum = await tx.pettyCashMovement.aggregate({ where: { boxId }, _sum: { amountCents: true } })
    const opening = box.floatCents - (sum._sum.amountCents ?? 0)
    if (opening === 0) return { posted: false, entryId: null, reason: 'nothing_to_post' }
    const amt = Math.abs(opening)
    const memo = `Petty cash ${box.name}: opening float before servd recorded it`
    const lines: JournalLineInput[] = opening > 0
      ? [{ accountCode: ACCT.PETTY_CASH, type: 'debit', amountCents: amt, memo, conceptId: box.conceptId }, { accountCode: counterCode, type: 'credit', amountCents: amt, memo, conceptId: box.conceptId }]
      : [{ accountCode: counterCode, type: 'debit', amountCents: amt, memo, conceptId: box.conceptId }, { accountCode: ACCT.PETTY_CASH, type: 'credit', amountCents: amt, memo, conceptId: box.conceptId }]
    await assertTemplateAccounts(tx, tenantId, lines.map((l) => l.accountCode))
    const noted = withLateNote(`Petty cash opening — ${box.name} (created ${fmtPktDate(box.createdAt)})`, lines, o.memoNote)
    const r = await postJournalEntry({
      tenantId, sourceType: 'pettycash.opening', sourceId: boxId, description: noted.description,
      entryDate: o.entryDate ?? box.createdAt, postedBy: o.postedBy ?? 'system', lines: noted.lines,
    }, { tx })
    return { posted: r.posted, entryId: r.entryId }
  })
}

/** Store what the backfill worked out on the movement, then post it — one transaction, the box locked. */
async function postHistoricMovement(
  movementId: string, tenantId: string, fill: Fill, o: RepostOptions,
): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  return prisma.$transaction(async (tx) => {
    const m = await tx.pettyCashMovement.findUniqueOrThrow({ where: { id: movementId }, select: { boxId: true, journalEntryId: true, accountCode: true, conceptId: true } })
    await tx.$queryRaw`SELECT id FROM petty_cash_boxes WHERE id = ${m.boxId} FOR UPDATE`
    if (m.journalEntryId) return { posted: false, entryId: m.journalEntryId }
    const data: Prisma.PettyCashMovementUncheckedUpdateInput = { tenantId }
    if (fill.source !== undefined) data.source = fill.source
    if (fill.accountCode !== undefined && !m.accountCode) data.accountCode = fill.accountCode
    if (fill.bankAccountId !== undefined) data.bankAccountId = fill.bankAccountId
    if (fill.cashVoucherId !== undefined) data.cashVoucherId = fill.cashVoucherId
    await tx.pettyCashMovement.update({ where: { id: movementId }, data })
    if (fill.line) {
      const existing = await tx.pettyCashSpendLine.count({ where: { movementId } })
      if (existing === 0) {
        await tx.pettyCashSpendLine.create({
          data: {
            tenantId, movementId, kind: 'expense', categoryKey: fill.line.categoryKey, accountCode: fill.line.accountCode,
            amountCents: fill.line.amountCents, conceptId: m.conceptId, description: fill.line.description,
          },
        })
      }
    }
    const r = await postPettyCashMovementTx(tx, movementId, o)
    if (r.outcome === 'no_entry') return { posted: false, entryId: null, reason: 'nothing_to_post' }
    return { posted: r.outcome !== 'unchanged', entryId: r.entryId }
  })
}
