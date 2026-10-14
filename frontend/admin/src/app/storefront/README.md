# storefront

Admin route: **/storefront** — the one place storefront content is edited
(owner decision 41). Replaces Visual Layout, /content, /storefront-hero and
/storefront-footer. Owner decision D4: this editor is upgraded in place, never
joined by a second content system.

## Files

- `page.tsx` — hub with tabs via `?tab=`: `kit` | `pages` | `popups` | `library` | `approvals` (default `pages`)
- `pages/[slug]/page.tsx` — page builder for a SiteLayout slug (URL-encoded):
  `servd:<page>`, `brand:<slug>[:<page>]`, `page:<slug>`
- `popups/[key]/page.tsx` — pop-up editor for `popup:<key>`
- `kit/[slug]/page.tsx` — brand kit editor for one brand (`brand:<slug>:kit`)

## Brand kit

A brand's look — colours, two fonts (heading, body) and four pictures (logo,
wordmark, mascot, badge) — is one `SiteLayout` row per brand, slug
`brand:<slug>:kit`, kind `kit`, the kit in `settings.kit` (no elements). Same
draft → submit → CEO approve / schedule / reject → versions → rollback as a
page; there is no second approval engine. `components/storefront/KitEditor.tsx`
builds its form from the storefront's `GET /api/storefront-brand-kit`
(`kitCatalog.ts`; no brand palette is copied into the admin) and shows the
brand's home page in the editor frame with the UNSAVED kit (`FrameDoc.kit`).
Empty field = the brand's built-in look. The publish keeps the brand's
ordering colour, logo, wordmark and mascot (`Concept`) in step, which is why
Marketing -> Brands only shows the kit and links here. `kit` is a reserved
brand page name (`isReservedBrandPage`).

UI lives in `components/storefront/` (Builder, LiveCanvas, Canvas, BlockInspector,
MotionPicker, SectionFields, panels, VersionsDrawer, ListPanels, LibraryPanel,
ApprovalsPanel); the API client and types in `lib/content.ts`; block types,
palette and defaults in `lib/blocks.ts`; the frame protocol in
`lib/editorProtocol.ts`. Every save is a draft (`PUT /site-layouts/:slug/draft`);
only role `admin` approves, rejects, rolls back or deletes.

## The builder (D4 stage 1)

Three panes, filling the screen under the header:

- **Left — Layers | Add.** Layers is the element list (`Canvas.tsx`, `compact`):
  pick, reorder (drag or arrows), move out of columns, duplicate, hide, delete.
  Badges show the entrance animation, the scroll effect and "not on the page"
  (a visible element the live page drew nothing for). Add is the palette; drag
  an item onto the Layers tab to drop it in place. Structure ops live in
  `tree.ts` (no undo yet — that is stage 7).
- **Centre — the real page** (`LiveCanvas.tsx`): an iframe of the storefront's
  `/editor-frame` showing the UNSAVED working copy through the storefront's own
  renderer, in phone (390×844), tablet (820×1180) or desktop (1280×800), scaled
  to fit (`localStorage['sf-editor-device']`). Click an element to select it
  (Layers and the inspector follow); hover outlines go both ways; clicking the
  live top bar / footer / page around a part offers that part's own editor.
  Pop-ups show in their real display (modal, bar, corner) over the page they
  target. Reload starts a new session.
- **Right — inspector.** Element (Content → Style → Entrance (plays once) →
  Scroll effect → Visibility), Page / Pop-up settings, pop-up Rules.

### The frame protocol (`lib/editorProtocol.ts`)

Byte-identical to `frontend/storefront/src/editor/protocol.ts`; change both
together. The admin posts `init` (on the frame's `ready`), `doc` (each change,
first at once then at most every 250 ms, latest wins), `select` / `hover` (only
when they start in the editor — a selection or hover that came from the frame
is never echoed back), `motion-preview` (the slider, rAF-throttled). The frame
answers `rendered` (rev, ok, error, the block ids it drew), `select`, `hover`
(with rects, for later direct manipulation), `context`, `motion-preview-ended`
and `error`. A refused doc (`TOO_LARGE`, `BAD_DOC`) counts as that change
failing, so the editor never waits on it.

Security: the admin posts only to `STOREFRONT_ORIGIN` (never `'*'`) and accepts
a message only from that origin, from this iframe's window, and with this
mount's session (except the first `ready`). The iframe is sandboxed
`allow-scripts allow-same-origin` only. The storefront allows framing of
`/editor-frame` by the `ADMIN_ORIGINS` origins only. The frame renders what it
is posted plus public data; it never fetches a draft and never counts A/B
views. Docs are capped at 600 000 UTF-8 bytes.

### Offline

With the storefront down the editor still opens: Layers, the inspector, general
elements and Save work from the API. The section catalogue gives up after 8 s
(a timeout is final, never retried automatically; a refused connection or HTTP
error is retried once);
an amber banner says what can't load, section forms say their form comes from
the storefront, and the centre says the live page can't be shown (no `ready`
within 12 s). A page nobody has edited yet (no draft, nothing live) has no
design to start from, so it waits for the storefront with a Retry.

### Scroll effects (`block.motion`)

`{ preset, intensity? }` on any block, separate from the one-shot entrance
`animation`. Presets: parallax, fade, grow, pin-reveal, sticky-stack, side-pan,
text-reveal; strength subtle / medium / strong. Offered on pages (all) and
footers (not pin-reveal / sticky-stack); never on top bars, widgets or pop-ups.
Simmer pages leave out text-reveal. The preview slider plays the effect on the
selected element in the live page and never changes the block. The four copies
of the schema: storefront `lib/blocks.ts`, admin `lib/blocks.ts`, mobile
`src/content/types.ts`, backend `siteLayouts/schemas.ts`. The behaviour lives in
the storefront's `lib/motion.ts` + `components/blocks/motion.css`.

### Fonts in the frame

The frame is sent the Library fonts the doc uses, picked like the live page's
`resolveFonts`: newest upload wins, and a company's page uses its own company's
fonts when the Library rows say whose they are.
