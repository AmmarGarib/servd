# frontend/storefront/src/app

Customer-facing routes.

- `page.tsx` — Landing page (browse all brands).
- [`browse/`](./browse/) — Combined-menu browse view.
- [`[concept]/`](./[concept]/) — Per-concept ordering flow (menu → cart → checkout → order tracking).
- [`brand/[slug]/`](./brand/) — Brand microsite (about, menu, visit pages).
- [`brands/`](./brands/) — Static brand homepages (Stackd, Strata, Flipd).
- [`account/`](./account/) — Logged-in customer portal (profile, addresses, orders, loyalty, complaints).
- [`auth/`](./auth/), [`login/`](./login/), [`signup/`](./signup/) — Authentication.
- [`order/`](./order/), [`orders/`](./orders/) — Order tracking.
- [`reserve/`](./reserve/) — Table reservations.
- [`group-order/`](./group-order/) — Shared cart for groups.
- [`supplier/`](./supplier/) — (Note: real supplier portal is in admin/src/app/supplier).
