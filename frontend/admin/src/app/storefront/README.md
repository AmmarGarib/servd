# storefront

Admin route: **/storefront** — the one place storefront content is edited
(owner decision 41). Replaces Visual Layout, /content, /storefront-hero and
/storefront-footer.

## Files

- `page.tsx` — hub with tabs via `?tab=`: `pages` | `popups` | `library` | `approvals`
- `pages/[slug]/page.tsx` — page builder for a SiteLayout slug (URL-encoded):
  `servd:home`, `servd:hero`, `brand:<slug>`, `brand:<slug>:footer`, `page:<slug>`
- `popups/[key]/page.tsx` — pop-up editor for `popup:<key>`

UI lives in `components/storefront/` (Builder, Canvas, BlockInspector, panels,
VersionsDrawer, ListPanels, LibraryPanel, ApprovalsPanel); the API client and
types in `lib/content.ts`; block types, palette and defaults in `lib/blocks.ts`.
Every save is a draft (`PUT /site-layouts/:slug/draft`); only role `admin`
approves, rejects, rolls back or deletes.
