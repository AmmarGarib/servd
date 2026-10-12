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
