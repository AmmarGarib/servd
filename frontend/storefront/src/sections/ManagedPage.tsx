// Renders a storefront page from the content module: the published layout
// (SiteLayout `slug`) when there is one, otherwise the page's default sections
// from the catalogue — which are the page's design with today's content. So a
// page looks the same before and after the owner first edits it.

import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { fetchSiteLayout, type Block, type SiteLayoutRead } from '../lib/blocks'
import { brandAccent, formatBrandName, type Concept } from '../lib/concept'
import type { LiveKits } from '../lib/brandKit'
import { getLiveKits } from '../lib/brandKitFetch'
import { FALLBACK_CONCEPTS } from '../lib/fallbackBrands'
import { BRAND_HOST_HEADER } from '../lib/brandDomains'
import { SiteLayoutView } from '../components/blocks/SiteLayoutView'
import { PageRenderer, type EditorMarker, type RenderContext } from '../components/blocks/PageRenderer'
import { pageDefault } from './catalog'
import type { SectionContext } from './types'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function liveConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    return res.ok ? ((await res.json()) as Concept[]) : []
  } catch { return [] }
}

/** `brand:<slug>:kit` is a brand's kit (Admin → Storefront → Brand kit),
 *  never a page: nothing renders for it. */
export const isKitSlug = (slug: string): boolean => /^brand:[^:]+:kit$/i.test(slug)

/** The brand a `brand:<slug>[:…]` page is about (live, else the fallback),
 *  its primaryColor set to the brand kit's accent. */
function brandOf(slug: string, concepts: Concept[], kits?: LiveKits): Concept | undefined {
  const m = /^brand:([^:]+)/.exec(slug)
  if (!m) return undefined
  const found = concepts.find((c) => c.slug === m[1]) ?? (Object.prototype.hasOwnProperty.call(FALLBACK_CONCEPTS, m[1]!) ? FALLBACK_CONCEPTS[m[1]!] : undefined)
  return found ? { ...found, primaryColor: brandAccent(found.slug, found.primaryColor, kits) } : undefined
}

/** Everything a section on `slug` renders against. `kits` overrides the live
 *  brand kits (the editor frame's draft kit). */
export async function sectionContextFor(slug: string, known?: { concepts?: Concept[]; params?: Record<string, string>; kits?: LiveKits }): Promise<SectionContext> {
  const [fetched, kits] = await Promise.all([
    known?.concepts ? Promise.resolve(known.concepts) : liveConcepts(),
    known?.kits ? Promise.resolve(known.kits) : getLiveKits(),
  ])
  const concepts = fetched.length ? fetched : Object.values(FALLBACK_CONCEPTS)
  const concept = brandOf(slug, concepts, kits)
  let onBrandHost = false
  try { onBrandHost = !!headers().get(BRAND_HOST_HEADER) } catch { /* outside a request */ }
  return { pageSlug: slug, concepts, onBrandHost, kits, ...(concept && { concept }), ...(known?.params && { params: known.params }) }
}

export function renderContextFor(sctx: SectionContext): RenderContext {
  const c = sctx.concept
  return {
    section: sctx,
    ...(c && {
      conceptSlug: c.slug,
      brand: { name: formatBrandName(c.name), description: c.description, primaryColor: c.primaryColor, slug: c.slug },
    }),
  }
}

/** The default blocks for a page (empty when the page has no default). */
export function defaultBlocks(slug: string): Block[] {
  const def = pageDefault(slug)
  if (!def) return []
  return def.sections.map((s, i) => ({
    id: `${s.variant}-${i}`,
    type: 'section' as const,
    variant: s.variant,
    ...(s.fields && { fields: s.fields }),
  }))
}

interface Props {
  slug: string
  /** Pre-fetched live brands, to save a request when the route has them. */
  concepts?: Concept[]
  /** No published layout and no default → 404 (custom pages). */
  notFoundWhenEmpty?: boolean
  /** Render this layout instead of the published one (draft preview). */
  layout?: SiteLayoutRead
  previewVariant?: 'a' | 'b'
  /** Route params for a template page (see SectionContext.params). */
  params?: Record<string, string>
  /** The editor frame (/editor-frame) only: mark the given layout's blocks
      for selection. The page-default branch never gets markers — its ids are
      not the editor's. */
  editor?: boolean
  /** The frame's per-block marker component (see RenderContext.editorMarker). */
  editorMarker?: EditorMarker
  /** Brand kits to theme with instead of the live ones (editor frame preview). */
  kits?: LiveKits
}

export async function ManagedPage({ slug, concepts, notFoundWhenEmpty, layout: given, previewVariant, params, editor, editorMarker, kits }: Props) {
  if (isKitSlug(slug)) {
    if (notFoundWhenEmpty) notFound()
    return null
  }
  const [layout, sctx] = await Promise.all([
    given ? Promise.resolve(given) : fetchSiteLayout(slug),
    sectionContextFor(slug, { ...(concepts && { concepts }), ...(params && { params }), ...(kits && { kits }) }),
  ])
  const context = renderContextFor(sctx)
  if (layout?.blocks?.length) {
    const ctx: RenderContext = editor ? { ...context, editor: true, ...(editorMarker && { editorMarker }) } : context
    return <SiteLayoutView layout={layout} context={ctx} {...(previewVariant && { previewVariant })} />
  }
  const blocks = defaultBlocks(slug)
  if (!blocks.length) {
    if (notFoundWhenEmpty) notFound()
    return null
  }
  return <PageRenderer blocks={blocks} context={context} />
}
