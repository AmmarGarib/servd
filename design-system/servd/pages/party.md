# servd "food crowd" direction — shared spec (owner-approved 2026-09-27)

The owner rejected three earlier directions (editorial-dark, liquid glass,
the prior main) as "not interesting" and loved the playful food-crowd hero:
"wow looks toooo good … I want this website to feel alive." Everything below
serves that: **playful, alive, interactive, crafted — never flat, never
template-y, never cheap-cartoon.** Reference the live hero:
`frontend/storefront/src/components/party/PartyHero.tsx` + `party.module.css`.

## The servd hub palette (contrast-checked)
| Token | Hex | Use |
|---|---|---|
| butter | `#FFD447` | Hero stage / signature ground |
| butter-deep | `#F4C22E` | Floors, shading |
| cream | `#FFF4D6` | Light surfaces, cards, ghost buttons |
| plum | `#4E2A4F` | servd brand — headlines, primary buttons (cream text) |
| ink | `#2A1A2B` | Body text, outlines, button 3D shadows |
| ink-mute | `#5C4A3D` | Secondary text (5.90:1 on butter) |
| tomato | `#FF5A3C` | DECORATION ONLY (2.96:1 on butter — never text) |
Pairs: plum/butter 8.35:1 · ink/butter 11.52:1 · cream/plum 10.84:1 · ink/cream 14.96:1.
Alternate section grounds so the page has rhythm: butter → cream → plum → butter.

## Type
Bricolage Grotesque 800 (`var(--font-display)`) for display, tight tracking
(-0.045em), with the emotional half in italic. Inter for body, 16px+, 1.6.

## Components that define the look
- **Chunky diner buttons**: 999px pill, 2.5px ink border, `box-shadow: 0 6px 0 ink`;
  hover lifts (-3px) + tiny rotate; active presses down (4px, shadow 2px).
- **Cards**: cream, 2.5px ink border, 20–28px radius, offset ink shadow; tilt/lift on hover.
- **Doodles**: hand-drawn SVG stars/squiggles/dots in plum/tomato, gently animated.
- **Motion vocabulary**: springy overshoot easing `cubic-bezier(0.34,1.56,0.64,1)`,
  word/letter drops, draw-on underlines, marquee strips, sticker slaps, wobble.

## The characters (the soul of it)
`components/characters/` — `FoodCrowd` (three.js, client-only, load via
`next/dynamic({ssr:false})`), props: `cast?: CharacterKind[]`
(`'burger'|'fries'|'coffee'|'sandwich'|'shake'|'croissant'`), `excitement?: 0..1`,
fills its parent box (size the parent; wide-short boxes suit it; <0.95 aspect
shows 3 centre characters, <1.35 shows 4). `emitCrowd({type:'cheer'})` from
`characters/crowdBus` makes every mounted crowd cheer. Each canvas is one
WebGL context — use at most ~2 crowds per page. Characters must never block
content or be the only way to reach anything (they're aria-hidden decoration).

## Non-negotiables
- Every text pair ≥ 4.5:1; focus visible; targets ≥ 44px; no horizontal scroll at 375px.
- `prefers-reduced-motion`: final states, no loops.
- SVG icons only — never emoji. simmer and stackd always lowercase.
- Never mention third-party delivery aggregators.
- Performance: animate transform/opacity; pause offscreen; lazy-load below the fold.

## Brand microsites
Each brand keeps ITS OWN brand book (palette, type, logos, mascots — see
`public/brand/*` and the layout headers) — the servd butter palette does NOT go
on brand pages. "Alive" is expressed in each brand's own language:
- **Flipd** — playful, court-side smash burger diner: characters welcome here.
- **stackd** — scratch-cooking café + market, its own mascot/wordmark art:
  characters welcome (the crowd's coffee cup wears the stackd sleeve).
- **simmer** — night-mode editorial speakeasy under a strict bible: NO
  characters, no gradients, no white, no emoji, no exclamation marks, single
  orange signal per viewport, Amarante + Times, lowercase. Alive = quiet,
  cinematic, crafted motion (light, smoke, candle, reveal, parallax), never cute.
