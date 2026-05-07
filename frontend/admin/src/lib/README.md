# frontend/admin/src/lib

Plain-TS helpers (no React).

- `api.ts` — Centralised fetch client + typed endpoint helpers (`api.get<T>`, `ordersApi.list`, `menuApi.getMenu`).
- `socket.ts` — Socket.IO client factory (room joining + reconnect).
- `format.ts` — Currency, date, duration formatters.
- `auth.ts` — Token storage + refresh helpers.
