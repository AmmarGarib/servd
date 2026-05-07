# backend/src

The TypeScript source tree, registered into Fastify by `index.ts`.

## Top-level files

- `index.ts` — Fastify bootstrap, CORS/helmet/rate-limit setup, route registration, worker startup.
- `config.ts` — Centralised env-var parsing.

## Subdirectories

- [`modules/`](./modules/README.md) — HTTP surface, organised by domain (orders, menu, accounting, procurement, etc.).
- [`lib/`](./lib/README.md) — Cross-cutting infrastructure (Prisma client, errors, ws, storage, permissions).
- [`adapters/`](./adapters/README.md) — Third-party integration adapters (Foodpanda, Careem, FBR, WhatsApp, payment gateways).
- [`workers/`](./workers/README.md) — Background workers (BullMQ-driven and timer-driven).
