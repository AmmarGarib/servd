# finance/voided-pre-bills

Admin route: **/finance/voided-pre-bills** — Finance → "Voided pre bills"
(owner amendment 2026-10-10, spec §17.1–§17.5).

A **pre-bill** is the guest check printed for an open order before payment
(till, waiter screen). It is never a tax invoice, never goes to the fiscal
POS, never posts to the ledger and never counts as revenue — only the full &
final (FnF) bill does. Every print, reprints included, is a permanent record;
this page lists them all.

## Files

- `page.tsx` — client page. Reads `GET /pre-bills` (backend
  `modules/prebills/routes.ts`); the CSV button downloads
  `GET /pre-bills?format=csv` with the same filters.

## What it shows

- **Filters:** date range (PKT days, default the last 30), brand, printed
  by, status (open / reprinted / became FnF bill / order cancelled),
  "Flagged only". The brand and printer lists come from the response's
  `facets`. "Flagged only" narrows the table; the summary tiles always cover
  the whole range.
- **Summary tiles:** pre-bills printed (prints, value, orders), orphaned
  orders, final bill lower (total shortfall), lines voided after printing.
  Money is counted ONCE PER ORDER (each order's latest print; each voided
  line once) — a bill reprinted three times and then cancelled is one
  walk-out, not three. The print counts are shown alongside.
- **Table** with red flag chips, computed by the server at read:
  - `ORPHANED` — the order was cancelled/rejected, or is still not final and
    its drawer closed or the pre-bill is over 12 hours old;
  - `FINAL_LOWER` — the FnF bill came out below the pre-bill's total for
    the tender the order was actually settled with (the card line only when
    every payment was card-class; any cash or a mix → the cash headline);
  - `LINE_VOIDS_AFTER` — lines were voided after the print.
- **Row drawer:** the lines the guest was shown, who printed it, the FnF
  bill and difference, the manager who approved the cancel and the reason,
  and each line voided afterwards with its approving manager.

## Rules

- **Read-only.** There is no delete, hide, edit or exclude — not here, not in
  the API. Do not add one.
- Access: roles admin, owner, management, finance (module `voided_prebills`,
  Finance workspace — added to `lib/workspaces.ts` / `lib/moduleAccess.ts`).
- Company scope comes from the server (`resolveTenantScope`); portfolio view
  spans the operator's companies.
- Colours are the admin tokens only (`--erp-danger` for flags, `--surface`,
  `--border`, `--muted`, `--text`); no hard-coded colours.
