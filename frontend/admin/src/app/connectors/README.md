# connectors

Dev → API (spec §10, D13): exactly two connectors (module ids `api_whatsapp`
and `api_pos` — never add a third).

- `page.tsx` — the hub: WhatsApp connector card and POS connector card.
- `whatsapp/page.tsx` — the platform-wide WhatsApp gateway (moved from `/configuration/whatsapp`, which redirects here; same `/auth/integrations/whatsapp*` endpoints).
- `pos/page.tsx` — the POS connector of the ACTIVE company: Status, Fiscal setup, POS IDs, Card machine, Raast QR, Submissions, Card charges (components in `components/connectors/`).

## Raast QR tab (2026-10-12)

`components/connectors/RaastSetup.tsx` + `components/connectors/raast/*`,
calls in `lib/connectorsApi.ts` (`/connectors/raast/*`, module `api_pos` —
no new module id). Bank-SMS matching for the Raast QR till tender: a counter
phone forwards the bank's credit SMS to servd, which finishes a waiting bill
only when exactly one bill fits (never a guess).

- **Overview** — on/off, counts, the readiness list. OFF per company by
  default; only the CEO switches it on (typed `SMS ON`; 409 `NOT_READY`
  lists what is missing); admin/IT can switch it off (`SMS OFF`).
- **Counter phones** — devices. The token is shown ONCE (add / rotate);
  rotating kills the old one; the CEO can reveal it again (audited). The
  token goes in the `Authorization: Bearer` header. "Allow the token in the
  URL" is per device, OFF by default, with the log warning (amendment S2).
- **Banks & templates** — the sender allow-list (each sender → one of the
  company's ledger-linked bank accounts), SMS templates in servd's own
  placeholder language (never a regex; each template has a "try it" box) and
  the matching rules. Each card saves only its own part.
- **Tester** — a pasted SMS against the saved set-up; writes nothing.
- **Bank SMS log** — every stored SMS and what servd did with it. SMS from
  unlisted senders and SMS with an ignore keyword (OTP, PIN…) are never
  stored.
- **Receiving accounts** — read-only. Finance sets them in Finance → Bank
  accounts (IT cannot call `/setup/*`; the data comes from
  `GET /connectors/raast/settings`).

Who: admin + IT configure, management reads, the CEO switches on / reveals.
The cashier's side (verify on the counter phone, never the customer's screen)
is the till's RaastPanel; finance's statement matching is Reconciliation →
Raast.

Not under `/api/*`: the admin rewrites `/api/:path*` to the backend.
