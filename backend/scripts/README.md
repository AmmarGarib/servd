# backend/scripts

One-off utility scripts run via `tsx`.

## Files

- `smoke-test.ts` — End-to-end order pipeline smoke test. Run with `npm run smoke`. Sets up a "Smoke Test Cafe" concept, places orders through `ingestOrder()` (the same path POS / storefront / aggregators use), and asserts station routing, course pacing, inventory deduction, auto-86, lifecycle transitions, concurrency safety, and webhook idempotency. 27 checks total. Cleans up its own data.
- `seed-test-data.ts` — Older seeding helper; superseded by `prisma/seed.ts` for most cases.
