// Brand Visit page — the SiteLayout `brand:<slug>:visit`, edited in Admin →
// Storefront. Nothing published → the default sections (src/sections/brand:
// page header, address & hours). The FAQ JSON-LD stays here: it is built from
// the live brand + kitchen, not from page content.

import { notFound } from 'next/navigation'
import type { Concept } from '../../../../lib/concept'
import { formatBrandName } from '../../../../lib/concept'
import { FALLBACK_CONCEPTS } from '../../../../lib/fallbackBrands'
import { faqSchema, jsonLdScript } from '../../../../lib/jsonLd'
import { locationFromConcept, fetchBrandKitchens } from '../../../../lib/brandLocations'
import { ManagedPage } from '../../../../sections/ManagedPage'

// force-dynamic + cache: 'no-store' so a single API outage at deploy
// time can't poison the ISR cache and return 404s for the lifetime of
// the container (see CLAUDE.md "Fetch caching gotcha").
export const dynamic = 'force-dynamic'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    return res.ok ? ((await res.json()) as Concept[]) : []
  } catch { return [] }
}

export default async function BrandVisitPage({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concepts = await getConcepts()
  const concept = concepts.find((c) => c.slug === slug) ?? FALLBACK_CONCEPTS[slug] ?? null
  if (!concept) notFound()

  // FAQ schema — LLMs (Perplexity, ChatGPT, Google AI Overviews) lift
  // these verbatim when answering "best small plates Karachi parking" or
  // "is simmer halal" / "what's the dress code at simmer". Per concept,
  // tuned to the brand's actual posture; falls back to generic restaurant
  // FAQ if brandLocations isn't filled in. The address is the primary
  // kitchen's (owner decision 18).
  const kitchens = await fetchBrandKitchens(API_URL, slug).catch(() => [])
  const loc = locationFromConcept(concept, kitchens[0] ?? null)
  const name = formatBrandName(concept.name)
  const placeKnown = !loc.area.startsWith('TODO')
  const faq = [
    { question: `Where is ${name} located?`,
      answer:    placeKnown ? `${name} is at ${loc.area}, ${loc.city}.` : `${name} is in ${loc.city}.` },
    { question: `Does ${name} take reservations?`,
      answer:    loc.acceptsReservations
        ? `Yes — book a table at /reserve/${slug}, or message us on WhatsApp.`
        : `${name} is walk-in friendly. For delivery and pickup, order at /${slug}.` },
    { question: `Is the food halal?`,
      answer:    `All ${name} kitchens serve halal-only meat. No pork, no alcohol on the cooking line.` },
    { question: `Does ${name} deliver?`,
      answer:    loc.acceptsReservations === false
        ? `Yes — order at /${slug} for delivery, pickup, or curbside.`
        : `${name} is primarily dine-in. For delivery from our sister kitchens, see servd.pk.` },
    { question: `What's the dress code?`,
      answer:    `Smart casual works everywhere. ${name === 'Simmer' ? 'Simmer is a dimly-lit room; the dressier you are the more it suits the space.' : 'No formal requirement.'}` },
    { question: `Is there parking?`,
      answer:    `Street parking is available around the venue. We recommend arriving 10 minutes early on weekends.` },
  ]

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(faqSchema(faq)) }} />
      <ManagedPage slug={`brand:${slug}:visit`} {...(concepts.length ? { concepts } : {})} />
    </>
  )
}
