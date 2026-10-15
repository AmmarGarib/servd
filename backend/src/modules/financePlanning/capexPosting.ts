// Capital spend → the ledger. ONE path (owner decision 24, fixed assets v2 —
// finance wave B, 2026-10-14):
//
//   1. Each CapEx instalment marked paid posts as it happens ('capex.payment',
//      keyed on the payment id, kept in step by syncSourcePosting). By what
//      the LINE is (capexTreatmentOf — the line's own `treatment` is the ONLY
//      override; there is no per-payment treatment):
//        capital   Dr 1340 Advances to suppliers (gross)
//        prepaid   Dr 1310 Prepaid expenses (rent advance; released monthly to
//                  6010 by accounting/prepaidReleases.ts, H25)
//        deposit   Dr 1360 Security deposits (refundable; returned / forfeited
//                  through depositReturn, never released)
//        expense   Dr 6110 Professional fees (broker / legal)
//      Cr where the money came from (lib/bankAccounts.ts moneyAccountCode,
//      the PROJECT's company) net of income tax withheld, Cr 2040 the WHT
//      (lib/withholding.ts computeWithholding, H8/H28 — the one resolver;
//      never on a deposit). Sales tax charged on a fee / rent (line
//      inputTaxCents, pro rata per instalment) is Dr the charging authority's
//      input account (taxAuthorities.inputTaxCodeFor); on a capital item it is
//      claimed when the item is capitalised.
//      A capital item paid AFTER it was capitalised settles the supplier:
//        Dr payableCodeForLine (2012 Payables — capital suppliers; 2010 for a
//        legacy line whose capitalisation credited 2010) / Cr money / Cr 2040.
//   2. A delivered item is CAPITALISED through the fixed-asset register:
//      prepareCapitalisation raises a 'capitalise' request
//      (fixedAssets/events.ts); the CEO approves it (their own preparation
//      applies at once) and the engine posts Dr class cost (+ Dr input tax) /
//      Cr 1340 what was advanced (capexAdvancesForLine) / Cr 2012 the rest.
//      The asset links back by FixedAsset.capexLineId — the old
//      'capex-line:' notes prefix is never read.
//
// What CapexPayment amounts mean: `paidAmountCents` (else `amountCents`) is
// the GROSS instalment settled with the supplier — sales tax included, income
// tax not yet withheld. The bank pays gross − whtCents. The WHT base is gross
// less the instalment's share of the line's input tax, so the withholding
// register's derived base (whtCents × 10000 ÷ whtRateBps) is that base.
//
// Guards (409) — a posted instalment cannot be moved under something that
// already used it: ADVANCE_APPLIED_TO_ASSET (a 1340 advance applied to a
// capitalised or pending line), PREPAID_RELEASING (a prepayment already
// released), DEPOSIT_RECLASSED / DEPOSIT_RETURNED (a deposit reclassed or
// returned), PAID_FROM_CASH (a payment that came from petty cash or a cash
// request — corrected there).

import type { FixedAssetClass, Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { ACCT, lateDatingFor, withLateNote, type JournalLineInput } from '../accounting/journal.js'
import { syncSourcePosting, liveRevision, type LiveRevision, type SyncOutcome } from '../accounting/sourcePosting.js'
import { inputTaxCodeFor, isAuthorityKey, INPUT_TAX_ACCOUNTS } from '../accounting/taxAuthorities.js'
import { computeWithholding, defaultSectionForCapex, whtSectionOrNull, type WhtSection } from '../../lib/withholding.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'
import { moneyAccountCode, assertPaymentReference, receiptText } from '../../lib/bankAccounts.js'
import { classOf, SMALLWARE_TYPES } from '../fixedAssets/classes.js'
import {
  createRequest, assertSharedHasLocation, capitaliseTarget, FA_WRITER_ROLES, PAYLOAD_SCHEMAS, type CapitalisePayload,
} from '../fixedAssets/events.js'

export type Db = Prisma.TransactionClient | PrismaClient
type Tx = Db

export const CAPEX_SOURCE = 'capex.payment'
export const DEPOSIT_RETURN_SOURCE = 'capex.deposit_return'
export const DEPOSIT_RECLASS_SOURCE = 'capex.deposit_reclass'
export const ACQUIRE_SOURCE = 'fixed_asset.acquire'
export const ADVANCES_TO_SUPPLIERS = ACCT.SUPPLIER_ADVANCES   // 1340
export const PREPAID_EXPENSES = ACCT.PREPAID                  // 1310
export const SECURITY_DEPOSITS = ACCT.SECURITY_DEPOSITS       // 1360
export const PROFESSIONAL_FEES = ACCT.PROFESSIONAL_FEES       // 6110
export const CAPITAL_PAYABLES = ACCT.CAPITAL_PAYABLES         // 2012
const LEGACY_PAYABLES = ACCT.AP_SUPPLIERS                     // 2010
const WHT_PAYABLE = ACCT.WHT_PAYABLE                          // 2040
const RENT = ACCT.RENT                                        // 6010

export const CAPEX_TREATMENTS = ['capital', 'prepaid', 'deposit', 'expense'] as const
export type CapexTreatment = (typeof CAPEX_TREATMENTS)[number]

const DEBIT_FOR: Record<CapexTreatment, string> = {
  capital: ADVANCES_TO_SUPPLIERS,
  prepaid: PREPAID_EXPENSES,
  deposit: SECURITY_DEPOSITS,
  expense: PROFESSIONAL_FEES,
}
const TREATMENT_OF_CODE: Record<string, CapexTreatment> = {
  [ADVANCES_TO_SUPPLIERS]: 'capital',
  [LEGACY_PAYABLES]: 'capital',
  [CAPITAL_PAYABLES]: 'capital',
  [PREPAID_EXPENSES]: 'prepaid',
  [SECURITY_DEPOSITS]: 'deposit',
  [PROFESSIONAL_FEES]: 'expense',
}
const CAPITAL_DEBITS = new Set<string>([ADVANCES_TO_SUPPLIERS, LEGACY_PAYABLES, CAPITAL_PAYABLES])

/** Project types where architect / design / project fees are part of the build (H26). */
export const BUILD_OUT_TYPES: readonly string[] = ['kitchen_buildout', 'refurb', 'expansion', 'new_brand']

export function isCapexTreatment(x: unknown): x is CapexTreatment {
  return typeof x === 'string' && (CAPEX_TREATMENTS as readonly string[]).includes(x)
}

/**
 * How a capex line's spend is booked. The line's own `treatment` is the ONLY
 * override; otherwise from what it is:
 *   security / refundable deposit (or a rent / lease deposit) → deposit (1360)
 *   rent / lease advance                                       → prepaid (1310, H25)
 *   broker / legal                                             → expense (6110)
 *   architect / design / project consultant → capital on a build-out (H26), else expense
 *   anything else                                              → capital
 */
export function capexTreatmentOf(
  line: { scope: string; category: string | null; item: string; treatment?: string | null },
  projectType: string | null | undefined,
): CapexTreatment {
  if (isCapexTreatment(line.treatment)) return line.treatment
  const text = `${line.scope} ${line.category ?? ''} ${line.item}`
  const deposit = /\bdeposits?\b/i.test(text)
  if (deposit && /\b(security|refundable|returnable)\b/i.test(text)) return 'deposit'
  const rent = /\b(rent|rental|lease)\b/i.test(text)
  if (rent && /\b(advance|prepaid|prepayment|upfront|in advance)\b/i.test(text)) return 'prepaid'
  if (rent && deposit) return 'deposit'
  if (/\b(broker|brokerage|legal|lawyer|solicitor|notary|stamp duty)\b/i.test(text)) return 'expense'
  if (/\b(architect|architectural|design fees?|designer|interior design|consultant|consultancy|consulting|project management|project manager|professional fees?)\b/i.test(text)) {
    return BUILD_OUT_TYPES.includes(projectType ?? '') ? 'capital' : 'expense'
  }
  return 'capital'
}

// ─── Reading the books ──────────────────────────────────────────────────────

/** The main (non input-tax) debit of a live revision. */
function mainDebit(live: LiveRevision | null): { accountCode: string; amountCents: number } | null {
  if (!live) return null
  const d = live.lines.find((l) => l.type === 'debit' && !INPUT_TAX_ACCOUNTS.includes(l.accountCode))
  return d ? { accountCode: d.accountCode, amountCents: d.amountCents } : null
}

/** The money credit of a live revision — the credit line that is NOT 2040 (WHT). */
function moneyCredit(live: LiveRevision | null): string | null {
  return live?.lines.find((l) => l.type === 'credit' && l.accountCode !== WHT_PAYABLE)?.accountCode ?? null
}

/** The live (non-voided) assets a CapEx line was capitalised as — FixedAsset.capexLineId. */
export async function findCapitalisedAssets(tenantId: string, lineId: string, db: Db = prisma) {
  return db.fixedAsset.findMany({
    where: { tenantId, capexLineId: lineId, status: { not: 'voided' } },
    select: { id: true, costCents: true, originalCostCents: true, status: true, assetTag: true, name: true },
    orderBy: [{ capexLineUnit: 'asc' }, { id: 'asc' }],
  })
}

/** The pending 'capitalise' request of a line, if any. */
export async function pendingCapitalisation(tenantId: string, lineId: string, db: Db = prisma) {
  return db.fixedAssetEvent.findFirst({
    where: { tenantId, capexLineId: lineId, kind: 'capitalise', status: 'pending' },
    select: { id: true, requestedById: true, requestedAt: true },
  })
}

/**
 * What was advanced for a line: each payment's LIVE 'capex.payment' debit on
 * 1340 (gross), read through `db` so a payment posted earlier in the same
 * transaction counts (Quick buy). The fixed-asset engine applies these at
 * capitalisation (Cr 1340).
 */
export async function capexAdvancesForLine(
  tenantId: string,
  lineId: string,
  db: Db,
): Promise<Array<{ paymentId: string; advancedCents: number }>> {
  const payments = await db.capexPayment.findMany({ where: { lineId }, select: { id: true }, orderBy: { createdAt: 'asc' } })
  const out: Array<{ paymentId: string; advancedCents: number }> = []
  for (const p of payments) {
    const { live } = await liveRevision(tenantId, CAPEX_SOURCE, p.id, db)
    const cents = (live?.lines ?? [])
      .filter((l) => l.type === 'debit' && l.accountCode === ADVANCES_TO_SUPPLIERS)
      .reduce((t, l) => t + l.amountCents, 0)
    if (cents > 0) out.push({ paymentId: p.id, advancedCents: cents })
  }
  return out
}

/**
 * The payable a capitalised line's later payments settle: 2012 (capital
 * suppliers) — or 2010 for a legacy line whose capitalisation credited 2010.
 * Decided from the line's live acquisition entries, whatever the payment's
 * own live entry says.
 */
export async function payableCodeForLine(tenantId: string, lineId: string, db: Db): Promise<'2012' | '2010'> {
  const assets = await db.fixedAsset.findMany({ where: { tenantId, capexLineId: lineId, status: { not: 'voided' } }, select: { id: true } })
  for (const a of assets) {
    const { live } = await liveRevision(tenantId, ACQUIRE_SOURCE, a.id, db)
    if (live?.lines.some((l) => l.type === 'credit' && l.accountCode === LEGACY_PAYABLES)) return '2010'
  }
  return '2012'
}

/** round(base × rate / 10000) within the exact-integer range (same rule as lib/withholding.ts). */
function applyBps(baseCents: number, rateBps: number): number {
  const whole = Math.floor(baseCents / 10_000)
  const rest = baseCents - whole * 10_000
  return whole * rateBps + Math.round((rest * rateBps) / 10_000)
}

/** A line's committed total: negotiated, else unit cost × quantity. */
export function lineCommittedCents(line: { negotiatedCents: unknown; unitCostCents: unknown; quantity: number }): number {
  return line.negotiatedCents != null
    ? toCents(line.negotiatedCents as number)
    : toCents(line.unitCostCents as number) * line.quantity
}

/** This instalment's share of the line's input tax (pro rata on the committed total). */
function inputTaxShare(gross: number, line: { inputTaxCents: unknown; negotiatedCents: unknown; unitCostCents: unknown; quantity: number }): number {
  const tax = toCents(line.inputTaxCents as number)
  if (tax <= 0 || gross <= 0) return 0
  const committed = lineCommittedCents(line)
  if (committed <= 0) return 0
  const whole = Math.floor(gross / committed)
  const share = whole * tax + Math.round(((gross - whole * committed) * tax) / committed)
  return Math.min(gross - 1, share)
}

// ─── Locks on a posted instalment ───────────────────────────────────────────

export interface PaymentLocks {
  appliedToAsset: boolean
  releasing: boolean
  reclassed: boolean
  returned: boolean
  fromCash: boolean
}

async function paymentLocks(
  tenantId: string,
  p: { id: string; lineId: string; source: string },
  live: LiveRevision | null,
  db: Db,
): Promise<PaymentLocks> {
  const debit = mainDebit(live)?.accountCode
  const applied = debit === ADVANCES_TO_SUPPLIERS
    && ((await db.fixedAsset.count({ where: { tenantId, capexLineId: p.lineId, status: { not: 'voided' } } })) > 0
      || !!(await pendingCapitalisation(tenantId, p.lineId, db)))
  const releasing = (await db.prepaidRelease.count({ where: { tenantId, sourceType: 'capex_payment', sourceId: p.id, reversedAt: null } })) > 0
  const reclassed = !!(await liveRevision(tenantId, DEPOSIT_RECLASS_SOURCE, p.id, db)).live
  const returned = !!(await liveRevision(tenantId, DEPOSIT_RETURN_SOURCE, p.id, db)).live
  return { appliedToAsset: applied, releasing, reclassed, returned, fromCash: p.source === 'cash' }
}

function lockError(l: PaymentLocks): AppError | null {
  if (l.fromCash) return new AppError('PAID_FROM_CASH', 'This instalment was paid from petty cash / a cash request — correct it there', 409)
  if (l.appliedToAsset) {
    return new AppError('ADVANCE_APPLIED_TO_ASSET',
      'This advance has been applied to the item on the fixed-asset register (or its capitalisation is waiting for the CEO) — void the asset first to change it', 409)
  }
  if (l.releasing) return new AppError('PREPAID_RELEASING', 'Part of this prepayment has already been released to rent — it can no longer be changed', 409)
  if (l.reclassed) return new AppError('DEPOSIT_RECLASSED', 'This payment was reclassed to security deposits — it can no longer be changed', 409)
  if (l.returned) return new AppError('DEPOSIT_RETURNED', 'This deposit has been returned or forfeited — it can no longer be changed', 409)
  return null
}

/** 409 when a posted instalment may not be deleted / un-paid (the delete route calls this). */
export async function assertPaymentRemovable(paymentId: string, db: Db = prisma): Promise<void> {
  const p = await db.capexPayment.findUnique({ where: { id: paymentId }, include: { line: { include: { project: { select: { tenantId: true } } } } } })
  if (!p) throw new NotFoundError('CapexPayment', paymentId)
  if (p.source === 'cash') throw lockError({ appliedToAsset: false, releasing: false, reclassed: false, returned: false, fromCash: true })!
  const tenantId = p.line.project.tenantId
  if (!tenantId) return
  const { live } = await liveRevision(tenantId, CAPEX_SOURCE, p.id, db)
  const err = lockError(await paymentLocks(tenantId, p, live, db))
  if (err) throw err
}

// ─── One instalment → the books ─────────────────────────────────────────────

/**
 * Post (or re-post, or reverse) one instalment, inside the caller's
 * transaction. The credit — where the money came from — is
 * lib/bankAccounts.ts moneyAccountCode with the PROJECT's company: cash →
 * 1010; bank → the instalment's own bank account (a live linked bank of the
 * project's company), else the company's only bank, else 1020, and 422
 * BANK_ACCOUNT_REQUIRED when it has two or more and none is named. When THIS
 * call names neither `payFrom` nor `bankAccountId`, an instalment already on
 * the books keeps the money account it was credited to (the credit that is
 * not 2040), so correcting an amount or a date never moves it to another bank.
 *
 * Withholding is fixed on the payment (whtCents / whtSection / whtRateBps /
 * filerStatus) when it is first posted paid, and recomputed from the fixed
 * rate when the amount changes; `whtOverrideReason` set = the stored whtCents
 * is the operator's override. 0 while the company's withholding is off.
 */
export async function syncCapexPaymentPosting(
  paymentId: string,
  opts: { tx?: Tx; postedBy?: string; payFrom?: 'bank' | 'cash'; bankAccountId?: string | null } = {},
): Promise<{ status: 'posted' | 'not_paid'; treatment: CapexTreatment | null; outcome: SyncOutcome; entryId: string | null; whtCents: number }> {
  const db = opts.tx ?? prisma
  const p = await db.capexPayment.findUnique({
    where: { id: paymentId },
    include: {
      line: {
        include: {
          project: { select: { id: true, name: true, tenantId: true, conceptId: true, projectType: true } },
          supplierRecord: { select: { id: true, name: true, filerStatus: true, whtExemptUntil: true, defaultWhtSection: true } },
        },
      },
    },
  })
  if (!p) throw new NotFoundError('CapexPayment', paymentId)
  // One writer per line against a capitalisation: the CEO's approval
  // (fixedAssets/events.ts applyCapitalise) reads the line's advances under
  // this lock, so a payment marked paid at the same moment either lands
  // before it (and is applied) or after it (and settles the payable) — never
  // stranded on 1340. Taken before anything about the line is read.
  if (opts.tx) await opts.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'capex_capitalise:' + p.lineId}))`
  const line = p.line
  const project = line.project
  const amount = toCents(p.paidAmountCents ?? p.amountCents)
  const paid = !!p.paidAt && amount > 0
  const tenantId = project.tenantId
  if (!tenantId) {
    if (!paid) return { status: 'not_paid', treatment: null, outcome: 'nothing', entryId: null, whtCents: 0 }
    throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company, so its payments cannot reach the books', 422)
  }

  const { live } = await liveRevision(tenantId, CAPEX_SOURCE, p.id, db)
  const liveMain = mainDebit(live)
  const locks = live ? await paymentLocks(tenantId, p, live, db) : null
  const locked = locks ? lockError(locks) : null

  if (!paid) {
    if (live && locked) throw locked
    const r = await syncSourcePosting({ tenantId, sourceType: CAPEX_SOURCE, id: p.id, desired: null, postedBy: opts.postedBy, reason: 'Capex payment no longer marked paid', tx: opts.tx })
    return { status: 'not_paid', treatment: null, outcome: r.outcome, entryId: null, whtCents: 0 }
  }

  // What the instalment is booked as:
  //   - one already on the books keeps what it was booked as (its live main
  //     debit) — a reclass of a sibling payment, or a line edit, never
  //     re-books it as something else;
  //   - else, the line is on the register or its capitalisation waits for
  //     the CEO: capital, whatever the line's text or treatment says (it
  //     settles the supplier's payable, or advances on 1340 while pending) —
  //     the asset decides;
  //   - else the line's treatment, else what the line reads as.
  const liveTreatment = liveMain ? TREATMENT_OF_CODE[liveMain.accountCode] : undefined
  const onRegister = !liveTreatment && (
    (await db.fixedAsset.count({ where: { tenantId, capexLineId: line.id, status: { not: 'voided' } } })) > 0
    || !!(await pendingCapitalisation(tenantId, line.id, db)))
  const treatment: CapexTreatment = liveTreatment
    ?? (onRegister ? 'capital' : (isCapexTreatment(line.treatment) ? line.treatment : capexTreatmentOf(line, project.projectType)))

  if (treatment === 'prepaid' && !live && (!p.coversFrom || !p.coversMonths)) {
    throw new AppError('PREPAID_TERM_REQUIRED', 'Say which months this rent advance covers (from which month, for how many months) — it is released to rent month by month', 422)
  }

  // Debit.
  let debitCode: string = DEBIT_FOR[treatment]
  if (treatment === 'capital') {
    if (liveMain && CAPITAL_DEBITS.has(liveMain.accountCode)) debitCode = liveMain.accountCode
    else if ((await db.fixedAsset.count({ where: { tenantId, capexLineId: line.id, status: { not: 'voided' } } })) > 0) {
      debitCode = await payableCodeForLine(tenantId, line.id, db)
    }
  }

  // Credit: where the money came from.
  const fromCash = p.source === 'cash'
  const namesMoney = !fromCash && (opts.payFrom !== undefined || opts.bankAccountId !== undefined)
  const liveMoney = moneyCredit(live)
  // A cash payment out of a cash request's paid 6xxx keeps the brand its credit was booked with.
  const creditConceptId = fromCash
    ? (live?.lines.find((l) => l.type === 'credit' && l.accountCode !== WHT_PAYABLE)?.conceptId ?? null)
    : null
  let creditCode: string
  if (fromCash) {
    if (!liveMoney) throw new AppError('CASH_PAYMENT_UNPOSTED', 'This instalment was paid from petty cash but has no entry on the books — post it from the cash request', 422)
    creditCode = liveMoney
  } else if (!namesMoney && liveMoney) {
    creditCode = liveMoney
  } else {
    creditCode = (await moneyAccountCode(db, tenantId, opts.payFrom === 'cash'
      ? { method: 'cash', bankAccountId: null }
      : { method: 'bank', bankAccountId: p.bankAccountId })).code
  }

  // Input tax on a fee / rent (pro rata of the line's); a capital item claims
  // it at capitalisation, a deposit carries none.
  const inputShare = (treatment === 'expense' || treatment === 'prepaid') ? inputTaxShare(amount, line) : 0
  let inputCode: string | null = null
  if (inputShare > 0) {
    if (!isAuthorityKey(line.inputTaxAuthority)) {
      throw new AppError('INPUT_TAX_AUTHORITY_REQUIRED', 'Say which authority charged the sales tax on this line (FBR or SRB)', 422)
    }
    inputCode = inputTaxCodeFor(line.inputTaxAuthority)
  }

  // Withholding (never on a deposit, never on cash-request money).
  let wht = 0
  const snapshot: Prisma.CapexPaymentUpdateInput = {}
  if (treatment !== 'deposit' && !fromCash) {
    const base = amount - (treatment === 'capital' ? inputTaxShare(amount, line) : inputShare)
    if (p.whtOverrideReason) {
      wht = toCents(p.whtCents)
    } else if (p.whtRateBps != null) {
      wht = p.whtSection ? applyBps(base, p.whtRateBps) : 0
    } else {
      const section: WhtSection | null = whtSectionOrNull(
        line.whtSection ?? line.supplierRecord?.defaultWhtSection ?? defaultSectionForCapex(treatment, project.projectType),
      )
      const r = await computeWithholding(db, { tenantId, supplier: line.supplierRecord, section, baseCents: base, at: p.paidAt! })
      wht = r.whtCents
      snapshot.whtSection = r.section
      snapshot.whtRateBps = r.rateBps
      snapshot.filerStatus = r.filerStatus
    }
  }
  if (wht < 0 || (wht > 0 && wht >= amount)) {
    throw new AppError('WHT_TOO_LARGE', 'The income tax withheld must be less than the instalment', 422)
  }
  if (wht !== toCents(p.whtCents)) snapshot.whtCents = wht
  if (Object.keys(snapshot).length > 0) await db.capexPayment.update({ where: { id: p.id }, data: snapshot })

  const mainCents = amount - inputShare
  // A posted instalment that something already used cannot move.
  if (live && locked && (!liveMain || liveMain.amountCents !== mainCents || liveMain.accountCode !== debitCode
    || live.entryDate.getTime() !== p.paidAt!.getTime())) {
    throw locked
  }

  const memo = `${project.name}: ${line.item} — ${p.label}${p.paymentRef ? ` ref ${p.paymentRef}` : ''}`.slice(0, 250)
  const conceptId = treatment === 'expense' || treatment === 'prepaid' ? project.conceptId : null
  const lines: JournalLineInput[] = [
    { accountCode: debitCode, type: 'debit', amountCents: mainCents, memo, conceptId },
    ...(inputShare > 0 && inputCode ? [{ accountCode: inputCode, type: 'debit' as const, amountCents: inputShare, memo }] : []),
    { accountCode: creditCode, type: 'credit', amountCents: amount - wht, memo, conceptId: creditConceptId },
    ...(wht > 0 ? [{ accountCode: WHT_PAYABLE, type: 'credit' as const, amountCents: wht, memo: `Income tax withheld — ${memo}`.slice(0, 250) }] : []),
  ]
  const what = treatment === 'capital'
    ? (debitCode === ADVANCES_TO_SUPPLIERS ? 'advance' : 'supplier balance')
    : treatment === 'prepaid' ? 'prepayment' : treatment === 'deposit' ? 'security deposit' : 'fee'
  const r = await syncSourcePosting({
    tenantId,
    sourceType: CAPEX_SOURCE,
    id: p.id,
    desired: { description: `Capex ${what}: ${project.name} — ${line.item}`, entryDate: p.paidAt!, lines },
    postedBy: opts.postedBy,
    reason: 'Capex payment changed',
    tx: opts.tx,
  })
  return { status: 'posted', treatment, outcome: r.outcome, entryId: r.entryId, whtCents: wht }
}

/** Recompute line.paidCents (Σ paid instalments, gross) and nudge its status. */
export async function recalcLinePaid(lineId: string, db: Db = prisma): Promise<void> {
  const sum = await db.capexPayment.aggregate({ where: { lineId, paidAt: { not: null } }, _sum: { paidAmountCents: true } })
  const paid = toCents(sum._sum.paidAmountCents ?? 0)
  const line = await db.capexLine.findUnique({ where: { id: lineId }, select: { negotiatedCents: true, status: true } })
  if (!line) return
  let status = line.status
  const negotiated = toCents(line.negotiatedCents ?? 0)
  if (negotiated && paid >= negotiated && !['delivered', 'installed', 'commissioned', 'done'].includes(status)) status = 'partial_paid'
  await db.capexLine.update({ where: { id: lineId }, data: { paidCents: paid, status } })
}

// ─── Cash seam (petty cash / cash requests) ─────────────────────────────────

/**
 * Equipment bought with cash (owner: cash goes through the cash-request /
 * petty-cash flow, never a CapEx "pay from cash"). Called inside the spend's
 * own transaction by trustops (a box spend: credit 1011; a cash-request
 * settlement: credit the request's paid 6xxx (H3), or 1355 for a legacy
 * advance). Creates a paid CapexPayment (source 'cash') on
 * the CapEx line and posts 'capex.payment:<id>' Dr 1340 (or the line's
 * payable once it is capitalised) / Cr `creditCode`; no withholding. The
 * line's project must belong to `tenantId` (422 CAPEX_LINE_NOT_IN_COMPANY /
 * PROJECT_HAS_NO_COMPANY) and be a capital line (422 NOT_CAPITAL). The
 * one-time guard is PettyCashSpendLine (tenantId, capexPaymentId), written by
 * the caller; a spend line that already carries a payment returns it.
 */
export async function recordCapexPaymentFromCashTx(tx: Tx, a: {
  tenantId: string; lineId: string; spendLineId: string; amountCents: number
  paidAt: Date; creditCode: string; actorId: string
  /** The brand on the credit line — only for a cash request's paid 6xxx (the brand its pay was booked to). */
  creditConceptId?: string | null
}): Promise<{ capexPaymentId: string; entryId: string }> {
  const fromExpense = /^6\d{3}$/.test(a.creditCode)
  if (a.creditCode !== ACCT.PETTY_CASH && a.creditCode !== ACCT.CASH_ADVANCES && !fromExpense) {
    throw new AppError('BAD_CASH_ACCOUNT', 'Cash for equipment comes from a petty-cash box (1011), a cash request\'s paid expense account (6xxx) or a legacy advance (1355)', 422)
  }
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) throw new AppError('BAD_AMOUNT', 'The amount must be a positive whole number of paisa', 422)
  assertMoneyFits(a.amountCents, 'The capex payment')
  const line = await tx.capexLine.findUnique({ where: { id: a.lineId }, include: { project: { select: { id: true, name: true, tenantId: true, deletedAt: true, projectType: true } } } })
  if (!line || line.project.deletedAt) throw new AppError('CAPEX_LINE_NOT_IN_COMPANY', 'That CapEx line does not belong to this company', 422)
  if (!line.project.tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company', 422)
  if (line.project.tenantId !== a.tenantId) throw new AppError('CAPEX_LINE_NOT_IN_COMPANY', 'That CapEx line does not belong to this company', 422)
  // The capitalisation lock (see syncCapexPaymentPosting) before the line's assets are read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'capex_capitalise:' + line.id}))`
  if (capexTreatmentOf(line, line.project.projectType) !== 'capital') {
    throw new AppError('NOT_CAPITAL', 'Only equipment / capital items are bought through a CapEx cash line', 422)
  }
  const spend = await tx.pettyCashSpendLine.findUnique({ where: { id: a.spendLineId }, select: { tenantId: true, capexPaymentId: true } })
  if (spend && spend.tenantId === a.tenantId && spend.capexPaymentId) {
    const { live } = await liveRevision(a.tenantId, CAPEX_SOURCE, spend.capexPaymentId, tx)
    if (live) return { capexPaymentId: spend.capexPaymentId, entryId: live.entryId }
  }

  const payment = await tx.capexPayment.create({
    data: {
      lineId: line.id, label: 'extra', amountCents: a.amountCents, paidAmountCents: a.amountCents, paidAt: a.paidAt,
      source: 'cash', whtCents: 0, whtRateBps: 0, notes: `Paid in cash — spend line ${a.spendLineId}`,
    },
  })
  const capitalised = (await tx.fixedAsset.count({ where: { tenantId: a.tenantId, capexLineId: line.id, status: { not: 'voided' } } })) > 0
  const debitCode = capitalised ? await payableCodeForLine(a.tenantId, line.id, tx) : ADVANCES_TO_SUPPLIERS
  const memo = `${line.project.name}: ${line.item} — paid in cash`.slice(0, 250)
  const r = await syncSourcePosting({
    tenantId: a.tenantId,
    sourceType: CAPEX_SOURCE,
    id: payment.id,
    desired: {
      description: `Capex ${capitalised ? 'supplier balance' : 'advance'} (cash): ${line.project.name} — ${line.item}`,
      entryDate: a.paidAt,
      lines: [
        { accountCode: debitCode, type: 'debit', amountCents: a.amountCents, memo },
        { accountCode: a.creditCode, type: 'credit', amountCents: a.amountCents, memo, conceptId: fromExpense ? (a.creditConceptId ?? null) : null },
      ],
    },
    postedBy: a.actorId,
    reason: 'Capex cash payment',
    tx,
  })
  await recalcLinePaid(line.id, tx)
  return { capexPaymentId: payment.id, entryId: r.entryId! }
}

// ─── Capitalisation (CapEx → the register, through the CEO) ─────────────────

export interface CapitaliseInput {
  lineId: string
  /** The company the caller resolved (route scope); a line of another company → 404. */
  tenantId?: string
  classKey: string
  inServiceAt?: string
  usefulLifeMonths?: number
  salvageCents?: number
  name?: string
  /** Where the asset is (omitted = the project's outlet). */
  locationId?: string | null
  /** An individual asset's brand (omitted = the project's brand; null = shared across brands). */
  conceptId?: string | null
  pool?: { typeKey: string; conceptId?: string | null }
  costCents?: number
  inputTaxCents?: number
  leaseEndsAt?: string
  reason?: string
}

const DELIVERED = ['delivered', 'installed', 'commissioned', 'done']
const MAX_SPLIT = 200

/**
 * Everything the engine would refuse, asked up front (the engine re-checks at
 * apply): 422 PROJECT_HAS_NO_COMPANY / NOT_CAPITAL / NOT_DELIVERED /
 * COST_BELOW_ADVANCES / SPLIT_TOO_LARGE / ASSET_CLASS / CLASS_INACTIVE /
 * POOL_TYPE_REQUIRED / POOL_NEEDS_LOCATION / LOCATION_NOT_IN_COMPANY /
 * CONCEPT_NOT_IN_COMPANY / LOCATION_REQUIRED_FOR_SHARED (an asset shared
 * across brands with no outlet — owner, 2026-10-14) /
 * INPUT_TAX_AUTHORITY_REQUIRED; 409 ALREADY_CAPITALISED /
 * CAPITALISATION_PENDING. Returns the parsed payload.
 */
export async function checkCapitalisable(db: Db, input: CapitaliseInput): Promise<{ tenantId: string; payload: CapitalisePayload; cls: FixedAssetClass; line: { id: string; item: string; projectName: string } }> {
  const line = await db.capexLine.findUnique({
    where: { id: input.lineId },
    include: { project: { select: { id: true, name: true, tenantId: true, conceptId: true, locationId: true, projectType: true, deletedAt: true } } },
  })
  if (!line || line.project.deletedAt) throw new NotFoundError('CapexLine', input.lineId)
  const tenantId = line.project.tenantId
  if (!tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company — assets belong to one company', 422)
  if (input.tenantId && input.tenantId !== tenantId) throw new NotFoundError('CapexLine', input.lineId)

  // What the line's posted instalments say it is wins over the text heuristic.
  let treatment = isCapexTreatment(line.treatment) ? line.treatment : null
  if (!treatment) {
    for (const p of await db.capexPayment.findMany({ where: { lineId: line.id }, select: { id: true } })) {
      const code = mainDebit((await liveRevision(tenantId, CAPEX_SOURCE, p.id, db)).live)?.accountCode
      if (code && TREATMENT_OF_CODE[code]) { treatment = TREATMENT_OF_CODE[code]!; break }
    }
  }
  treatment ??= capexTreatmentOf(line, line.project.projectType)
  if (treatment !== 'capital') {
    throw new AppError('NOT_CAPITAL', 'A rent advance is a prepayment, a deposit is held on 1360 and a broker / legal fee is an expense — none becomes an asset', 422)
  }
  if (!DELIVERED.includes(line.status) && !line.actualDeliveryDate) {
    throw new AppError('NOT_DELIVERED', 'Capitalise the item once it is delivered — mark it delivered first', 422)
  }
  if ((await db.fixedAsset.count({ where: { tenantId, capexLineId: line.id, status: { not: 'voided' } } })) > 0) {
    throw new AppError('ALREADY_CAPITALISED', 'This item is already on the fixed-asset register', 409)
  }
  if (await pendingCapitalisation(tenantId, line.id, db)) {
    throw new AppError('CAPITALISATION_PENDING', 'This item\'s capitalisation is already waiting for the CEO', 409)
  }

  const cls = await classOf(tenantId, input.classKey, db)
  if (!cls.isActive) throw new AppError('CLASS_INACTIVE', `${cls.label} is switched off for this company`, 422)
  const locationId = input.locationId !== undefined ? input.locationId : line.project.locationId
  if (input.locationId) {
    const l = await db.location.findFirst({ where: { id: input.locationId, tenantId, deletedAt: null }, select: { id: true } })
    if (!l) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That location does not belong to this company', 422)
  }
  if (cls.pooled) {
    if (!input.pool) throw new AppError('POOL_TYPE_REQUIRED', 'Say which smallwares type this is (plates, knives, …)', 422)
    if (!SMALLWARE_TYPES.includes(input.pool.typeKey)) {
      throw new AppError('POOL_TYPE', `Unknown smallwares type "${input.pool.typeKey}" — one of ${SMALLWARE_TYPES.join(', ')}`, 422)
    }
    if (!locationId) throw new AppError('POOL_NEEDS_LOCATION', 'Smallwares are pooled per outlet — name the outlet', 422)
    if (input.pool.conceptId) {
      const c = await db.concept.findFirst({ where: { id: input.pool.conceptId, tenantId, deletedAt: null }, select: { id: true } })
      if (!c) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand does not belong to this company', 422)
    }
  } else {
    if (line.quantity > MAX_SPLIT) {
      throw new AppError('SPLIT_TOO_LARGE', `A line of more than ${MAX_SPLIT} units cannot be split into individual assets — split the line or use a pooled class`, 422)
    }
    if (input.conceptId) {
      const c = await db.concept.findFirst({ where: { id: input.conceptId, tenantId, deletedAt: null }, select: { id: true } })
      if (!c) throw new AppError('CONCEPT_NOT_IN_COMPANY', 'That brand does not belong to this company', 422)
    }
    // Shared equipment always says where it is (the project's outlet counts).
    const target = capitaliseTarget({ locationId: input.locationId, conceptId: input.conceptId }, false, line.project)
    assertSharedHasLocation(target.conceptId, target.locationId)
  }

  const advanced = (await capexAdvancesForLine(tenantId, line.id, db)).reduce((t, a) => t + a.advancedCents, 0)
  const gross = input.costCents ?? Math.max(lineCommittedCents(line), advanced)
  if (gross <= 0) throw new AppError('NO_COST', 'This line has no cost to capitalise', 422)
  assertMoneyFits(gross, 'The asset\'s cost')
  if (gross < advanced) {
    throw new AppError('COST_BELOW_ADVANCES', `PKR ${(advanced / 100).toFixed(0)} has been advanced for this item — the asset cannot cost less`, 422)
  }
  const inputTax = input.inputTaxCents ?? toCents(line.inputTaxCents)
  if (inputTax > 0 && !isAuthorityKey(line.inputTaxAuthority)) {
    throw new AppError('INPUT_TAX_AUTHORITY_REQUIRED', 'Say which authority charged the sales tax on this line before capitalising its input tax', 422)
  }
  if (inputTax >= gross) throw new AppError('INPUT_TAX_TOO_LARGE', 'Input tax must be less than the cost', 422)

  const payload = PAYLOAD_SCHEMAS.capitalise.parse({
    classKey: cls.key,
    ...(input.inServiceAt ? { inServiceAt: input.inServiceAt } : {}),
    ...(input.usefulLifeMonths !== undefined ? { usefulLifeMonths: input.usefulLifeMonths } : {}),
    ...(input.salvageCents !== undefined ? { salvageCents: input.salvageCents } : {}),
    ...(input.name ? { name: input.name } : {}),
    // The target that passed the checks above is what the CEO's approval
    // applies: the outlet (and, for an individual asset, the brand) resolved
    // NOW, never the project's at approval time — a project edited while the
    // request waits cannot turn it into shared equipment with no location.
    locationId: locationId ?? null,
    ...(!cls.pooled ? { conceptId: input.conceptId !== undefined ? input.conceptId : (line.project.conceptId ?? null) } : {}),
    ...(cls.pooled && input.pool ? { pool: input.pool } : {}),
    ...(input.costCents !== undefined ? { costCents: input.costCents } : {}),
    ...(input.inputTaxCents !== undefined ? { inputTaxCents: input.inputTaxCents } : {}),
    ...(input.leaseEndsAt ? { leaseEndsAt: input.leaseEndsAt } : {}),
  })
  return { tenantId, payload, cls, line: { id: line.id, item: line.item, projectName: line.project.name } }
}

function defaultReason(item: string, project: string): string {
  return `Capitalise "${item}" from CapEx project "${project}"`.slice(0, 1000)
}

/**
 * Prepare a delivered line for the register: a 'capitalise' request
 * (fixedAssets/events.ts createRequest). EVERY capitalisation goes to the CEO
 * (today's ADMIN_ONLY control kept — an owner question is open); the CEO's
 * own preparation applies at once and returns the new asset ids.
 */
export async function prepareCapitalisation(
  input: CapitaliseInput,
  actor: { id: string; role: string },
): Promise<{ eventId: string; applied: boolean; assetIds: string[] }> {
  if (!FA_WRITER_ROLES.includes(actor.role)) {
    throw new AppError('FA_WRITE_FORBIDDEN', 'Only finance, management or the owners can prepare a capitalisation', 403)
  }
  const { tenantId, payload, line } = await checkCapitalisable(prisma, input)
  try {
    const { event, applied } = await createRequest({
      kind: 'capitalise',
      capexLineId: line.id,
      tenantId,
      reason: (input.reason ?? '').trim().length >= 10 ? input.reason!.trim() : defaultReason(line.item, line.projectName),
      payload: { ...payload },
    }, actor)
    const ids = (event.payload as { assetIds?: unknown } | null)?.assetIds
    return { eventId: event.id, applied, assetIds: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [] }
  } catch (err) {
    if (err instanceof AppError && err.code === 'REQUEST_PENDING') {
      throw new AppError('CAPITALISATION_PENDING', 'This item\'s capitalisation is already waiting for the CEO', 409)
    }
    throw err
  }
}

/**
 * The pending 'capitalise' request row, written inside the caller's
 * transaction (Quick buy: the project, line, payment and request commit
 * together). Same row createRequest writes for a request that waits; the
 * CEO's own Quick buy is then applied through events.applyEvent — the one
 * approval engine. TODO(w3-fa-api): replace with an exported
 * events.createRequestTx once it exists.
 */
export async function insertCapitaliseRequestTx(
  tx: Tx,
  a: { tenantId: string; lineId: string; payload: CapitalisePayload; reason: string; requestedById: string; effectiveDate: Date },
): Promise<string> {
  try {
    const ev = await tx.fixedAssetEvent.create({
      data: {
        tenantId: a.tenantId,
        capexLineId: a.lineId,
        kind: 'capitalise',
        status: 'pending',
        effectiveDate: a.effectiveDate,
        payload: JSON.parse(JSON.stringify(a.payload)) as Prisma.InputJsonObject,
        amountCents: a.payload.costCents ?? null,
        reason: a.reason.slice(0, 1000),
        requestedById: a.requestedById,
      },
      select: { id: true },
    })
    return ev.id
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError('CAPITALISATION_PENDING', 'This item\'s capitalisation is already waiting for the CEO', 409)
    }
    throw err
  }
}

// ─── Deposits (H25: refundable deposits on 1360) ────────────────────────────

/** What a payment holds on 1360: its own live 1360 debit, or a legacy 1310 reclassed. */
export async function depositHeldCents(tenantId: string, paymentId: string, db: Db): Promise<number> {
  const own = (await liveRevision(tenantId, CAPEX_SOURCE, paymentId, db)).live
  const fromPayment = (own?.lines ?? []).filter((l) => l.type === 'debit' && l.accountCode === SECURITY_DEPOSITS).reduce((t, l) => t + l.amountCents, 0)
  const re = (await liveRevision(tenantId, DEPOSIT_RECLASS_SOURCE, paymentId, db)).live
  const reclassed = (re?.lines ?? []).filter((l) => l.type === 'debit' && l.accountCode === SECURITY_DEPOSITS).reduce((t, l) => t + l.amountCents, 0)
  return fromPayment + reclassed
}

/**
 * A deposit comes back (or is kept by the landlord): 'capex.deposit_return:
 * <paymentId>' Dr money (returned) + Dr 6010 (forfeited, the project's brand)
 * / Cr 1360. The totals are what the call says (a second call re-states them).
 * Dated `receivedAt` — a closed month is 422 PERIOD_LOCKED (user-entered money).
 *
 * Money returned names how it came back (`method`: a receipt method, lib/
 * bankAccounts.ts — cash, bank transfer, bank deposit, cheque) and its
 * payment reference # (422 PAYMENT_REFERENCE_REQUIRED without one, owner
 * 2026-10-14); the money account is moneyAccountCode of the PROJECT's company
 * (a bank of another company → 422). The description and the money line's
 * memo carry "bank deposit, ref 4471"; the payment keeps depositReturnMethod /
 * depositReturnRef. Nothing returned (all kept) needs no method or reference.
 */
export async function recordDepositReturn(tx: Tx, a: {
  paymentId: string; returnedCents: number; forfeitedCents: number; reason?: string | null
  receivedAt: Date; method: string; reference?: string | null; bankAccountId?: string | null; postedBy: string
}): Promise<{ entryId: string | null; heldCents: number; reference: string | null }> {
  const p = await tx.capexPayment.findUnique({ where: { id: a.paymentId }, include: { line: { include: { project: true } } } })
  if (!p) throw new NotFoundError('CapexPayment', a.paymentId)
  const project = p.line.project
  if (!project.tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company', 422)
  const held = await depositHeldCents(project.tenantId, p.id, tx)
  if (held <= 0) throw new AppError('NOT_A_DEPOSIT', 'This payment is not a security deposit on the books (1360)', 422)
  const total = a.returnedCents + a.forfeitedCents
  if (total <= 0) throw new AppError('NOTHING_RETURNED', 'Say how much came back or was kept', 422)
  if (total > held) {
    throw new AppError('RETURN_EXCEEDS_DEPOSIT', `The deposit held is PKR ${(held / 100).toFixed(2)} — returned plus kept cannot be more`, 422)
  }
  if (a.forfeitedCents > 0 && (a.reason ?? '').trim().length < 5) {
    throw new AppError('REASON_REQUIRED', 'Say why the landlord kept part of the deposit', 422)
  }
  const returned = a.returnedCents > 0
  const reference = returned ? assertPaymentReference(a.method, a.reference) : null
  const money = returned
    ? await moneyAccountCode(tx, project.tenantId, { method: a.method, bankAccountId: a.bankAccountId ?? null })
    : { code: null, bankAccountId: null }
  const paid = returned ? receiptText(a.method, reference) : null
  const memo = `${project.name}: ${p.line.item} — deposit ${a.forfeitedCents > 0 ? `returned / kept (${(a.reason ?? '').trim()})` : 'returned'}`.slice(0, 250)
  const description = `Security deposit returned: ${project.name} — ${p.line.item}${paid ? ` (${paid})` : ''}`
  // syncSourcePosting compares amounts, accounts and the date only: a re-statement that
  // changes just the words (a corrected reference # or method on the same bank) reverses
  // the live entry first, so the books say what the payment row says.
  const { live } = await liveRevision(project.tenantId, DEPOSIT_RETURN_SOURCE, p.id, tx)
  if (live) {
    const was = await tx.journalEntry.findUnique({ where: { id: live.entryId }, select: { description: true } })
    if (was && was.description !== description) {
      await syncSourcePosting({
        tenantId: project.tenantId, sourceType: DEPOSIT_RETURN_SOURCE, id: p.id, desired: null,
        postedBy: a.postedBy, reason: 'Deposit return reference corrected', tx,
      })
    }
  }
  const r = await syncSourcePosting({
    tenantId: project.tenantId,
    sourceType: DEPOSIT_RETURN_SOURCE,
    id: p.id,
    desired: {
      description,
      entryDate: a.receivedAt,
      lines: [
        ...(returned && money.code ? [{ accountCode: money.code, type: 'debit' as const, amountCents: a.returnedCents, memo: `Deposit returned (${paid}) — ${memo}` }] : []),
        ...(a.forfeitedCents > 0 ? [{ accountCode: RENT, type: 'debit' as const, amountCents: a.forfeitedCents, memo, conceptId: project.conceptId }] : []),
        { accountCode: SECURITY_DEPOSITS, type: 'credit', amountCents: total, memo },
      ],
    },
    postedBy: a.postedBy,
    reason: 'Deposit return changed',
    tx,
  })
  await tx.capexPayment.update({
    where: { id: p.id },
    data: {
      depositReturnedCents: a.returnedCents, depositForfeitedCents: a.forfeitedCents, depositReturnedAt: a.receivedAt,
      depositReturnMethod: returned ? a.method : null,
      depositReturnRef: reference,
      depositReturnBankAccountId: returned ? money.bankAccountId : null,
    },
  })
  return { entryId: r.entryId, heldCents: held, reference }
}

/**
 * A legacy security deposit booked as a prepayment (Dr 1310) moves to 1360:
 * 'capex.deposit_reclass:<paymentId>' Dr 1360 / Cr 1310, dated now (late
 * rule). The line becomes a deposit line; the payment is then locked
 * (DEPOSIT_RECLASSED). 409 ALREADY_RECLASSED · 409 PREPAID_RELEASING ·
 * 422 NOT_A_PREPAYMENT.
 */
export async function reclassLegacyDeposit(tx: Tx, paymentId: string, opts: { dryRun: boolean; postedBy: string }): Promise<{ amountCents: number; entryId: string | null; dryRun: boolean }> {
  const p = await tx.capexPayment.findUnique({ where: { id: paymentId }, include: { line: { include: { project: true } } } })
  if (!p) throw new NotFoundError('CapexPayment', paymentId)
  const project = p.line.project
  if (!project.tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company', 422)
  const tenantId = project.tenantId
  if ((await liveRevision(tenantId, DEPOSIT_RECLASS_SOURCE, p.id, tx)).live) throw new AppError('ALREADY_RECLASSED', 'This deposit has already been moved to 1360', 409)
  const live = (await liveRevision(tenantId, CAPEX_SOURCE, p.id, tx)).live
  const main = mainDebit(live)
  if (!main || main.accountCode !== PREPAID_EXPENSES) throw new AppError('NOT_A_PREPAYMENT', 'Only a payment booked as a prepayment (1310) can be moved to security deposits', 422)
  if ((await tx.prepaidRelease.count({ where: { tenantId, sourceType: 'capex_payment', sourceId: p.id, reversedAt: null } })) > 0) {
    throw new AppError('PREPAID_RELEASING', 'Part of this prepayment has already been released to rent — it is not a deposit', 409)
  }
  if (opts.dryRun) return { amountCents: main.amountCents, entryId: null, dryRun: true }
  const d = await lateDatingFor(tx, tenantId, new Date())
  if ('lockedThroughToday' in d) throw new AppError('BOOKS_CLOSED_TODAY', 'The books are closed through today — nothing can post until a month is open', 409)
  const memo = `${project.name}: ${p.line.item} — legacy deposit moved from prepaid to security deposits`.slice(0, 250)
  const body = withLateNote(`Security deposit reclass: ${project.name} — ${p.line.item}`, [
    { accountCode: SECURITY_DEPOSITS, type: 'debit', amountCents: main.amountCents, memo },
    { accountCode: PREPAID_EXPENSES, type: 'credit', amountCents: main.amountCents, memo },
  ], d.memoNote)
  const r = await syncSourcePosting({
    tenantId, sourceType: DEPOSIT_RECLASS_SOURCE, id: p.id,
    desired: { description: body.description, entryDate: d.entryDate, lines: body.lines },
    postedBy: opts.postedBy, reason: 'Deposit reclass', tx,
  })
  // The reclass is per PAYMENT (its DEPOSIT_RECLASS entry, and the
  // DEPOSIT_RECLASSED lock). The line becomes 'deposit' only when no OTHER
  // instalment of it is on the books as something else — a sibling rent
  // advance on 1310 must stay a rent advance (with its WHT and input tax), not
  // be re-booked as a deposit on its next edit.
  const siblings = await tx.capexPayment.findMany({ where: { lineId: p.lineId, id: { not: p.id } }, select: { id: true } })
  let othersElsewhere = false
  for (const s of siblings) {
    const m = mainDebit((await liveRevision(tenantId, CAPEX_SOURCE, s.id, tx)).live)
    if (!m || m.accountCode === SECURITY_DEPOSITS) continue
    if ((await liveRevision(tenantId, DEPOSIT_RECLASS_SOURCE, s.id, tx)).live) continue   // itself reclassed to 1360
    othersElsewhere = true
    break
  }
  if (!othersElsewhere) await tx.capexLine.update({ where: { id: p.lineId }, data: { treatment: 'deposit' } })
  return { amountCents: main.amountCents, entryId: r.entryId, dryRun: false }
}

// ─── Orphan advances ────────────────────────────────────────────────────────

/** Live 'capex.payment' entries whose payment row is gone or whose project was deleted. */
export async function findOrphanAdvances(tenantIds: string[], db: Db = prisma): Promise<Array<{ paymentId: string; tenantId: string; entryId: string; amountCents: number; debitCode: string | null; reason: 'payment_deleted' | 'project_deleted' }>> {
  if (tenantIds.length === 0) return []
  const entries = await db.journalEntry.findMany({
    where: { tenantId: { in: tenantIds }, OR: [{ reference: { startsWith: `${CAPEX_SOURCE}:` } }, { reference: { startsWith: `${CAPEX_SOURCE}.reversal:` } }] },
    select: { id: true, tenantId: true, reference: true, lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } } },
    orderBy: { createdAt: 'asc' },
  })
  const reversed = new Set(entries.filter((e) => e.reference!.startsWith(`${CAPEX_SOURCE}.reversal:`)).map((e) => `${e.tenantId}|${e.reference!.slice(`${CAPEX_SOURCE}.reversal:`.length)}`))
  const live = new Map<string, { tenantId: string; entryId: string; amountCents: number; debitCode: string | null }>()
  for (const e of entries) {
    if (!e.reference!.startsWith(`${CAPEX_SOURCE}:`)) continue
    const sid = e.reference!.slice(`${CAPEX_SOURCE}:`.length)
    if (reversed.has(`${e.tenantId}|${sid}`)) continue
    const debits = e.lines.filter((l) => l.type === 'debit')
    live.set(sid.split('@')[0]!, {
      tenantId: e.tenantId!, entryId: e.id,
      amountCents: debits.reduce((t, l) => t + toCents(l.amountCents), 0),
      debitCode: debits[0]?.account.code ?? null,
    })
  }
  if (live.size === 0) return []
  const rows = await db.capexPayment.findMany({ where: { id: { in: [...live.keys()] } }, select: { id: true, line: { select: { project: { select: { deletedAt: true } } } } } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: Array<{ paymentId: string; tenantId: string; entryId: string; amountCents: number; debitCode: string | null; reason: 'payment_deleted' | 'project_deleted' }> = []
  for (const [paymentId, e] of live) {
    const row = byId.get(paymentId)
    if (!row) out.push({ paymentId, ...e, reason: 'payment_deleted' })
    else if (row.line.project.deletedAt) out.push({ paymentId, ...e, reason: 'project_deleted' })
  }
  return out
}

// ─── The books' view of CapEx lines (tracker, Investment page) ──────────────

export interface CapexLineLedger {
  advancedCents: number
  prepaidCents: number
  releasedCents: number
  depositHeldCents: number
  expensedCents: number
  settledPayableCents: number
  whtCents: number
  /** Cost still on the books of the line's ACTIVE assets (M-04: disposed / voided excluded). */
  capitalisedCents: number
  disposedCents: number
  /** First active asset with the line's active cost (kept for the existing screens). */
  asset: { id: string; costCents: number; status: string } | null
  assets: Array<{ id: string; assetTag: string | null; costCents: number; status: string }>
  capitalisation: { assetIds: string[]; pendingEventId: string | null }
  payments: Record<string, { status: 'posted' | 'unposted'; accountCode: string | null; whtCents: number; releasedCents: number }>
}

/** Live revisions with their lines, per base id, for one source type (batched). */
async function liveEntriesFor(tenantIds: string[], sourceType: string, ids: Set<string>, db: Db): Promise<Map<string, LiveRevision['lines']>> {
  const out = new Map<string, LiveRevision['lines']>()
  if (ids.size === 0 || tenantIds.length === 0) return out
  const entries = await db.journalEntry.findMany({
    where: { tenantId: { in: tenantIds }, OR: [{ reference: { startsWith: `${sourceType}:` } }, { reference: { startsWith: `${sourceType}.reversal:` } }] },
    select: { reference: true, lines: { select: { type: true, amountCents: true, conceptId: true, account: { select: { code: true } } } } },
    orderBy: { createdAt: 'asc' },
  })
  const reversed = new Set(entries.filter((e) => e.reference!.startsWith(`${sourceType}.reversal:`)).map((e) => e.reference!.slice(`${sourceType}.reversal:`.length)))
  for (const e of entries) {
    if (!e.reference!.startsWith(`${sourceType}:`)) continue
    const sid = e.reference!.slice(`${sourceType}:`.length)
    const base = sid.split('@')[0]!
    if (!ids.has(base) || reversed.has(sid)) continue
    out.set(base, e.lines.map((l) => ({ accountCode: l.account.code, type: l.type, amountCents: toCents(l.amountCents), conceptId: l.conceptId })))
  }
  return out
}

const sumOf = (lines: LiveRevision['lines'] | undefined, type: 'debit' | 'credit', code: string) =>
  (lines ?? []).filter((l) => l.type === type && l.accountCode === code).reduce((t, l) => t + l.amountCents, 0)

/** Ledger view of capex lines, keyed by line id. */
export async function capexLedgerState(
  tenantIds: string[],
  lines: Array<{ id: string; payments: Array<{ id: string }> }>,
  db: Db = prisma,
): Promise<Map<string, CapexLineLedger>> {
  const paymentIds = new Set(lines.flatMap((l) => l.payments.map((p) => p.id)))
  const lineIds = lines.map((l) => l.id)
  const [pay, ret, recl, assets, pending, releases] = await Promise.all([
    liveEntriesFor(tenantIds, CAPEX_SOURCE, paymentIds, db),
    liveEntriesFor(tenantIds, DEPOSIT_RETURN_SOURCE, paymentIds, db),
    liveEntriesFor(tenantIds, DEPOSIT_RECLASS_SOURCE, paymentIds, db),
    lineIds.length === 0 ? [] : db.fixedAsset.findMany({
      where: { tenantId: { in: tenantIds }, capexLineId: { in: lineIds }, status: { not: 'voided' } },
      select: { id: true, capexLineId: true, costCents: true, originalCostCents: true, status: true, assetTag: true },
      orderBy: [{ capexLineUnit: 'asc' }, { id: 'asc' }],
    }),
    lineIds.length === 0 ? [] : db.fixedAssetEvent.findMany({
      where: { tenantId: { in: tenantIds }, capexLineId: { in: lineIds }, kind: 'capitalise', status: 'pending' },
      select: { id: true, capexLineId: true },
    }),
    paymentIds.size === 0 ? [] : db.prepaidRelease.groupBy({
      by: ['sourceId'],
      where: { tenantId: { in: tenantIds }, sourceType: 'capex_payment', sourceId: { in: [...paymentIds] }, reversedAt: null },
      _sum: { amountCents: true },
    }),
  ])
  const releasedOf = new Map(releases.map((r) => [r.sourceId, toCents(r._sum.amountCents ?? 0)]))
  const byLine = new Map<string, CapexLineLedger>()
  for (const l of lines) {
    const mine = assets.filter((a) => a.capexLineId === l.id)
    const active = mine.filter((a) => a.status === 'active')
    const row: CapexLineLedger = {
      advancedCents: 0, prepaidCents: 0, releasedCents: 0, depositHeldCents: 0, expensedCents: 0, settledPayableCents: 0, whtCents: 0,
      capitalisedCents: active.reduce((t, a) => t + toCents(a.costCents), 0),
      disposedCents: mine.filter((a) => a.status === 'disposed').reduce((t, a) => t + (toCents(a.originalCostCents) || toCents(a.costCents)), 0),
      asset: active[0] ? { id: active[0].id, costCents: active.reduce((t, a) => t + toCents(a.costCents), 0), status: 'active' } : null,
      assets: mine.map((a) => ({ id: a.id, assetTag: a.assetTag, costCents: toCents(a.costCents), status: a.status })),
      capitalisation: { assetIds: mine.map((a) => a.id), pendingEventId: pending.find((e) => e.capexLineId === l.id)?.id ?? null },
      payments: {},
    }
    for (const p of l.payments) {
      const e = pay.get(p.id)
      const main = e?.find((x) => x.type === 'debit' && !INPUT_TAX_ACCOUNTS.includes(x.accountCode))
      const wht = sumOf(e, 'credit', WHT_PAYABLE)
      const released = releasedOf.get(p.id) ?? 0
      row.payments[p.id] = { status: e ? 'posted' : 'unposted', accountCode: main?.accountCode ?? null, whtCents: wht, releasedCents: released }
      if (!e) continue
      row.whtCents += wht
      row.releasedCents += released
      const amt = main?.amountCents ?? 0
      switch (main?.accountCode) {
        case ADVANCES_TO_SUPPLIERS: row.advancedCents += amt; break
        case PREPAID_EXPENSES: row.prepaidCents += amt; break
        case SECURITY_DEPOSITS: row.depositHeldCents += amt; break
        case PROFESSIONAL_FEES: row.expensedCents += amt; break
        case CAPITAL_PAYABLES: case LEGACY_PAYABLES: row.settledPayableCents += amt; break
      }
      const reclassed = sumOf(recl.get(p.id), 'debit', SECURITY_DEPOSITS)
      if (reclassed > 0) { row.prepaidCents -= reclassed; row.depositHeldCents += reclassed }
      row.depositHeldCents -= sumOf(ret.get(p.id), 'credit', SECURITY_DEPOSITS)
    }
    byLine.set(l.id, row)
  }
  return byLine
}
