// Custom storefront pages built in Admin → Storefront → Pages, stored as the
// SiteLayout `page:<slug>` and served at /pages/<slug>. Only the approved
// (live) copy renders; nothing live → 404 (from generateMetadata too, so the
// status is a real 404).
//
// Search title/description: the page's own SEO settings (editor → Page),
// else its name and the first intro/body text it renders (hidden blocks
// skipped, the visitor's A/B variant — variant A for a crawler), else a
// sentence built from its name — never the site-wide description, which
// every page would then share. Canonical is servd's.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SERVD_ORIGIN, metaDescription, pageMetadata } from '../../../lib/brandDomains'
import { fetchSiteLayout, pageSeo, type Block } from '../../../lib/blocks'
import { mergeFields } from '../../../sections/catalog'
import { SiteLayoutView, resolveVariant } from '../../../components/blocks/SiteLayoutView'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string }> | { slug: string } }

/** Plain text of an owner-written field (markdown / tags stripped). */
function plain(v: unknown): string {
  return typeof v === 'string'
    ? v.replace(/<[^>]*>/g, ' ').replace(/[#*_`>\[\]]+/g, ' ').replace(/\(\s*https?:[^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
}

/** The first intro / body text the page renders — its natural description.
 *  Hidden blocks are skipped (the renderer skips them); columns are read
 *  left to right, as they render. */
function firstText(blocks: Block[]): string {
  for (const b of blocks) {
    if (!b || b.hidden) continue
    let text = ''
    if (b.type === 'hero' || b.type === 'banner') text = plain(b.subtitle)
    else if (b.type === 'text') text = plain(b.body)
    else if (b.type === 'section') {
      const f = mergeFields(b.variant, b.fields)
      text = plain(f['body']) || plain(f['intro']) || plain(f['subtitle']) || plain(f['overview'])
    } else if (b.type === 'columns' && Array.isArray(b.columns)) {
      for (const col of b.columns) {
        text = Array.isArray(col) ? firstText(col) : ''
        if (text) break
      }
    }
    if (text.length >= 40) return text
  }
  return ''
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const layout = await fetchSiteLayout(`page:${slug}`)
  if (!layout?.blocks?.length) notFound()
  const seo = pageSeo(layout)
  const name = layout.title?.trim() || slug.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  // The blocks this request renders: its A/B variant (no cookie → A).
  const derived = firstText(resolveVariant(layout).blocks)
  return pageMetadata({
    title:       seo.title ?? name,
    description: seo.description ?? (derived
      ? metaDescription(derived, 160)
      : metaDescription(`${name} — a page on servd, where you order from Karachi’s kitchens in one place and join Insiders for rewards on every order.`, 160)),
    canonical:   `${SERVD_ORIGIN}/pages/${slug}`,
  })
}

export default async function CustomPage({ params }: Params) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const layout = await fetchSiteLayout(`page:${slug}`)
  if (!layout?.blocks?.length) notFound()
  return <SiteLayoutView layout={layout} />
}
