# accounting

Admin route: **/accounting**. Next.js App Router page module — `page.tsx` is the entry, any sibling `layout.tsx` wraps it.

## Files

- `page.tsx` — Next.js page component (server or client)

## Subdirectories

- [`ap-aging/`](./ap-aging/) — see [`ap-aging/README.md`](./ap-aging/README.md)
- [`audit-log/`](./audit-log/) — see [`audit-log/README.md`](./audit-log/README.md)
- [`balance-sheet/`](./balance-sheet/) — see [`balance-sheet/README.md`](./balance-sheet/README.md)
- [`cash-flow/`](./cash-flow/) — see [`cash-flow/README.md`](./cash-flow/README.md)
- Food cost moved to Reports: [`../reports/food-cost/`](../reports/food-cost/) (`/accounting/food-cost` redirects to `/reports/food-cost` in `next.config.js`)
- [`fixed-assets/`](./fixed-assets/) — the fixed-asset register (see below)
- [`menu-engineering/`](./menu-engineering/) — see [`menu-engineering/README.md`](./menu-engineering/README.md)
- [`period-close/`](./period-close/) — see [`period-close/README.md`](./period-close/README.md)
- [`pl-ledger/`](./pl-ledger/) — see [`pl-ledger/README.md`](./pl-ledger/README.md)
- [`recipes/`](./recipes/) — see [`recipes/README.md`](./recipes/README.md)
- [`sales-tax-return/`](./sales-tax-return/) — see [`sales-tax-return/README.md`](./sales-tax-return/README.md)
- [`trial-balance/`](./trial-balance/) — see [`trial-balance/README.md`](./trial-balance/README.md)
- [`vendors/`](./vendors/) — see [`vendors/README.md`](./vendors/README.md)

## Fixed assets (`/accounting/fixed-assets`)

The register of equipment and fit-out, upgraded in place (wave B). Equipment reaches it **only through CapEx**
(`/finance/capex`, or Buy equipment = Quick buy at `/finance/capex?quickBuy=1`); there is no Add form.
Depreciation is automatic (nightly, completed months), so there is no on/off switch, only "Charge now through
<last completed month>". The hub links to it from Ledger Reports (Fixed Assets).

- `fixed-assets/page.tsx` — **Register**: filters (status, class, brand, outlet, as-of date), per-company totals in the
  all-companies view, the last automatic run per company with failures, "Charge now", CSV.
- `fixed-assets/[id]/page.tsx` — one asset: schedule (posted, due, forecast), tax years (smallwares say "tax treatment to
  confirm"), history, descriptive edit, and the requests (dispose, write down, change estimate, move, void, undo a disposal).
- `fixed-assets/pools/page.tsx` — **Smallwares** pools per outlet, brand and type: units, value, purchases (layers), last count.
  Counts are open to the F&B manager; write-offs and moves are finance requests.
- `fixed-assets/requests/page.tsx` — **Requests**: the queue the CEO's approvals inbox also reads. Finance raises, the CEO
  approves or rejects (buttons come from each request's `canDecide` / `canCancel`).
- `fixed-assets/reports/page.tsx` — **Reports**: depreciation schedule, roll-forward, book value at a date, tie-out to the ledger
  (green = ties, red = a difference), supplier advances on 1340, tax depreciation (the CEO freezes a year). There is no deferred-tax figure.
- `fixed-assets/classes/page.tsx` — **Classes & policy**: lives, tax rates, pooled flag (CEO edits, others read) and the register policy
  (tag prefix, alert days).
- Shared pieces live in `components/fixedAssets/`: `shared.tsx` (API shapes, lookups hook, tab frame, error wording),
  `RequestForms.tsx`, `RequestCard.tsx`, `ScheduleTable.tsx`, and for CapEx `CapexForms.tsx` + `capexTypes.ts`
  (prepare for the register, Quick buy, deposit return, withholding preview, orphan clean-up).

Every class, default life, outlet, brand and permission comes from `GET /accounting/fixed-assets/lookups`
(`capabilities.canWrite / canCount / canApprove`); the pages keep no class list and no role list.
