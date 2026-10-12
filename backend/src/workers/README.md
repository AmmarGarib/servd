# backend/src/workers

Background workers. Most are BullMQ-driven (Redis-backed queues) — a few are simple `setInterval` pollers. All gated by `ENABLE_WORKERS=true` (default off in dev, on in production).

## Workers

- `coursePacing.ts` — Polls for items past their `scheduledFireAt` and auto-fires them.
- `loyaltyTriggers.ts` — Birthday bonuses, tier promotions, expiring-points alerts.
- `loyaltyExpiration.ts` — Expires unused loyalty points after the configured TTL.
- `reservationReminders.ts` — 24h + 2h SMS reminders for upcoming reservations.
- `scheduledReports.ts` — Per-company scheduled report emails (daily sales, shift summary, low stock, AP aging), configured in Configuration → Scheduled reports.
- `fiscalConnector.ts` — Fiscal outbox: BullMQ `fiscal-connector` fast path plus a Redis-independent 30 s sweeper that sends sale / refund documents to each company's fiscal POS (the only FBR/SRB filer).
- `terminalConnector.ts` — Card-machine reconciler: every 10 s, per company with charges in flight, re-checks charge status, records approved charges and reverses void-pending ones.
- `segmentComputation.ts` — Recomputes behavioural CRM segments nightly.
- `socialPublish.ts` — Polls scheduled Meta/Instagram posts and publishes them.
- `riderDispatch.ts` — Every 30 s: times out the auto-dispatcher's unaccepted offers (3 min), then offers unassigned delivery orders placed in the last 6 h to the nearest available rider of the order's company or a fleet-agreement provider, skipping riders who declined. Both writes are claims (an offer only lands on an order still without a rider and a rider still available; a timeout never withdraws an accepted job). Hourly: prunes `rider_locations` older than 24 h.
