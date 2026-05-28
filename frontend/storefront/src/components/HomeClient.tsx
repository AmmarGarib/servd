'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Concept } from '../lib/concept'
import { brandAccent, brandStory, conceptHeroImage } from '../lib/concept'
import { MarqueeText } from './kinetic/MarqueeStrip'
import { useScrollReveal } from './kinetic/motionHooks'

// servd home — the FOOD hub. Not an aggregator directory. Not an
// informational site. The page is about getting you to your next meal
// in as few taps as possible.
//
// Brand palette: --servd-* tokens are deep royal blue across the
// storefront. Per-brand pages still inherit their own per-brand
// accent (Simmer forest green, Stax purple, Flipd sky blue).

interface Props {
  concepts: Concept[]
}

export function HomeClient({ concepts }: Props) {
  const brands = concepts
    .filter((c) => ['simmer', 'stax', 'flipd'].includes(c.slug))
    .sort((a, b) => ['stax', 'simmer', 'flipd'].indexOf(a.slug) - ['stax', 'simmer', 'flipd'].indexOf(b.slug))
    .map((c) => ({
      ...c,
      accent: brandAccent(c.slug, c.primaryColor),
      story:  brandStory(c.slug),
      img:    conceptHeroImage(c),
    }))

  // Hero spotlight cycles through brand photographs every 3s — the
  // page leads with FOOD, not branding. The wash stays royal so the
  // platform identity reads as the dominant surface.
  const [activeIdx, setActiveIdx] = useState(0)
  useEffect(() => {
    if (brands.length === 0) return
    const t = setInterval(() => setActiveIdx((i) => (i + 1) % brands.length), 3200)
    return () => clearInterval(t)
  }, [brands.length])
  const live = brands[activeIdx] ?? null

  const pageRef = useScrollReveal<HTMLDivElement>()

  return (
    <div ref={pageRef} style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}>

      {/* ── HERO ─ Deep royal blue. Cycling food photography behind the
            wordmark. ONE primary CTA: order now. */}
      <section className="relative overflow-hidden"
        style={{
          background: 'var(--servd-green)',
          color: 'white',
          minHeight: 'min(100vh, 920px)',
          display: 'flex', alignItems: 'stretch',
        }}>

        {live && (
          <div aria-hidden style={{
            position: 'absolute', inset: 0, zIndex: 0,
            backgroundImage: `url(${live.img})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            opacity: 0.32, transition: 'background-image 800ms ease-in-out',
            mixBlendMode: 'luminosity',
          }} />
        )}

        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 1,
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--servd-green) 60%, transparent) 0%, color-mix(in srgb, var(--servd-green) 88%, transparent) 60%, var(--servd-green-dark) 100%)',
        }} />

        <div className="container relative z-10" style={{
          paddingTop: 'clamp(4rem, 9vw, 7rem)',
          paddingBottom: 'clamp(4rem, 9vw, 7rem)',
          display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 'clamp(3rem, 8vw, 5rem)',
        }}>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
            <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.75)' }}>
              servd · the kitchen, direct
            </p>
            <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.55)' }}>
              Karachi · {brands.length || 'three'} kitchens
            </p>
          </div>

          <div>
            <h1 className="display" style={{
              fontSize: 'clamp(3.5rem, 11vw, 9rem)',
              color: 'white',
              maxWidth: '1100px',
              lineHeight: 0.95,
              letterSpacing: '-0.045em',
              margin: 0,
            }}>
              Cooked&nbsp;tonight.<br />
              <span className="display-italic" style={{ color: 'rgba(255,255,255,0.7)' }}>At your door.</span>
            </h1>
            <p style={{ marginTop: '1.75rem', fontSize: 'clamp(1.1rem, 1.8vw, 1.45rem)', color: 'rgba(255,255,255,0.85)', maxWidth: '40rem', lineHeight: 1.4 }}>
              Three kitchens. One bag. No aggregator markup. Order direct from the people who cook the food.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
              <Link href="/browse" style={{
                background: 'white',
                color: 'var(--servd-green)',
                fontFamily: 'var(--font-display)', fontWeight: 800,
                fontSize: 'clamp(1rem, 1.4vw, 1.15rem)',
                padding: '1.1rem 2rem',
                borderRadius: '999px',
                textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', gap: '0.6rem',
                boxShadow: '0 12px 32px rgba(0,0,0,0.22)',
              }}>
                Order now <span aria-hidden style={{ opacity: 0.65 }}>→</span>
              </Link>
              <Link href="#brands" style={{
                color: 'rgba(255,255,255,0.85)', fontWeight: 700, fontSize: '0.95rem',
                padding: '1.1rem 1.5rem', borderRadius: '999px',
                border: '1px solid rgba(255,255,255,0.3)',
                textDecoration: 'none',
              }}>
                See the kitchens
              </Link>
            </div>

            {live && (
              <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.95rem', fontWeight: 500 }}>
                <span style={{ color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.2em', fontSize: '0.7rem', marginRight: '0.65rem' }}>Tonight from</span>
                <Link href={`/${live.slug}`} style={{ color: 'white', fontWeight: 800, textDecoration: 'none', borderBottom: '2px solid rgba(255,255,255,0.4)', paddingBottom: '0.1rem' }}>
                  {live.name}
                </Link>
                <span style={{ marginLeft: '0.75rem', opacity: 0.75 }}>— {live.story.tagline}</span>
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── MARQUEE divider ── */}
      <MarqueeText
        items={[
          'three kitchens',
          'one bag',
          'no markup',
          'cooked tonight',
          'karachi-built',
        ]}
        accent
      />

      {/* ── BRAND CARDS ─ Big, food-led, single-click into the order
            flow. No "explore" or "learn more". Each card has ONE CTA:
            Order from X. */}
      <section id="brands" style={{ background: 'var(--servd-bg)' }}>
        <div className="container" style={{ paddingTop: 'clamp(4rem, 8vw, 6rem)', paddingBottom: '2rem' }}>
          <p className="eyebrow eyebrow-accent">The kitchens</p>
          <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', maxWidth: '900px', margin: '0.5rem 0 1rem', letterSpacing: '-0.04em' }}>
            Pick one. Pick two.<br />
            <span className="display-italic">Pick all of them.</span>
          </h2>
          <p style={{ color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '36rem', lineHeight: 1.55 }}>
            One bag, one delivery. We hold the slowest dish so the salad stays cold and the burger stays hot.
          </p>
        </div>

        <div className="container" style={{ paddingBottom: 'clamp(4rem, 8vw, 6rem)' }}>
          <div style={{ display: 'grid', gap: '1.25rem' }}>
            {brands.map((b) => (
              <Link key={b.id} href={`/${b.slug}`}
                style={{
                  display: 'block', textDecoration: 'none', color: 'inherit',
                  position: 'relative', overflow: 'hidden',
                  borderRadius: '1.5rem',
                  minHeight: 'clamp(280px, 38vw, 420px)',
                  background: `${b.accent} url(${b.img}) center/cover`,
                }}>
                <div aria-hidden style={{
                  position: 'absolute', inset: 0,
                  background: 'linear-gradient(135deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.15) 55%, rgba(0,0,0,0.55) 100%)',
                }} />
                <div aria-hidden style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '6px',
                  background: b.accent,
                }} />
                <div style={{
                  position: 'relative', zIndex: 1, height: '100%',
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  padding: 'clamp(1.5rem, 4vw, 2.5rem)', color: 'white',
                  minHeight: 'clamp(280px, 38vw, 420px)',
                }}>
                  <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.7)' }}>
                    /{b.slug}
                  </p>
                  <div>
                    <h3 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', color: 'white', lineHeight: 0.98, letterSpacing: '-0.04em' }}>
                      {b.name}
                    </h3>
                    <p style={{ marginTop: '0.75rem', fontSize: 'clamp(1rem, 1.4vw, 1.2rem)', color: 'rgba(255,255,255,0.9)', maxWidth: '28rem', lineHeight: 1.4 }}>
                      {b.story.tagline}
                    </p>
                    <div style={{ marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
                      <span style={{
                        background: 'white', color: 'var(--servd-ink)',
                        fontFamily: 'var(--font-display)', fontWeight: 800,
                        fontSize: '0.95rem',
                        padding: '0.7rem 1.3rem', borderRadius: '999px',
                        display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                      }}>
                        Order from {b.name} <span aria-hidden style={{ opacity: 0.6 }}>→</span>
                      </span>
                      <span style={{
                        color: 'rgba(255,255,255,0.85)', fontSize: '0.85rem', fontWeight: 600,
                        textDecoration: 'none', borderBottom: '1px solid rgba(255,255,255,0.4)',
                        paddingBottom: '0.1rem',
                      }}>
                        About this kitchen →
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── PROMISE NUMBERS — short, useful, no preaching. ─────────── */}
      <section style={{ background: 'var(--servd-green)', color: 'white', padding: 'clamp(3rem, 6vh, 5rem) 0' }}>
        <div className="container" style={{ display: 'grid', gap: 'clamp(2rem, 4vw, 3rem)', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', textAlign: 'center' }}>
          {[
            { big: '1', label: 'bag, even with three kitchens' },
            { big: '0%', label: 'aggregator markup' },
            { big: '40m', label: 'typical delivery time' },
          ].map((s) => (
            <div key={s.big}>
              <p className="display" style={{ fontSize: 'clamp(3rem, 6vw, 4.5rem)', color: 'white', lineHeight: 0.95, margin: 0, letterSpacing: '-0.04em' }}>
                {s.big}
              </p>
              <p style={{ marginTop: '0.5rem', fontSize: '0.95rem', color: 'rgba(255,255,255,0.85)', maxWidth: '18rem', marginLeft: 'auto', marginRight: 'auto' }}>
                {s.label}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FINAL CTA — single, big, terminal. ────────────────────── */}
      <section style={{ background: 'var(--servd-bg)', padding: 'clamp(5rem, 10vw, 8rem) 0', textAlign: 'center' }}>
        <div className="container">
          <p className="eyebrow eyebrow-accent">Hungry now?</p>
          <h2 className="display" style={{ fontSize: 'clamp(3rem, 8.5vw, 6rem)', margin: '0.5rem 0 2rem', maxWidth: '900px', marginLeft: 'auto', marginRight: 'auto', letterSpacing: '-0.045em' }}>
            Let&apos;s feed you.
          </h2>
          <Link href="/browse" style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.6rem',
            background: 'var(--servd-green)', color: 'white',
            fontFamily: 'var(--font-display)', fontWeight: 800,
            fontSize: '1.15rem',
            padding: '1.2rem 2.4rem', borderRadius: '999px',
            textDecoration: 'none',
            boxShadow: '0 12px 32px rgba(30,58,138,0.32)',
          }}>
            Open the menu <span aria-hidden style={{ opacity: 0.65 }}>→</span>
          </Link>
          <p style={{ marginTop: '1.5rem', color: 'var(--servd-mute)', fontSize: '0.9rem' }}>
            Already a member? <Link href="/account" style={{ color: 'var(--servd-green-dark)', fontWeight: 700, textDecoration: 'underline' }}>Sign in</Link>
          </p>
        </div>
      </section>
    </div>
  )
}
