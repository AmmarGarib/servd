// The fields of ONE section on a managed page, for words a route renders
// outside the page builder (the reserve intro on /reserve/<brand>, the cookie
// notice). The live published layout's first section of that variant, else
// the page's default section, merged over the spec defaults (mergeFields) —
// so with nothing published the words are the spec defaults, and once the
// owner edits that section in Admin → Storefront and the CEO publishes it,
// the edit shows here too. API down → the defaults.

import { fetchSiteLayout, type Block } from '../lib/blocks'
import { mergeFields, pageDefault } from './catalog'

function findSection(blocks: Block[] | null | undefined, variant: string): Record<string, unknown> | null {
  for (const b of blocks ?? []) {
    if (!b || b.hidden) continue
    if (b.type === 'section' && b.variant === variant) return (b.fields ?? {}) as Record<string, unknown>
    if (b.type === 'columns' && Array.isArray(b.columns)) {
      for (const col of b.columns) {
        const hit = Array.isArray(col) ? findSection(col as Block[], variant) : null
        if (hit) return hit
      }
    }
  }
  return null
}

export async function liveSectionFields(slug: string, variant: string): Promise<Record<string, unknown>> {
  const layout = await fetchSiteLayout(slug)
  const live = findSection(layout?.blocks, variant)
  if (live) return mergeFields(variant, live)
  const def = pageDefault(slug)?.sections.find((s) => s.variant === variant)
  return mergeFields(variant, def?.fields)
}
