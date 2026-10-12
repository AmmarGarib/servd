# backend

Fastify HTTP API + WebSocket server. The single source of truth for orders, menu, inventory, accounting, and external integrations.

## Stack

- **Fastify 5** — HTTP framework (built for high-throughput webhooks)
- **Prisma 5** — type-safe ORM, PostgreSQL on Neon
- **BullMQ + Redis** — background workers (fiscal connector outbox, card-machine reconciler, scheduled reports, rider dispatch)
- **Socket.IO** — real-time fan-out to KDS and storefront clients
- **Zod** — runtime validation for every route input

## Layout

- [`src/`](./src/) — TypeScript source. Organised into `modules/` (HTTP surface) and `lib/` (cross-cutting infra).
- [`prisma/`](./prisma/) — Schema + migrations + seed.
- [`scripts/`](./scripts/) — One-off scripts (`smoke-test.ts`, etc).
- [`tests/`](./tests/) — Vitest suite.

## Common commands

```
npm run dev          # tsx watch — hot-reload server on :3001
npm run smoke        # end-to-end order pipeline smoke test
npm run db:generate  # prisma generate (run after schema edits)
npm run db:migrate   # prisma migrate dev (creates a migration)
npm run db:seed      # populate concepts + sample data
npm run test         # vitest run
```

## Environment

Required env vars in `.env`:
- `DATABASE_URL` — Postgres connection string (Neon).
- `REDIS_URL` — Redis connection string (BullMQ + WebSocket adapter).
- `JWT_SECRET` — staff token signing key.

Optional but recommended:
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` — Cloudflare R2 for media uploads.
- `SMTP_USER`, `SMTP_PASS` — outgoing email.
- `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` — SMS.
- `SERVD_SECRET_KEY` — base64 of 32 bytes (`openssl rand -base64 32`); encrypts stored integration secrets (POS connector keys, WhatsApp gateway key). Box env only, never commit it. There are no FBR / SRB variables: the external fiscal POS files, configured per company in admin → Dev → API → POS connector (`src/connectors/`).
- `ENABLE_WORKERS=true` — turn on BullMQ workers in dev (default off).
