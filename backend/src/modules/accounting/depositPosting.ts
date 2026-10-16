// Bank deposit drop → journal posting.
//
// A deposit moves cash into the bank, so it posts Dr <the bank's ledger code>
// (BankAccount.accountCode, lib/bankAccounts.ts; 1020 when none was picked)
// and credits the account the cash actually sat in:
//
//   • the shift's mid-shift drops → 1010 Cash on hand (the shift close moved
//     them there: Dr 1010 / Cr 1015)
//   • the shift's counted close less the float kept in the drawer → 1015
//     Drawer (the close leaves the takings there)
//   • anything beyond that, or a deposit not tied to a shift → 1010
//
// A drop may be split across several shifts (owner, 2026-10-16, bank bags:
// "One deposit can be split across several shifts") — deposit_drop_shifts
// rows, read only through `dropAllocations` below (a legacy drop with
// `shiftId` and no rows is one allocation of its whole amount). Each shift's
// share takes from that shift's cash in the order the drops were made: what
// EARLIER drops of the same shift already took (their drops first, then the
// drawer takings) is not taken again, so two bags for one shift never credit
// 1010 twice (audit fix, 2026-10-16). The split is a pure function of the
// earlier drops, so a re-post books the same lines.
//
// With this entry on the bank's code, a bank-statement import auto-matches
// the deposit line instead of leaving it for a manual adjustment. One entry
// per drop, keyed on the drop id. The bank's deposit slip # (when given) and
// the tamper-bag serial are in the description and every line's memo, so the
// statement line can be found by either (owner, 2026-10-14).

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { drawerExpectation } from '../../lib/drawer.js'
import { bankLedgerCode } from '../../lib/bankAccounts.js'
import { ACCT, postJournalEntry, withLateNote, type JournalLineInput, type RepostOptions } from './journal.js'

/**
 * What a deposit tied to `shiftId` should contain: the shift's drops plus
 * its counted close less the opening float retained in the drawer (0 while
 * the drawer is still open). Basing it on the COUNT rather than on expected
 * cash keeps a variance already flagged at close from being flagged again.
 */
export async function expectedShiftDeposit(shiftId: string): Promise<{ dropsCents: number; fromDrawerCents: number; expectedCents: number }> {
  const [drawer, shift] = await Promise.all([
    drawerExpectation(shiftId),
    prisma.shift.findUnique({ where: { id: shiftId }, select: { openingFloatCents: true, closingFloatCents: true } }),
  ])
  const fromDrawerCents = shift?.closingFloatCents != null
    ? Math.max(0, shift.closingFloatCents - shift.openingFloatCents)
    : 0
  return { dropsCents: drawer.dropsCents, fromDrawerCents, expectedCents: drawer.dropsCents + fromDrawerCents }
}

type Db = Prisma.TransactionClient | PrismaClient

/** One shift's share of a deposit drop. */
export interface DropAllocation { dropId: string; shiftId: string; amountCents: number; droppedAt: Date }

const byDropOrder = (a: DropAllocation, b: DropAllocation) =>
  a.droppedAt.getTime() - b.droppedAt.getTime() || (a.dropId < b.dropId ? -1 : a.dropId > b.dropId ? 1 : 0)

/**
 * THE reader of how deposit drops split across shifts: the deposit_drop_shifts
 * rows, plus a legacy drop that names `shiftId` and has no rows (one
 * allocation of its whole amount). Filter by the drops' company and either
 * shifts or one drop. Sorted in drop order (droppedAt, then id).
 */
export async function dropAllocations(db: Db, where: { tenantId: string; shiftIds?: string[]; dropId?: string }): Promise<DropAllocation[]> {
  if (where.shiftIds && where.shiftIds.length === 0) return []
  const [rows, legacy] = await Promise.all([
    db.depositDropShift.findMany({
      where: {
        tenantId: where.tenantId,
        ...(where.shiftIds ? { shiftId: { in: where.shiftIds } } : {}),
        ...(where.dropId ? { depositDropId: where.dropId } : {}),
      },
      select: { depositDropId: true, shiftId: true, amountCents: true, depositDrop: { select: { droppedAt: true } } },
    }),
    db.depositDrop.findMany({
      where: {
        tenantId: where.tenantId,
        shiftId: where.shiftIds ? { in: where.shiftIds } : { not: null },
        ...(where.dropId ? { id: where.dropId } : {}),
        amountCents: { gt: 0 },
        allocations: { none: {} },
      },
      select: { id: true, shiftId: true, amountCents: true, droppedAt: true },
    }),
  ])
  return [
    ...rows.map((r) => ({ dropId: r.depositDropId, shiftId: r.shiftId, amountCents: r.amountCents, droppedAt: r.depositDrop.droppedAt })),
    ...legacy.map((d) => ({ dropId: d.id, shiftId: d.shiftId!, amountCents: d.amountCents, droppedAt: d.droppedAt })),
  ].sort(byDropOrder)
}

/** Σ banked per shift, from `dropAllocations`. */
export async function bankedByShift(db: Db, tenantId: string, shiftIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const a of await dropAllocations(db, { tenantId, shiftIds })) out.set(a.shiftId, (out.get(a.shiftId) ?? 0) + a.amountCents)
  return out
}

/**
 * What is still to be banked from `shiftId`: its expected deposit less every
 * allocation already recorded for it (floor 0) — the figure a NEW drop is
 * compared with (audit fix: a second bag is no longer compared with the whole
 * shift).
 */
export async function remainingShiftDeposit(db: Db, tenantId: string, shiftId: string): Promise<{ expectedCents: number; bankedCents: number; remainingCents: number }> {
  const expected = await expectedShiftDeposit(shiftId)
  const bankedCents = (await bankedByShift(db, tenantId, [shiftId])).get(shiftId) ?? 0
  return { expectedCents: expected.expectedCents, bankedCents, remainingCents: Math.max(0, expected.expectedCents - bankedCents) }
}

/**
 * How one shift's share of a drop splits between the safe (1010 — the shift's
 * mid-shift drops) and the drawer (1015 — its counted takings), net of what
 * EARLIER drops of the same shift took: earlier shares consume the drops
 * first, then the takings; this share does the same with what is left. The
 * rest of the share (beyond the shift's cash) comes from the safe.
 */
export async function shiftShareSplit(db: Db, tenantId: string, alloc: DropAllocation): Promise<{ fromDropsCents: number; fromDrawerCents: number; restCents: number }> {
  const expected = await expectedShiftDeposit(alloc.shiftId)
  const all = await dropAllocations(db, { tenantId, shiftIds: [alloc.shiftId] })
  const before = all.filter((a) => a.dropId !== alloc.dropId && byDropOrder(a, alloc) < 0).reduce((t, a) => t + a.amountCents, 0)
  const tookDrops = Math.min(before, expected.dropsCents)
  const tookDrawer = Math.min(before - tookDrops, expected.fromDrawerCents)
  const fromDropsCents = Math.min(alloc.amountCents, Math.max(0, expected.dropsCents - tookDrops))
  const fromDrawerCents = Math.min(alloc.amountCents - fromDropsCents, Math.max(0, expected.fromDrawerCents - tookDrawer))
  return { fromDropsCents, fromDrawerCents, restCents: alloc.amountCents - fromDropsCents - fromDrawerCents }
}

/**
 * `opts` is for re-posting a refused drop (reconciliation/backfillOrders.ts):
 * dated in the open period with a note naming the drop's date when its own
 * month is closed. Same key either way — a drop posts once.
 */
export async function postDepositDrop(dropId: string, opts: RepostOptions = {}): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const drop = await prisma.depositDrop.findUnique({ where: { id: dropId } })
  if (!drop) return { posted: false, entryId: null, reason: 'deposit_not_found' }
  if (!drop.tenantId) return { posted: false, entryId: null, reason: 'deposit_has_no_company' }
  if (drop.amountCents <= 0) return { posted: false, entryId: null, reason: 'no_amount' }

  const bankCode = await bankLedgerCode(drop.tenantId, drop.bankAccountId)

  // Each shift's share: the safe takes its drops part and anything beyond
  // the shift's cash; the drawer its takings part. Unallocated → the safe.
  let fromDrawer = 0
  for (const alloc of await dropAllocations(prisma, { tenantId: drop.tenantId, dropId: drop.id })) {
    fromDrawer += (await shiftShareSplit(prisma, drop.tenantId, alloc)).fromDrawerCents
  }
  fromDrawer = Math.min(fromDrawer, drop.amountCents)
  const fromSafe = drop.amountCents - fromDrawer

  const marks = [drop.slipNumber ? `slip ${drop.slipNumber}` : null, drop.bagSerial ? `bag ${drop.bagSerial}` : null].filter(Boolean)
  const tag = marks.length > 0 ? ` (${marks.join(', ')})` : ''
  const lines: JournalLineInput[] = [
    { accountCode: bankCode, type: 'debit', amountCents: drop.amountCents, memo: `Cash deposited${tag}` },
  ]
  if (fromSafe > 0)   lines.push({ accountCode: ACCT.CASH_ON_HAND, type: 'credit', amountCents: fromSafe,   memo: `Deposit from safe${tag}` })
  if (fromDrawer > 0) lines.push({ accountCode: ACCT.CASH_DRAWER,  type: 'credit', amountCents: fromDrawer, memo: `Deposit of shift takings${tag}` })

  const late = withLateNote(`Bank deposit drop${tag}`, lines, opts.memoNote)
  const result = await postJournalEntry({
    tenantId: drop.tenantId,
    sourceType: 'deposit.drop',
    sourceId: drop.id,
    description: late.description,
    entryDate: opts.entryDate ?? drop.droppedAt,
    postedBy: opts.postedBy ?? drop.droppedById,
    lines: late.lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}
