# servd — Mobile vs Desktop Responsive Audit

_Date: 2026-06-17. Covers the customer **storefront**, operator **admin**, and **POS/KDS/Expo** surfaces._

## Device priorities (per your note)
| Surface | Primary device | Also |
|---|---|---|
| Storefront (customers) | **Phone** | tablet, laptop |
| Admin (staff/managers/you) | **Tablet on-site** | phone (managers), laptop (you) |
| POS / KDS / Expo | **Tablet only** | — |

## The one framing fact that drives most admin/POS issues
The admin shell (`AppShell.tsx`) switches at a **single breakpoint, `md` = 768px**. Below 768 → mobile drawer (good). At **≥768px it shows a fixed 220px sidebar** with no auto-collapse. Every tablet (portrait 768–820, landscape 1024) therefore loses 220px to the sidebar — leaving ~548px (portrait) to ~804px (landscape) of content — and the **drawer never appears on tablet**. Several pages then nest a *second* sidebar inside that, and many grids are gated at `xl:` (1280px) which a tablet never reaches. This is the root cause of items A1–A4 and P1–P3 below.

Tailwind breakpoint reality: `md`=768, `lg`=1024, `xl`=1280. A landscape tablet hits `lg` but **never `xl`**, so any `xl:`-gated multi-column layout collapses on tablet.

---

## ✅ Fixed in this pass (safe, high-value, shipped)
| # | Area | File | Fix |
|---|---|---|---|
| H | Storefront hero (phone) | `ui/scroll-expansion-hero.tsx`, `lib/heroConfig.ts` | Media box no longer grows into a tall portrait box on phones (was forcing a 16:9 clip into ~370×600 → "too zoomed in"); solid-white legible title (dropped `mix-blend-difference`); smaller title/eyebrow on phones. |
| S1 | Signup OTP (phone) | `app/signup/page.tsx` | 6 fixed 44px boxes (~304px) overflowed the ~294px card → boxes now flex/shrink (`flex-1 min-w-0 max-w-[2.75rem]`, tighter gap). Account creation no longer clips on a 390px phone. |
| S2 | Account loyalty points (phone) | `app/account/page.tsx` | Fixed `3.2rem` points number clipped large balances → `clamp(2rem,9vw,3.2rem)` + `tabular-nums`. |
| S3 | Browse grid (small phone) | `app/browse/BrowseClient.tsx` | `minmax(300px,1fr)` overflowed at 320–360px → `minmax(min(100%,280px),1fr)`. |
| S4 | Menu grid (small phone) | `app/[concept]/page.tsx` | `minmax(280px,1fr)` → `minmax(min(100%,260px),1fr)`. |
| P1 | Expo pass board (tablet) | `app/expo/page.tsx` | Columns gated at `xl:` collapsed the whole board to 1 column on a landscape tablet → added `lg:grid-cols-3` so the 3 working columns show on tablet. |
| P2 | KDS grids (tablet) | `app/kds/page.tsx`, `app/kds/[station]/page.tsx` | Cooking/waiting grids capped at 2 columns on landscape tablet (`xl:grid-cols-3`) → `lg:grid-cols-3` recovers the 3rd column. |
| P3 | POS waiter steppers (tablet) | `app/pos/waiter/page.tsx` | Qty −/+ were `h-7 w-7` (28px), below fast-tap size → `h-11 w-11` (matches PosCart). |
| A1 | Scheduling (tablet, **functional**) | `app/scheduling/page.tsx` | Per-cell add/delete shift controls were `opacity-0 group-hover:` — **invisible/untappable on touch**, so staff couldn't edit shifts on a tablet. Now always visible (subtle, brighten on hover). |

All type-check clean; storefront + admin rebuilt and deployed.

---

## 🚩 MAJOR — escalated for your sign-off (need layout rework / a design call)

### Admin shell & navigation
- **A-M1 — Tablet sidebar strategy.** The 220px sidebar is permanent from 768px with no tablet auto-collapse (`AppShell.tsx:817`). On a portrait tablet that's 29% of the screen, permanently. **Recommendation:** use the drawer pattern up to `lg` (1024), OR default the sidebar to the 52px icon-rail on tablet widths. This single change reclaims space on *every* admin page for your on-site staff. _Pick: drawer-up-to-lg (cleanest) vs default-collapsed-on-tablet (keeps it one tap away)._
- **A-M2 — Pages that nest a *second* sidebar.** Orders (`+208px`), Settings (`+224px`), Marketing→Brands (`+288px`). On a 768px tablet that's 428–508px of chrome; **Marketing→Brands is actually broken on phones** (the 288px panel alone exceeds a 390px screen, editor unreachable). **Recommendation:** below `lg`, collapse each inner sidebar into a `<select>`/drawer (Orders & Settings already have a hidden mobile strip — just extend it to tablet).

### Admin data tables (systemic — affects ~40 pages)
- **A-M3 — `.s-table` degrades on tablet.** `globals.css` `.s-table` has no `min-width` and no `white-space:nowrap`, and **~half of ~43 table-bearing pages have no `overflow-x-auto` wrapper at all**. Result: finance/accounting/reports/payroll/reconciliation tables *wrap* currency values into multi-line cells (unreadable) instead of scrolling on a tablet's narrow column. **Recommendation (one coordinated change, big payoff):** add `min-width` + `whitespace-nowrap` to `.s-table` cells and ensure every `.s-table` sits in an `overflow-x-auto` wrapper (+ sticky first column on the widest tables). I scoped this as MAJOR because it touches many pages and needs a regression pass — happy to do it as its own batch.

### Admin workflow pages (tablet)
- **A-M4 — Scheduling week grid**: 780px-min, 8-col, staff name column scrolls away (`scheduling/page.tsx:278`). Needs a sticky staff column or stacked per-day cards below `md`. (The hover-only controls part is already fixed above.)
- **A-M5 — Reservations** (`reservations/page.tsx:145,272`): the `1fr+320px` split fires at `lg` inside a squeezed ~804px box → day view crushed; the 6-button action row per reservation is sub-tap-size. Needs split gated to `xl:`/full-screen + stacked row actions.
- **A-M6 — Store hours** (`hours/page.tsx:127`): each day row has ~436px of fixed-width inputs in a ~548px column with no wrap → the Reservable toggle pushes off. Needs `flex-wrap` + flexible time inputs.

### POS / KDS (tablet)
- **P-M1 — Should ops surfaces go full-screen?** `/expo`, `/reservations`, `/tables`, `/floorplan`, `/dispatch` currently render *with* the sidebar. They're fast in-service screens; adding them to `FULL_SCREEN_PREFIXES` (like `/kds`,`/pos`) would give them the whole tablet. **This is a UX call** (staff lose sidebar nav on those pages) → your decision.
- **P-M2 — `/tables` height bug** (`tables/page.tsx:103`): `h-[calc(100vh-89px)]` hardcodes an 89px header that *wraps to ~140px on portrait* → content clips. Needs `flex-1 min-h-0`. (Small fix but behavioral — flagging.)
- **P-M3 — POS portrait layout**: 320px cart rail + `grid-cols-3` menu makes item cards too narrow on a portrait tablet (`pos/page.tsx:181,210`). Needs an orientation-aware layout (cart as bottom-sheet `< lg`).
- **P-M4 — `/reservations/week`, floor-plan editor touch resize**: week grid crushes 7 columns on portrait; floor-plan editing relies on typing X/Y/W/H (no touch drag handles).

### Storefront (phone)
- **C-M1 — Brand microsite nav vanishes on phone.** `BrandShell.tsx:138` — every nav link is `hidden sm:inline-block` with **no hamburger fallback**, so on a phone the only nav on a brand microsite is the wordmark + "Order →". **Recommendation:** add a mobile disclosure menu (or keep Menu/Book visible). Customer-facing — worth prioritizing.
- **C-M2 — Orders list cards** (`orders/page.tsx:179`): fixed `1fr auto` with two side-by-side action pills never collapses → squeezed/crowded on phone. Stack below ~480px.
- **C-M3 — Brand layout breakpoints**: Simmer itinerary uses fixed 184px frames + a magic `top:87px` dot; Stax status/brief grids bypass the `.stax-visit-grid` collapse class and leave dangling borders on phone; Generic uses 4rem emoji as the whole card visual. Each needs a phone pass.
- **C-M4 — `DragRail` touch conflict** (`kinetic/DragRail.tsx:32`): pointer-drag fires for touch and fights native momentum scroll (jank, captures vertical swipes). Early-return for non-mouse pointers.

---

## 🔧 MINOR — catalogued for follow-up batches (safe, mechanical)

These are real but low-risk; I held them out of this pass to keep the diff verifiable. Grouped by theme so they can be knocked out in clean batches:

1. **`100vh` → `100dvh` roll-up (storefront, ~14 files).** `min-h-screen`/`100vh`/`92vh` everywhere → mobile browser chrome hides content/CTAs. Mechanical swap to `dvh` (Tailwind `min-h-dvh`, `h-dvh`). Files: `[concept]/page.tsx`, `checkout`, `order/[id]`, `account`, `orders`, `reserve/[slug]`, `reserve/claim|confirm`, `not-found`, `error`, `SimmerMenu`, `GenericBrandLayout`, brand `qr`.
2. **Sub-44px touch targets (~40 across all 3 surfaces).** Nav links/pills, password show/hide, "Resend code", account text-buttons, CEO/fnb period pills, locations/hours preset buttons, reservations action buttons, dispatch select, KDS station toggles, expo reject chips. Mechanical padding bumps.
3. **Non-wrapping flex rows that overflow on phone (~12).** fnb/brand metric rows, orders bulk bar, menu category header, settings staff/shifts rows, finance metric cluster, storefront MediaField, workforce search, `/kds/reservations` header.
4. **Fixed `grid-cols-2/3` in modals/forms with no breakpoint (~10).** locations, settings GST, scheduling modal, reservations modal, marketing identity, tables add/config, account complaint picker.
5. **`safe-area-inset` on fixed bottom CTAs (storefront).** Checkout "Place Order", menu cart pill, order tracker — add `env(safe-area-inset-bottom)` + `viewport-fit=cover`.
6. **Emoji used as structural icons (convention violation, several).** POS payment tiles/FAB, expo fulfilment-type glyphs, KDS, checkout `✓`, order tracker `⏳`, account/reserve `✓`, Generic brand cards. Replace with SVG/text.
7. **Misc bugs spotted in passing:** `reservations/week/page.tsx:44` calls `setState` during render (React warning/loop risk); `TicketCard.tsx` still carries dead Uber/DoorDash/Deliveroo source UI; `/kds/[station]` header shows a raw UUID instead of the station name.

---

## Suggested order of attack (my recommendation)
1. **A-M1 (tablet sidebar)** + **A-M3 (`.s-table`)** — biggest leverage for your on-site tablet staff; together they fix dozens of admin pages.
2. **C-M1 (brand mobile nav)** + the **`100dvh` + safe-area** minors — biggest customer-facing phone wins.
3. **A-M2 (nested sidebars)**, **A-M4/5/6** (scheduling/reservations/hours) — core staff workflows.
4. POS portrait (P-M3) + full-screen decision (P-M1).
5. Sweep the remaining MINOR batches (touch targets, emoji icons, grid breakpoints).

Tell me which of the 🚩 items to take on next and I'll implement them as focused, reviewable batches.
