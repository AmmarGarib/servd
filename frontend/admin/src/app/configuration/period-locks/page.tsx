import { redirect } from 'next/navigation'

// Period locks have ONE write path: /accounting/period-close (PKT end-of-day
// locks that only move forward, the lock history, and the admin-only reopen
// with a reason, an audit entry and an exception flag — owner decision 21).
// This page wrote its own locks through /setup/period-locks at 00:00 UTC —
// five hours short of the day it claimed to close — with no audit on create
// and a delete that reopened the books off the accounting trail. Kept as a
// redirect for old links.
export default function PeriodLocksRedirect() {
  redirect('/accounting/period-close')
}
