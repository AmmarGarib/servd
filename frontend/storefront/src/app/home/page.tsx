// servd home page, served at servd.pk/ (app/page.tsx re-exports it; /home and /browse redirect to /). Every section on it
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
import { profileUrl } from '../../lib/brandLocations'
import { conceptsOrFallback, fetchLiveConcepts, inBrandOrder, joinNames } from '../../lib/liveConcepts'
import { mergeFields } from '../../sections/catalog'
import { ManagedPage } from '../../sections/ManagedPage'
import { PageSurface } from '../../sections/pageSurface'
import { HomeSearchParam } from '../../sections/servd/HomeSearchParam'

export const dynamic = 'force-dynamic'

const CANONICAL = `${SERVD_ORIGIN}/`
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
function companyFacts(fields: Record<string, unknown>): { legalName?: string; email?: string; telephone?: string } {
  const lines = Array.isArray(fields['companyLines']) ? (fields['companyLines'] as unknown[]) : []
  let legalName: string | undefined
  let email: string | undefined
  let telephone: string | undefined
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue
    const text = typeof (raw as { text?: unknown }).text === 'string' ? (raw as { text: string }).text.trim() : ''
    const href = typeof (raw as { href?: unknown }).href === 'string' ? (raw as { href: string }).href.trim() : ''
    if (!email && /^mailto:/i.test(href)) email = href.replace(/^mailto:/i, '').split('?')[0]?.trim() || undefined
    else if (!telephone && /^tel:/i.test(href)) telephone = href.replace(/^tel:/i, '').trim() || undefined
    else if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) email = text
    else if (!legalName && /\b(pvt|private|ltd|limited|llc|inc|plc)\b/i.test(text)) legalName = text
  }
  return { ...(legalName && { legalName }), ...(email && { email }), ...(telephone && { telephone }) }
}

// Hosts that are a profile OF servd (not a page about it): a footer link to one
// of these is one of servd's own profiles.
const PROFILE_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.com|tiktok\.com|youtube\.com|linkedin\.com|x\.com|twitter\.com|threads\.net|g\.page|business\.google\.com)$/i

/**
 * servd's OWN profiles for the Organization's sameAs. servd has no brand
 * record (its brands do — Concept.sameAs), so they are edited where the
 * company's other facts are: the servd footer (Admin → Storefront →
 * servd:footer, CEO-approved). Read from its `socialProfiles` list when the
 * section has one, and from any footer link (customer links, company lines)
 * that points at a profile host — add "Instagram → https://instagram.com/…"
 * as a company line and it is published here. A brand's profile linked from
 * servd's footer would be read too, so keep those off the footer.
 */
function servdProfiles(fields: Record<string, unknown>): string[] {
  const out: string[] = []
  const add = (v: unknown) => {
    const u = profileUrl(v)
    if (u && !out.includes(u)) out.push(u)
  }
  const profiles = Array.isArray(fields['socialProfiles']) ? (fields['socialProfiles'] as unknown[]) : []
  for (const p of profiles) add(typeof p === 'string' ? p : (p && typeof p === 'object' ? (p as { href?: unknown }).href : ''))
  for (const key of ['customerLinks', 'companyLines']) {
    const list = Array.isArray(fields[key]) ? (fields[key] as unknown[]) : []
    for (const raw of list) {
      const href = raw && typeof raw === 'object' ? profileUrl((raw as { href?: unknown }).href) : ''
      if (!href) continue
      try { if (PROFILE_HOSTS.test(new URL(href).hostname)) add(href) } catch { /* not a URL */ }
    }
  }
  return out.slice(0, 12)
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
      // The logo shown top-left on every servd page (CLAUDE.md).
      logoUrl: `${SERVD_ORIGIN}/brand/servd-logo.png`,
      // servd's own profiles only, from the servd footer (servdProfiles) —
      // never a brand's (those are on each brand's Restaurant node).
      sameAs:  servdProfiles(footerFields(footer)),
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
      <PageSurface slug="servd:home">
        <ManagedPage slug="servd:home" {...(live.length > 0 && { concepts: live })} />
      </PageSurface>
    </>
  )
}
