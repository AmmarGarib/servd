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
- `raastConnector.ts` — Raast QR (node-cron, no Redis): every 30 s processes bank SMS the webhook's fast path missed, puts stuck `processing` claims back, and expires awaiting Raast intents; every 10 min (companies with SMS matching on) raises `raast_unconfirmed` (a typed reference no SMS confirmed) and `raast_sms_unmatched` (a bank credit no bill claimed); daily 03:15 PKT drops SMS text older than 90 days (unparsed: 30). Every write is a conditional claim, so two processes never double-apply.
- `segmentComputation.ts` — Recomputes behavioural CRM segments nightly.
- `socialPublish.ts` — Polls scheduled Meta/Instagram posts and publishes them.
- `riderDispatch.ts` — Every 30 s: times out the auto-dispatcher's unaccepted offers (3 min), then offers unassigned delivery orders placed in the last 6 h to the nearest available rider of the order's company or a fleet-agreement provider, skipping riders who declined. Both writes are claims (an offer only lands on an order still without a rider and a rider still available; a timeout never withdraws an accepted job). Hourly: prunes `rider_locations` older than 24 h.
