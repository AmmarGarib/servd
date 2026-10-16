// Control-account tie-out and the legacy cross-company residue (H30).
//
// Three liabilities each have a subledger that must agree with the ledger:
//   2050 Customer Wallet Liability  vs Σ customer_wallets.balanceCents
//   2060 Loyalty Points Liability   vs Σ loyalty_accounts.pointsBalance × point value
//   2080 Gift Card Liability        vs the gift-card books check (giftCards/books.ts —
//                                   THE 2080 tie-out; reused, not recomputed)
//
// Before loyalty (migration 20261010150300) and wallets (20261011160000) went
// per company, a point or a wallet rupee issued by one company could be spent
// at another: the spending company debited ITS 2050/2060 for value it never
// issued, and wallet top-ups never reached the ledger at all. Those split
// migrations moved the subledgers but left the ledger as it was (their headers
// name the one-off clean-up: Dr 6060 / Cr 2050, and the loyalty equivalent).
//
// H30 default: write the pre-launch residue off INSIDE each company, once, CEO
// only, with a reason. Only the difference AS AT THE SPLIT MIGRATION is written
// off (the subledger is rebuilt at that instant from loyalty_transactions /
// wallet_transactions); anything that drifted after it is a real difference
// and stays visible as the 'control_tieout' close warning.
//
//   ledger > subledger (liability overstated): Dr 2050/2060 / Cr 6060 Marketing & Promo
//   ledger < subledger (understated):          Dr 6060      / Cr 2050/2060
//   key 'legacy.cross_company_writeoff:<tenantId>:<code>' — once per company and code

import type { Prisma, PrismaClient } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { ledgerBalancesByCode } from '../../lib/bankAccounts.js'
import { calculatePointsValue } from '../../lib/loyaltySettings.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { ACCT, postJournalEntry, type JournalLineInput } from '../accounting/journal.js'
import { fmtPktDate } from '../accounting/dates.js'
import { giftCardBooksCheck } from '../giftCards/books.js'

export type Db = Prisma.TransactionClient | PrismaClient

export const LEGACY_WRITEOFF_SOURCE = 'legacy.cross_company_writeoff'
export const LEGACY_CODES = [ACCT.WALLET_LIABILITY, ACCT.LOYALTY_LIABILITY] as const
export type LegacyCode = (typeof LEGACY_CODES)[number]
/** Where the write-off goes (the split migrations' headers name 6060). */
export const LEGACY_WRITEOFF_ACCOUNT = ACCT.MARKETING_PROMO

/** The migration that split each subledger per company — the write-off is measured at its instant. */
export const SPLIT_MIGRATIONS: Record<LegacyCode, { migration: string; label: string }> = {
  [ACCT.WALLET_LIABILITY]: { migration: '20261011160000_customer_wallet_per_company', label: 'customer wallets went per company' },
  [ACCT.LOYALTY_LIABILITY]: { migration: '20261010150300_loyalty_per_company', label: 'loyalty points went per company' },
}

export const legacyWriteOffSourceId = (tenantId: string, code: LegacyCode) => `${tenantId}:${code}`
export const legacyWriteOffReference = (tenantId: string, code: LegacyCode) => `${LEGACY_WRITEOFF_SOURCE}:${legacyWriteOffSourceId(tenantId, code)}`

export function isLegacyCode(code: string): code is LegacyCode {
  return (LEGACY_CODES as readonly string[]).includes(code)
}

// ─── Subledgers rebuilt at a date ────────────────────────────────────────────

/** Σ wallet balances of the company as they stood at `asOf` (now − the moves after it). */
async function walletSubledgerAt(db: Db, tenantId: string, asOf?: Date): Promise<number> {
  const [bal, after] = await Promise.all([
    db.customerWallet.aggregate({ where: { tenantId }, _sum: { balanceCents: true } }),
    asOf
      ? db.walletTransaction.aggregate({ where: { tenantId, createdAt: { gt: asOf } }, _sum: { amountCents: true } })
      : Promise.resolve(null),
  ])
  return Number(bal._sum.balanceCents ?? 0) - Number(after?._sum.amountCents ?? 0)
}

/**
 * Wallet money spent on orders whose sale is not in the books at `asOf`
 * (finance sim MI-4): the wallet is debited at checkout, 2050 only when the
 * sale is booked (order.complete, or the till ticket's drawer close), so
 * until then 2050 still holds it. Net per order up to `asOf` (a cancel or a
 * refund that gave the wallet back nets to 0).
 */
async function walletAwaitingSaleAt(db: Db, tenantId: string, asOf: Date): Promise<{ count: number; cents: number }> {
  const grouped = await db.walletTransaction.groupBy({
    by: ['orderId'],
    where: { tenantId, orderId: { not: null }, createdAt: { lte: asOf } },
    _sum: { amountCents: true },
  })
  const spent = new Map<string, number>()
  for (const g of grouped) {
    const net = Number(g._sum.amountCents ?? 0)
    if (g.orderId && net < 0) spent.set(g.orderId, -net)
  }
  if (spent.size === 0) return { count: 0, cents: 0 }
  // Most were booked by their order.complete: one query clears them.
  const completes = await db.journalEntry.findMany({
    where: { tenantId, reference: { in: [...spent.keys()].map((id) => `order.complete:${id}`) }, entryDate: { lte: asOf } },
    select: { reference: true },
  })
  for (const e of completes) spent.delete((e.reference ?? '').slice('order.complete:'.length))
  // The rest: a till ticket booked at its drawer close, or not booked yet.
  const { orderSaleBookedEntry } = await import('../accounting/cogs.js')
  let count = 0, cents = 0
  for (const [orderId, amount] of spent) {
    const booked = await orderSaleBookedEntry(db, tenantId, orderId)
    if (booked && booked.entryDate <= asOf) continue
    count += 1
    cents += amount
  }
  return { count, cents }
}

/** The company's loyalty points at `asOf`, valued at its point value. */
async function loyaltySubledgerAt(db: Db, tenantId: string, asOf?: Date): Promise<{ points: number; cents: number }> {
  const [bal, after] = await Promise.all([
    db.loyaltyAccount.aggregate({ where: { tenantId }, _sum: { pointsBalance: true } }),
    asOf
      ? db.loyaltyTransaction.aggregate({ where: { loyaltyAccount: { tenantId }, createdAt: { gt: asOf } }, _sum: { pointsDelta: true } })
      : Promise.resolve(null),
  ])
  const points = Number(bal._sum.pointsBalance ?? 0) - Number(after?._sum.pointsDelta ?? 0)
  return { points, cents: await calculatePointsValue(points, tenantId) }
}

/** What 2050 / 2060 hold as liabilities (credits − debits) at `asOf`. */
async function ledgerLiabilitiesAt(db: Db, tenantId: string, asOf?: Date): Promise<Map<string, number>> {
  const raw = await ledgerBalancesByCode(tenantId, [...LEGACY_CODES], { ...(asOf && { asOf }), db: db as Prisma.TransactionClient })
  return new Map(LEGACY_CODES.map((c) => [c, 0 - (raw.get(c) ?? 0)]))
}

// ─── The tie-out ─────────────────────────────────────────────────────────────

export interface TieOutRow {
  code: '2050' | '2060' | '2080'
  label: string
  /** The ledger's liability (credits − debits). */
  ledgerCents: number
  /** What the subledger says is owed. */
  subledgerCents: number
  /** ledger − subledger: 0 = they agree. */
  differenceCents: number
  /** The instant the row is measured at. */
  asOf: string
  note?: string
}

export interface ControlTieOut {
  tenantId: string
  asOf: string
  rows: TieOutRow[]
  /** True when every row agrees. */
  clean: boolean
}

/** 2050 / 2060 at `asOf`; 2080 from the gift-card books check (as of now — it explains its own differences). */
export async function controlTieOut(db: Db, tenantId: string, asOf: Date): Promise<ControlTieOut> {
  const [ledger, wallets, walletAwaiting, loyalty, tenant] = await Promise.all([
    ledgerLiabilitiesAt(db, tenantId, asOf),
    walletSubledgerAt(db, tenantId, asOf),
    walletAwaitingSaleAt(db, tenantId, asOf),
    loyaltySubledgerAt(db, tenantId, asOf),
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ])
  const at = asOf.toISOString()
  const rows: TieOutRow[] = []
  const w = ledger.get(ACCT.WALLET_LIABILITY) ?? 0
  const walletOwed = wallets + walletAwaiting.cents
  rows.push({
    code: '2050', label: 'Customer wallets', ledgerCents: w, subledgerCents: walletOwed, differenceCents: w - walletOwed, asOf: at,
    ...(walletAwaiting.count > 0 && { note: `Wallet balances plus ${walletAwaiting.count} order(s) paid from the wallet whose sale is not booked yet` }),
  })
  const l = ledger.get(ACCT.LOYALTY_LIABILITY) ?? 0
  rows.push({
    code: '2060', label: 'Loyalty points', ledgerCents: l, subledgerCents: loyalty.cents, differenceCents: l - loyalty.cents, asOf: at,
    note: `${loyalty.points.toLocaleString('en-PK')} points at the company's point value`,
  })
  const g = await giftCardBooksCheck(tenantId, tenant?.name ?? '')
  rows.push({
    code: '2080', label: 'Gift cards', ledgerCents: g.ledgerCents || 0, subledgerCents: g.expectedCents || 0, differenceCents: g.differenceCents || 0,
    asOf: new Date().toISOString(),
    note: g.unexplainedCents !== g.differenceCents
      ? `As of now (Gift cards → Books check): ${g.issueNotBooked.count} card sale(s) never booked explain part of it; unexplained ${g.unexplainedCents} paisa`
      : 'As of now (Gift cards → Books check)',
  })
  return { tenantId, asOf: at, rows, clean: rows.every((r) => r.differenceCents === 0) }
}

// ─── The split-date difference and its evidence ──────────────────────────────

/** The instant a split migration ran: _prisma_migrations.finished_at, else the timestamp in its name (UTC). */
export async function splitAt(db: Db, code: LegacyCode): Promise<Date> {
  const name = SPLIT_MIGRATIONS[code].migration
  const has = await db.$queryRaw<Array<{ ok: boolean }>>`SELECT to_regclass('_prisma_migrations') IS NOT NULL AS ok`
  if (has[0]?.ok) {
    const rows = await db.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM _prisma_migrations
       WHERE migration_name = ${name} AND finished_at IS NOT NULL AND rolled_back_at IS NULL
       ORDER BY finished_at ASC LIMIT 1`
    if (rows[0]?.finished_at) return new Date(rows[0].finished_at)
  }
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(name)!
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])))
}

export interface LegacyDifference {
  code: LegacyCode
  splitAt: string
  splitLabel: string
  ledgerCents: number
  subledgerCents: number
  /** ledger − subledger at the split: what the write-off clears. */
  differenceCents: number
  /** The write-off already posted, if any. */
  writtenOff: { entryId: string; entryDate: string } | null
}

/** The residue of one code as at its split migration, and whether it was written off. */
export async function legacyDifference(db: Db, tenantId: string, code: LegacyCode): Promise<LegacyDifference> {
  const at = await splitAt(db, code)
  const [ledger, sub, done] = await Promise.all([
    ledgerLiabilitiesAt(db, tenantId, at),
    code === ACCT.WALLET_LIABILITY ? walletSubledgerAt(db, tenantId, at) : loyaltySubledgerAt(db, tenantId, at).then((r) => r.cents),
    db.journalEntry.findFirst({ where: { tenantId, reference: legacyWriteOffReference(tenantId, code) }, select: { id: true, entryDate: true } }),
  ])
  const ledgerCents = ledger.get(code) ?? 0
  return {
    code,
    splitAt: at.toISOString(),
    splitLabel: SPLIT_MIGRATIONS[code].label,
    ledgerCents,
    subledgerCents: sub,
    differenceCents: ledgerCents - sub,
    writtenOff: done ? { entryId: done.id, entryDate: done.entryDate.toISOString() } : null,
  }
}

export interface LegacyEvidence {
  /** Loyalty redemptions spent at a company that did not issue the points (tagged by the 20261010150300 migration). */
  crossCompanyRedemptions: { count: number; points: number; items: Array<{ id: string; createdAt: string; pointsDelta: number; orderId: string | null; description: string | null }> }
  /** Wallet top-ups / bonuses before the wallet split — never posted to 2050. */
  walletCreditsBeforeSplit: { count: number; cents: number }
  /** Wallet spends before the split — each debited the SPENDING company's 2050. */
  walletSpendsBeforeSplit: { count: number; cents: number }
}

/** What explains a company's pre-split residue (shown with the write-off preview). */
export async function legacyEvidence(db: Db, tenantId: string): Promise<LegacyEvidence> {
  const walletSplit = await splitAt(db, ACCT.WALLET_LIABILITY)
  const tagged = {
    description: { contains: '[cross-company redemption' },
    OR: [{ loyaltyAccount: { tenantId } }, { order: { concept: { tenantId } } }],
  } satisfies Prisma.LoyaltyTransactionWhereInput
  const [redemptions, redemptionSum, credits, spends] = await Promise.all([
    db.loyaltyTransaction.findMany({
      where: tagged, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, createdAt: true, pointsDelta: true, orderId: true, description: true },
    }),
    db.loyaltyTransaction.aggregate({ where: tagged, _sum: { pointsDelta: true }, _count: { _all: true } }),
    db.walletTransaction.aggregate({
      where: { tenantId, createdAt: { lte: walletSplit }, type: { in: ['topup', 'bonus'] } },
      _sum: { amountCents: true }, _count: { _all: true },
    }),
    db.walletTransaction.aggregate({
      where: { tenantId, createdAt: { lte: walletSplit }, type: 'spend' },
      _sum: { amountCents: true }, _count: { _all: true },
    }),
  ])
  return {
    crossCompanyRedemptions: {
      count: redemptionSum._count._all,
      points: Number(redemptionSum._sum.pointsDelta ?? 0),
      items: redemptions.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), pointsDelta: r.pointsDelta, orderId: r.orderId, description: r.description })),
    },
    walletCreditsBeforeSplit: { count: credits._count._all, cents: Number(credits._sum.amountCents ?? 0) },
    walletSpendsBeforeSplit: { count: spends._count._all, cents: Math.abs(Number(spends._sum.amountCents ?? 0)) },
  }
}

// ─── The write-off ───────────────────────────────────────────────────────────

export interface LegacyWriteOffPreview extends LegacyDifference {
  tenantId: string
  lines: JournalLineInput[]
  evidence: LegacyEvidence
  /** Today's tie-out of the same code: what stays a warning after the write-off. */
  driftAfterSplitCents: number
  dryRun: boolean
  entryId?: string
}

/**
 * Write off one code's pre-split residue in `tenantId`'s books (dry run: the
 * preview only). Once per company and code (409 ALREADY_WRITTEN_OFF); 422
 * NOTHING_TO_WRITE_OFF when the books agreed at the split. Dated today
 * (a closed today → 422 PERIOD_LOCKED from the journal).
 */
export async function writeOffLegacy(
  tenantId: string, code: LegacyCode, reason: string, userId: string, dryRun: boolean,
): Promise<LegacyWriteOffPreview> {
  if (!isLegacyCode(code)) throw new AppError('CODE_INVALID', 'Only 2050 (wallets) and 2060 (loyalty) carry pre-split residue', 422)
  const diff = await legacyDifference(serviceClient, tenantId, code)
  const amount = Math.abs(diff.differenceCents)
  const what = code === ACCT.WALLET_LIABILITY ? 'wallet' : 'loyalty'
  const memo = `Pre-split cross-company ${what} residue in ${code} as at ${fmtPktDate(new Date(diff.splitAt))} (when ${diff.splitLabel})`
  const lines: JournalLineInput[] = amount === 0 ? [] : diff.differenceCents > 0
    ? [
        { accountCode: code, type: 'debit', amountCents: amount, memo },
        { accountCode: LEGACY_WRITEOFF_ACCOUNT, type: 'credit', amountCents: amount, memo },
      ]
    : [
        { accountCode: LEGACY_WRITEOFF_ACCOUNT, type: 'debit', amountCents: amount, memo },
        { accountCode: code, type: 'credit', amountCents: amount, memo },
      ]
  const [evidence, today] = await Promise.all([
    legacyEvidence(serviceClient, tenantId),
    controlTieOut(serviceClient, tenantId, new Date()),
  ])
  const todayDiff = today.rows.find((r) => r.code === code)?.differenceCents ?? 0
  const preview: LegacyWriteOffPreview = {
    ...diff, tenantId, lines, evidence,
    driftAfterSplitCents: todayDiff - (diff.writtenOff ? 0 : diff.differenceCents),
    dryRun,
  }
  if (dryRun) return preview
  if (diff.writtenOff) {
    throw new AppError('ALREADY_WRITTEN_OFF', `The ${code} residue was already written off on ${fmtPktDate(new Date(diff.writtenOff.entryDate))}`, 409)
  }
  if (amount === 0) {
    throw new AppError('NOTHING_TO_WRITE_OFF', `${code} agreed with its subledger when ${diff.splitLabel} — there is nothing to write off`, 422)
  }
  const res = await serviceClient.$transaction(async (tx) => {
    await assertTemplateAccounts(tx, tenantId, [code, LEGACY_WRITEOFF_ACCOUNT])
    return postJournalEntry({
      tenantId,
      sourceType: LEGACY_WRITEOFF_SOURCE,
      sourceId: legacyWriteOffSourceId(tenantId, code),
      description: `${memo} — written off inside this company (H30): ${reason}`.slice(0, 480),
      entryDate: new Date(),
      postedBy: userId,
      lines,
    }, { tx })
  }, { timeout: 30_000, maxWait: 10_000 })
  if (!res.posted) throw new AppError('ALREADY_WRITTEN_OFF', `The ${code} residue was already written off`, 409)
  return { ...preview, writtenOff: { entryId: res.entryId, entryDate: new Date().toISOString() }, entryId: res.entryId, driftAfterSplitCents: todayDiff - diff.differenceCents }
}
