// Capital spend → the ledger. ONE path (owner decision 24):
//
//   1. Each CapEx instalment marked paid posts as it happens ('capex.payment',
//      keyed on the payment id, kept in step by syncSourcePosting):
//        capital item          Dr 1340 Advances to suppliers / Cr bank
//        rent advance/deposit  Dr 1310 Prepaid expenses      / Cr bank
//        broker / consultant   Dr 6110 Professional fees     / Cr bank
//      A capital item paid AFTER it was capitalised settles the supplier:
//        Dr 2010 / Cr bank (the capitalisation credited 2010 for the unpaid part).
//   2. When the item is delivered it is CAPITALISED through the fixed-asset
//      register (capitaliseCapexLine): Dr 15x0 / Cr 1340 for what was
//      advanced, Cr 2010 for the rest; depreciation then runs from the register.
//
// The Capex tracker keeps the project side (quotes, status, budget); the
// fixed-asset register is the only place capital spend becomes an asset. The
// old Excel-mirror capital ledger (CapitalLedgerEntry) posted nothing and is
// read-only history now; the capex tracker used to post nothing either, so an
// oven paid in three instalments never reached the bank balance, the balance
// sheet or the investing cash flow unless someone typed it in twice.

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { ACCT } from '../accounting/journal.js'
import { syncSourcePosting, liveRevision, liveRevisionsFor, type SyncOutcome } from '../accounting/sourcePosting.js'
import { ASSET_CATEGORIES, postAcquisition, type AssetCategory } from '../fixedAssets/service.js'

type Tx = Prisma.TransactionClient | PrismaClient

export const CAPEX_SOURCE = 'capex.payment'
export const ADVANCES_TO_SUPPLIERS = '1340'
export const PREPAID_EXPENSES = '1310'
export const PROFESSIONAL_FEES = '6110'

export type CapexTreatment = 'capital' | 'prepaid' | 'expense'
const DEBIT_FOR: Record<CapexTreatment, string> = {
  capital: ADVANCES_TO_SUPPLIERS,
  prepaid: PREPAID_EXPENSES,
  expense: PROFESSIONAL_FEES,
}
const TREATMENT_OF_CODE: Record<string, CapexTreatment> = {
  [ADVANCES_TO_SUPPLIERS]: 'capital',
  [ACCT.AP_SUPPLIERS]: 'capital',
  [PREPAID_EXPENSES]: 'prepaid',
  [PROFESSIONAL_FEES]: 'expense',
}

/** How a capex line's spend is booked, from what it is (decision 24). */
export function capexTreatmentOf(line: { scope: string; category: string | null; item: string }): CapexTreatment {
  const text = `${line.scope} ${line.category ?? ''} ${line.item}`
  if (/\brent\b/i.test(text) && /\b(advance|deposit|security|prepaid|upfront)\b/i.test(text)) return 'prepaid'
  if (/\b(broker|brokerage|consultant|consultancy|consulting|legal|architect|professional fee|design fee)\b/i.test(text)) return 'expense'
  return 'capital'
}

/** The fixed asset a capex line was capitalised as (FixedAsset.notes carries the link until capexLineId exists). */
export function capexLinkNote(lineId: string): string {
  return `capex-line:${lineId}`
}

export async function findCapitalisedAsset(tenantId: string, lineId: string, db: Tx = prisma) {
  return (db as typeof prisma).fixedAsset.findFirst({
    where: { tenantId, notes: { startsWith: capexLinkNote(lineId) } },
    select: { id: true, costCents: true, name: true, acquiredAt: true },
  })
}

export async function syncCapexPaymentPosting(
  paymentId: string,
  opts: { tx?: Tx; postedBy?: string; treatment?: CapexTreatment; payFrom?: 'bank' | 'cash' } = {},
): Promise<{ status: 'posted' | 'not_paid'; treatment: CapexTreatment | null; outcome: SyncOutcome; entryId: string | null }> {
  const db = (opts.tx ?? prisma) as typeof prisma
  const p = await db.capexPayment.findUnique({
    where: { id: paymentId },
    include: { line: { include: { project: { select: { id: true, name: true, tenantId: true, conceptId: true } } } } },
  })
  if (!p) throw new NotFoundError('CapexPayment', paymentId)
  const project = p.line.project
  const amount = p.paidAmountCents ?? p.amountCents
  const paid = !!p.paidAt && amount > 0
  const tenantId = project.tenantId
  if (!tenantId) {
    if (!paid) return { status: 'not_paid', treatment: null, outcome: 'nothing', entryId: null }
    throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company, so its payments cannot reach the books', 422)
  }
  if (!paid) {
    const r = await syncSourcePosting({ tenantId, sourceType: CAPEX_SOURCE, id: p.id, desired: null, postedBy: opts.postedBy, reason: 'Capex payment no longer marked paid', tx: opts.tx })
    return { status: 'not_paid', treatment: null, outcome: r.outcome, entryId: null }
  }

  const { live } = await liveRevision(tenantId, CAPEX_SOURCE, p.id, db)
  const liveDebit = live?.lines.find((l) => l.type === 'debit')?.accountCode
  const liveCredit = live?.lines.find((l) => l.type === 'credit')?.accountCode
  const treatment = opts.treatment ?? (liveDebit ? TREATMENT_OF_CODE[liveDebit] : undefined) ?? capexTreatmentOf(p.line)
  let debitCode = DEBIT_FOR[treatment]
  if (treatment === 'capital') {
    // Already an asset: this payment settles what the capitalisation left owing.
    if (liveDebit === ACCT.AP_SUPPLIERS) debitCode = ACCT.AP_SUPPLIERS
    else if (!live && await findCapitalisedAsset(tenantId, p.lineId, db)) debitCode = ACCT.AP_SUPPLIERS
  }
  const creditCode = opts.payFrom === 'cash' ? ACCT.CASH_ON_HAND
    : opts.payFrom === 'bank' ? ACCT.BANK
    : liveCredit ?? ACCT.BANK
  const memo = `${project.name}: ${p.line.item} — ${p.label}${p.paymentRef ? ` ref ${p.paymentRef}` : ''}`.slice(0, 250)
  const conceptId = treatment === 'expense' ? project.conceptId : null
  const r = await syncSourcePosting({
    tenantId,
    sourceType: CAPEX_SOURCE,
    id: p.id,
    desired: {
      description: `Capex ${treatment === 'capital' ? (debitCode === ACCT.AP_SUPPLIERS ? 'supplier balance' : 'advance') : treatment === 'prepaid' ? 'prepayment' : 'fee'}: ${project.name} — ${p.line.item}`,
      entryDate: p.paidAt!,
      lines: [
        { accountCode: debitCode,  type: 'debit',  amountCents: amount, memo, conceptId },
        { accountCode: creditCode, type: 'credit', amountCents: amount, memo },
      ],
    },
    postedBy: opts.postedBy,
    reason: 'Capex payment changed',
    tx: opts.tx,
  })
  return { status: 'posted', treatment, outcome: r.outcome, entryId: r.entryId }
}

export interface CapitaliseInput {
  lineId: string
  category: AssetCategory
  usefulLifeMonths: number
  salvageCents?: number
  name?: string
  acquiredAt?: Date
  costCents?: number
  locationId?: string | null
  postedBy: string
}

/**
 * Capitalise a delivered capex line through the fixed-asset register:
 * Dr 15x0 cost / Cr 1340 what was advanced, Cr 2010 the rest still owed.
 * Once per line (advisory-locked, and refused when the asset exists).
 */
export async function capitaliseCapexLine(input: CapitaliseInput) {
  const line = await prisma.capexLine.findUnique({
    where: { id: input.lineId },
    include: { project: { select: { id: true, name: true, tenantId: true, conceptId: true, locationId: true } }, payments: { select: { id: true } } },
  })
  if (!line) throw new NotFoundError('CapexLine', input.lineId)
  const tenantId = line.project.tenantId
  if (!tenantId) throw new AppError('PROJECT_HAS_NO_COMPANY', 'This capex project is not bound to a company — assets belong to one company', 422)
  if (capexTreatmentOf(line) !== 'capital') {
    throw new AppError('NOT_CAPITAL', 'A rent advance is a prepayment and a broker / consultant fee is an expense — neither becomes an asset', 422)
  }
  const delivered = ['delivered', 'installed', 'commissioned', 'done'].includes(line.status) || !!line.actualDeliveryDate
  if (!delivered) throw new AppError('NOT_DELIVERED', 'Capitalise the item once it is delivered — mark it delivered first', 422)
  if (!ASSET_CATEGORIES[input.category]) throw new AppError('ASSET_CATEGORY', `Unknown asset category ${input.category}`, 422)

  // What was advanced for this line: live 'capex.payment' entries on 1340.
  const live = await liveRevisionsFor([tenantId], CAPEX_SOURCE, line.payments.map((p) => p.id))
  const advancedCents = Array.from(live.values())
    .filter((e) => e.debitCode === ADVANCES_TO_SUPPLIERS)
    .reduce((t, e) => t + e.amountCents, 0)
  const committed = line.negotiatedCents ?? line.unitCostCents * line.quantity
  const costCents = input.costCents ?? Math.max(committed, advancedCents)
  if (costCents <= 0) throw new AppError('NO_COST', 'This line has no cost to capitalise', 422)
  if (costCents < advancedCents) {
    throw new AppError('COST_BELOW_ADVANCES', `PKR ${(advancedCents / 100).toFixed(0)} has been advanced for this item — the asset cannot cost less`, 422)
  }
  const owed = costCents - advancedCents

  return prisma.$transaction(async (tx) => {
    // One capitalisation per line, even under a double click.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${capexLinkNote(line.id)}))`
    if (await findCapitalisedAsset(tenantId, line.id, tx)) {
      throw new AppError('ALREADY_CAPITALISED', 'This item is already on the fixed-asset register', 409)
    }
    const name = (input.name ?? line.item).trim().slice(0, 120)
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId,
        name,
        category: input.category,
        acquisitionCreditCode: advancedCents > 0 ? ADVANCES_TO_SUPPLIERS : ACCT.AP_SUPPLIERS,
        acquiredAt: input.acquiredAt ?? line.actualDeliveryDate ?? line.installedDate ?? new Date(),
        costCents,
        salvageCents: input.salvageCents ?? 0,
        usefulLifeMonths: input.usefulLifeMonths,
        conceptId: line.project.conceptId,
        locationId: input.locationId ?? line.project.locationId ?? null,
        supplier: line.vendor,
        notes: `${capexLinkNote(line.id)} — capitalised from capex project "${line.project.name}"`,
        createdById: input.postedBy,
      },
    })
    const credits = [
      ...(advancedCents > 0 ? [{ accountCode: ADVANCES_TO_SUPPLIERS, amountCents: advancedCents, memo: `Advances applied — ${name}` }] : []),
      ...(owed > 0 ? [{ accountCode: ACCT.AP_SUPPLIERS, amountCents: owed, memo: `Still owed to ${line.vendor ?? 'the supplier'} — ${name}` }] : []),
    ]
    const posted = await postAcquisition(asset.id, input.postedBy, {
      tx,
      credits,
      description: `Capitalised ${name} from capex project "${line.project.name}"`,
    })
    return { asset, entryId: posted.entryId, advancedCents, owedCents: owed }
  })
}

/** Ledger view of capex lines for the tracker and the Investment page. */
export async function capexLedgerState(tenantIds: string[], lines: Array<{ id: string; payments: Array<{ id: string }> }>) {
  const paymentIds = lines.flatMap((l) => l.payments.map((p) => p.id))
  const live = await liveRevisionsFor(tenantIds, CAPEX_SOURCE, paymentIds)
  const assets = lines.length === 0 ? [] : await prisma.fixedAsset.findMany({
    where: { tenantId: { in: tenantIds }, OR: lines.map((l) => ({ notes: { startsWith: capexLinkNote(l.id) } })) },
    select: { id: true, costCents: true, notes: true, status: true },
  })
  const assetOf = new Map<string, { id: string; costCents: number; status: string }>()
  for (const a of assets) {
    const lineId = a.notes?.slice('capex-line:'.length).split(' ')[0]
    if (lineId) assetOf.set(lineId, { id: a.id, costCents: a.costCents, status: a.status })
  }
  const byLine = new Map<string, { advancedCents: number; prepaidCents: number; expensedCents: number; settledPayableCents: number; asset: { id: string; costCents: number; status: string } | null; payments: Record<string, { status: 'posted' | 'unposted'; accountCode: string | null }> }>()
  for (const l of lines) {
    const row = { advancedCents: 0, prepaidCents: 0, expensedCents: 0, settledPayableCents: 0, asset: assetOf.get(l.id) ?? null, payments: {} as Record<string, { status: 'posted' | 'unposted'; accountCode: string | null }> }
    for (const p of l.payments) {
      const e = live.get(p.id)
      row.payments[p.id] = { status: e ? 'posted' : 'unposted', accountCode: e?.debitCode ?? null }
      if (!e) continue
      if (e.debitCode === ADVANCES_TO_SUPPLIERS) row.advancedCents += e.amountCents
      else if (e.debitCode === PREPAID_EXPENSES) row.prepaidCents += e.amountCents
      else if (e.debitCode === PROFESSIONAL_FEES) row.expensedCents += e.amountCents
      else if (e.debitCode === ACCT.AP_SUPPLIERS) row.settledPayableCents += e.amountCents
    }
    byLine.set(l.id, row)
  }
  return byLine
}
