# blocks

The renderers for SiteLayout blocks (`lib/blocks.ts`): every storefront page
is a `Block[]` edited in Admin → Storefront.

## Files

- `PageRenderer.tsx` — server component: maps each block to its renderer and
  wraps it (in this order, outermost first): the editor's selection marker
  (only inside `/editor-frame`), the scroll-effect wrapper (only when
  `block.motion` is valid), then `BlockSlot` (background / text colour /
  padding / font / entrance animation). Groups consecutive `sticky-stack`
  blocks in one `.sv-stack`. A block without motion, outside the editor,
  renders exactly as before.
- `SiteLayoutView.tsx` — a published (or previewed) layout: library fonts,
  page fonts, the A/B variant, the view/convert beacon (`TrackedLayout`,
  skipped when `previewVariant` is set), and `MotionRuntime` when the blocks
  carry a scroll effect. Header, widget and pop-up layouts never take motion
  (`motion: false` in the render context).
- `TrackedLayout.tsx`, `conversion.ts` — A/B view + conversion beacon.
- `Animate.tsx` — the one-shot ENTRANCE animation (`block.animation`).
- `Motion.tsx` — `MotionWrap`, the scroll-effect wrapper (`block.motion`).
  Plain markup + inline custom properties, no hooks; imports `motion.css`.
- `motion.css` — the scroll-effect rules and `@keyframes` (not in
  globals.css). CSS scroll-driven animations (`view-timeline`,
  `animation-timeline`, `animation-range`) under `@supports`; the fallback
  rule only applies once the JS engine marks a wrapper ready; reduced motion
  removes every effect (content fully visible); `data-sv-m-scrub` is the
  editor's preview slider.
- `MotionRuntime.tsx` — client, renders nothing; loads `motionClient.ts` on
  demand and starts the engine while mounted.
- `motionClient.ts` — browser-only, no React: the reach guard (all browsers:
  a preset whose range end the page can't scroll to gets `data-sv-motion-off`
  — natural content), the IntersectionObserver / requestAnimationFrame
  fallback where scroll timelines are missing (drives the same keyframes via
  `currentTime`), and the editor preview helpers (`setScrubProgress`,
  `clearScrub`, `scrollStackTo`).
- `Hero.tsx`, `Banner.tsx`, `CtaButton.tsx` — links go through `blockHref`
  (`lib/blocks.ts`): `javascript:` / `data:` / `vbscript:` become `#`.
- `FeaturedMenu.tsx`, `Reviews.tsx`, `Kitchens.tsx` — fetch live data in
  render. Any value put into a server-side URL is encoded
  (`encodeURIComponent`): the editor frame renders unauthenticated input.
- `Gallery.tsx`, `ImageBlockUi.tsx`, `VideoBlockUi.tsx`, `TextBody.tsx`,
  `Quote.tsx`, `StatStrip.tsx`, `Voices.tsx`, `Spacer.tsx`, `Divider.tsx`,
  `SignupFormBlock.tsx` — the other general blocks.

## Scroll effects (`block.motion`)

`{ preset, intensity? }` on any block (sections, columns and column children
included). Presets and their exact values live in ONE table,
`lib/motion.ts` (`MOTION_SPECS`); the schema has four copies (storefront
`lib/blocks.ts`, admin `lib/blocks.ts`, mobile `content/types.ts`, backend
`siteLayouts/schemas.ts`). Renderers always go through `normalizeMotion`, so
an unknown preset is "no effect", never hidden content. Independent of — and
composable with — the entrance `animation`.

Caveats (by design): parallax / side-pan move the whole block, so on a
full-bleed coloured band Strong can show the page behind its edges; a
transform makes the block the containing block for its `position: fixed`
children; sticky-stack needs two or more consecutive stack blocks; sections
with their own scroll motion (servd scroll hero, Simmer fridge, Stackd
stickers) keep it.
