# reconciliation

Admin route: **/reconciliation** (`?tab=shifts|bank|raast`). Next.js App Router page module — `page.tsx` is the entry, any sibling `layout.tsx` wraps it.

## Files

- `page.tsx` — Next.js page component (server or client): POS shifts (with a Raast column), bank statement imports (lines matched to a Raast payment carry a "Raast #ref" chip; a generic match can be undone by the CEO / co-owners — `POST /reconciliation/bank/lines/:id/unmatch`; the adjustment form warns on a credit of a Raast receiving account, since an adjustment would book a customer's transfer twice), and the Raast tab
- `RaastTab.tsx` — Raast QR payments (`/reconciliation/raast/*`): KPIs (provisional, older than the flag days, matched, needs attention, unmatched bank alerts), the receipts with filters, and the actions — Match (statement-line candidates; S3's *suggested* line is only offered, finance confirms it), Fix reference (CEO / co-owners — M4), Not received (write-off, CEO / co-owners), Unmatch (CEO / co-owners), Re-run matching; and the read-only bank SMS log
- `BackfillUnposted.tsx` — CEO: preview / post shifts, sales, points and refunds missing from the ledger
- `MissedBillVariances.tsx` — CEO: preview / apply supplier-bill price differences that receipts never picked up (`POST /reconciliation/apply-missed-bill-variances`)
