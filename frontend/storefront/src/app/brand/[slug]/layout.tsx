// Per-brand microsite layout. Hides the global servd nav/footer and renders
// a brand-themed shell instead — so each brand reads like its own website
// (it is served on its own domain: stackd.pk, simmer.pk, flipd.pk).
//
// The header and footer are content-module pages (`brand:<slug>:header`,
// `brand:<slug>:footer`), edited in Admin → Storefront; nothing published →
// the default `brand.header` / `brand.footer` sections (src/sections/brand).
//
// Resilient against api hiccups: if the live concepts fetch fails (api
// warmup, network blip), the known live brands fall back to their bundled
// records (lib/liveConcepts) so customers don't get a 404 wall. A slug that
// is not a brand is a real 404 (status and all — there is no loading
// boundary above this layout to send a 200 first).
//
// Metadata: this layout's is the brand HOME's — its title, description,
// canonical (the brand's own domain) and share card in the brand's name —
// plus the `%s · <Brand>` title template every other brand page uses. Each
// subpage sets its own canonical, title and description (./meta.ts).

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { brandCanonical, metaDescription } from '../../../lib/brandDomains'
import { BrandShell } from '../../../components/brand/BrandShell'
import { brandAccent, brandStory, formatBrandName, type Concept } from '../../../lib/concept'
import { fetchSiteLayout, pageSeo } from '../../../lib/blocks'
import { locationFromConcept } from '../../../lib/brandLocations'
import { fetchLiveConcepts, findConcept, resolveConcept } from '../../../lib/liveConcepts'
import { ManagedPage } from '../../../sections/ManagedPage'
import { brandHomeTitle, brandPageMetadata, type Params } from './meta'

export const dynamic = 'force-dynamic'

export default async function BrandLayout({
  children,
  params,
}: Params & { children: React.ReactNode }) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const live = await fetchLiveConcepts()
  const concept = findConcept(slug, live)
  if (!concept) notFound()

  const themed: Concept = { ...concept, primaryColor: brandAccent(concept.slug, concept.primaryColor) }
  // Hand ManagedPage the brands we already have (it falls back itself when
  // the list is empty).
  const known = live.length ? { concepts: live } : {}
  return (
    <BrandShell
      concept={themed}
      header={<ManagedPage slug={`brand:${slug}:header`} {...known} />}
      footer={<ManagedPage slug={`brand:${slug}:footer`} {...known} />}
    >
      {children}
    </BrandShell>
  )
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const [concept, layout] = await Promise.all([resolveConcept(slug), fetchSiteLayout(`brand:${slug}`)])
  // A real 404 for a slug that is not a brand (not a 200 "Not found" page).
  if (!concept) notFound()

  // Route the name through formatBrandName — the browser tab, search results,
  // and link previews are user-visible surfaces, so they get the canonical
  // capitalised name whatever case the DB row holds.
  const name = formatBrandName(concept.name)
  const seo = pageSeo(layout)
  // The brand home stands alone: "Stackd — café in DHA Phase 6, Karachi",
  // from the live cuisine and area (never a placeholder), not "Stackd · servd".
  const title = seo.title ?? brandHomeTitle(concept, locationFromConcept(concept))
  const description = seo.description ?? metaDescription(concept.description?.trim() || brandStory(slug).oneLiner)
  const meta = brandPageMetadata({ concept, path: '', title, description })
  return {
    ...meta,
    // Absolute, so the root '%s · servd' template stays off the brand's own
    // site; the template is for this brand's other pages.
    title: { absolute: title, template: `%s · ${name}` },
    // The canonical is the brand's OWN domain. This page is reachable at both
    // servd.pk/brand/flipd and flipd.pk/, and without this Google picks one
    // itself — which defeats the reason each brand owns a domain at all.
    alternates: { canonical: brandCanonical(slug) },
    openGraph: { ...meta.openGraph, title },
    twitter: { ...meta.twitter, title },
  }
}
