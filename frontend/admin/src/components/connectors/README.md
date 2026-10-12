# connectors

Components of Dev → API → POS connector (`/connectors/pos`, spec §10). All calls go through `lib/connectorsApi.ts`, coded against `backend/src/modules/connectors/routes.ts` (and the till routes in `posRoutes.ts` for resolve / reverse).

- `PosStatus.tsx` — mode (Off / Live since / TEST), health, backlog counters (click → Submissions), card charges that need a person (Resolve only where `resolveTerminalCharge` accepts it — `canResolveCharge`; Reverse for charges, managers). The documents / charges lists (and counts) show the active company only, even in the all-companies view (the API binds them to it); switch company to see another's.
- `FiscalSetup.tsx` — §17.7 "Fiscal reporting required" switch (CEO, reason required), driver / base URL (locked while live: 409 SWITCH_OFF_FIRST), API key (hint only), webhook secret (shown once on Regenerate), webhook URL, settings, Test / Dry-run, Go live / Switch off (CEO, typed), Release all held (CEO, optionally one brand — no date range, no skip).
- `PosIdsTable.tsx` — the ONE editor of brand FBR / SRB POS ids (`PUT /connectors/fiscal/brand-pos-ids`) plus outlet overrides (`settings.outlets`).
- `TerminalSetup.tsx` — card machine driver, on/off at the till, key, secret, timings, manual-reference fallback, machines per outlet, test.
- `FiscalSubmissions.tsx` — fiscal documents with filters, drawer (payload + attempts), Retry, Record manual filing, Retry all failed. No skip (§17.0).
- `TerminalCharges.tsx` — card charges for reconciliation; Approve / Decline with the test driver.
- `ui.tsx` — badges, cards, banners, modal, PKT time formatting. Admin tokens only, no emoji icons.
- `ui.tsx` `RangeNumberInput` — numeric settings keep the typed text and only pass up a whole number inside the range; out-of-range shows inline and the form disables Save (never clamp on keystroke).
