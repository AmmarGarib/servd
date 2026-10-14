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
// With this entry on the bank's code, a bank-statement import auto-matches
// the deposit line instead of leaving it for a manual adjustment. One entry
// per drop, keyed on the drop id. The bank's deposit slip # (when given) and
// the tamper-bag serial are in the description and every line's memo, so the
// statement line can be found by either (owner, 2026-10-14).

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

  let fromSafe = drop.amountCents
  let fromDrawer = 0
  if (drop.shiftId) {
    const expected = await expectedShiftDeposit(drop.shiftId)
    const drops = Math.min(drop.amountCents, expected.dropsCents)
    fromDrawer = Math.min(drop.amountCents - drops, expected.fromDrawerCents)
    fromSafe = drop.amountCents - fromDrawer
  }

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
