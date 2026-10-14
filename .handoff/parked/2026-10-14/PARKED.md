# Parked by the owner (2026-10-13, ~23:20 UTC): "stop these 2 cleanly, keep whatever you've started in place, remind me after finance is sorted"

The two areas below come OUT of wave B. Finance ships first. Everything already started stays in place:
- the schema (tables/columns/enums/CHECKs from migration 20261014090000) stays — unused until resumed;
- wave-0 libs stay (lib/onAccountCard.ts, tenders ON_ACCOUNT_TENDER, module id emergency_overrides + its gate, approval
  type ids) — unused;
- the original briefs are kept in this folder (parked/) for the resume;
- neither parked stage-1 builder wrote any code: w1-dlv-core was cancelled before it started, w1-bans was stopped while still reading
  (verified: no Edit/Write in its transcript), so there is nothing to move to a branch.

## A. Delivery and customers — PARKED
- Delivery completes only with the customer's code; no staff "Delivered"; reroute the code to the rider; door problems; rider
  app server side (w1-dlv-core — cancelled before it started).
- Strikes and bans per company, ban appeals via the help desk, blocked-customer notices (w1-bans — stopped).
- COD custody: one COD status definition, rider debt 1351 (own + fleet riders), custody worker, reports, rider-debt reversal on
  settle (w2-dlv-cod; the COD-reversal part of w3-till; the 'cod.rider_debt.reversal' reposter; the COD tab of w3-admin-finance;
  COD pay-in grouping).
- Emergency overrides module: send the code to the rider, log returned food as waste, strike on refusal (w3-dlv-return).
- In w2-sale: the 409 USE_EMERGENCY_OVERRIDE refusal and the `returned` cancel hook — DROP (cancelling a picked-up delivery
  order keeps TODAY's behaviour). The normal cancel semantics for stock (unfired lines back to lots, fired lines wasted) STAY.
- Screens: w4-admin-delivery (all), w4-apps (all — incl. the tablet "Box given"; the tablet app is not deployed anyway),
  w4-customer's blocked notice / appeal / rerouted-code parts, mobile app changes (the app is not in the stores).
- Docs: rider-app and emergency-override runbooks.

## B. Corporate clients on account — PARKED
- On-account clients, QR cards, exposure/credit limits, charging at the till, statements, on-account refunds, the till's
  "On account" panel, client pages, card print, Z-report on-account rows (w2-oa-recv's on-account part; w3-till's on-account
  tender + onAccountRoutes; w4-admin-oa's till/clients/statement parts).
- Till-clearing contra 1115 (split of till clearing from real receivables 1110), its cut-over sweep and worker — it exists for
  on-account; PARKED with it (w3-till tillClearing.ts + worker; the 1115 lines in orderPosting/shiftPosting; w1-recon's
  till-clearing contra part; the 'ledger.till_clearing_split' reposter).

## C. KEPT in finance (they sat on the parked cards but are about the books, not the parked features)
- Bad-debt write-off of an ordinary receivable invoice, CEO approves every one (G12) — from w2-oa-recv → keep, re-scoped.
- Sales tax withheld by a client paying a receivable invoice (H13, 1335) — from w2-oa-recv → keep.
- Raast "void, never booked", CEO only (w1-recon) — keep, and the Raast-void exclusions at the till (w3-till) — keep.
- Delivery fee GST on top: the fee + GST rows on storefront checkout, the order tracker, the admin order page and the tablet
  printer; the 4110 delivery-fee unwind on a cancelled ticket (w3-till) — keep.
- "Box given" (packaging rule): the backend route (w3-till) and the till cart / admin order page button (w4-admin-oa) — keep.
- w1-taxsales is finished: its on-account fiscal-buyer code stays as written (harmless with no on-account charges).

## D. Wave Z must
- hide the admin links to parked pages that wave 0 already added: 'Emergency overrides' (module emergency_overrides page
  /emergency-overrides) and 'On-account clients' (/accounting/receivables/clients) in frontend/admin/src/lib/moduleCatalog.ts,
  and the MODULE_GAPS text that promises them; keep the module ids;
- leave the parked schema and libs in place; register no parked routes/workers;
- CLAUDE.md: a short "Parked (owner, 2026-10-13)" note pointing at this file;
- remind the owner after finance deploys: resume A and B (owner: "remind me to do them after finance sorted").
