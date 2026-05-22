import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Concept } from '../../../../lib/concept'
import { brandStory, conceptHeroImage } from '../../../../lib/concept'

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcept(slug: string) {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { next: { revalidate: 60 } })
    if (!res.ok) return null
    const all: Concept[] = await res.json()
    return all.find((c) => c.slug === slug) ?? null
  } catch { return null }
}

export default async function BrandAboutPage({ params }: { params: Promise<{ slug: string }> | { slug: string } }) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concept = await getConcept(slug)
  if (!concept) notFound()

  const story = brandStory(slug)

  return (
    <>
      {/* Hero */}
      <section className="section" style={{ paddingTop: 'clamp(3rem, 7vw, 5rem)' }}>
        <div className="container-narrow" style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            About {concept.name}
          </p>
          <h1 style={{ fontSize: 'clamp(2.25rem, 6vw, 4rem)', marginBottom: '1.25rem' }}>
            {story.tagline}
          </h1>
          <p style={{ color: 'var(--servd-mute)', fontSize: 'clamp(1.05rem, 1.6vw, 1.2rem)', lineHeight: 1.6 }}>
            {story.long}
          </p>
        </div>
      </section>

      {/* Long-form pillars */}
      <section className="section" style={{ background: 'var(--servd-surface)' }}>
        <div className="container-narrow">
          <div style={{ display: 'grid', gap: '2.5rem' }}>
            {[
              {
                heading: 'Built in-house',
                body: `${concept.name} is a kitchen GS Foods owns and runs end-to-end — recipe to delivery. Nothing about your meal is outsourced, white-labelled, or aggregator-handled.`,
              },
              {
                heading: 'Direct ordering, no middlemen',
                body: 'When you order on servd, the kitchen sees your ticket directly. No 25% commission baked into the price. No "your order has been forwarded" status games. The kitchen fires it; we deliver it.',
              },
              {
                heading: 'One platform, every brand',
                body: 'Loyalty points, wallet credit, and saved addresses follow you across every GS Foods kitchen. Order Stax tonight, Strata tomorrow, Bukhari for Sunday lunch — same account, same payment, same tracker.',
              },
            ].map((p) => (
              <div key={p.heading}>
                <h2 style={{ fontSize: 'clamp(1.4rem, 2.5vw, 1.75rem)', marginBottom: '0.75rem' }}>{p.heading}</h2>
                <p style={{ color: 'var(--servd-mute)', fontSize: '1rem', lineHeight: 1.7 }}>{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Big image break */}
      <section style={{
        height: 'clamp(220px, 40vw, 420px)',
        background: `${concept.primaryColor ?? 'var(--servd-green-dark)'} url(${conceptHeroImage(concept)}) center/cover`,
      }} aria-hidden="true" />

      {/* CTA */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container-narrow">
          <h2 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.5rem)', marginBottom: '0.75rem' }}>
            Want to taste it?
          </h2>
          <p style={{ color: 'var(--servd-mute)', marginBottom: '2rem', maxWidth: '32rem', marginInline: 'auto' }}>
            The proof is in the food.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href={`/${concept.slug}`} className="servd-btn-primary" style={{ padding: '1rem 2.25rem' }}>
              Order from {concept.name} →
            </Link>
            <Link href={`/brand/${concept.slug}/menu`} className="servd-btn-secondary" style={{ padding: '1rem 2rem' }}>
              See the menu
            </Link>
          </div>
        </div>
      </section>
    </>
  )
}
