# auth

Backend module: **auth**. HTTP routes + business logic for the Auth domain. Registered into Fastify by `src/index.ts` under the `/auth` URL prefix.

## Files

- `middleware.ts` — Request middleware (Fastify pre-handler or Next.js middleware)
- `routes.ts` — Fastify route registrations for this module
- `service.ts` — Business-logic functions invoked by route handlers
