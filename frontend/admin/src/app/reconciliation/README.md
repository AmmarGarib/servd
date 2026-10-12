# reconciliation

Admin route: **/reconciliation**. Next.js App Router page module — `page.tsx` is the entry, any sibling `layout.tsx` wraps it.

## Files

- `page.tsx` — Next.js page component (server or client)
- `BackfillUnposted.tsx` — CEO: preview / post shifts, sales, points and refunds missing from the ledger
- `MissedBillVariances.tsx` — CEO: preview / apply supplier-bill price differences that receipts never picked up (`POST /reconciliation/apply-missed-bill-variances`)
