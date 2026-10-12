# connectors

Dev → API (spec §10, D13): exactly two connectors.

- `page.tsx` — the hub: WhatsApp connector card and POS connector card.
- `whatsapp/page.tsx` — the platform-wide WhatsApp gateway (moved from `/configuration/whatsapp`, which redirects here; same `/auth/integrations/whatsapp*` endpoints).
- `pos/page.tsx` — the POS connector of the ACTIVE company: Status, Fiscal setup, POS IDs, Card machine, Submissions, Card charges (components in `components/connectors/`).

Not under `/api/*`: the admin rewrites `/api/:path*` to the backend.
