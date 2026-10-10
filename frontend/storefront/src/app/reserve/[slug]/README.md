# [slug]

Storefront route: **/reserve/[slug]** — the public booking widget for one brand.

## Files

- `layout.tsx` — server shell: looks the brand up (`lookupConcept` in
  `lib/liveConcepts.ts`) and returns a real 404 when the API answered without
  the slug (not a brand, or one hidden / deactivated in admin). When the API
  didn't answer it renders anyway (bundled brands keep their metadata, any
  other slug is `noindex`), so an outage or rate limit is never a 404. Sets
  the page's title ('Book a table at <Brand>'), description and canonical
  (`${SERVD_ORIGIN}/reserve/<slug>`). A brand with reservations switched off
  is `noindex`.
- `page.tsx` — the booking widget (client component).
