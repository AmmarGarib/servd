# rider

Backend module: **rider**. The rider app's API, registered by `src/index.ts` under `/rider`. Contract: `docs/rider-app.md`.

Every route needs a rider access token (`riderAuth/middleware.ts`) and acts only on orders with `riderId` = the signed-in rider. Assign / unassign / delivered go through `dispatch/service.ts`.

## Files

- `routes.ts` — `/me`, `/shift`, `/jobs`, `/jobs/:orderId[/accept|decline|picked-up|arrived|deliver]`, `/location` (409 `OFF_SHIFT` while offline — nothing stored)
- `service.ts` — the `Job` shape and the job steps (hand-over code: 5 tries, then 423)
