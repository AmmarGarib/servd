'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Concept } from '../lib/concept'
import { brandAccent, brandStory, conceptHeroImage } from '../lib/concept'
import { useScrollReveal } from './kinetic/motionHooks'

// servd home — the FOOD hub.
//
// The visual hierarchy here is FOOD FIRST. Royal blue is the chrome —
// the wordmark, the CTAs, the marquee — but the hero, the brand cards,
// the section dividers all lead with full-bleed food photography.
//
// Graceful degradation: if the api hiccups and concepts comes back
// empty, we render the three live brands from hardcoded data so the
// home page never goes blank. The data is kept in sync with
// BRAND_STORIES + conceptHeroImage in lib/concept.ts.

interface Props {
  concepts: Concept[]
}

// Fallback brand cards — used when the live concepts API returns nothing
// (api warmup, network blip, etc.). Order matches the live brand grid.
const FALLBACK_BRANDS = [
  { id: 'fallback-stax',   name: 'Stax',   slug: 'stax',   primaryColor: null },
  { id: 'fallback-simmer', name: 'Simmer', slug: 'simmer', primaryColor: null },
  { id: 'fallback-flipd',  name: 'Flipd',  slug: 'flipd',  primaryColor: null },
] as Array<Pick<Concept, 'id' | 'name' | 'slug' | 'primaryColor'>>

export function HomeClient({ concepts }: Props) {
  const source = concepts.filter((c) => ['simmer', 'stax', 'flipd'].includes(c.slug))
  // If the live concept list came back empty (api blip), fall through
  // to the hardcoded fallback so the home page never looks blank.
  const usable = source.length > 0 ? source : FALLBACK_BRANDS

  const brands = usable
    .sort((a, b) => ['stax', 'simmer', 'flipd'].indexOf(a.slug) - ['stax', 'simmer', 'flipd'].indexOf(b.slug))
    .map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      accent: brandAccent(c.slug, c.primaryColor),
      story:  brandStory(c.slug),
      img:    conceptHeroImage({ ...c, type: 'restaurant', description: null, logoUrl: null } as Concept),
    }))

  // Hero food image cycles every 3.5s — leads with the photograph,
  // royal blue is the chrome around it.
  const [activeIdx, setActiveIdx] = useState(0)
  useEffect(() => {
    if (brands.length === 0) return
    const t = setInterval(() => setActiveIdx((i) => (i + 1) % brands.length), 3500)
    return () => clearInterval(t)
  }, [brands.length])
  const live = brands[activeIdx] ?? brands[0]

  const pageRef = useScrollReveal<HTMLDivElement>()

  return (
    <div ref={pageRef} style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}>

      {/* ── HERO ─ Full-bleed food photo + deep royal wash with the
            wordmark on top. The food is the hero, not the blue. */}
      <section className="relative overflow-hidden" style={{
        minHeight: 'min(100vh, 920px)',
        color: 'white',
        display: 'flex', alignItems: 'stretch',
      }}>

        {/* Food background — full opacity, full bleed. */}
        {live && (
          <div aria-hidden style={{
            position: 'absolute', inset: 0, zIndex: 0,
            backgroundImage: `url(${live.img})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            transition: 'background-image 900ms ease-in-out',
          }} />
        )}

        {/* Royal wash — keeps type legible without hiding the food.
            Bottom-heavy gradient so the food shows clearly in the
            upper third and the CTAs sit on a darker base. */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0, zIndex: 1,
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--servd-green) 35%, transparent) 0%, color-mix(in srgb, var(--servd-green) 65%, transparent) 50%, color-mix(in srgb, var(--servd-green-dark) 96%, transparent) 100%)',
        }} />

        <div className="container relative z-10" style={{
          paddingTop: 'clamp(4rem, 9vw, 7rem)',
          paddingBottom: 'clamp(4rem, 9vw, 7rem)',
          display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 'clamp(3rem, 8vw, 5rem)',
        }}>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
            <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.85)' }}>
              servd · the kitchen, direct
            </p>
            <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.65)' }}>
              Karachi · {brands.length} kitchens
            </p>
          </div>

          <div>
            <h1 className="display" style={{
              fontSize: 'clamp(3.5rem, 12vw, 9.5rem)',
              color: 'white',
              maxWidth: '1100px',
              lineHeight: 0.92,
              letterSpacing: '-0.045em',
              margin: 0,
              textShadow: '0 2px 16px rgba(0,0,0,0.35)',
            }}>
              Cooked&nbsp;tonight.<br />
              <span className="display-italic" style={{ color: 'rgba(255,255,255,0.78)' }}>At your door.</span>
            </h1>
            <p style={{
              marginTop: '1.75rem',
              fontSize: 'clamp(1.1rem, 1.8vw, 1.45rem)',
              color: 'rgba(255,255,255,0.9)',
              maxWidth: '40rem',
              lineHeight: 1.4,
              textShadow: '0 1px 8px rgba(0,0,0,0.4)',
            }}>
              Three kitchens. One bag. No aggregator markup. Order direct from the people who cook the food.
            </p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
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
                boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
              }}>
                Order now <span aria-hidden style={{ opacity: 0.65 }}>→</span>
              </Link>
              <Link href="#brands" style={{
                color: 'white', fontWeight: 700, fontSize: '0.95rem',
                padding: '1.1rem 1.5rem', borderRadius: '999px',
                background: 'rgba(255,255,255,0.12)',
                border: '1px solid rgba(255,255,255,0.35)',
                textDecoration: 'none',
                backdropFilter: 'blur(6px)',
              }}>
                See the kitchens
              </Link>
            </div>

            {live && (
              <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: '0.95rem', fontWeight: 500, textShadow: '0 1px 6px rgba(0,0,0,0.4)' }}>
                <span style={{ color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.2em', fontSize: '0.7rem', marginRight: '0.65rem' }}>Tonight from</span>
                <Link href={`/${live.slug}`} style={{ color: 'white', fontWeight: 800, textDecoration: 'none', borderBottom: '2px solid rgba(255,255,255,0.5)', paddingBottom: '0.1rem' }}>
                  {live.name}
                </Link>
                <span style={{ marginLeft: '0.75rem', opacity: 0.85 }}>— {live.story.tagline}</span>
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── BRAND CARDS ─ Each one is a full-bleed food block leading
            into the order flow. */}
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
              <Link key={b.id} href={`/${b.slug}`} aria-label={`Order from ${b.name}`}
                style={{
                  display: 'block', textDecoration: 'none', color: 'inherit',
                  position: 'relative', overflow: 'hidden',
                  borderRadius: '1.5rem',
                  minHeight: 'clamp(320px, 42vw, 460px)',
                  background: `${b.accent} url(${b.img}) center/cover`,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                }}>
                <div aria-hidden style={{
                  position: 'absolute', inset: 0,
                  background: 'linear-gradient(135deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.15) 55%, rgba(0,0,0,0.65) 100%)',
                }} />
                <div aria-hidden style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: '6px',
                  background: b.accent,
                }} />
                <div style={{
                  position: 'relative', zIndex: 1, height: '100%',
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  padding: 'clamp(1.5rem, 4vw, 2.5rem)', color: 'white',
                  minHeight: 'clamp(320px, 42vw, 460px)',
                }}>
                  <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.8)' }}>
                    /{b.slug}
                  </p>
                  <div>
                    <h3 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', color: 'white', lineHeight: 0.98, letterSpacing: '-0.04em', textShadow: '0 2px 10px rgba(0,0,0,0.4)' }}>
                      {b.name}
                    </h3>
                    <p style={{ marginTop: '0.75rem', fontSize: 'clamp(1rem, 1.4vw, 1.2rem)', color: 'rgba(255,255,255,0.92)', maxWidth: '28rem', lineHeight: 1.4, textShadow: '0 1px 6px rgba(0,0,0,0.45)' }}>
                      {b.story.tagline}
                    </p>
                    <span style={{
                      marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                      background: 'white', color: 'var(--servd-ink)',
                      fontFamily: 'var(--font-display)', fontWeight: 800,
                      fontSize: '0.95rem',
                      padding: '0.7rem 1.3rem', borderRadius: '999px',
                    }}>
                      Order from {b.name} <span aria-hidden style={{ opacity: 0.6 }}>→</span>
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── INSIDERS — servd loyalty membership pitch. Replaces the
            promise-numbers strip. Single CTA: become a member. ──── */}
      <section style={{ background: 'var(--servd-green)', color: 'white', padding: 'clamp(4rem, 8vh, 7rem) 0', position: 'relative', overflow: 'hidden' }}>
        {/* Soft ambient glow so the section reads as 'premium tier' */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(255,255,255,0.08) 0%, transparent 60%)',
          pointerEvents: 'none',
        }} />

        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          {/* Header — eyebrow + bricolage display + sub */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 'clamp(2rem, 5vw, 4rem)',
            marginBottom: 'clamp(2.5rem, 5vw, 3.5rem)',
            alignItems: 'baseline',
          }}>
            <div>
              <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '1rem' }}>
                Insiders · free to join
              </p>
              <h2 className="display" style={{
                fontSize: 'clamp(2.5rem, 6vw, 4.5rem)',
                color: 'white',
                margin: 0,
                lineHeight: 0.95,
                letterSpacing: '-0.04em',
              }}>
                The best stuff<br />
                <span className="display-italic" style={{ color: 'rgba(255,255,255,0.7)' }}>doesn&rsquo;t get listed.</span>
              </h2>
            </div>
            <p style={{
              color: 'rgba(255,255,255,0.82)',
              fontSize: '1.05rem',
              lineHeight: 1.55,
              maxWidth: '32rem',
            }}>
              Limited drops. Off-menu plates. Weekday lunch perks. Points on every order. Insiders get first.
            </p>
          </div>

          {/* Three perks — light tinted cards on royal so they read.
              Middle one bumped up to read as the headline perk. */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '1rem',
            alignItems: 'stretch',
          }}>
            {[
              {
                badge: '24h', tag: 'First access',
                head: 'Drops before they list',
                body: 'New stacks, omakase nights, Friday-only tenders. Insiders get a 24-hour window before public booking.',
                featured: false,
              },
              {
                badge: '★', tag: 'Off-menu',
                head: 'The hidden menus',
                body: 'Build-your-own plates, off-menu sandwiches, dishes the chefs run for friends. Members only.',
                featured: true,
              },
              {
                badge: '+', tag: 'Free perks',
                head: 'Points on every order',
                body: 'Earn 1 pt per Rs. 10 spent. Free weekday lunch delivery. Redeem points for a meal at 2,000.',
                featured: false,
              },
            ].map((p) => (
              <div key={p.head} style={{
                background: p.featured ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.07)',
                border: p.featured ? '1px solid rgba(255,255,255,0.35)' : '1px solid rgba(255,255,255,0.18)',
                borderRadius: '1.25rem',
                padding: '1.5rem 1.4rem',
                color: 'white',
                transform: p.featured ? 'translateY(-12px)' : 'none',
                transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                backdropFilter: 'blur(8px)',
              }}>
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center', justifyContent: 'center',
                  width: '2.4rem', height: '2.4rem',
                  background: p.featured ? 'white' : 'rgba(255,255,255,0.12)',
                  color: p.featured ? 'var(--servd-green)' : 'white',
                  borderRadius: '999px',
                  fontFamily: 'var(--font-display)', fontWeight: 800,
                  fontSize: '0.95rem',
                  marginBottom: '1rem',
                }}>{p.badge}</div>
                <p className="eyebrow" style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '0.5rem' }}>
                  {p.tag}
                </p>
                <h3 className="display" style={{
                  fontSize: 'clamp(1.35rem, 2.3vw, 1.65rem)',
                  color: 'white',
                  margin: '0 0 0.6rem',
                  lineHeight: 1.05,
                  letterSpacing: '-0.02em',
                }}>
                  {p.head}
                </h3>
                <p style={{
                  color: 'rgba(255,255,255,0.78)',
                  fontSize: '0.92rem',
                  lineHeight: 1.55,
                  margin: 0,
                }}>
                  {p.body}
                </p>
              </div>
            ))}
          </div>

          {/* Single Insiders CTA — white pill against royal */}
          <div style={{
            marginTop: 'clamp(2.5rem, 5vw, 3.5rem)',
            display: 'flex', flexWrap: 'wrap',
            alignItems: 'center', gap: '1rem',
          }}>
            <Link href="/signup?insider=1" style={{
              background: 'white',
              color: 'var(--servd-green)',
              fontFamily: 'var(--font-display)', fontWeight: 800,
              fontSize: '1.05rem',
              padding: '1rem 1.85rem',
              borderRadius: '999px',
              textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: '0.6rem',
              boxShadow: '0 12px 32px rgba(0,0,0,0.22)',
            }}>
              Become an Insider <span aria-hidden style={{ opacity: 0.6 }}>→</span>
            </Link>
            <Link href="/login" style={{
              color: 'rgba(255,255,255,0.85)',
              fontWeight: 700, fontSize: '0.95rem',
              textDecoration: 'underline',
              textUnderlineOffset: '4px',
              textDecorationColor: 'rgba(255,255,255,0.4)',
            }}>
              Already a member? Sign in
            </Link>
            <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.85rem' }}>
              · free forever · cancel anytime
            </span>
          </div>
        </div>
      </section>

      {/* Global StorefrontFooter has its own "Hungry now? Let's go"
          plus order CTA — we don't double up here. */}
    </div>
  )
}
