// "Resolved by journal entry" — a cash voucher still HELD on 1357 that the
// conversion (voucherHoldConversion.ts) cannot book (equipment-looking,
// stock / CapEx lines, a hold that does not equal the voucher, a refused
// posting …) is cleared by finance with a MANUAL journal (POST
// /accounting/journal: Dr the right account / Cr 1357). Owner (Ammar, CEO,
// 2026-10-16): "add the resolved button, and make it block the close".
//
// GET  /trustops/cash-vouchers/:id/resolve-candidates — the voucher company's
//      live manual entries dated on/after the hold that credit 1357 and resolve
//      no voucher yet (newest first, ≤ 30), each with its net 1357 credit and
//      whether it clears the hold exactly.
// POST /trustops/cash-vouchers/:id/resolve-by-journal { journalEntryId, note ≥ 10 }
//   • who: a finance approver (role finance holding accounting, or the CEO;
//     403 NOT_FINANCE) — never the voucher's raiser / holder (409 SELF_APPROVE);
//   • the voucher: another company's → 404; still held (disbursed,
//     expenseOnVerify, not bookedAtPay, not posted, a hold pay on record) —
//     else 409 VOUCHER_NOT_HELD; its live hold must be on the books (409
//     HOLD_NOT_BOOKED);
//   • the entry: one of the VOUCHER's company's (another company's → 404), a
//     manual entry ('manual:<uuid>' — 422 NOT_A_MANUAL_ENTRY), live (never
//     reversed — 422 ENTRY_REVERSED), dated on or after the hold's Karachi day
//     (422 ENTRY_BEFORE_HOLD), whose net CREDIT to 1357 equals the live hold
//     exactly (422 ENTRY_AMOUNT_MISMATCH) and per brand (422
//     ENTRY_BRAND_MISMATCH — 1357 nets per brand, like the conversion);
//   • one entry resolves one voucher (CashVoucher.postedJournalEntryId is
//     @unique — 409 JOURNAL_ALREADY_USED), and the claim is conditional on the
//     voucher still being held under its row lock (a second call, or the boot
//     conversion racing it → 409 VOUCHER_NOT_HELD). The resolve takes the same
//     advisory lock as a reversal of the entry.
// It POSTS NOTHING. The voucher becomes bookedAtPay = true with
// postedJournalEntryId = that entry — exactly a converted hold's state — so
// finance's documents check afterwards books nothing (cashRequestSettle.ts
// markDocsChecked) and the 1357 tie-out stops counting it as held. The open
// 'cash_voucher_hold_unconverted' flag is resolved; audited on the voucher's
// history ('cash_voucher.resolve_by_journal') and the accounting trail
// ('cash_voucher.hold_resolved_by_journal' on the entry). A resolving entry
// cannot be reversed or edited afterwards (manualJournal.ts: 409
// ENTRY_RESOLVES_VOUCHER) — a later correction is another manual entry. The
// month close BLOCKS while a voucher is still held (closeChecks.ts
// 'vouchers_held_on_1357', CEO-overridable).

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { ACCT } from '../accounting/journal.js'
import { MANUAL_PREFIX, MANUAL_REVERSAL_PREFIX } from '../accounting/manualJournal.js'
import { fmtPktDate } from '../accounting/dates.js'
import { liveHoldOf, resolveUnconvertedFlags } from './voucherHoldConversion.js'

type Db = Prisma.TransactionClient | typeof prisma

const PKT_OFFSET_MS = 5 * 3600_000
const DAY_MS = 86_400_000
/** The start (UTC instant) of the Karachi day `d` falls in. */
const pktDayStart = (d: Date) => new Date(Math.floor((d.getTime() + PKT_OFFSET_MS) / DAY_MS) * DAY_MS - PKT_OFFSET_MS)
const pkr = (c: number) => `PKR ${(c / 100).toFixed(2)}`

const VOUCHER_SELECT = {
  id: true, tenantId: true, number: true, status: true, expenseOnVerify: true, bookedAtPay: true, postedAt: true,
  pettyCashMovementId: true, payJournalEntryId: true,
} as const
type HeldVoucher = Prisma.CashVoucherGetPayload<{ select: typeof VOUCHER_SELECT }>

/** Still held on 1357: paid under the 2026-10-15 hold flow, not converted, not resolved, documents not checked. */
export const isStillHeld = (v: Pick<HeldVoucher, 'status' | 'expenseOnVerify' | 'bookedAtPay' | 'postedAt' | 'pettyCashMovementId' | 'payJournalEntryId'>) =>
  v.status === 'disbursed' && v.expenseOnVerify && !v.bookedAtPay && !v.postedAt && (!!v.pettyCashMovementId || !!v.payJournalEntryId)

type Line = { type: string; amountCents: number | bigint; conceptId: string | null; account: { code: string } }

/** Net per brand on 1357 of an entry's lines, signed by `side` (credit: credits − debits). */
function net1357ByBrand(lines: Line[], side: 'debit' | 'credit') {
  const byBrand = new Map<string | null, number>()
  for (const l of lines) {
    if (l.account.code !== ACCT.VOUCHERS_AWAITING_DOCS) continue
    const k = l.conceptId ?? null
    const c = toCents(l.amountCents)
    byBrand.set(k, (byBrand.get(k) ?? 0) + (l.type === side ? c : -c))
  }
  for (const [k, c] of byBrand) if (c === 0) byBrand.delete(k)
  return { byBrand, cents: [...byBrand.values()].reduce((t, c) => t + c, 0) }
}

const sameBrands = (a: Map<string | null, number>, b: Map<string | null, number>) =>
  a.size === b.size && [...a].every(([k, c]) => b.get(k) === c)

const entryLines = (db: Db, id: string) =>
  db.journalEntry.findUnique({ where: { id }, include: { lines: { include: { account: { select: { code: true } } } } } })

/** The live hold of a held voucher (net and per brand), or 409 (not held / hold not on the books). */
async function liveHold(db: Db, v: HeldVoucher) {
  if (!isStillHeld(v)) {
    throw new AppError('VOUCHER_NOT_HELD', `Cash voucher ${v.number} is not held on 1357 — its expense is already booked (or it was not paid under the hold flow)`, 409)
  }
  const hold = await liveHoldOf(db, v)
  if ('code' in hold) throw new AppError(hold.code, `Cash voucher ${v.number} cannot be resolved: ${hold.reason}`, 409)
  const je = await entryLines(db, hold.entryId)
  const net = net1357ByBrand(je?.lines ?? [], 'debit')
  if (net.cents <= 0) throw new AppError('HOLD_NOT_BOOKED', `Cash voucher ${v.number} has nothing held on 1357`, 409)
  return { cents: net.cents, byBrand: net.byBrand, entryDate: hold.entryDate }
}

type Hold = Awaited<ReturnType<typeof liveHold>>

/** Check `entryId` resolves held voucher `v` (see the header); throws the route's error. */
async function assertResolvingEntry(db: Db, v: HeldVoucher, entryId: string, hold: Hold) {
  // The VOUCHER's company only — another company's entry is the same 404 as a missing one.
  const je = await db.journalEntry.findFirst({
    where: { id: entryId, tenantId: v.tenantId },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  if (!je) throw new NotFoundError('JournalEntry', entryId)
  if (!je.reference?.startsWith(MANUAL_PREFIX)) {
    throw new AppError('NOT_A_MANUAL_ENTRY', 'Only a manual journal entry (Finance → Journal) can resolve a held voucher', 422)
  }
  const reversal = await db.journalEntry.findFirst({
    where: { tenantId: v.tenantId, reference: `${MANUAL_REVERSAL_PREFIX}${je.reference.slice(MANUAL_PREFIX.length)}` },
    select: { id: true },
  })
  if (reversal) throw new AppError('ENTRY_REVERSED', 'That journal entry has been reversed — pick the live entry', 422)
  if (je.entryDate.getTime() < pktDayStart(hold.entryDate).getTime()) {
    throw new AppError('ENTRY_BEFORE_HOLD', `That entry is dated ${fmtPktDate(je.entryDate)}, before ${v.number} was paid (${fmtPktDate(hold.entryDate)})`, 422)
  }
  const cr = net1357ByBrand(je.lines, 'credit')
  if (cr.cents !== hold.cents) {
    throw new AppError(
      'ENTRY_AMOUNT_MISMATCH',
      `That entry credits 1357 by ${pkr(cr.cents)}; ${v.number} holds ${pkr(hold.cents)} on 1357 — the entry must clear exactly that`,
      422,
    )
  }
  if (!sameBrands(cr.byBrand, hold.byBrand)) {
    throw new AppError('ENTRY_BRAND_MISMATCH', `That entry credits 1357 under a different brand than ${v.number}'s hold — 1357 must clear under the same brand`, 422)
  }
  const used = await db.cashVoucher.findFirst({ where: { postedJournalEntryId: je.id }, select: { number: true } })
  if (used) throw new AppError('JOURNAL_ALREADY_USED', `That journal entry already resolves (or books) cash voucher ${used.number}`, 409)
  return { reference: je.reference, entryDate: je.entryDate }
}

export interface ResolveResult { entryId: string; amountCents: number; entryDate: Date }

/** Mark held voucher `voucherId` resolved by manual entry `entryId` (see the header). Posts nothing. */
export async function resolveHeldByJournal(input: { voucherId: string; entryId: string }): Promise<ResolveResult> {
  const pre = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: input.voucherId }, select: VOUCHER_SELECT })
  // Clear errors first; every check is repeated under the locks.
  const preHold = await liveHold(prisma, pre)
  const { reference } = await assertResolvingEntry(prisma, pre, input.entryId, preHold)
  try {
    return await prisma.$transaction(async (tx) => {
      // The lock a reversal of this entry takes (manualJournal.ts) — it cannot be reversed underneath the claim.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`journal.reverse:${pre.tenantId}:${reference}`}))`
      await tx.$queryRaw`SELECT id FROM cash_vouchers WHERE id = ${pre.id} FOR UPDATE`
      const v = await tx.cashVoucher.findUniqueOrThrow({ where: { id: pre.id }, select: VOUCHER_SELECT })
      const hold = await liveHold(tx, v)
      const { entryDate } = await assertResolvingEntry(tx, v, input.entryId, hold)
      // The claim: only a voucher still held, once.
      const claimed = await tx.cashVoucher.updateMany({
        where: { id: v.id, tenantId: v.tenantId, status: 'disbursed', expenseOnVerify: true, bookedAtPay: false, postedAt: null },
        data: { bookedAtPay: true, postedJournalEntryId: input.entryId },
      })
      if (claimed.count === 0) throw new AppError('VOUCHER_NOT_HELD', `Cash voucher ${v.number} is no longer held on 1357`, 409)
      return { entryId: input.entryId, amountCents: hold.cents, entryDate }
    }, { timeout: 20_000, maxWait: 10_000 })
  } catch (err) {
    // postedJournalEntryId is @unique: a parallel resolve of another voucher with the same entry.
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError('JOURNAL_ALREADY_USED', 'That journal entry already resolves another cash voucher', 409)
    }
    throw err
  }
}

/** After the commit: the voucher's open 'cash_voucher_hold_unconverted' flag is resolved. */
export async function closeHoldFlag(voucherId: string, entryId: string, note: string, actorId: string): Promise<void> {
  await resolveUnconvertedFlags(voucherId, `Resolved by journal entry ${entryId}: ${note}`, actorId)
}

/**
 * The company's manual entries that could resolve held voucher `voucherId`:
 * live, dated on or after its hold, crediting 1357, used by no voucher.
 * Newest first; `matches` = it clears the hold exactly (amount and brand).
 */
export async function resolveCandidates(voucherId: string): Promise<{
  heldCents: number
  holdDate: Date
  items: Array<{ id: string; entryDate: Date; description: string; creditCents: number; matches: boolean }>
}> {
  const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId }, select: VOUCHER_SELECT })
  const hold = await liveHold(prisma, v)
  const entries = await prisma.journalEntry.findMany({
    where: {
      tenantId: v.tenantId,
      reference: { startsWith: MANUAL_PREFIX },
      entryDate: { gte: pktDayStart(hold.entryDate) },
      lines: { some: { type: 'credit', account: { code: ACCT.VOUCHERS_AWAITING_DOCS, tenantId: v.tenantId } } },
    },
    include: { lines: { include: { account: { select: { code: true } } } } },
    orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
    take: 100,
  })
  const base = { heldCents: hold.cents, holdDate: hold.entryDate }
  if (entries.length === 0) return { ...base, items: [] }
  const reversed = new Set((await prisma.journalEntry.findMany({
    where: { tenantId: v.tenantId, reference: { in: entries.map((e) => `${MANUAL_REVERSAL_PREFIX}${e.reference!.slice(MANUAL_PREFIX.length)}`) } },
    select: { reference: true },
  })).map((r) => r.reference!.slice(MANUAL_REVERSAL_PREFIX.length)))
  const used = new Set((await prisma.cashVoucher.findMany({
    where: { postedJournalEntryId: { in: entries.map((e) => e.id) } },
    select: { postedJournalEntryId: true },
  })).map((r) => r.postedJournalEntryId))
  const items = entries
    .filter((e) => !reversed.has(e.reference!.slice(MANUAL_PREFIX.length)) && !used.has(e.id))
    .map((e) => {
      const cr = net1357ByBrand(e.lines, 'credit')
      return { id: e.id, entryDate: e.entryDate, description: e.description, creditCents: cr.cents, matches: cr.cents === hold.cents && sameBrands(cr.byBrand, hold.byBrand) }
    })
    .filter((e) => e.creditCents > 0)
    .slice(0, 30)
  return { ...base, items }
}
