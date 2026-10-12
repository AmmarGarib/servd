import { redirect } from 'next/navigation'

// "My approvals" is replaced by the ONE approvals inbox (owner decision D3,
// 2026-10-11). Everything this page did is there: the HR requests waiting on
// you (same GET /hr/approvals, same rule per step), opened in the same record
// view (RecordDetail — overtime hours, swaps, letters) with approve / reject
// through POST /hr/records/:section/:id/decide. Your team is on /team. This
// route stays only so old links and bookmarks land on the HR filter.
export default function HrApprovalsRedirect() {
  redirect('/ceo/approvals?type=hr_request')
}
