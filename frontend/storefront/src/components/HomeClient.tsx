'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Concept } from '../lib/concept'
import { conceptHeroImage } from '../lib/concept'
import { DragRail } from './kinetic/DragRail'
import { MarqueeText } from './kinetic/MarqueeStrip'
import { useScrollReveal } from './kinetic/motionHooks'

// servd home — kinetic, agency-modern. The platform is the framing; the
// three brands are the product. Big asymmetric typography, floating motifs,
// drag carousels, marquee strips. Per-brand colour comes through inline
// --brand-accent assignments so each section feels rooted in the brand it's
// showcasing.

interface Props {
  concepts: Concept[]
}

// Live brand voices — kept in code so the home page can showcase them even
// before the operator wires content blocks via the CMS. Each carries the
// brand's accent (lights up its name on hover + colours the brand card)
// and a one-line voice that sells the kitchen in five words or less.
const VOICES: Array<{ brand: string; slug: string; line: string; accent: string; emoji: string }> = [
  { brand: 'Stax',   slug: 'stax',   line: 'Smashed, stacked, sauced.',             accent: '#FF6B35', emoji: '🍔' },
  { brand: 'Simmer', slug: 'simmer', line: 'Slow nights, plated softly.',           accent: '#22c55e', emoji: '🍲' },
  { brand: 'Flipd',  slug: 'flipd',  line: 'Buttermilk-brined, hand-breaded, hot.', accent: '#F5B700', emoji: '🍗' },
]

const FEATURED: Array<{ dish: string; brand: string; brandSlug: string; price: string; img: string; tag?: string }> = [
  { dish: 'The Stax Classic',  brand: 'Stax',   brandSlug: 'stax',   price: 'Rs. 1,200', img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=900&q=85', tag: 'Double smash' },
  { dish: 'Slow-Roast Lamb',   brand: 'Simmer', brandSlug: 'simmer', price: 'Rs. 1,950', img: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=900&q=85', tag: '12 hours' },
  { dish: 'Hot Honey Tenders', brand: 'Flipd',  brandSlug: 'flipd',  price: 'Rs. 950',   img: 'https://images.unsplash.com/photo-1598514983318-2f64f8f4796c?w=900&q=85', tag: '24h brine' },
]

const REVIEWS = [
  { quote: 'Burgers from Stax, a bowl from Simmer, tenders from Flipd — three kitchens in one cart. Everything arrived hot.', name: 'Sara K.',  area: 'DHA Phase 6'    },
  { quote: 'The slow-roast lamb from Simmer is the only reason my lunch isn\'t depressing anymore.',                          name: 'Imran R.', area: 'Clifton Block 4' },
  { quote: 'Family of six. Three kitchens, one order, one delivery, no chaos. Logistics figured out.',                        name: 'Hira M.',  area: 'Bahria Town'    },
  { quote: 'My kid won\'t shut up about the hot honey tenders. Solved a weekday-dinner problem permanently.',                  name: 'Adnan F.', area: 'Gulshan-e-Iqbal' },
]

export function HomeClient({ concepts: _concepts }: Props) {
  // Hero brand names auto-cycle through their accent every 1.8s. Hover
  // overrides the auto-cycle for that name. The accent the page is
  // currently spotlighting also drives the kinetic shapes behind the
  // headline — the shape tinting tracks the active brand.
  const [activeIdx, setActiveIdx] = useState(0)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  useEffect(() => {
    if (hoveredIdx !== null) return
    const t = setInterval(() => setActiveIdx((i) => (i + 1) % VOICES.length), 1800)
    return () => clearInterval(t)
  }, [hoveredIdx])
  const liveIdx = hoveredIdx ?? activeIdx
  const liveAccent = VOICES[liveIdx]?.accent ?? '#22c55e'
  // Scroll-reveal observer — children with .reveal-on-scroll fade in
  // as they enter the viewport. Each major section mounts under this ref.
  const pageRef = useScrollReveal<HTMLDivElement>()

  return (
    <div ref={pageRef} style={{ background: 'white', color: 'var(--servd-ink)' }}>

      {/* ── Promo strip ─────────────────────────────────────────────── */}
      <div className="surface-ink"
        style={{
          padding: '0.6rem 1rem', textAlign: 'center',
          fontSize: '0.82rem', fontWeight: 500, letterSpacing: '0.02em',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
        <span style={{ color: 'var(--servd-green)', fontWeight: 800 }}>RS. 200 OFF</span>
        {' '}your first order · code{' '}
        <code style={{ background: 'rgba(34,197,94,0.16)', color: 'var(--servd-green)', padding: '0.12rem 0.45rem', borderRadius: '4px', fontWeight: 800 }}>FRESH200</code>
        {' · '}
        <Link href="/browse" style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'underline' }}>Order now →</Link>
      </div>

      {/* ── HERO — asymmetric, kinetic. The accent tracks the brand
            currently in the spotlight; floating shapes echo the same
            accent so the page feels alive without being chaotic. ───── */}
      <section className="surface-ink relative overflow-hidden"
        style={{
          minHeight: 'min(92vh, 920px)',
          ['--brand-accent' as string]: liveAccent,
          ['--brand-ink' as string]:    '#0a0a0a',
        }}>

        {/* servd is the platform — discovery + order + delivery tracking.
            Restrained hero: just an ambient glow that tracks the active
            brand's accent. No floating decorations, no food emojis,
            no scattered shapes. The hero earns its weight from typography
            + the brand spotlight cycle, not from kinetic ornament. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, zIndex: 1,
          background: `radial-gradient(ellipse 50% 50% at 70% 30%, ${liveAccent}30 0%, transparent 70%),
                       radial-gradient(ellipse 50% 50% at 20% 80%, ${liveAccent}18 0%, transparent 70%)`,
          transition: 'background 800ms ease',
        }} />

        <div className="container relative z-10" style={{ paddingTop: 'clamp(4rem, 9vw, 7rem)', paddingBottom: 'clamp(4rem, 9vw, 7rem)' }}>

          <p className="eyebrow"
            style={{ color: 'var(--brand-accent)', marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
            Karachi · three kitchens · one cart
          </p>

          {/* Display headline — chunky, asymmetric. Brand names sit in
              their own line each, cycling colour. The italic word breaks
              the rhythm so the layout doesn't read like a list. */}
          <h1 className="display"
            style={{
              fontSize: 'clamp(3.2rem, 9.5vw, 8rem)',
              color: 'white',
              maxWidth: '1100px',
              marginBottom: 'clamp(2rem, 4vw, 3rem)',
            }}>
            Real kitchens. <span className="display-italic" style={{ color: 'var(--brand-accent)' }}>Real food.</span>
            <br />
            Built for the way<br />
            you eat now.
          </h1>

          {/* Brand voice strip — each name lights up in its accent. The
              spotlight cycles automatically; hovering pins. */}
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '0.4rem 2.5rem',
            marginBottom: 'clamp(2.5rem, 5vw, 4rem)',
            fontSize: 'clamp(1.05rem, 1.8vw, 1.35rem)',
            fontWeight: 600,
            color: 'rgba(255,255,255,0.55)',
          }}>
            {VOICES.map((v, i) => {
              const active = i === liveIdx
              return (
                <button
                  key={v.slug}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  onFocus={() => setHoveredIdx(i)}
                  onBlur={() => setHoveredIdx(null)}
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    color: active ? v.accent : 'rgba(255,255,255,0.55)',
                    fontFamily: 'var(--font-display)',
                    fontWeight: 800,
                    letterSpacing: '-0.02em',
                    fontSize: 'clamp(1.4rem, 2.6vw, 2.1rem)',
                    cursor: 'pointer',
                    transition: 'color 220ms ease',
                  }}>
                  {v.brand}<span style={{ opacity: 0.5 }}> — </span>
                  <span style={{ fontWeight: 500, fontSize: '0.62em', verticalAlign: 'middle' }}>
                    {v.line}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Dual CTA — Order Now (brand-accent pill) + Explore brands
              (outline). Big targets, generous spacing. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.9rem' }}>
            <Link href="/browse" className="brand-pill">
              Order now <span style={{ opacity: 0.65 }}>→</span>
            </Link>
            <Link href="#brands" className="brand-pill-outline">
              Meet the kitchens
            </Link>
          </div>
        </div>
      </section>

      {/* ── Marquee — section divider that gives the page a kinetic
            heartbeat between blocks. ──────────────────────────────── */}
      <MarqueeText
        items={[
          'Three kitchens',
          'One bag',
          'No chaos',
          'Karachi-built',
          'Direct from the kitchen',
        ]}
        accent
      />

      {/* ── BRANDS — drag carousel of the live brands. Each card carries
            its accent + a featured photo. Click anywhere → brand
            microsite. ───────────────────────────────────────────── */}
      <section id="brands" className="section" style={{ background: 'white' }}>
        <div className="container" style={{ marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
          <p className="eyebrow eyebrow-accent">The kitchens</p>
          <div className="asym-2" style={{ marginTop: '0.5rem' }}>
            <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)' }}>
              Three brands.<br />
              <span className="display-italic">One household name.</span>
            </h2>
            <p style={{ fontSize: '1.05rem', color: 'var(--servd-mute)', maxWidth: '420px' }}>
              Each kitchen does one thing properly — burgers, slow-cook, fried —
              and shares a delivery bag. Pick from one, two, or all three.
              We figure out the timing.
            </p>
          </div>
        </div>

        <DragRail>
          {VOICES.map((v) => (
            <Link
              key={v.slug}
              href={`/brand/${v.slug}`}
              className="kinetic-card group"
              style={{
                width: 'min(420px, 80vw)',
                ['--brand-accent' as string]: v.accent,
                ['--brand-ink' as string]:    '#0a0a0a',
                background: '#0a0a0a',
                color: 'white',
                textDecoration: 'none',
              }}>
              <div style={{
                position: 'relative',
                aspectRatio: '4 / 5',
                background: `
                  radial-gradient(ellipse 80% 60% at 70% 20%, ${v.accent}22 0%, transparent 60%),
                  linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%)
                `,
                overflow: 'hidden',
              }}>
                <div className="kinetic-arrow">→</div>
                <div style={{
                  position: 'absolute', left: '1.5rem', bottom: '1.5rem',
                  zIndex: 2,
                }}>
                  <p className="eyebrow" style={{ color: v.accent, marginBottom: '0.5rem' }}>
                    {v.slug}.servd.pk
                  </p>
                  <h3 className="display" style={{ fontSize: 'clamp(2.2rem, 4vw, 3.2rem)', color: 'white' }}>
                    {v.brand}
                  </h3>
                  <p style={{ marginTop: '0.5rem', color: 'rgba(255,255,255,0.7)', fontSize: '1rem' }}>
                    {v.line}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </DragRail>
      </section>

      {/* ── FEATURED DISHES — editorial photography grid. The headline
            sits chunky on the left; the cards take the right. ─────── */}
      <section className="section surface-warm">
        <div className="container">
          <div className="asym-2 asym-2-flip" style={{ marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
            <p className="display" style={{ fontSize: 'clamp(1.5rem, 2.5vw, 2rem)', color: 'var(--servd-mute)' }}>
              <span className="eyebrow eyebrow-accent" style={{ display: 'block', marginBottom: '0.5rem' }}>What's good right now</span>
              Hand-picked by the chefs running each line.
              Pulled fresh on the next print.
            </p>
            <h2 className="display" style={{ fontSize: 'clamp(2.8rem, 6vw, 5rem)' }}>
              The hits.<br />
              <span className="display-italic">Plated.</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
            {FEATURED.map((f) => (
              <Link
                key={f.dish}
                href={`/brand/${f.brandSlug}/menu`}
                className="kinetic-card"
                style={{
                  ['--brand-accent' as string]: VOICES.find((v) => v.slug === f.brandSlug)?.accent ?? 'var(--servd-green)',
                  ['--brand-ink' as string]:    '#0a0a0a',
                  background: 'white',
                  textDecoration: 'none',
                  color: 'var(--servd-ink)',
                }}>
                <div style={{
                  position: 'relative',
                  aspectRatio: '4 / 3',
                  backgroundImage: `url(${f.img})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}>
                  <div className="kinetic-arrow">→</div>
                  {f.tag && (
                    <span style={{
                      position: 'absolute', top: '1rem', left: '1rem',
                      background: 'rgba(0,0,0,0.75)', color: 'white',
                      padding: '0.3rem 0.7rem', borderRadius: '999px',
                      fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                    }}>{f.tag}</span>
                  )}
                </div>
                <div style={{ padding: '1.25rem' }}>
                  <p className="eyebrow" style={{ color: 'var(--brand-accent)', marginBottom: '0.4rem' }}>{f.brand}</p>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' }}>
                    <p style={{ fontSize: '1.2rem', fontWeight: 800, letterSpacing: '-0.015em' }}>{f.dish}</p>
                    <p style={{ fontWeight: 700, color: 'var(--servd-mute)' }}>{f.price}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── THE PROMISE — three pillars laid out asymmetric. The accent
            shifts on each pillar so the section reads as multi-brand. ── */}
      <section className="section relative overflow-hidden" style={{ background: 'white' }}>
        <div className="container relative">
          <p className="eyebrow eyebrow-accent">The promise</p>
          <h2 className="display" style={{ fontSize: 'clamp(2.8rem, 6vw, 5rem)', marginBottom: '2.5rem', maxWidth: '900px' }}>
            We're not a delivery app.<br />
            <span className="display-italic">We're the kitchen.</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
            {[
              { accent: '#FF6B35', label: 'Direct',   title: 'No middleman markup',  body: 'You order from us, we cook, we deliver. Same kitchen end to end. The price you pay is the price we charge.' },
              { accent: '#22c55e', label: 'Hot',      title: 'One bag, three kitchens', body: 'Our riders wait for the slowest dish so everything arrives at the same temperature. The salad is cold; the burger is hot.' },
              { accent: '#F5B700', label: 'Honest',   title: 'No fake urgency',      body: 'No "only 2 left", no countdown timers, no surge pricing on a rainy Tuesday. The menu is real, the price is real.' },
            ].map((p, i) => (
              <div key={i} style={{ ['--brand-accent' as string]: p.accent } as React.CSSProperties}>
                <span style={{
                  display: 'inline-block',
                  width: '3rem', height: '3rem', borderRadius: '999px',
                  background: p.accent, marginBottom: '1.25rem',
                  position: 'relative',
                }}>
                  <span style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#0a0a0a', fontWeight: 900, fontSize: '1.4rem',
                  }}>{i + 1}</span>
                </span>
                <p className="eyebrow eyebrow-accent" style={{ marginBottom: '0.5rem' }}>{p.label}</p>
                <h3 className="display" style={{ fontSize: 'clamp(1.5rem, 2.5vw, 2rem)', marginBottom: '0.75rem' }}>
                  {p.title}
                </h3>
                <p style={{ color: 'var(--servd-mute)', lineHeight: 1.55 }}>{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── INSIDERS — membership push. This section is the loyalty
            growth engine: turn one-time orderers into Insiders, who get
            early access to limited drops, free delivery on weekday
            lunches, and a private channel for the omakase nights at
            Simmer. Three-tier card layout, central CTA. ─────────── */}
      <section className="section surface-ink relative overflow-hidden"
        style={{ ['--brand-accent' as string]: '#c9a961', ['--brand-ink' as string]: '#0a0a0a' }}>
        {/* Soft gold wash so this section reads as "the premium tier" */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse 60% 50% at 50% 30%, rgba(201,169,97,0.18) 0%, transparent 60%)',
        }} />
        <div className="container relative">
          <div className="asym-2" style={{ marginBottom: 'clamp(2.5rem, 5vw, 3.5rem)' }}>
            <div>
              <p className="eyebrow" style={{ color: '#c9a961', marginBottom: '1rem' }}>
                Insiders · free to join
              </p>
              <h2 className="display" style={{
                fontSize: 'clamp(2.8rem, 6.5vw, 5rem)',
                color: 'white',
              }}>
                The best stuff<br />
                <span className="display-italic" style={{ color: '#c9a961' }}>doesn't get listed.</span>
              </h2>
            </div>
            <p style={{
              color: 'rgba(255,255,255,0.7)',
              fontSize: '1.05rem',
              lineHeight: 1.55,
              maxWidth: '440px',
            }}>
              Limited drops. Omakase nights at Simmer. Build-your-own off-menu Stax. Free delivery on weekday lunches. Insiders get first.
            </p>
          </div>

          {/* Three perks in a row — keep the layout asymmetric (middle
              card stands taller) so it doesn't read as a generic grid. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5" style={{ alignItems: 'stretch' }}>
            {[
              {
                tag:   'First access',
                head:  'Drops before they list',
                body:  'New Stax stacks, Simmer omakase nights, Flipd Friday tenders — Insiders get a 24-hour window before anyone else can book.',
                badge: '24h',
              },
              {
                tag:   'Off-menu',
                head:  'The hidden Stax menu',
                body:  "Build-your-own pubstax, off-menu sandwiches, and dishes the chefs run for friends. Members only.",
                badge: '★',
                featured: true,
              },
              {
                tag:   'Free perks',
                head:  'Lunch delivery on us',
                body:  'Weekday lunch delivery free for Insiders. Plus 200 points on every order. Redeem for a meal once you hit 2,000.',
                badge: 'Rs. 0',
              },
            ].map((p, i) => (
              <div key={i} style={{
                background: p.featured
                  ? 'linear-gradient(160deg, rgba(201,169,97,0.16) 0%, rgba(201,169,97,0.04) 60%, transparent 100%)'
                  : 'rgba(255,255,255,0.03)',
                border: p.featured ? '1px solid rgba(201,169,97,0.45)' : '1px solid rgba(255,255,255,0.08)',
                borderRadius: '1.25rem',
                padding: '1.5rem 1.4rem',
                color: 'white',
                position: 'relative',
                transform: p.featured ? 'translateY(-12px)' : 'none',
                transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}>
                <div style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '2.4rem',
                  height: '2.4rem',
                  background: p.featured ? '#c9a961' : 'rgba(255,255,255,0.08)',
                  color: p.featured ? '#0a0a0a' : '#c9a961',
                  borderRadius: '999px',
                  fontFamily: 'var(--font-display)',
                  fontWeight: 800,
                  fontSize: '0.95rem',
                  marginBottom: '1rem',
                }}>{p.badge}</div>
                <p className="eyebrow" style={{ color: '#c9a961', marginBottom: '0.5rem' }}>
                  {p.tag}
                </p>
                <h3 className="display" style={{
                  fontSize: 'clamp(1.35rem, 2.3vw, 1.65rem)',
                  color: 'white',
                  marginBottom: '0.6rem',
                  lineHeight: 1.05,
                }}>
                  {p.head}
                </h3>
                <p style={{
                  color: 'rgba(255,255,255,0.7)',
                  fontSize: '0.92rem',
                  lineHeight: 1.55,
                }}>
                  {p.body}
                </p>
              </div>
            ))}
          </div>

          {/* Single Insiders CTA — branded with the gold accent so the
              "premium tier" framing carries through. */}
          <div style={{
            marginTop: 'clamp(2.5rem, 5vw, 3.5rem)',
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem',
          }}>
            <Link
              href="/signup?insider=1"
              className="brand-pill"
              style={{ background: '#c9a961', color: '#0a0a0a', fontSize: '1.05rem' }}
            >
              Become an Insider →
            </Link>
            <Link
              href="/insiders"
              style={{
                color: 'rgba(255,255,255,0.75)',
                fontWeight: 600,
                textDecoration: 'underline',
                textUnderlineOffset: '4px',
                textDecorationColor: 'rgba(201,169,97,0.5)',
              }}
            >
              See all member perks
            </Link>
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.86rem' }}>
              · free forever · cancel anytime
            </span>
          </div>
        </div>
      </section>

      {/* ── REVIEWS — drag carousel, each card heavy ink, brand-tinted
            accent quote-mark. The marquee speeds up the read. ──────── */}
      <section className="section" style={{ background: 'white' }}>
        <div className="container" style={{ marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
          <p className="eyebrow eyebrow-accent">From our regulars</p>
          <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', maxWidth: '900px' }}>
            People are <span className="display-italic">extremely</span> normal about us.
          </h2>
        </div>

        <DragRail>
          {REVIEWS.map((r, i) => {
            const accent = VOICES[i % VOICES.length]!.accent
            return (
              <div
                key={i}
                className="kinetic-card"
                style={{
                  width: 'min(440px, 82vw)',
                  background: '#0a0a0a',
                  color: 'white',
                  padding: '2rem 1.75rem 1.75rem',
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  minHeight: '280px',
                  ['--brand-accent' as string]: accent,
                  ['--brand-ink' as string]:    '#0a0a0a',
                }}>
                <div>
                  <span style={{ fontSize: '3rem', lineHeight: 1, color: accent, fontFamily: 'var(--font-display)', fontWeight: 800 }}>"</span>
                  <p style={{ fontSize: '1.05rem', lineHeight: 1.5, color: 'rgba(255,255,255,0.92)', marginTop: '-0.5rem' }}>
                    {r.quote}
                  </p>
                </div>
                <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                  <span style={{
                    width: '2.2rem', height: '2.2rem', borderRadius: '999px',
                    background: accent, color: '#0a0a0a',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 900, fontSize: '0.95rem',
                  }}>{r.name.charAt(0)}</span>
                  <div>
                    <p style={{ fontWeight: 700, fontSize: '0.95rem' }}>{r.name}</p>
                    <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)' }}>{r.area}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </DragRail>
      </section>

      {/* ── FINAL CTA — ink surface, big type, single action. The
            accent here is locked to servd-green since it's the
            platform CTA, not a brand pitch. ───────────────────────── */}
      <section className="surface-ink relative overflow-hidden"
        style={{ ['--brand-accent' as string]: '#22c55e', ['--brand-ink' as string]: '#0a0a0a' }}>
        {/* Soft ambient — keeping the platform CTA clean, no kinetic
            decoration. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at 50% 60%, rgba(34,197,94,0.18) 0%, transparent 60%)`,
        }} />

        <div className="container relative z-10 text-center" style={{ paddingTop: 'clamp(5rem, 10vw, 8rem)', paddingBottom: 'clamp(5rem, 10vw, 8rem)' }}>
          <p className="eyebrow" style={{ color: 'var(--brand-accent)', marginBottom: '1.5rem' }}>Ready when you are</p>
          <h2 className="display" style={{
            fontSize: 'clamp(3rem, 8.5vw, 6.5rem)',
            color: 'white', marginBottom: '2rem',
          }}>
            Three kitchens.<br />
            <span className="display-italic" style={{ color: 'var(--brand-accent)' }}>One bag.</span>
          </h2>
          <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.9rem', justifyContent: 'center' }}>
            <Link href="/browse" className="brand-pill">Order now →</Link>
            <Link href="/account" className="brand-pill-outline">Sign in</Link>
          </div>
        </div>
      </section>
    </div>
  )
}

// Keep the unused import alive — conceptHeroImage may be needed by future
// blocks that pull hero photography per concept.
void conceptHeroImage
