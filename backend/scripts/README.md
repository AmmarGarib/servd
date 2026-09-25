# backend/scripts

One-off utility scripts run via `tsx`.

## Files

- `smoke-test.ts` — End-to-end order pipeline smoke test. Run with `npm run smoke`. Sets up a "Smoke Test Cafe" concept, places orders through `ingestOrder()` (the same path POS / storefront / aggregators use), and asserts station routing, course pacing, inventory deduction, auto-86, lifecycle transitions, concurrency safety, and webhook idempotency. 27 checks total. Cleans up its own data.
- `seed-test-data.ts` — Older seeding helper; superseded by `prisma/seed.ts` for most cases.
- `backfill-shift-close-postings.ts` — Lists closed POS shifts with no `shift.close` journal entry (every shift closed through the old `/reconciliation` close, plus till closes whose post failed) and, with `--apply`, posts the ones in open periods. Never forces: shifts in locked months (owner decision), unbalanced entries and company-less shifts are listed for the accountant. Report-only by default; idempotent.
