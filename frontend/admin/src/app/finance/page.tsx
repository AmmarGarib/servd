import { redirect } from 'next/navigation'

// /finance was a second "P&L" built on the sales register (FinancialEntry):
// GST-inclusive revenue, the discount taken off twice, no costs, no POS card
// sales, and a Transactions tab calling an endpoint that never existed. The
// P&L is the ledger's now — /accounting/pl-ledger (Statement + By brand
// tabs); the transaction feed is /accounting/ledger. This route stays as a
// redirect so bookmarks and the "← Finance" back-links on the /finance/*
// pages still land somewhere useful.
export default function FinancePage() {
  redirect('/accounting/pl-ledger')
}
