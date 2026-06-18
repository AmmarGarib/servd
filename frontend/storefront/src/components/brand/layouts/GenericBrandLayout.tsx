'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { brandStory, conceptHeroImage, typeLabel, formatBrandName } from '../../../lib/concept'
import { PromoBar } from '../parts/PromoBar'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { BottomCTA } from '../parts/BottomCTA'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'

// Generic catch-all brand layout. Used for any concept slug that doesn't
// have its own dedicated layout. Mirrors HomeClient's section depth scoped
// per brand: hero, signatures, value props, story, reviews, mission strip,
// cross-brand discovery, bottom CTA. Brand colour drives the accent.

interface Props {
  concept: Concept
  concepts: Concept[]
}

const GENERIC_SIGNATURES: Array<{ name: string; price: string; emoji: string; note?: string }> = [
  { name: 'House Favourite', price: '—', emoji: '⭐',   note: 'Our most-ordered dish.' },
  { name: 'Chef’s Pick',     price: '—', emoji: '👨‍🍳', note: 'Try what the team eats.' },
  { name: 'Crowd Pleaser',   price: '—', emoji: '🤤',   note: 'Safe bet, big portions.' },
]

const GENERIC_REVIEWS = [
  { text: '"Direct from the kitchen — you can taste it. Hot, fresh, on time, every time."',                       name: 'A regular',     area: 'Karachi' },
  { text: '"One menu, one checkout, no fuss. Exactly how ordering should feel."',     name: 'A neighbour',   area: 'Karachi' },
  { text: '"The team behind servd actually cooks the food. It shows."',                                           name: 'A first-timer', area: 'Karachi' },
]

export function GenericBrandLayout({ concept, concepts }: Props) {
  const accent    = concept.primaryColor || 'var(--servd-green-dark)'
  const story     = brandStory(concept.slug)
  const heroImage = conceptHeroImage(concept)
  const hoursData = useHoursData(concept.slug)

  return (
    <div style={{ background: '#fff', color: 'var(--servd-ink)' }}>
      <PromoBar brandName={formatBrandName(concept.name)} brandSlug={concept.slug} accent={accent} />

      <section style={{
        position: 'relative',
        minHeight: 'min(78dvh, 680px)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        padding: 'clamp(2rem, 6vw, 4rem) 0',
        background: `linear-gradient(135deg, ${accent} 0%, ${accent}dd 60%, ${accent}aa 100%), url(${heroImage}) center/cover`,
        backgroundBlendMode: 'multiply',
        color: 'white',
        overflow: 'hidden',
        borderBottom: '1px solid var(--servd-line)',
      }}>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.32em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.78)', marginBottom: '0.85rem' }}>
            A servd kitchen · GS Foods · {typeLabel(concept.type)}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
            <h1 style={{
              fontSize: 'clamp(3rem, 9vw, 7rem)',
              fontWeight: 900,
              letterSpacing: '-0.05em',
              lineHeight: 0.92,
              margin: 0,
              maxWidth: '62rem',
            }}>
              {formatBrandName(concept.name)}.
            </h1>
            <OpenStatusBadge hoursData={hoursData} accentColor="var(--servd-green)" size="md" />
          </div>
          <p style={{ fontSize: 'clamp(1.15rem, 2vw, 1.6rem)', color: 'rgba(255,255,255,0.92)', maxWidth: '46rem', lineHeight: 1.4, fontWeight: 500 }}>
            {story.tagline}
          </p>
          <p style={{ marginTop: '0.6rem', fontSize: 'clamp(1rem, 1.5vw, 1.2rem)', color: 'rgba(255,255,255,0.78)', maxWidth: '46rem', lineHeight: 1.5 }}>
            {concept.description ?? story.oneLiner}
          </p>
          <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap', marginTop: '2.25rem' }}>
            <Link href={`/${concept.slug}`} style={{
              padding: 'clamp(1rem, 1.8vw, 1.2rem) clamp(2rem, 4vw, 2.6rem)',
              background: 'white', color: 'var(--servd-black)',
              fontWeight: 900, fontSize: 'clamp(1rem, 1.6vw, 1.15rem)',
              textDecoration: 'none', borderRadius: '999px',
              boxShadow: '0 16px 38px rgba(0,0,0,0.25)',
            }}>
              Order from {formatBrandName(concept.name)} →
            </Link>
            <Link href={`/brand/${concept.slug}/menu`} style={{
              padding: 'clamp(1rem, 1.8vw, 1.2rem) clamp(1.75rem, 3.2vw, 2.2rem)',
              background: 'rgba(255,255,255,0.14)',
              color: 'white', border: '1px solid rgba(255,255,255,0.4)',
              fontWeight: 700, fontSize: 'clamp(1rem, 1.6vw, 1.15rem)',
              textDecoration: 'none', borderRadius: '999px',
            }}>
              See full menu
            </Link>
          </div>
          <div style={{ marginTop: '3rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {story.highlights.map((h) => (
              <span key={h} style={{
                fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.06em',
                color: 'rgba(255,255,255,0.85)', padding: '0.4rem 0.8rem',
                borderRadius: '999px', background: 'rgba(0,0,0,0.18)',
                border: '1px solid rgba(255,255,255,0.2)',
              }}>{h}</span>
            ))}
          </div>
          {hoursData && hoursData.hours.length > 0 && (
            <div style={{ marginTop: '2rem' }}>
              <p style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginBottom: '0.6rem' }}>
                Hours (PKT)
              </p>
              <HoursGrid hoursData={hoursData} accentColor="var(--servd-green)" />
            </div>
          )}
        </div>
      </section>

      <section style={{ padding: 'clamp(2.5rem, 6vw, 5rem) 0', borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <p style={{ color: accent, fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            What we&rsquo;re known for
          </p>
          <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', letterSpacing: '-0.02em', marginBottom: '2rem' }}>
            Signature dishes
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
            {GENERIC_SIGNATURES.map((d) => (
              <div key={d.name} className="servd-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{
                  aspectRatio: '4/3',
                  background: `linear-gradient(135deg, ${accent} 0%, ${accent}cc 100%)`,
                  display: 'grid', placeItems: 'center', fontSize: '4rem',
                }}>
                  <span aria-hidden="true">{d.emoji}</span>
                </div>
                <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 800, letterSpacing: '-0.01em' }}>{d.name}</h3>
                    <p style={{ fontSize: '1rem', fontWeight: 800, color: accent, whiteSpace: 'nowrap' }}>{d.price}</p>
                  </div>
                  {d.note && <p style={{ color: 'var(--servd-mute)', fontSize: '0.88rem', lineHeight: 1.45 }}>{d.note}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ padding: 'clamp(2.5rem, 6vw, 5rem) 0', borderBottom: '1px solid var(--servd-line)', background: '#fafaf9' }}>
        <div className="container" style={{ maxWidth: '46rem' }}>
          <p style={{ color: accent, fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            The story
          </p>
          <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', letterSpacing: '-0.02em', marginBottom: '1.25rem' }}>
            Why {formatBrandName(concept.name)}?
          </h2>
          <p style={{ fontSize: '1.05rem', lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: story.long }}
          />
          <p style={{ fontSize: '1rem', lineHeight: 1.6, color: 'var(--servd-mute)', marginTop: '1rem' }}>
            Cooked fresh in our own kitchen — just food we&rsquo;d be happy to serve a friend.
          </p>
        </div>
      </section>

      <section style={{ padding: 'clamp(2.5rem, 6vw, 5rem) 0', borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <p style={{ color: accent, fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem', textAlign: 'center' }}>
            From your neighbours
          </p>
          <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', letterSpacing: '-0.02em', textAlign: 'center', marginBottom: '2.5rem' }}>
            <span style={{ color: accent }}>4.8 stars</span> from {formatBrandName(concept.name)} regulars
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
            {GENERIC_REVIEWS.map((r, i) => (
              <div key={i} className="servd-card" style={{ padding: '1.75rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ color: '#f59e0b', letterSpacing: '0.1em', fontSize: '0.95rem' }} aria-label="5 out of 5 stars">★★★★★</div>
                <p style={{ fontSize: '0.97rem', lineHeight: 1.55 }}>{r.text}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.5rem' }}>
                  <div style={{ width: '2.2rem', height: '2.2rem', borderRadius: '50%', background: `${accent}22`, color: accent, fontWeight: 800, display: 'grid', placeItems: 'center', fontSize: '0.85rem' }}>
                    {r.name[0]}
                  </div>
                  <div>
                    <p style={{ fontSize: '0.85rem', fontWeight: 700 }}>{r.name}</p>
                    <p style={{ fontSize: '0.78rem', color: 'var(--servd-mute)' }}>{r.area}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CrossBrandStrip current={concept} concepts={concepts} accent={accent} />
      <BottomCTA brandName={formatBrandName(concept.name)} brandSlug={concept.slug} accent={accent} />
    </div>
  )
}
