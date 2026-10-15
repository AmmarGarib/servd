// The whole section catalogue (data only). Served to the admin editor by
// /api/storefront-sections and used by the storefront to render pages that
// have nothing published.

import type { PageDefault, SectionSpec } from './types'
import * as servd from './servd/catalog'
import * as brand from './brand/catalog'
import * as stackd from './stackd/catalog'
import * as simmer from './simmer/catalog'
import * as flipd from './flipd/catalog'
import * as legal from './legal/catalog'

const GROUPS = [servd, brand, stackd, simmer, flipd, legal]

export const SECTION_SPECS: SectionSpec[] = GROUPS.flatMap((g) => g.specs)
export const PAGE_DEFAULTS: PageDefault[] = GROUPS.flatMap((g) => g.pages)

const BY_VARIANT = new Map(SECTION_SPECS.map((s) => [s.variant, s]))

export function sectionSpec(variant: string): SectionSpec | undefined {
  return BY_VARIANT.get(variant)
}

/** A slug pattern (`brand:*:about`, `servd:*`, `*`) matches a slug. */
export function slugMatches(pattern: string, slug: string): boolean {
  if (pattern === '*' || pattern === slug) return true
  const p = pattern.split(':')
  const s = slug.split(':')
  if (p.length !== s.length) return false
  return p.every((part, i) => part === '*' || part === s[i])
}

/** The default composition for a page: exact slug first, then a pattern. */
export function pageDefault(slug: string): PageDefault | undefined {
  return PAGE_DEFAULTS.find((p) => p.slug === slug)
    ?? PAGE_DEFAULTS.find((p) => p.slug !== slug && slugMatches(p.slug, slug))
}

/** The section's fields merged over its spec's defaults (shallow). */
export function mergeFields(variant: string, fields: unknown): Record<string, unknown> {
  const spec = sectionSpec(variant)
  const own = fields && typeof fields === 'object' && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {}
  const out: Record<string, unknown> = { ...(spec?.defaults ?? {}) }
  for (const [k, v] of Object.entries(own)) if (v !== undefined && v !== null) out[k] = v
  return out
}
