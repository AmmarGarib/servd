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
// per drop, keyed on the drop id.

import { prisma } from '../../lib/prisma.js'
import { drawerExpectation } from '../../lib/drawer.js'
import { bankLedgerCode } from '../../lib/bankAccounts.js'
import { ACCT, postJournalEntry, type JournalLineInput } from './journal.js'

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

export async function postDepositDrop(dropId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
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

  const tag = drop.bagSerial ? ` (bag ${drop.bagSerial})` : ''
  const lines: JournalLineInput[] = [
    { accountCode: bankCode, type: 'debit', amountCents: drop.amountCents, memo: `Cash deposited${tag}` },
  ]
  if (fromSafe > 0)   lines.push({ accountCode: ACCT.CASH_ON_HAND, type: 'credit', amountCents: fromSafe,   memo: `Deposit from safe${tag}` })
  if (fromDrawer > 0) lines.push({ accountCode: ACCT.CASH_DRAWER,  type: 'credit', amountCents: fromDrawer, memo: `Deposit of shift takings${tag}` })

  const result = await postJournalEntry({
    tenantId: drop.tenantId,
    sourceType: 'deposit.drop',
    sourceId: drop.id,
    description: `Bank deposit drop${tag}`,
    entryDate: drop.droppedAt,
    postedBy: drop.droppedById,
    lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}
