# Configuration Hub

A single page (`/configuration`) listing every editable setting in the platform as a tile. Each tile shows a "ready / needs setup / optional" status pill so operators can see at a glance what's still left to wire up.

## Sub-pages (one per tile)

- [`api-tokens/`](./api-tokens/) — Issue / revoke long-lived bearer tokens.
- [`audit-log/`](./audit-log/) — Audit log retention + scope viewer.
- [`backup/`](./backup/) — Backup + data export defaults.
- [`billing/`](./billing/) — Subscription plan + invoices.
- [`hours/`](./hours/) — Hours of operation per concept.
- [`language/`](./language/) — i18n + currency + date format.
- [`loyalty/`](./loyalty/) — Points earn rate, redemption, tier thresholds.
- [`notifications/`](./notifications/) — Customer + manager notification cadence.
- [`payment-methods/`](./payment-methods/) — Cash/Keenu/JazzCash/EasyPaisa toggles + fees.
- [`printer/`](./printer/) — Receipt printer / ESC-POS settings.
- [`roles/`](./roles/) — **Role × permission matrix editor** (admin-only). Source of truth for the `useCan()` hook.
- [`tax/`](./tax/) — GST rates + FBR e-invoice config.

## How tiles get their status

Each tile in `/configuration` runs a small react-query against the related entity count (e.g. concepts, stations, suppliers) and renders Ready / Needs setup / Optional based on what it sees. Wire status into a new tile by adding a `useQuery` in the hub page and computing the `status` field for that tile.
