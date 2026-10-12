# The editor frame (`/editor-frame`)

The live page in the middle of **Admin → Storefront** (owner decision D4,
stage 1). The admin frames `https://servd.pk/editor-frame` and posts the
operator's **unsaved working copy** into it; the frame renders it through the
SAME renderers as the live site (`ManagedPage` → `SiteLayoutView` →
`PageRenderer` → sections, `BrandShell`, `PopupFrame`) and draws selection and
hover outlines over it. There is one content system and one renderer: no
second schema, no publish-on-save, no change to draft → submit → CEO approve.

## Files

| file | what |
|---|---|
| `app/editor-frame/page.tsx` | the route: noindex metadata, imports every section group's CSS + renderers, mounts the client with the allowed admin origins |
| `app/editor-frame/actions.ts` | `renderEditorFrame(input)` — the one server action: sanitise → rate limit → compose → return the React tree (RSC) |
| `FrameDocument.tsx` | composes the page in its real context (draft part + live chrome around it) |
| `EditorFrameClient.tsx` | messaging, single-flight render pump, in-place commit, overlay, input capture, scroll-effect preview, pop-ups |
| `BlockMarker.tsx` | `display: contents` selection marker + per-block error boundary |
| `protocol.ts` | the postMessage protocol — **byte-identical** to `frontend/admin/src/lib/editorProtocol.ts` |
| `sanitize.ts` | isomorphic input validation (also run client-side on pop-up docs) |
| `limits.ts` | concurrency cap, per-IP rate limit, the frame-only 30 s caches |
| `types.ts` | the action's input / result shapes and error texts |
| `lib/editorFrame.ts` | `isEditorFramePath()` — the root layout's servd nav, footer, feedback button and pop-ups stand down on this path |
| `lib/adminOrigins.ts` | `ADMIN_ORIGINS` (one definition: this CSP, the frame's postMessage allow-list, `/api/storefront-sections` CORS) |

## What the frame shows

| edited slug | top → bottom |
|---|---|
| `servd:<page>` (home, press, reserve, waitlist, location, …) | live servd header (sticky) → the DRAFT in its `PageSurface` → live footer |
| `page:<x>` | live header → the DRAFT (as `/pages/<x>` renders it) → live footer |
| `servd:header` | the DRAFT header → live home → live footer |
| `servd:footer` | live header → live home → the DRAFT footer |
| `servd:feedback` | live header, home, footer → the DRAFT button |
| `brand:<b>[:<page>]` | `BrandShell` with the live brand header / footer around the DRAFT |
| `brand:<b>:header` / `:footer` | the shell with the DRAFT in that slot and the live brand home |
| `popup:<k>` | rendered by the client in its real display (modal / corner fixed; bar in flow above the page) over the live page it targets: the one brand in `settings.popup.brands`, else servd home |

A draft with no blocks shows the page's built-in design (unmarked — those ids
are not the editor's). A custom page with nothing visible gets an editor-only
note. `servd:location` previews the first publishable location by name.

Every block of the DRAFT carries `data-sv-block="<id>"` + `data-sv-type`
(column children and pop-up blocks too); every live part around it carries
`data-sv-context="<slug>"` (a click offers that part's own editor). Live pages
never carry either.

Fonts: the frame renders the Library fonts the admin posts with the doc
(`FrameDoc.fonts`). The admin picks, per family, the newest upload of the
edited page's company (any company for `servd:*` / `page:*`) — the same rule
the API's `resolveFonts` uses for the live page.

## Protocol (v1, `protocol.ts`)

```
admin mounts iframe (session S)      frame → ready{session:null}  every 1 s until init (max 15)
admin → init{session:S, doc rev 1}   frame renders → rendered{rev 1, ids}
admin → doc{rev n} (throttled)       frame: single flight, latest wins → rendered{rev n}
admin → select{id, scroll}           frame outlines it (scrolls it into view when under half visible)
frame click → select{id, rect}       (the admin never echoes it back)
hover both ways, only on change; a hover that started in the frame is never echoed
admin → motion-preview{id, p}        frame scrubs the effect in place (sticky-stack: scrolls the stack)
admin → ping                         frame → ready{session:S}
```

Every failure for a doc is answered with `rendered{rev, ok:false, error}`
(bad or too-large doc, a failed or rate-limited render, an action call that
threw, a page that threw while drawing); `error` is for session-level problems
only (`PROTOCOL`, or a doc without a readable rev). After a storefront
redeploy the old action id is unknown: the frame reloads itself once per
session and the admin re-sends `init` on the new `ready`.

## Security

- **Framing.** The middleware sets `Content-Security-Policy: frame-ancestors
  <ADMIN_ORIGINS>` on `/editor-frame` only; `next.config.js` leaves
  `X-Frame-Options` off that one path (every other path, including
  `/editor-frame/…` and `/editor-frame-…`, keeps `SAMEORIGIN`). On a brand
  domain the path is a 404 nobody may frame. The admin's iframe is sandboxed
  `allow-scripts allow-same-origin` (no forms, pop-ups, top navigation,
  modals).
- **Messages, both directions, never `'*'`.** The frame accepts a message only
  from `window.parent`, from an allowed admin origin, from the origin locked by
  the first valid `init`, carrying that session. Before `init` it announces to
  the referrer origin (when allowed) or to each allowed origin. The admin
  accepts only `STOREFRONT_ORIGIN` from its own iframe's window.
- **No drafts anywhere else.** The frame never fetches a draft (no preview
  token, no staff call, no cookies read). It renders only the posted JSON plus
  public data the live page already reads. Nothing is stored or written.
- **Nothing counted.** Every part renders with `previewVariant`, so there is
  no `TrackedLayout` (no `SiteLayoutStat` views / conversions); no JSON-LD,
  view trackers, beacons, visitor cookie, live pop-ups or feedback posts.
- **The action renders unauthenticated input.** `sanitize.ts` bounds it
  (600 kB of UTF-8, ≤ 80 blocks, columns ≤ 4 × 40, no nested columns, plain
  objects with string ids/types, settings reduced to fonts / A-B / pop-up
  rules, fonts ≤ 30, the slug parsed with the backend grammar and the layout
  kind derived from it). `featured_menu` / `reviews` / `kitchens`
  `conceptSlug` must look like a slug. **Every value a renderer puts into a
  server-side URL must be encoded** (`encodeURIComponent`) — never trust that
  only approved layouts reach a renderer any more. Script hrefs in core blocks
  go through `blockHref`; section fields through `sections/safe.ts`.
- **Load.** At most 6 renders in flight server-wide (over that:
  `RATE_LIMITED` at once, the client retries after 2 s) and 240 per minute per
  client IP (Cloudflare's IP through the tunnel, else the first
  X-Forwarded-For hop). A render's slot covers the action's own data loading
  AND the tree it returns, which React renders (sections, menus, reviews…)
  while the response streams: a successful call keeps its slot until the same
  client's next call (the frame is single flight) or 3 s after it returned,
  whichever comes first — so one editor holds at most one slot. Every fetch the
  composition makes (live chrome layouts, the brand list, the preview
  location) gives up after 5 s and the page falls back to its built-in design,
  so a hung API cannot hold the slots. `edited: null` (a live page, the pop-up
  backdrop) is accepted only for `servd:home` and `brand:<slug>`; the 30 s
  layout cache evicts its least recently used entry, never the whole cache.
  Input is never logged — on failure the server log gets the code, slug, size,
  a reference and the exception message; the caller gets only "Part of the
  page couldn't be drawn. (ref …)".
- **Input capture.** Clicks, middle clicks, form submits, link drags and
  Enter/Space on links and buttons never reach the page; the frame never
  navigates. The page still scrolls normally.
