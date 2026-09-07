// Geo landing page — one per physical location.
//
// Per the local-seo skill: each physical location needs its own indexable
// page with H1 carrying the location, embedded Google Map, canonical NAP,
// hours, menu + reservation CTA. Avoids "thin location pages" by including
// the brand description + concept context + an embedded map.

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { addressLine, whatsappLink, fetchBrandLocations, LEGACY_LOCATION_SLUGS } from '../../../lib/brandLocations'
import { restaurantSchema, breadcrumbSchema, jsonLdScript } from '../../../lib/jsonLd'
import { brandStory } from '../../../lib/concept'

const SITE = 'https://servd-app.garibsons.app'
const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ loc: string }> }) {
  const { loc } = await params
  const brands = await fetchBrandLocations(API_URL)
  const want = LEGACY_LOCATION_SLUGS[loc] ?? loc
  const brand = Object.values(brands).find((b) => b.locationSlug === want || b.slug === want)
  if (!brand) return { title: 'Location not found' }
  return {
    title:       `${brand.name} · ${brand.area} · ${brand.city}`,
    description: `Visit ${brand.name} at ${addressLine(brand)}. ${brand.cuisine}. ${brand.acceptsReservations ? 'Reservations available.' : 'Walk-in friendly.'}`,
    alternates:  { canonical: `${SITE}/locations/${loc}` },
  }
}

export default async function LocationPage({ params }: { params: Promise<{ loc: string }> }) {
  const { loc: locSlug } = await params
  const brands = await fetchBrandLocations(API_URL)
  // Match by locationSlug first (operator-friendly URL like
  // /locations/ittehad-commercial), fall back to concept slug
  // (/locations/simmer) so freshly-added concepts work without a custom
  // locationSlug field in the DB.
  // A retired slug (e.g. bukhari-commercial, still on old links/GBP) resolves
  // to its brand rather than 404ing.
  const wantSlug = LEGACY_LOCATION_SLUGS[locSlug] ?? locSlug
  const brand = Object.values(brands).find((b) => b.locationSlug === wantSlug || b.slug === wantSlug)
  if (!brand) notFound()
  const story = brandStory(brand.slug)
  const mapsQuery = encodeURIComponent(`${brand.name} ${brand.area} ${brand.city}`)

  const schemaGraph = [
    restaurantSchema({
      loc:         brand,
      description: story.tagline,
    }),
    breadcrumbSchema([
      { name: 'servd',         url: `${SITE}/` },
      { name: brand.name,      url: `${SITE}/brand/${brand.slug}` },
      { name: brand.area,      url: `${SITE}/locations/${brand.locationSlug}` },
    ]),
  ]

  return (
    <main style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)', minHeight: '100dvh' }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(schemaGraph) }} />

      <section className="section" style={{ paddingTop: 'clamp(4rem, 8vw, 6rem)', paddingBottom: 'clamp(2rem, 4vw, 3rem)' }}>
        <div className="container">
          <p className="eyebrow eyebrow-accent">{brand.city} · {brand.area.split(',').slice(-1)[0]?.trim()}</p>
          <h1 className="display" style={{ fontSize: 'clamp(2.5rem, 7vw, 5rem)', maxWidth: '900px', margin: '0.5rem 0 1rem', letterSpacing: '-0.04em' }}>
            {brand.name} · {brand.area}
          </h1>
          <p style={{ color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '36rem', lineHeight: 1.55 }}>
            {story.tagline}
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0, paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
          {/* NAP card */}
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>Find us</p>
            <p style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.25rem' }}>{addressLine(brand)}</p>
            {!brand.street.startsWith('TODO') && (
              <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', marginBottom: '1rem' }}>{brand.street}</p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '1rem' }}>
              <a href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`}
                target="_blank" rel="noopener noreferrer"
                className="brand-pill"
                style={{ background: 'var(--servd-green)', color: 'white' }}>
                Open in Maps →
              </a>
              <a href={`tel:${brand.phone.replace(/\s/g, '')}`}
                className="brand-pill"
                style={{ background: 'var(--servd-surface)', color: 'var(--servd-ink)', border: '1px solid var(--servd-line)' }}>
                Call
              </a>
              <a href={whatsappLink(brand, `hi ${brand.name.toLowerCase()}`)}
                target="_blank" rel="noopener noreferrer"
                className="brand-pill"
                style={{ background: '#25D366', color: 'white' }}>
                WhatsApp
              </a>
            </div>
          </div>

          {/* Actions card */}
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <p className="eyebrow" style={{ marginBottom: '0.5rem' }}>Visit</p>
            <p style={{ fontSize: '0.95rem', color: 'var(--servd-mute)', lineHeight: 1.5, marginBottom: '1rem' }}>
              {brand.acceptsReservations
                ? `${brand.name} takes reservations — secure your table or browse the current menu.`
                : `${brand.name} is walk-in friendly. Order ahead for pickup, curbside, or delivery.`}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              <Link href={`/brand/${brand.slug}/menu`} className="brand-pill" style={{ background: 'var(--servd-ink)', color: 'white' }}>
                See the menu →
              </Link>
              {brand.acceptsReservations && (
                <Link href={`/reserve/${brand.slug}`} className="brand-pill" style={{ background: 'var(--servd-surface)', color: 'var(--servd-ink)', border: '1px solid var(--servd-line)' }}>
                  Book a table
                </Link>
              )}
              <Link href={`/${brand.slug}`} className="brand-pill" style={{ background: 'var(--servd-surface)', color: 'var(--servd-ink)', border: '1px solid var(--servd-line)' }}>
                Order now
              </Link>
            </div>
          </div>
        </div>

        {/* Embedded Google map */}
        <div className="container" style={{ marginTop: '2rem' }}>
          <div style={{ aspectRatio: '16/9', borderRadius: '1rem', overflow: 'hidden', border: '1px solid var(--servd-line)' }}>
            <iframe
              src={`https://www.google.com/maps?q=${mapsQuery}&output=embed`}
              width="100%" height="100%" style={{ border: 0 }}
              loading="lazy" referrerPolicy="no-referrer-when-downgrade"
              title={`${brand.name} on Google Maps`}
            />
          </div>
        </div>
      </section>
    </main>
  )
}
