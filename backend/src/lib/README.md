# backend/src/lib

Cross-cutting infrastructure used by every module.

## Files

- `prisma.ts` — Singleton Prisma client.
- `redis.ts` — Singleton Redis client.
- `ws.ts` — Socket.IO server + safe emitters (never throw if WS is uninitialised).
- `errors.ts` — `AppError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError` + Fastify error formatter.
- `storage.ts` — Cloudflare R2 presigned-URL generator.
- `moduleAccess.ts` — Role → module defaults and the server-side module gate (`RoleModuleAccess`).
- `tenantScope.ts` — Company scoping helpers (`scopeTenantWhere`, `assertConceptOwned`, `activeTenantId`, …). Empty scope denies.
- `audit.ts` — Audit log helpers (used by refunds, voids, comps, config edits).
- `notify.ts` — Email + SMS dispatchers (no-op when SMTP/Twilio aren't configured).
- `whatsapp.ts` — Meta Cloud API client.
- `reservation.ts` — Background cart-release worker for abandoned reservations.
- `secretBox.ts` — AES-256-GCM encryption at rest for integration secrets (key from `SERVD_SECRET_KEY`).
- `connectorRoles.ts` — Who may configure the API connectors (`CONNECTOR_ADMINS`).
- `conceptAccess.ts` — Multi-tenant access control (which concepts a staff user can see).
- `fleet.ts` — Fleet agreements: may this rider's company carry that order's company's orders? (the one rule — `docs/rider-app.md`).
- `deliveryOtp.ts` — The delivery hand-over code: CSPRNG generation, constant-time compare, the 5-try limit, and who may read it (admin / management).
