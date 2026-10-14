import type { LiveKits } from '../lib/brandKit'
// Storefront sections — every storefront page is a list of blocks edited in
// Admin → Storefront (owner, 2026-10-07: "every element in the storefront
// module, all pages"). A page's bespoke design is broken into SECTIONS: one
// block type, `section`, whose `variant` picks a renderer and whose `fields`
// hold every word, image, link and colour on it.
//
// This file is the contract between three places:
//   - storefront renderers   (src/sections/<group>/renderers.tsx)
//   - the section catalogue  (src/sections/<group>/catalog.ts — data only)
//   - the admin editor       (fetches the catalogue from /api/storefront-sections
//                              and builds each section's form from `fields`)
// Keep it serialisable: the catalogue goes over the wire as JSON.

import type { ReactNode } from 'react'
import type { Concept } from '../lib/concept'

// ─── Field specs (drive the admin form) ────────────────────────────────────

interface FieldBase {
  /** Key in the section's `fields` object. */
  key: string
  label: string
  /** One line of help under the input. */
  hint?: string
}

export type FieldSpec =
  | (FieldBase & { kind: 'text' })                      // one line
  | (FieldBase & { kind: 'textarea'; rows?: number })   // paragraph; \n = line break
  | (FieldBase & { kind: 'image' })                     // URL, Library picker
  | (FieldBase & { kind: 'video' })                     // URL, Library picker
  | (FieldBase & { kind: 'url' })                       // a link target only
  | (FieldBase & { kind: 'link' })                      // { text, href }
  | (FieldBase & { kind: 'color' })                     // CSS colour; '' = design default
  | (FieldBase & { kind: 'toggle' })                    // boolean
  | (FieldBase & { kind: 'number'; min?: number; max?: number; step?: number })
  | (FieldBase & { kind: 'select'; options: Array<{ value: string; label: string }> })
  | (FieldBase & { kind: 'list'; item: FieldSpec[]; itemLabel?: string; max?: number })

export interface LinkValue { text: string; href: string }

// ─── Section specs (the catalogue) ─────────────────────────────────────────

export interface SectionSpec {
  /** `<group>.<name>`, e.g. `stackd.hero`. Stable — stored in page JSON. */
  variant: string
  /** Palette label, e.g. "Stackd hero". */
  label: string
  /** Palette group heading, e.g. "Stackd", "servd", "Brand pages". */
  group: string
  description?: string
  /** Up to 3 letters for the palette chip. */
  icon?: string
  /**
   * Which pages offer it in the palette: slug patterns (`brand:stackd`,
   * `brand:*`, `brand:*:footer`, `servd:*`, `page:*`, `*`). It can still be
   * kept anywhere it already sits.
   */
  pages: string[]
  fields: FieldSpec[]
  /** Today's content. A field missing from a block falls back to this. */
  defaults: Record<string, unknown>
  /** Field key whose value summarises the section on the editor canvas. */
  summaryKey?: string
}

/** The blocks a page shows when nothing is published for it. */
export interface PageDefault {
  /** Exact slug (`brand:stackd`) or pattern (`brand:*:about`). Exact wins. */
  slug: string
  sections: Array<{ variant: string; fields?: Record<string, unknown> }>
}

// ─── Rendering ─────────────────────────────────────────────────────────────

export interface SectionContext {
  /** The page being rendered, e.g. `brand:stackd:about`, `servd:home`. */
  pageSlug: string
  /** Brand pages: the brand (live row, or the API-down fallback record). */
  concept?: Concept
  /** Every live brand (servd tiles, cross-brand strips). */
  concepts: Concept[]
  /** True when served on the brand's own domain (stackd.pk) — links to servd
      pages must then be absolute. */
  onBrandHost?: boolean
  /** The route's own params when a page template serves many URLs
      (e.g. { loc: 'stackd-ittehad' } on /locations/[loc]). */
  params?: Record<string, string>
  /** The live brand kits — with the editor's DRAFT kit laid over its brand
      inside the editor frame (lib/brandKit.ts; sections/brand/kitImage.ts). */
  kits?: LiveKits
}

export interface SectionProps<F = Record<string, unknown>> {
  /** The block's fields merged over the spec's defaults. */
  fields: F
  ctx: SectionContext
  /** Block id — stable across renders; use it for DOM ids/anchors if needed. */
  id: string
}

export type SectionComponent = (props: SectionProps<any>) => ReactNode | Promise<ReactNode> // eslint-disable-line @typescript-eslint/no-explicit-any
