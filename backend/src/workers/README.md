# backend/src/workers

Background workers. Most are BullMQ-driven (Redis-backed queues) — a few are simple `setInterval` pollers. All gated by `ENABLE_WORKERS=true` (default off in dev, on in production).

## Workers

- `orderIngestion.ts` — Processes `order:ingest` jobs from webhook queues.
- `coursePacing.ts` — Polls for items past their `scheduledFireAt` and auto-fires them.
- `loyaltyTriggers.ts` — Birthday bonuses, tier promotions, expiring-points alerts.
- `loyaltyExpiration.ts` — Expires unused loyalty points after the configured TTL.
- `reservationReminders.ts` — 24h + 2h SMS reminders for upcoming reservations.
- `scheduledReports.ts` — Per-company scheduled report emails (daily sales, shift summary, low stock, AP aging), configured in Configuration → Scheduled reports.
- `fbrSubmission.ts` — Batches completed orders + submits to FBR every 5 minutes.
- `segmentComputation.ts` — Recomputes behavioural CRM segments nightly.
- `socialPublish.ts` — Polls scheduled Meta/Instagram posts and publishes them.
