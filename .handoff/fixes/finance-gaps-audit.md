# Finance gaps audit (Explore agent, 2026-10-13 ~12:00 UTC) — UNVERIFIED until the verify workflow confirms
(Excludes petty cash + Raast, known; excludes fixed assets/depreciation + food cost variance — workflow wf_67f55209-40b.)
1 COD unpaid stays booked as cash (orderPosting.ts:379-388; orders/routes.ts:325-364 cod-unpaid; pos/routes.ts:307-325)
2 F&F settlements never posted (hr/routes.ts:295-299; hr/service.ts:523-541; hr/ledger.ts)
3 Inter-company contributions never posted; no due-to/due-from (positions/contributions.ts:29-31)
4 All purchases -> 1210 Food; InventoryItem.category exists; non-stock lines -> 1210; COGS always 5010; no-recipe items no COGS (supplierPosting.ts:639-646; procurement/service.ts:31-36,404-409; orderPosting.ts:276-277,450-453)
5 Input tax always 1320 (never 1321-1324); OpEx no input tax / WHT (supplierPosting.ts:656-658; salesTaxReturn.ts:77-80,477,495-498; opex/posting.ts)
6 Sales tax return output = net movement on 2030-2034 (tax payments reduce it) (salesTaxReturn.ts:48-66,396-400,468-474)
7 Gift cards: void posts nothing; expiry no breakage; bank sale -> 1030; no comp tender; sale JE failure swallowed (giftCards/routes.ts:121,161,167,234-257; service.ts:113-115)
8 Silent posting failures: gift sale, deposit drops, manual waste, stocktake (crosschecks/routes.ts:345-357); backfill covers orders/loyalty/refunds/closes only; void-waste flag points to a backfill that can't repost (journal.ts:352)
9 Payments hard-coded 1020/1010: supplier payments (supplierPosting.ts:839-842), payroll (hr/routes.ts:1541-1545), staff loans (hr/ledger.ts:155), receivables receipts (receivables/routes.ts:27), wallet top-ups, fixed asset purchase, reservation deposits
10 Delivery fee in brand food revenue + counted taxable (pricing.ts:202-215; orderPosting.ts:337-346; salesTaxReturn.ts:411-441)
11 Payroll stand-in accounts: EOBI/SESSI -> 2090; salary tax -> 2040 (supplier WHT); no remittance posting (hr/ledger.ts:24)
12 Rent advances (capex) -> 1310 never amortised; security deposits -> 1310 (capexPosting.ts:5-6,32-41)
13 Card MDR never accrued; 1030 cleared only by manual split (reconciliation/service.ts:290-300)
14 No supplier credit notes/returns; AR credit notes not built (receivables/routes.ts:229-231); no bad debt write-off; customer WHT (1330) never posted; no on-account tender at till
15 GRNI off-ledger (procurement/receiving.ts)
16 Period close checks Raast only (accounting/routes.ts:779-835); no year-end close; BS current earnings since day one (reports.ts:216-218)
17 Low: reservation deposits no UI; no-show capture Dr 1020/Cr 4100 no tax (reservations/routes.ts:1717-1723); transfer shrinkage unbooked (stockTransfers/routes.ts:145-157); OpEx keyword mapping (expenseCategories.ts:8-11)
18 Cosmetic: stale comments giftCards/routes.ts:5-6, supplierPosting.ts:639-640; no-op noteItemVoid orderPosting.ts:1054-1060; "Purchase order feature coming soon" inventory/page.tsx:604; invoice_counters drop?
