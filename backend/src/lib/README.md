# backend/src/lib

Cross-cutting infrastructure used by every module.

## Files

- `prisma.ts` — Singleton Prisma client.
- `redis.ts` — Singleton Redis client.
- `ws.ts` — Socket.IO server + safe emitters (never throw if WS is uninitialised).
- `errors.ts` — `AppError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError` + Fastify error formatter.
- `storage.ts` — Cloudflare R2 presigned-URL generator.
- `permissions.ts` — Role × permission catalogue + `userCan()` cache.
- `audit.ts` — Audit log helpers (used by refunds, voids, comps, config edits).
- `notify.ts` — Email + SMS dispatchers (no-op when SMTP/Twilio aren't configured).
- `whatsapp.ts` — Meta Cloud API client.
- `reservation.ts` — Background cart-release worker for abandoned reservations.
- `fbr.ts` — FBR e-invoice submission helper.
- `hmac.ts` — Constant-time HMAC verification for webhooks.
- `conceptAccess.ts` — Multi-tenant access control (which concepts a staff user can see).
- `fleet.ts` — Fleet agreements: may this rider's company carry that order's company's orders? (the one rule — `docs/rider-app.md`).
- `deliveryOtp.ts` — The delivery hand-over code: CSPRNG generation, constant-time compare, the 5-try limit, and who may read it (admin / management).
