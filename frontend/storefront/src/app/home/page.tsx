// servd home page (/home — `/` and `/browse` redirect here). Every section on it
// is content (SiteLayout `servd:home`, Admin → Storefront, CEO-approved): the
// scroll-expansion hero, the kitchen tiles, how it works, Insiders, Visit and
// the waitlist strip. Nothing published → the catalogue's default sections,
// which are the page as designed. Anchors #kitchens / #insiders / #visit live
// on those sections.

import type { Metadata } from 'next'
import { SERVD_ORIGIN, brandCanonical, pageMetadata } from '../../lib/brandDomains'
import { fetchSiteLayout, pageSeo, type Block, type SiteLayoutRead } from '../../lib/blocks'
import { formatBrandName } from '../../lib/concept'
import { organizationSchema, websiteSchema, jsonLdScript } from '../../lib/jsonLd'
import { conceptsOrFallback, fetchLiveConcepts, inBrandOrder, joinNames } from '../../lib/liveConcepts'
import { mergeFields } from '../../sections/catalog'
import { ManagedPage } from '../../sections/ManagedPage'
import { HomeSearchParam } from '../../sections/servd/HomeSearchParam'

export const dynamic = 'force-dynamic'

const CANONICAL = `${SERVD_ORIGIN}/home`
const DESCRIPTION = 'One place to order from Simmer, Stackd, and Flipd. Explore the kitchens and join Insiders for rewards on every order.'

export async function generateMetadata(): Promise<Metadata> {
  const [layout, live] = await Promise.all([fetchSiteLayout('servd:home'), fetchLiveConcepts()])
  const seo = pageSeo(layout)
  // The home page's own title (no ' · servd' suffix — it leads with the
  // name), built from the live brand list in a fixed order (inBrandOrder —
  // the API's row order moves when a brand is edited, and the title must not
  // flip between requests). The editor's SEO title (Admin → Storefront →
  // servd:home → Page) wins and goes through the site template.
  const names = inBrandOrder(conceptsOrFallback(live)).map((c) => formatBrandName(c.name))
  const list = names.length > 0 && names.length <= 3 ? joinNames(names) : ''
  return pageMetadata({
    title:       seo.title ?? { absolute: list ? `servd — order ${list} online in Karachi` : 'servd — order from your favourite Karachi kitchens' },
    description: seo.description ?? DESCRIPTION,
    canonical:   CANONICAL,
  })
}

/** The servd footer's fields (live layout, else the section defaults) — the
 *  one place the company's legal name and contact email are edited. */
function footerFields(layout: SiteLayoutRead | null): Record<string, unknown> {
  const block = (layout?.blocks ?? []).find(
    (b: Block) => b.type === 'section' && b.variant === 'servd.footer',
  )
  return mergeFields('servd.footer', block && block.type === 'section' ? block.fields : undefined)
}

/** Legal name + email from the footer's Company lines: the mailto: line is the
 *  email, the line naming a company form (Pvt. Ltd., Limited…) the legal name. */
function companyFacts(fields: Record<string, unknown>): { legalName?: string; email?: string } {
  const lines = Array.isArray(fields['companyLines']) ? (fields['companyLines'] as unknown[]) : []
  let legalName: string | undefined
  let email: string | undefined
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue
    const text = typeof (raw as { text?: unknown }).text === 'string' ? (raw as { text: string }).text.trim() : ''
    const href = typeof (raw as { href?: unknown }).href === 'string' ? (raw as { href: string }).href.trim() : ''
    if (!email && /^mailto:/i.test(href)) email = href.replace(/^mailto:/i, '').split('?')[0]?.trim() || undefined
    else if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) email = text
    else if (!legalName && /\b(pvt|private|ltd|limited|llc|inc|plc)\b/i.test(text)) legalName = text
  }
  return { ...(legalName && { legalName }), ...(email && { email }) }
}

export default async function HomePage() {
  const [live, footer] = await Promise.all([
    fetchLiveConcepts(),
    fetchSiteLayout('servd:footer'),
  ])
  // Fixed order for the ItemList positions (the API's row order moves when a
  // brand is edited). The kitchen tiles on the page keep their own order.
  const brands = inBrandOrder(conceptsOrFallback(live))

  // JSON-LD: Organization (servd / GS Foods) + WebSite (search box) + the
  // kitchens as an ItemList of links to their own sites. Each brand's full
  // Restaurant node lives on its own domain; repeating it here only let two
  // copies of one entity drift apart.
  const schema = [
    organizationSchema({
      name:    'servd',
      url:     CANONICAL,
      logoUrl: `${SERVD_ORIGIN}/icon-512.png`,
      // servd has no social profiles of its own yet (the old entry was
      // Simmer's Instagram — a different entity).
      sameAs:  [],
      ...companyFacts(footerFields(footer)),
    }),
    websiteSchema(),
    {
      '@context': 'https://schema.org',
      '@type':    'ItemList',
      name:       'Kitchens on servd',
      // The summary-page form: each entry is the brand's own site, where its
      // full Restaurant node lives. A typed Restaurant item here would be
      // validated as a restaurant listing in its own right (address and all).
      itemListElement: brands.map((c, i) => ({
        '@type':  'ListItem',
        position: i + 1,
        name:     formatBrandName(c.name),
        url:      brandCanonical(c.slug),
      })),
    },
  ]

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schema) }} />
      {/* /home?q=… (the sitelinks search box above) opens the search sheet. */}
      <HomeSearchParam />
      <div className="sv-home">
        <ManagedPage slug="servd:home" {...(live.length > 0 && { concepts: live })} />
      </div>
    </>
  )
}
