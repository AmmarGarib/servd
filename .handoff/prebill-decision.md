# Owner decision 2026-10-10 — pre-bills vs full & final (FnF) bills

"Making a prebill shouldn't report the sale to POS. Only a fnf (full and final)
bill will report/push the sale. Pre bills that are created must go to a special
section in ERP finance section called 'voided pre bills'."

Interpretation (stated to the owner; adjustable):
- PRE-BILL: explicit "Print pre-bill" action on an OPEN order (till, waiter
  screen, tablet). Prints "PRE-BILL — NOT A TAX INVOICE", no fiscal number/QR.
  NEVER sent to the fiscal POS. Every pre-bill (and every reprint) is logged as
  a record: company, brand, order, table, sequence no. per company, items +
  totals snapshot, printed by, printed at, device.
- The generic receipt for an order that is not fully paid must no longer look
  like a final bill: it is the pre-bill (logged), not a second path.
- FULL & FINAL (FnF) BILL: issued when the order is fully paid/settled. This is
  the ONLY fiscal event: pushed to the external POS exactly once (idempotent on
  the order). Fiscal invoice no. + QR from the POS printed on the FnF bill.
  Online/storefront orders (no pre-bill) push once on paid+completed. Refund
  after FnF -> fiscal credit note. Cancel/void before FnF -> nothing to the POS.
- FINANCE -> "Voided pre bills" (Finance workspace page, company-scoped,
  finance + CEO + management): lists EVERY pre-bill with status
  (converted to FnF #…, superseded by a later pre-bill, ORPHANED = order
  cancelled/voided or still open after its shift closed / N hours) and flags
  in red: orphaned pre-bills, and pre-bills whose FnF total is LOWER than the
  pre-bill total. Filters by date/brand/cashier; CSV export.

## Owner decision 2026-10-10 (2) — voids are manager-only

"This void is not a void that cashier or server can do. It must be manager that voids."

- Every void on an order that has been rung up (line void, whole-order void,
  cancelling an order — and in particular anything after a pre-bill) requires a
  MANAGER: either the actor is a manager role (isOverrideApprover) or a valid
  manager PIN is entered on the cashier's screen (verifyManagerPin, same
  company). Cashier / server / waiter can never void alone — the cashier void
  cap (refund policy cashierVoidLimitCents) no longer lets staff void without a
  manager (treat it as 0 for voids; the manager cap still applies).
- The approving manager is recorded on the void (approverId), shown in
  Finance -> Voided pre bills and the audit log; the void reason stays required.
- Admin refund-policy page: show that voids always need a manager (the
  cashier void limit field is retired/hidden for voids).
- Tests: cashier/waiter void without PIN -> 403 MANAGER_OVERRIDE_REQUIRED;
  with another company's manager PIN -> 403; with own manager PIN -> ok and
  approverId recorded; manager login -> ok.
