// Brand About page — the SiteLayout `brand:<slug>:about`, edited in Admin →
// Storefront. Nothing published → the default sections (src/sections/brand:
// story hero, pillars, image break, call to action).
//
// Its own canonical (stackd.pk/about), title ("About · Stackd") and
// description (the story the page tells); a breadcrumb rooted at the brand's
// home; and an AboutPage node about the brand's Restaurant.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Breadcrumbs } from '../../../../components/Breadcrumbs'
import { brandCanonical } from '../../../../lib/brandDomains'
import { fetchSiteLayout, pageSeo } from '../../../../lib/blocks'
import { brandStory, brandSurface, formatBrandName } from '../../../../lib/concept'
import { jsonLdScript, restaurantId } from '../../../../lib/jsonLd'
import { fetchLiveConcepts, findConceptOrThrow, resolveConcept } from '../../../../lib/liveConcepts'
import { ManagedPage } from '../../../../sections/ManagedPage'
import { SUBPAGE_TITLE, brandCtx, brandPageMetadata, leadText, pageBlocks, type Params } from '../meta'

// force-dynamic + cache: 'no-store' so a single API outage at deploy
// time can't poison the ISR cache and return 404s for the lifetime of
// the container (see CLAUDE.md "Fetch caching gotcha").
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const pageSlug = `brand:${slug}:about`
  const [concept, layout] = await Promise.all([resolveConcept(slug), fetchSiteLayout(pageSlug)])
  if (!concept) notFound()

  const seo = pageSeo(layout)
  // The story the page tells: the story hero's text (empty = the brand's long
  // story, as the section renders it), else the first lead on the page.
  const blocks = pageBlocks(pageSlug, layout)
  const ctx = brandCtx(pageSlug, concept)
  const description = seo.description
    ?? (leadText(blocks, ctx, { variants: ['brand.aboutHero'], keys: ['body'] })
      || (blocks.some((b) => b.type === 'section' && b.variant === 'brand.aboutHero') ? brandStory(slug).long : '')
      || leadText(blocks, ctx, { min: 40 })
      || brandStory(slug).long)

  return brandPageMetadata({ concept, path: 'about', title: seo.title ?? SUBPAGE_TITLE.about, description })
}

export default async function BrandAboutPage({ params }: Params) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concepts = await fetchLiveConcepts()
  const concept = findConceptOrThrow(slug, concepts)
  if (!concept) notFound()

  const url = brandCanonical(slug, 'about')
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type':    'AboutPage',
      '@id':      `${url}#webpage`,
      url,
      name:       `${SUBPAGE_TITLE.about} · ${formatBrandName(concept.name)}`,
      inLanguage: 'en',
      about:      { '@id': restaurantId(slug) },
      isPartOf:   { '@id': `${brandCanonical(slug).replace(/\/+$/, '')}/#website` },
    },
  ]

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />
      <ManagedPage slug={`brand:${slug}:about`} {...(concepts.length ? { concepts } : {})} />
      {/* The visible trail sits under the page, above the footer (Apple-style):
          the top of every brand page is its own header — Flipd's is fixed and
          would sit on top of it. */}
      <Breadcrumbs color={brandSurface(slug).text} items={[
        { name: formatBrandName(concept.name), href: brandCanonical(slug) },
        { name: SUBPAGE_TITLE.about, href: url },
      ]} />
    </>
  )
}
