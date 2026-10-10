# frontend/storefront/src/app

Customer-facing routes.

- `page.tsx` — Redirects to `/home` (the middleware does this first); `home/` is the landing page.
- [`home/`](./home/) — servd home (sections from Admin → Storefront).
- [`[concept]/`](./[concept]/) — Per-concept ordering flow (menu → cart → checkout → order tracking).
- [`brand/[slug]/`](./brand/) — Brand microsite (about, menu, visit pages).
- [`account/`](./account/) — Logged-in customer portal (profile, addresses, orders, loyalty, complaints).
- [`auth/`](./auth/), [`login/`](./login/), [`signup/`](./signup/) — Authentication.
- [`orders/`](./orders/) — Order history and reviews (tracking is `/<brand>/order/<id>`).
- [`reserve/`](./reserve/) — Table reservations.
- [`group-order/`](./group-order/) — Shared cart for groups.
- [`supplier/`](./supplier/) — (Note: real supplier portal is in admin/src/app/supplier).
