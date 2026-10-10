# riderAuth

Backend module: **riderAuth**. Rider-app sign-in, registered by `src/index.ts` under `/rider-auth`. Contract: `docs/rider-app.md`.

A rider is not a `User`: riders get their own token types (`rider` / `rider_refresh`), which every staff guard and the socket handshake refuse, and the rider guard refuses every staff and customer token.

## Files

- `routes.ts` — `POST /otp/request`, `/otp/verify`, `/refresh`, `/logout`
- `service.ts` — which rider a code may go to, token issue / verify, the public rider shape
- `middleware.ts` — `requireRider`, the preHandler for every `/rider/*` route (sets the RLS scope)
