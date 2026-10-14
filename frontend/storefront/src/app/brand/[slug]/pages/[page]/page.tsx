// Pages the owner adds to a brand in Admin → Storefront ("New page" under the
// brand). SiteLayout `brand:<slug>:<page>`, served at /brand/<slug>/pages/<page>
// and on the brand's own domain at /pages/<page> (middleware rewrite). Only
// the approved copy renders; nothing live → a real 404 (from generateMetadata
// too, so the status is 404, not a 200 page that says so).
//
// Its own canonical (stackd.pk/pages/<page>), title ("<Page> · Stackd") and
// description: the page's SEO settings, else its editor title and its first
// intro / body text.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchSiteLayout, pageSeo } from '../../../../../lib/blocks'
import { formatBrandName } from '../../../../../lib/concept'
import { jsonLdScript } from '../../../../../lib/jsonLd'
import { asSentence, fitSentences, resolveConcept } from '../../../../../lib/liveConcepts'
import { ManagedPage } from '../../../../../sections/ManagedPage'
import { brandBreadcrumb, brandCtx, brandPageMetadata, leadText, pageBlocks } from '../../meta'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string; page: string }> | { slug: string; page: string } }

// The brand's chrome and fixed pages are SiteLayouts under the same key
// shape; /pages/<one of these> would serve the header as a page, or a second
// copy of /menu, /about or /visit. `kit` is the brand kit (colours, fonts,
// images), never a page.
const RESERVED = new Set(['header', 'footer', 'menu', 'about', 'visit', 'kit'])

/** The page's live layout, or a 404. */
async function livePage(slug: string, page: string) {
  if (RESERVED.has(page.toLowerCase())) notFound()
  const layout = await fetchSiteLayout(`brand:${slug}:${page}`)
  if (!layout?.blocks?.length) notFound()
  return layout
}

/** "summer-menu" → "Summer menu". */
const humanise = (s: string) => s.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, page } = await Promise.resolve(params as Promise<{ slug: string; page: string }>)
  const [concept, layout] = await Promise.all([resolveConcept(slug), livePage(slug, page)])
  if (!concept) notFound()
  const pageSlug = `brand:${slug}:${page}`
  const seo = pageSeo(layout)
  const title = seo.title ?? (layout.title?.trim() || humanise(page))
  const lead = leadText(pageBlocks(pageSlug, layout), brandCtx(pageSlug, concept), { min: 40 })
  const description = seo.description
    ?? (lead || fitSentences([`${title} — ${formatBrandName(concept.name)}.`, asSentence(concept.description)], 155))
  return brandPageMetadata({ concept, path: `pages/${page}`, title, description })
}

export default async function BrandCustomPage({ params }: Params) {
  const { slug, page } = await Promise.resolve(params as Promise<{ slug: string; page: string }>)
  const [concept, layout] = await Promise.all([resolveConcept(slug), livePage(slug, page)])
  if (!concept) notFound()
  const title = pageSeo(layout).title ?? (layout.title?.trim() || humanise(page))
  const ld = brandBreadcrumb(concept, title, `pages/${page}`)
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <ManagedPage slug={`brand:${slug}:${page}`} layout={layout} notFoundWhenEmpty />
    </>
  )
}
