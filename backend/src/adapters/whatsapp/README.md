# whatsapp

The customer WhatsApp ORDER flow on the one shared GS Foods number. Inbound
messages reach it from `POST /webhooks/whatsapp` (`modules/webhooks/routes.ts`)
after supplier chat and open customer CRM threads have had their turn.

## Flow

`idle → brand → browsing → category → cart → confirm`, plus `switch` (asked
"switch kitchens and empty your cart?").

- **Brand menu first (owner decision, 2026-10-12).** A new session, a greeting
  (`hi`, `salaam`, …) or a keyword (`menu`, `brands`, `switch`, `change brand`,
  `kitchens`) sends an interactive list of the brands that take orders RIGHT
  NOW, across every company: `isActive`, not deleted, `storefrontVisible`,
  open by its opening hours in PKT (`orderingState`, the check checkout runs),
  belongs to a company, and has a dish a customer can REACH (priced, available,
  in a section that is switched on and showing at this time of day — the only
  way `sendToMenu` offers items). Names go through `formatBrandName`. One brand → straight to it; none → "Ordering is
  closed right now." (+ when each opens). A typed number or name also picks.
- **The brand must stay live.** Every inbound message on a session with a
  brand re-checks the brand rule (active, not deleted, on the storefront, in a
  company); a brand switched off, hidden or deleted mid-session (or a
  pre-brand-menu session's old default) is dropped with its cart and the
  brand menu is sent. `placeOrder` checks it again (409 `BRAND_CLOSED`), then
  the hours.
- **Typed replies.** The production gateway (`lib/whatsapp.ts`) is text-only:
  buttons go out as `1. Place order`, list rows as `• Mains`, and no tap ever
  comes back. Every prompt stores its options in `session.lastOptions`, and a
  typed number, title (case/punctuation-insensitive), copied line, or an
  unambiguous 4+ letter prefix is mapped back to that option's tap
  (`matchOption`). An exact title beats a keyword ("Hello Bowls"); a prefix
  never does.
- **A cart is one brand's.** Picking another brand with a non-empty cart asks
  first; "Keep my cart" keeps it, "Switch" empties it.
- **Returning members** (matched by phone) are greeted by first name. When the
  brand of their LAST order still takes orders, the greeting offers
  "Reorder last" there (and "Other kitchens"); otherwise the brand menu.
- **Orders** are created at the session's brand (`ingestOrder`, source
  `servd`, `raw_payload.channel = 'whatsapp'`), so they land in that brand's
  company, priced by `priceOrder` at the brand's cash GST rate (pay on
  collection — never `concept.taxRate`). Checked first: the brand is open, the
  items are served now, and the brand's company has no ban on the customer.
  No loyalty, wallet, gift card or promo is redeemed on WhatsApp.
- **Copy** is servd's neutral voice: no emoji, no exclamation marks (the same
  words go out for Simmer).

## Configuration

`WHATSAPP_DEFAULT_CONCEPT` (a brand slug) is optional. When it names a brand
that takes orders, that brand is listed first; it is also the fallback when the
brand list cannot be read. Missing or wrong, it is ignored.

## Sessions

`lib/wa-session.ts` keeps the session in Redis (`wa:session:<phone>`, 30 min).
v2 adds `tenantId`, `brandOptions`, `pendingConceptId`, `lastOptions`; older sessions are
migrated on read (`normaliseSession`).

## Files

- `conversation.ts` — the state machine (`handleWaMessage`, `orderingBrands`, `placeOrder`)

Tests: `tests/whatsappBrandMenu.test.ts`, `tests/auditLedgerFollowups.test.ts` (F4).
