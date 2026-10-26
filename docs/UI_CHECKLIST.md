# UI / UX checklist — run on EVERY new or changed screen (owner, 2026-10-26)

Owner: "This sort of little UI/UX shit was supposed to be solved. If issue comes when we build new stuff,
put in md file to check UI/UX when we build new stuff." This list is part of "done". A screen that fails
any line is not finished, however well the feature works. Fix the pattern in the SHARED component, then
the same fix reaches every similar tab (owner rule: a fix shown on one screenshot is built for all similar
screens).

## How to check
- Look at the changed screen at **390 px (phone)**, **768 px (tablet)** and **1440 px (laptop)** — a
  Playwright screenshot of each, with every dropdown, menu, date picker, modal and drawer on the screen
  OPENED once. Compare against the screen before the change.
- Long values: a 30-character brand / supplier / employee name, PKR 12,345,678.00, an empty list, an
  error from the API, a slow load.

## Floating things (dropdowns, menus, pop-overs, suggestion lists)
- [ ] Built with `components/ui/AnchoredMenu.tsx` (portal, fixed, clamped to the screen, flips up).
      Never `absolute right-0` / `absolute left-0` panels inside the page.
- [ ] Fully on screen at 390 px — nothing cut off on any side, at least 8 px from the edge.
- [ ] Above everything around it (tabs, tables, sticky headers, the floating buttons) — nothing shows
      through it.
- [ ] Not clipped by a scrolling table or card (`overflow-x-auto` parents).
- [ ] Closes on outside tap and Escape; follows its button when the page scrolls; keyboard works (arrows, Enter).

## Layout
- [ ] No horizontal scroll of the PAGE at 390 px (wide tables scroll inside their own box).
- [ ] 16 px side gutter on phone; nothing hidden under the floating menu / search / bell buttons or
      the bottom-left company switcher.
- [ ] Buttons and controls wrap onto the next line instead of overflowing; tap targets ≥ 40 px.
- [ ] Money right-aligned, tabular figures, never broken across two lines in the middle of a number
      ("PKR" may sit above the figure on phone; the figure itself stays on one line).
- [ ] Tables: first column readable on phone; sticky header if long.

## Look
- [ ] `node scripts/check-tokens.mjs` (frontend/admin) passes — every `s-*` colour exists (`bg-s-card` didn't, so
      every dropdown was see-through).
- [ ] ERP tokens only (`var(--erp-*)`, `s-*` classes) — no hard-coded colours; purple = actions,
      green = state / good news (CLAUDE.md colour rules).
- [ ] Line icons only, never emoji. Empty states use `CompactEmptyState`.
- [ ] Shared finance parts (`components/finance/ui`) on finance screens; `.s-input` controls in a
      toolbar pass `w-auto`.

## Behaviour
- [ ] Loading, empty and error states all shown (never a blank area or a raw error code alone).
- [ ] Double-submit guarded; Enter submits forms; Escape closes dialogs; focus returns to the trigger.
- [ ] Numbers don't change on scroll (`NumberField` / `MoneyInput`); dates use the date fields.
- [ ] A role without the module sees the no-access page, not a broken screen.
- [ ] Words are plain (no codes, no jargon); errors say what to do next.

## Before shipping
- [ ] The three screenshots above, before and after, looked at by the builder (not only "tsc passed").
- [ ] If a shared component changed: screenshots of at least three other screens that use it.
