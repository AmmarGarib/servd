# siteLayouts

Backend module: **siteLayouts**. HTTP routes + business logic for the Site Layouts domain. Registered into Fastify by `src/index.ts` under the `/siteLayouts` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module
- `schemas.ts` — zod for blocks and page settings (blocks loose, settings strict)
- `service.ts` — slug grammar, scoping, publishing, fonts

## Scroll effects (`motion`, D4 stage 1)

Any block — top level, inside a `columns` block, or in `settings.ab.blocks` —
may carry `motion: { preset, intensity? }`, a scroll effect that is separate
from (and composes with) the one-shot entrance `animation`. `preset` is one of
`MOTION_PRESETS` (`parallax`, `fade`, `grow`, `pin-reveal`, `sticky-stack`,
`side-pan`, `text-reveal`), `intensity` one of `MOTION_INTENSITIES` (`subtle`,
`medium`, `strong`; absent = medium). The schema is strict: an unknown preset
or intensity, an extra key or a non-object is a 400 `VALIDATION_ERROR`;
`null` means "none" and is dropped. Layouts without `motion` parse exactly as
before. The routes and the service treat it as data — drafts, submit, CEO
approve/schedule, versions and rollback carry it unchanged. The four copies of
the lists (here, `frontend/storefront/src/lib/blocks.ts`,
`frontend/admin/src/lib/blocks.ts`, `mobile/src/content/types.ts`) must stay
identical; `keyframes`, `devices`, `range` and `delayMs` are reserved inside
`motion` for later stages. Covered by `tests/siteLayoutMotion.test.ts`.

## Brand kit (`brand:<slug>:kit`, kind `kit`, owner 2026-10-14)

One row per brand holds the brand's look in `settings.kit` / `draftSettings.kit`
(`blocks` / `draftBlocks` are always `[]`). `kitSettingsSchema` is strict:
`{ kit: { v: 1, palette?, roles?, fonts?, images? } }` — colours 6-digit hex
only, palette keys `/^[a-z][a-z0-9-]{0,30}$/` (max 24), fonts a built-in id
(`KIT_BUILTIN_FONTS`) or `library:<mediaAssetId>` (a font of the SAME company,
else 422 `KIT_FONT_NOT_IN_COMPANY`), images an https URL ≤ 1000 chars or a
`/brand/` path. A cleared field (`''` / null) is dropped = "today's default".
A kit row with blocks is 422 `KIT_NO_BLOCKS`; a page carrying `kit` is 422
`KIT_NOT_ALLOWED`. `kit` is a reserved brand part (never in `/pages/live`).

Publishing (approve now, scheduled, rollback) syncs the brand's `Concept` in
the same transaction through `applyKitToConceptTx`: `primaryColor ←
roles.ordering`, `logoUrl ← images.logo`, `wordmarkUrl ← images.wordmark`,
`mascotUrl ← images.mascot` — only the fields the kit sets, the brand found by
slug inside the row's own company.

`GET /site-layouts/kits/live` (public) → `{ kits: { [brandSlug]: { kit,
version, fonts: [{ id, family, url, format }] } } }` for live kits of active,
storefront-visible brands. The list route adds `label: "Brand kit — <Brand>"`
for kit rows (the approvals inbox uses it). Covered by `tests/brandKit.test.ts`.
