'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { conceptHeroImage, formatBrandName } from '../../../lib/concept'
import { KineticShape } from '../../kinetic/KineticShape'
import { MarqueeText } from '../../kinetic/MarqueeStrip'
import { DragRail } from '../../kinetic/DragRail'

// KineticBrandLayout — the shared design-system layout that every brand
// microsite uses. Per-brand identity comes from:
//   - concept.primaryColor (set on the BrandShell wrapper as --brand-accent)
//   - concept.name / description / hero image
//   - the per-brand voice line + emoji motif below (BRAND_VOICE)
//
// This replaces the old per-brand bespoke layouts (Stackd/Simmer/Flipd) as the
// default. Bespoke layouts still exist as files for future fine-tuning, but
// every brand currently inherits this kinetic structure so the customer
// experience is consistent across the three brands.

interface Props {
  concept:  Concept
  concepts: Concept[]
}

// Per-brand voice + signature emoji. The emoji floats in the hero as the
// playful 3D motif (no actual 3D asset needed). Brands not in this map fall
// through to a generic spotlight string + a plate emoji.
const BRAND_VOICE: Record<string, { voice: string; emoji: string; menuTeaser: string[] }> = {
  stackd: {
    voice: 'Smashed. Stacked. Sauced.',
    emoji: '🍔',
    menuTeaser: ['The Stackd Classic', 'Double Smash', 'Smoke Stack', 'Spicy Honey Crunch'],
  },
  simmer: {
    voice: 'Slow nights. Plated softly.',
    emoji: '🍲',
    menuTeaser: ['Slow-Roast Lamb', 'Khichdi Bowl', 'Daal Tadka', 'Saffron Pulao'],
  },
  flipd: {
    voice: 'Buttermilk-brined. Hand-breaded. Hot.',
    emoji: '🍗',
    menuTeaser: ['Hot Honey Tenders', 'Classic 3-Piece', 'Korean Glaze', 'Nashville Hot'],
  },
}

function voiceFor(slug: string) {
  return BRAND_VOICE[slug] ?? { voice: 'Direct from the kitchen.', emoji: '🍽️', menuTeaser: [] }
}

export function KineticBrandLayout({ concept, concepts }: Props) {
  const { voice, emoji, menuTeaser } = voiceFor(concept.slug)
  const heroImg = conceptHeroImage(concept)
  const accent = concept.primaryColor || 'var(--servd-green)'
  const otherBrands = concepts.filter((c) => c.slug !== concept.slug).slice(0, 3)

  return (
    <div>
      {/* ── HERO — black surface, asymmetric kinetic. Big chunky brand
            name in the brand's accent; floating shapes in the same accent
            keep the page rooted to the brand. ──────────────────────── */}
      <section className="surface-ink relative overflow-hidden"
        style={{ minHeight: 'min(92dvh, 880px)' }}>

        <KineticShape variant="blob"  size={460} style={{ top: '-15%', right: '-10%' }} />
        <KineticShape variant="blob"  size={280} style={{ bottom: '0%', left: '-8%' }} />
        <KineticShape variant="ring"  size={140} style={{ top: '20%', left: '8%' }} spin />
        <KineticShape variant="crisp" size={48}  style={{ bottom: '28%', right: '14%' }} />
        <KineticShape variant="emoji" emoji={emoji} size={200} style={{ top: '12%', right: '8%' }} />

        <div className="container relative z-10"
          style={{ paddingTop: 'clamp(4rem, 9vw, 7rem)', paddingBottom: 'clamp(4rem, 9vw, 7rem)' }}>

          <p className="eyebrow"
            style={{ color: 'var(--brand-accent)', marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
            on servd · {concept.name.toLowerCase()}
          </p>

          {/* Brand name as the typographic hero — chunky display weight. */}
          <h1 className="display"
            style={{
              fontSize: 'clamp(4rem, 14vw, 11rem)',
              color: 'white',
              maxWidth: '1200px',
              marginBottom: 'clamp(1.5rem, 3vw, 2rem)',
            }}>
            {concept.name}<span style={{ color: 'var(--brand-accent)' }}>.</span>
          </h1>

          <p className="display-italic"
            style={{
              fontSize: 'clamp(1.4rem, 3vw, 2.4rem)',
              color: 'rgba(255,255,255,0.8)',
              marginBottom: 'clamp(2.5rem, 5vw, 3.5rem)',
              maxWidth: '720px',
            }}>
            {voice}
          </p>

          {concept.description && (
            <p style={{
              fontSize: 'clamp(1rem, 1.5vw, 1.15rem)',
              color: 'rgba(255,255,255,0.6)',
              maxWidth: '560px',
              marginBottom: 'clamp(2.5rem, 4vw, 3rem)',
              lineHeight: 1.6,
            }}>
              {concept.description}
            </p>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.9rem' }}>
            <Link href={`/${concept.slug}`} className="brand-pill">
              Order from {concept.name} →
            </Link>
            <Link href={`/brand/${concept.slug}/menu`} className="brand-pill-outline">
              Browse the menu
            </Link>
          </div>
        </div>
      </section>

      {/* ── Marquee — keep the heartbeat going between sections, in the
            brand's accent. ───────────────────────────────────────── */}
      <MarqueeText
        items={[
          voice.replace(/\.$/, ''),
          `on servd`,
          `direct from the kitchen`,
          concept.name,
        ]}
        accent
        speed={28}
      />

      {/* ── EDITORIAL SLAB — big image + asymmetric copy. The image
            takes ~55% on desktop; copy fills the rest. ──────────── */}
      <section className="section" style={{ background: 'white' }}>
        <div className="container">
          <div className="asym-2 asym-2-flip" style={{ marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
            <p style={{ fontSize: 'clamp(1.05rem, 1.6vw, 1.2rem)', color: 'var(--servd-mute)', lineHeight: 1.6, maxWidth: '460px' }}>
              <span className="eyebrow eyebrow-accent" style={{ display: 'block', marginBottom: '0.5rem' }}>
                What we do
              </span>
              {formatBrandName(concept.name)} is one of three kitchens on the servd network. We focus on what we cook best — and let the other kitchens do the rest. Order from {formatBrandName(concept.name)} alone, or mix in dishes from simmer and Flipd. Same bag, same delivery.
            </p>
            <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)' }}>
              One kitchen.<br />
              <span className="display-italic" style={{ color: accent }}>Done properly.</span>
            </h2>
          </div>

          <div style={{
            position: 'relative',
            aspectRatio: '16 / 9',
            borderRadius: '1.5rem',
            overflow: 'hidden',
            background: accent,
            backgroundImage: heroImg ? `url(${heroImg})` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}>
            <KineticShape variant="crisp" size={120} color={accent} style={{ top: '8%', right: '8%' }} />
          </div>
        </div>
      </section>

      {/* ── MENU TEASER — drag rail of signature dishes (or a generic
            "come see the menu" CTA card if we don't have voice data). ── */}
      {menuTeaser.length > 0 && (
        <section className="section surface-warm">
          <div className="container" style={{ marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
            <p className="eyebrow eyebrow-accent">The lineup</p>
            <div className="asym-2">
              <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)' }}>
                What's good<br />
                <span className="display-italic">on the line.</span>
              </h2>
              <p style={{ color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '420px' }}>
                Signature dishes from the {concept.name} kitchen. The full menu lives behind the order page — these are the hits.
              </p>
            </div>
          </div>

          <DragRail>
            {menuTeaser.map((dish, i) => (
              <Link
                key={dish}
                href={`/${concept.slug}`}
                className="kinetic-card"
                style={{
                  width: 'min(320px, 75vw)',
                  background: '#0a0a0a',
                  color: 'white',
                  textDecoration: 'none',
                  padding: '1.5rem 1.5rem 1.75rem',
                  minHeight: '240px',
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                }}>
                <div>
                  <span className="eyebrow" style={{ color: accent }}>{String(i + 1).padStart(2, '0')}</span>
                  <h3 className="display" style={{
                    fontSize: 'clamp(1.6rem, 2.5vw, 2.1rem)',
                    color: 'white',
                    marginTop: '0.5rem',
                  }}>
                    {dish}
                  </h3>
                </div>
                <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }}>See on menu</span>
                  <span style={{
                    width: '2.4rem', height: '2.4rem',
                    background: accent, color: '#0a0a0a',
                    borderRadius: '999px',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 900, fontSize: '1.1rem',
                  }}>→</span>
                </div>
              </Link>
            ))}
          </DragRail>
        </section>
      )}

      {/* ── THE PLATFORM — cross-sells the other brands. Each card uses
            its own accent so the page acts as a hub for the network. ── */}
      {otherBrands.length > 0 && (
        <section className="section" style={{ background: 'white' }}>
          <div className="container" style={{ marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
            <p className="eyebrow eyebrow-accent">On servd</p>
            <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', maxWidth: '900px' }}>
              Every kitchen.<br />
              <span className="display-italic">One place.</span>
            </h2>
            <p style={{ marginTop: '1rem', color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '520px' }}>
              {concept.name} is one of the kitchens on servd. Explore the brands, order what you are craving, and check out once.
            </p>
          </div>

          <DragRail>
            {otherBrands.map((other) => {
              const ov = BRAND_VOICE[other.slug]
              const otherAccent = other.primaryColor || 'var(--servd-green)'
              return (
                <Link
                  key={other.slug}
                  href={`/brand/${other.slug}`}
                  className="kinetic-card"
                  style={{
                    width: 'min(380px, 80vw)',
                    background: '#0a0a0a',
                    color: 'white',
                    textDecoration: 'none',
                    ['--brand-accent' as string]: otherAccent,
                    ['--brand-ink' as string]:    '#0a0a0a',
                  }}>
                  <div style={{
                    position: 'relative',
                    aspectRatio: '4 / 5',
                    background: `linear-gradient(135deg, ${otherAccent}25, transparent 60%), #0a0a0a`,
                    overflow: 'hidden',
                  }}>
                    <KineticShape variant="blob"  size={280} color={otherAccent} style={{ top: '-10%', right: '-15%' }} />
                    <KineticShape variant="emoji" emoji={ov?.emoji ?? '🍽️'} size={150} style={{ bottom: '8%', right: '12%' }} />
                    <KineticShape variant="ring"  size={80} color={otherAccent} style={{ top: '20%', left: '14%' }} spin />
                    <div className="kinetic-arrow">→</div>
                    <div style={{ position: 'absolute', left: '1.5rem', bottom: '1.5rem', zIndex: 2 }}>
                      <p className="eyebrow" style={{ color: otherAccent, marginBottom: '0.5rem' }}>
                        also on servd
                      </p>
                      <h3 className="display" style={{ fontSize: 'clamp(2.2rem, 4vw, 3rem)', color: 'white' }}>
                        {other.name}
                      </h3>
                      <p style={{ marginTop: '0.5rem', color: 'rgba(255,255,255,0.7)', fontSize: '0.95rem' }}>
                        {ov?.voice ?? other.description ?? 'Direct from the kitchen.'}
                      </p>
                    </div>
                  </div>
                </Link>
              )
            })}
          </DragRail>
        </section>
      )}
    </div>
  )
}
