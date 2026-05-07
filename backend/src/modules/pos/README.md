# pos

Backend module: **pos**. HTTP routes + business logic for the Pos domain. Registered into Fastify by `src/index.ts` under the `/pos` URL prefix.

## Files

- `receipt.ts` — TypeScript module
- `routes.ts` — Fastify route registrations for this module
- `service.ts` — Business-logic functions invoked by route handlers
