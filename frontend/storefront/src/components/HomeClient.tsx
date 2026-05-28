'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Concept } from '../lib/concept'
import { brandAccent, brandStory } from '../lib/concept'
import { DragRail } from './kinetic/DragRail'
import { MarqueeText } from './kinetic/MarqueeStrip'
import { useScrollReveal } from './kinetic/motionHooks'

// servd home — the platform front door. Kinetic but disciplined. Brand
// colors come from the same brandAccent() override used by the per-brand
// microsites so a brand's accent is identical wherever it appears
// (home, /brand/<slug>, BrandShell nav). No emoji as structural icons.
// No fake dish content — every brand callout routes into the actual
// brand page.

interface Props {
  concepts: Concept[]
}

// ── Promise pillars ──────────────────────────────────────────────────
// Three brand-accents rotated so the pillar row reads as multi-brand
// without depending on whichever concepts the API returned.
const PILLAR_ACCENTS = ['var(--simmer-orange)', 'var(--stax-purple)', 'var(--flipd-sky-deep)']

// ── Sample customer quotes — placeholder until real reviews are wired. ──
// Marked in copy as "placeholder" so a future PR can swap to live reviews
// without touching the layout. Keeping them on-brand and Karachi-flavored.
const REVIEWS = [
  { quote: 'Three kitchens in one cart. Everything arrived hot, even the slowest dish.', name: 'Sara K.',  area: 'DHA Phase 6'    },
  { quote: 'Simmer is the only reason my lunch is no longer depressing.',                  name: 'Imran R.', area: 'Clifton Block 4' },
  { quote: 'Family of six. Three kitchens, one delivery, no chaos. Logistics figured out.', name: 'Hira M.',  area: 'Bahria Town'    },
  { quote: 'My kid will not shut up about the tenders. Weekday-dinner problem solved.',     name: 'Adnan F.', area: 'Gulshan-e-Iqbal' },
]

export function HomeClient({ concepts }: Props) {
  // Live brand voices, driven by the actual API response so the spotlight
  // automatically picks up new brands when the operator adds them.
  // Each row uses the brandAccent() override so colors match the brand
  // pages exactly — single source of truth.
  const voices = concepts
    .filter((c) => ['simmer', 'stax', 'flipd'].includes(c.slug))
    .sort((a, b) => ['stax', 'simmer', 'flipd'].indexOf(a.slug) - ['stax', 'simmer', 'flipd'].indexOf(b.slug))
    .map((c) => ({
      brand:  c.name,
      slug:   c.slug,
      line:   brandStory(c.slug).tagline,
      accent: brandAccent(c.slug, c.primaryColor),
    }))

  // Hero spotlight cycles through the brand accents every 2.4s. Hovering
  // a name pins it. Cycle is paused if no brands resolved.
  const [activeIdx, setActiveIdx] = useState(0)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  useEffect(() => {
    if (hoveredIdx !== null || voices.length === 0) return
    const t = setInterval(() => setActiveIdx((i) => (i + 1) % voices.length), 2400)
    return () => clearInterval(t)
  }, [hoveredIdx, voices.length])
  const liveIdx = hoveredIdx ?? activeIdx
  const liveAccent = voices[liveIdx]?.accent ?? 'var(--servd-green)'

  const pageRef = useScrollReveal<HTMLDivElement>()

  return (
    <div ref={pageRef} style={{ background: 'white', color: 'var(--servd-ink)' }}>

      {/* ── HERO ─────────────────────────────────────────────────────────
          The accent gradient tracks whichever brand is in the spotlight.
          No floating decorations — typography carries the weight. */}
      <section className="surface-ink relative overflow-hidden"
        style={{
          minHeight: 'min(92vh, 920px)',
          ['--brand-accent' as string]: liveAccent,
          ['--brand-ink' as string]: '#0a0a0a',
        }}>

        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, zIndex: 1,
          background: `radial-gradient(ellipse 60% 50% at 75% 30%, color-mix(in srgb, var(--brand-accent) 24%, transparent) 0%, transparent 70%),
                       radial-gradient(ellipse 50% 50% at 20% 80%, color-mix(in srgb, var(--brand-accent) 14%, transparent) 0%, transparent 70%)`,
          transition: 'background 800ms ease',
        }} />

        <div className="container relative z-10" style={{ paddingTop: 'clamp(4rem, 9vw, 7rem)', paddingBottom: 'clamp(4rem, 9vw, 7rem)' }}>

          <p className="eyebrow" style={{ color: 'var(--brand-accent)', marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
            Karachi · {voices.length || 'three'} kitchens · one cart
          </p>

          <h1 className="display" style={{
            fontSize: 'clamp(3.2rem, 9.5vw, 8rem)',
            color: 'white',
            maxWidth: '1100px',
            marginBottom: 'clamp(2rem, 4vw, 3rem)',
          }}>
            Real kitchens.{' '}
            <span className="display-italic" style={{ color: 'var(--brand-accent)' }}>Real food.</span>
            <br />
            Built for the way<br />
            you eat now.
          </h1>

          {/* Brand voice strip — each name lights up in its real accent.
              Cycles automatically, hover pins. */}
          {voices.length > 0 && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: '0.4rem 2.5rem',
              marginBottom: 'clamp(2.5rem, 5vw, 4rem)',
              fontWeight: 600,
              color: 'rgba(255,255,255,0.55)',
            }}>
              {voices.map((v, i) => {
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
                      textAlign: 'left',
                    }}>
                    {v.brand}<span style={{ opacity: 0.5 }}> — </span>
                    <span style={{ fontWeight: 500, fontSize: '0.62em', verticalAlign: 'middle' }}>
                      {v.line}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

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

      {/* ── Marquee — section divider with a heartbeat. ─────────────── */}
      <MarqueeText
        items={[
          'Three kitchens',
          'One bag',
          'No middleman markup',
          'Karachi-built',
          'Direct from the kitchen',
        ]}
        accent
      />

      {/* ── BRANDS — drag carousel of the live brands, each card carrying
            its real accent + a featured photo. The whole card is the
            link target. ─────────────────────────────────────────── */}
      <section id="brands" className="section" style={{ background: 'white' }}>
        <div className="container" style={{ marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
          <p className="eyebrow eyebrow-accent">The kitchens</p>
          <div className="asym-2" style={{ marginTop: '0.5rem' }}>
            <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)' }}>
              {voices.length === 1 ? 'One brand.' : `${capitalize(numberWord(voices.length))} brands.`}<br />
              <span className="display-italic">One household name.</span>
            </h2>
            <p style={{ fontSize: '1.05rem', color: 'var(--servd-mute)', maxWidth: '420px' }}>
              Each kitchen does one thing properly — and shares a delivery bag.
              Pick from one, two, or all of them. We figure out the timing.
            </p>
          </div>
        </div>

        <DragRail>
          {voices.map((v) => (
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
                  radial-gradient(ellipse 80% 60% at 70% 20%, color-mix(in srgb, ${v.accent} 22%, transparent) 0%, transparent 60%),
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
                    /brand/{v.slug}
                  </p>
                  <h3 className="display" style={{ fontSize: 'clamp(2.2rem, 4vw, 3.2rem)', color: 'white' }}>
                    {v.brand}
                  </h3>
                  <p style={{ marginTop: '0.5rem', color: 'rgba(255,255,255,0.7)', fontSize: '1rem', maxWidth: '24ch' }}>
                    {v.line}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </DragRail>
      </section>

      {/* ── PROMISE — three pillars, accent shifts per pillar so the row
            reads as multi-brand without naming brands. ──────────────── */}
      <section className="section relative overflow-hidden" style={{ background: 'white' }}>
        <div className="container relative">
          <p className="eyebrow eyebrow-accent">The promise</p>
          <h2 className="display" style={{ fontSize: 'clamp(2.8rem, 6vw, 5rem)', marginBottom: '2.5rem', maxWidth: '900px' }}>
            We are not a delivery app.<br />
            <span className="display-italic">We are the kitchen.</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
            {[
              { label: 'Direct',  title: 'No middleman markup',     body: 'You order from us, we cook, we deliver. Same kitchen end to end. The price you pay is the price we charge.' },
              { label: 'Hot',     title: 'One bag, three kitchens', body: 'Riders wait for the slowest dish so everything arrives at the same temperature. The salad is cold, the burger is hot.' },
              { label: 'Honest',  title: 'No fake urgency',          body: 'No "only 2 left", no countdown timers, no surge pricing on a rainy Tuesday. The menu is real, the price is real.' },
            ].map((p, i) => {
              const accent = PILLAR_ACCENTS[i] ?? 'var(--servd-green)'
              return (
                <div key={p.label} style={{ ['--brand-accent' as string]: accent } as React.CSSProperties}>
                  <span style={{
                    display: 'inline-flex',
                    width: '3rem', height: '3rem', borderRadius: '999px',
                    background: accent, marginBottom: '1.25rem',
                    alignItems: 'center', justifyContent: 'center',
                    color: '#0a0a0a', fontWeight: 900, fontSize: '1.4rem',
                    fontFamily: 'var(--font-display)',
                  }}>{i + 1}</span>
                  <p className="eyebrow eyebrow-accent" style={{ marginBottom: '0.5rem' }}>{p.label}</p>
                  <h3 className="display" style={{ fontSize: 'clamp(1.5rem, 2.5vw, 2rem)', marginBottom: '0.75rem' }}>
                    {p.title}
                  </h3>
                  <p style={{ color: 'var(--servd-mute)', lineHeight: 1.55 }}>{p.body}</p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── INSIDERS — premium tier framing, gold wash. ─────────────── */}
      <section className="section surface-ink relative overflow-hidden"
        style={{ ['--brand-accent' as string]: '#c9a961', ['--brand-ink' as string]: '#0a0a0a' }}>
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
                <span className="display-italic" style={{ color: '#c9a961' }}>does not get listed.</span>
              </h2>
            </div>
            <p style={{
              color: 'rgba(255,255,255,0.7)',
              fontSize: '1.05rem',
              lineHeight: 1.55,
              maxWidth: '440px',
            }}>
              Limited drops. Off-menu plates. Weekday lunch perks. Insiders get first.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-5" style={{ alignItems: 'stretch' }}>
            {[
              { tag: 'First access', head: 'Drops before they list', body: 'New stacks, omakase nights, Friday-only tenders. Insiders get a 24-hour window before public booking.', badge: '24h' },
              { tag: 'Off-menu',     head: 'The hidden menus',        body: 'Build-your-own plates, off-menu sandwiches, dishes the chefs run for friends. Members only.', badge: '★', featured: true },
              { tag: 'Free perks',   head: 'Lunch delivery on us',   body: 'Weekday lunch delivery free for Insiders. Plus 200 points on every order, redeemable at 2,000.', badge: 'Rs. 0' },
            ].map((p) => (
              <div key={p.head} style={{
                background: p.featured
                  ? 'linear-gradient(160deg, rgba(201,169,97,0.16) 0%, rgba(201,169,97,0.04) 60%, transparent 100%)'
                  : 'rgba(255,255,255,0.03)',
                border: p.featured ? '1px solid rgba(201,169,97,0.45)' : '1px solid rgba(255,255,255,0.08)',
                borderRadius: '1.25rem',
                padding: '1.5rem 1.4rem',
                color: 'white',
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
              See all perks
            </Link>
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.86rem' }}>
              · free forever · cancel anytime
            </span>
          </div>
        </div>
      </section>

      {/* ── REVIEWS — drag carousel, each card heavy ink with a
            brand-tinted accent. Quotes are placeholder until real
            reviews come through. ─────────────────────────────────── */}
      <section className="section" style={{ background: 'white' }}>
        <div className="container" style={{ marginBottom: 'clamp(2rem, 4vw, 3rem)' }}>
          <p className="eyebrow eyebrow-accent">From our regulars</p>
          <h2 className="display" style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', maxWidth: '900px' }}>
            People are <span className="display-italic">extremely</span> normal about us.
          </h2>
        </div>

        <DragRail>
          {REVIEWS.map((r, i) => {
            const accent = voices[i % Math.max(voices.length, 1)]?.accent ?? 'var(--servd-green)'
            return (
              <div
                key={r.name}
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
                  <span style={{ fontSize: '3rem', lineHeight: 1, color: accent, fontFamily: 'var(--font-display)', fontWeight: 800 }}>&quot;</span>
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

      {/* ── FINAL CTA — locked to servd-green since it's the platform CTA. */}
      <section className="surface-ink relative overflow-hidden"
        style={{ ['--brand-accent' as string]: '#22c55e', ['--brand-ink' as string]: '#0a0a0a' }}>
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
            {voices.length === 1 ? 'One kitchen.' : `${capitalize(numberWord(voices.length || 3))} kitchens.`}<br />
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

function numberWord(n: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
  return words[n] ?? String(n)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
