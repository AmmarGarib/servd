'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Concept } from '../lib/concept'
import { typeLabel, typeIcon, conceptHeroImage } from '../lib/concept'

// servd home — the platform, not a delivery app. The brands are the product.
// Editorial, food-forward, brand-first. No gamification. No fake urgency.
// Show the food. Show the kitchens. Get out of the way.

interface Props {
  concepts: Concept[]
}

// Food photography for featured dishes — real images, not emoji gradients.
const FEATURED: Array<{ dish: string; brand: string; brandSlug: string; price: string; img: string; tag?: string }> = [
  // Strata removed 2026-05-12 — concept retired from the DB; was leaving a
  // dead "Performance Bowl" tile on the hero mosaic.
  { dish: 'The Stax Classic',      brand: 'Stax',            brandSlug: 'stax',            price: 'Rs. 1,200', img: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=700&q=85', tag: 'Double smash' },
  { dish: 'Slow-Roast Lamb',       brand: 'Simmer',          brandSlug: 'simmer',          price: 'Rs. 1,950', img: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=700&q=85', tag: '12 hours' },
  { dish: 'Hot Honey Tenders',     brand: 'Flipd',           brandSlug: 'flipd',           price: 'Rs. 950',   img: 'https://images.unsplash.com/photo-1598514983318-2f64f8f4796c?w=700&q=85', tag: '24h brine' },
  { dish: 'Seekh Kebab Bowl',      brand: 'Craveman',        brandSlug: 'craveman',        price: 'Rs. 1,300', img: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=700&q=85', tag: 'Karachi-style' },
  { dish: 'Loaded Bowl',           brand: 'Garnish Station', brandSlug: 'garnish-station', price: 'Rs. 900',   img: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=700&q=85', tag: 'Build your own' },
]

const VOICES: Array<{ brand: string; slug: string; line: string; color: string }> = [
  // Strata retired — same reason as above. Keep the array length ≥ 4 so the
  // hero slice still has enough names to feature on top.
  { brand: 'Simmer',          slug: 'simmer',          line: 'Slow nights, plated softly.',                  color: '#2d4a3e' },
  { brand: 'Stax',            slug: 'stax',            line: 'Smashed, stacked, sauced.',                    color: '#D4581A' },
  { brand: 'Flipd',           slug: 'flipd',           line: 'Buttermilk-brined, hand-breaded, hot.',        color: '#E5A100' },
  { brand: 'Craveman',        slug: 'craveman',        line: 'Karachi comfort food, sorted.',                color: '#F5A623' },
  { brand: 'Garnish Station', slug: 'garnish-station', line: 'You build it. We finish it.',                  color: '#8CB82A' },
]

const REVIEWS = [
  { text: '"Burgers from Stax, a bowl from Strata, tenders from Flipd — three kitchens in one cart. Both arrived hot, in one bag. The multi-kitchen thing actually works."', name: 'Sara K.',  area: 'DHA Phase 6'    },
  { text: '"The Loaded Bowl from Garnish is the only reason my lunch isn\'t depressing anymore. Crisp, dressed right, never soggy."',                                        name: 'Imran R.', area: 'Clifton Block 4' },
  { text: '"Ordered for a family of six — five kitchens in one order, one delivery, no chaos. They figured out the logistics so I didn\'t have to."',                        name: 'Hira M.',  area: 'Bahria Town'    },
]

const INK = '#0a110e'

export function HomeClient({ concepts }: Props) {
  // Hero brand-names auto-cycle through their accent colour every 1.6s. The
  // CEO liked the hover-highlight effect but wanted it to play on its own
  // (no need to mouse over each name). Hovering still works AND pauses the
  // auto-cycle for that name — manual interaction beats automation, but
  // the rest of the time the page does its own little promo loop.
  const heroNames = VOICES.slice(0, 4)
  const [activeIdx, setActiveIdx] = useState(0)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  useEffect(() => {
    // Pause auto-cycle while the user is hovering — they're driving the show.
    if (hoveredIdx !== null) return
    const t = setInterval(() => {
      setActiveIdx((i) => (i + 1) % heroNames.length)
    }, 1600)
    return () => clearInterval(t)
  }, [hoveredIdx, heroNames.length])

  return (
    <div style={{ background: '#fff', color: INK }}>

      {/* ── Promo strip ──────────────────────────────────────────────────── */}
      <div style={{
        background: INK, color: 'white',
        padding: '0.55rem 1rem', textAlign: 'center',
        fontSize: '0.82rem', fontWeight: 500, letterSpacing: '0.02em',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <span style={{ color: 'var(--servd-green)', fontWeight: 700 }}>RS. 200 OFF</span>
        {' '}your first order · code{' '}
        <code style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--servd-green)', padding: '0.1rem 0.4rem', borderRadius: '3px', fontWeight: 700 }}>FRESH200</code>
        {' · '}
        <Link href="/browse" style={{ color: 'rgba(255,255,255,0.6)', textDecoration: 'underline' }}>Order now</Link>
      </div>

      {/* ── HERO — editorial. Brands are the headline. ───────────────────── */}
      <section style={{
        background: INK, color: 'white',
        minHeight: 'min(88vh, 820px)',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        alignItems: 'stretch',
        overflow: 'hidden',
      }}>
        {/* Left — editorial copy */}
        <div style={{
          padding: 'clamp(3rem, 7vw, 6rem) 0 clamp(3rem, 6vw, 5rem)',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          <div className="container" style={{ maxWidth: '640px' }}>
            <p style={{
              fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.42em',
              color: 'var(--servd-green)', textTransform: 'uppercase', marginBottom: '2.5rem',
            }}>
              Karachi · direct from the kitchen
            </p>

            {/* Brand names as the typographic hero — auto-cycling colour
                highlight. Each name lights up in its accent for 1.6s before
                the spotlight moves to the next. Mouse hover overrides the
                cycle for that name. */}
            <div style={{ marginBottom: '3rem' }}>
              {heroNames.map((v, idx) => {
                const isActive = hoveredIdx === idx || (hoveredIdx === null && activeIdx === idx)
                return (
                  <Link key={v.slug} href={`/brand/${v.slug}`} style={{
                    display: 'block', textDecoration: 'none',
                    fontSize: 'clamp(2.25rem, 5.5vw, 4.25rem)',
                    fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1.05,
                    color: isActive ? v.color : 'rgba(255,255,255,0.22)',
                    // Slightly longer transition than the cycle interval's
                    // step so colours bleed rather than snap.
                    transition: 'color 400ms ease',
                  }}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                  >
                    {v.brand}
                  </Link>
                )
              })}
              <p style={{
                fontSize: 'clamp(2.25rem, 5.5vw, 4.25rem)',
                fontWeight: 800, letterSpacing: '-0.04em', lineHeight: 1.05,
                color: 'rgba(255,255,255,0.22)',
              }}>
                + more.
              </p>
            </div>

            <p style={{
              fontSize: 'clamp(1rem, 1.5vw, 1.2rem)',
              color: 'rgba(255,255,255,0.55)', lineHeight: 1.7, fontWeight: 300,
              maxWidth: '32rem', marginBottom: '2.5rem',
            }}>
              Seven kitchens. One cart. Order from any of them together — we cook every dish fresh and deliver in a single bag.
            </p>

            <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
              <Link href="/browse" style={{
                padding: '1rem 2.25rem',
                background: 'var(--servd-green)', color: INK,
                fontWeight: 800, fontSize: '0.95rem',
                letterSpacing: '0.02em', textDecoration: 'none',
                borderRadius: '4px',
              }}>
                Browse kitchens →
              </Link>
              <Link href="#kitchens" style={{
                padding: '1rem 2.25rem',
                background: 'transparent', color: 'rgba(255,255,255,0.65)',
                fontWeight: 600, fontSize: '0.95rem',
                letterSpacing: '0.02em', textDecoration: 'none',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '4px',
              }}>
                See the kitchens
              </Link>
            </div>
          </div>

          {/* Trust figures */}
          <div className="container" style={{ marginTop: '4rem', maxWidth: '640px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              {[
                { value: '7',    label: 'kitchens' },
                { value: '4.8★', label: 'avg rating' },
                { value: '~30m', label: 'avg delivery' },
              ].map((t, i) => (
                <div key={t.label} style={{
                  padding: '1.4rem 0 0',
                  paddingLeft: i > 0 ? '1.5rem' : 0,
                  borderLeft: i > 0 ? '1px solid rgba(255,255,255,0.1)' : 'none',
                  paddingRight: i < 2 ? '1.5rem' : 0,
                }}>
                  <p style={{ fontSize: 'clamp(1.6rem, 3vw, 2.25rem)', fontWeight: 900, letterSpacing: '-0.04em', color: 'white', marginBottom: '0.2rem' }}>{t.value}</p>
                  <p style={{ fontSize: '0.7rem', fontWeight: 600, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{t.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right — food photo mosaic */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', minHeight: 'min(80vh, 720px)' }}>
          {FEATURED.slice(0, 4).map((d, i) => (
            <Link key={d.dish} href={`/brand/${d.brandSlug}`} style={{ position: 'relative', overflow: 'hidden', textDecoration: 'none', display: 'block' }}>
              <img
                src={d.img}
                alt={d.dish}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transition: 'transform 0.5s ease' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLImageElement).style.transform = 'scale(1.06)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLImageElement).style.transform = 'scale(1)' }}
              />
              <div style={{
                position: 'absolute', inset: 0,
                background: i % 2 === 0
                  ? 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, transparent 60%)'
                  : 'linear-gradient(315deg, rgba(0,0,0,0.35) 0%, transparent 60%)',
              }} />
              <div style={{ position: 'absolute', bottom: '0.85rem', left: '0.85rem' }}>
                <p style={{ fontSize: '0.6rem', fontWeight: 700, color: 'rgba(255,255,255,0.65)', letterSpacing: '0.18em', textTransform: 'uppercase' }}>{d.brand}</p>
                <p style={{ fontSize: '0.82rem', fontWeight: 700, color: 'white' }}>{d.dish}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── The kitchens — brands are the product ───────────────────────── */}
      <section id="kitchens" style={{ padding: 'clamp(3rem, 7vw, 6rem) 0', borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '2.5rem', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                The kitchens
              </p>
              <h2 style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 300, letterSpacing: '0.02em', lineHeight: 1.1 }}>
                Seven brands. One order.
              </h2>
            </div>
            <Link href="/browse" style={{
              fontSize: '0.82rem', fontWeight: 600, letterSpacing: '0.22em',
              textTransform: 'uppercase', color: INK, textDecoration: 'none',
              borderBottom: '1px solid var(--servd-green)', paddingBottom: '0.2rem',
            }}>
              Browse all →
            </Link>
          </div>

          {concepts.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center', border: '1px solid var(--servd-line)' }}>
              <p style={{ color: 'var(--servd-mute)' }}>Loading kitchens…</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1.25rem' }}>
              {concepts.map((c) => <BrandCard key={c.id} concept={c} />)}
            </div>
          )}
        </div>
      </section>

      {/* ── Tonight's picks — food photography, no emoji ─────────────────── */}
      <section style={{ padding: 'clamp(3rem, 7vw, 6rem) 0', background: '#fafaf9', borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '2.5rem' }}>
            <div>
              <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                Worth ordering tonight
              </p>
              <h2 style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 300, letterSpacing: '0.02em', lineHeight: 1.1 }}>
                The food.
              </h2>
            </div>
            <Link href="/browse" style={{ fontSize: '0.82rem', fontWeight: 600, letterSpacing: '0.22em', textTransform: 'uppercase', color: INK, textDecoration: 'none', borderBottom: '1px solid var(--servd-green)', paddingBottom: '0.2rem' }}>
              Full menus →
            </Link>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1.25rem' }}>
            {FEATURED.map((d) => (
              <Link key={d.dish} href={`/brand/${d.brandSlug}`} style={{
                textDecoration: 'none', color: 'inherit',
                display: 'flex', flexDirection: 'column',
                background: 'white', border: '1px solid var(--servd-line)',
              }}>
                <div style={{ aspectRatio: '4/3', overflow: 'hidden', position: 'relative' }}>
                  <img src={d.img} alt={d.dish} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  {d.tag && (
                    <div style={{
                      position: 'absolute', top: '0.75rem', left: '0.75rem',
                      background: 'white', color: INK,
                      fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.1em',
                      textTransform: 'uppercase', padding: '0.25rem 0.6rem',
                    }}>
                      {d.tag}
                    </div>
                  )}
                </div>
                <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <p style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--servd-mute)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
                    {d.brand}
                  </p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.01em' }}>{d.dish}</h3>
                    <span style={{ fontSize: '0.95rem', fontWeight: 700, color: INK, whiteSpace: 'nowrap' }}>{d.price}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── Insiders — platform-level perks and cross-kitchen deals ────── */}
      <section style={{
        padding: 'clamp(3rem, 7vw, 6rem) 0',
        background: `linear-gradient(180deg, ${INK} 0%, #1a1f1a 100%)`,
        color: 'white',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div className="container">
          <div style={{ marginBottom: '2.5rem' }}>
            <h2 style={{
              fontSize: 'clamp(3.5rem, 12vw, 9rem)',
              fontWeight: 900,
              letterSpacing: '-0.05em',
              lineHeight: 0.9,
              color: 'var(--servd-green)',
              textTransform: 'uppercase',
              margin: 0,
            }}>
              INSIDERS.
            </h2>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
              <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '1rem', maxWidth: '36rem', lineHeight: 1.5 }}>
                Cross-kitchen bundles, points multipliers, member-only unlocks. Earn at any kitchen, spend at any kitchen.{' '}
                <Link href="/account" style={{ color: 'var(--servd-green)', textDecoration: 'underline' }}>Become a member →</Link>
              </p>
              <Link href="/browse" style={{
                padding: '0.7rem 1.25rem', fontSize: '0.9rem', fontWeight: 800,
                color: INK, background: 'var(--servd-green)',
                borderRadius: '999px', textDecoration: 'none', whiteSpace: 'nowrap',
              }}>
                See all perks →
              </Link>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
            {[
              { badge: 'MEMBER',   title: '2× points Tuesdays',      body: 'Every order, every kitchen, every Tuesday earns double servd points.',                   cta: 'Activate',        color: 'var(--servd-green)' },
              { badge: 'BUNDLE',   title: 'Family Feast',             body: '4 meals from any 3 kitchens · Rs. 2,499',                                               subtext: 'Save Rs. 600 vs ordering separately', cta: 'Build my feast',  color: '#f59e0b' },
              { badge: 'NEW',      title: 'Rs. 200 off first order',  body: 'Code FRESH200 · plus free delivery · plus 100 servd points to start.',                  cta: 'Use FRESH200',    color: 'var(--servd-green)' },
              { badge: 'LATE',     title: 'After-10pm unlock',        body: 'Member-only late menu — extended hours from Stax, Garnish Station, and Craveman.',      cta: 'Join to unlock',  color: '#a855f7' },
              { badge: 'COMBO',    title: 'Mix Two, Free Side',       body: 'Any two mains across kitchens — fries / salad / kheer on the house.',                   cta: 'Mix & match',     color: '#0ea5e9' },
              { badge: 'BIRTHDAY', title: 'Free dessert, your week',  body: 'Dessert on us from any kitchen — every year, on your birthday week.',                   cta: 'Set my birthday', color: '#ec4899' },
            ].map((d) => (
              <Link
                key={d.title}
                href="/browse"
                style={{
                  display: 'flex', flexDirection: 'column', gap: '0.6rem',
                  padding: '1.5rem 1.4rem',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '12px',
                  textDecoration: 'none', color: 'white',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = d.color; e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
              >
                <span style={{
                  alignSelf: 'flex-start', fontSize: '0.62rem', fontWeight: 800,
                  letterSpacing: '0.2em', color: d.color,
                  border: `1px solid ${d.color}55`, padding: '0.2rem 0.55rem', borderRadius: '4px',
                }}>
                  {d.badge}
                </span>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 800, letterSpacing: '-0.01em', color: 'white' }}>{d.title}</h3>
                <p style={{ fontSize: '0.88rem', color: 'rgba(255,255,255,0.65)', lineHeight: 1.45 }}>{d.body}</p>
                {'subtext' in d && d.subtext && <p style={{ fontSize: '0.78rem', color: d.color, fontWeight: 700 }}>{d.subtext}</p>}
                <span style={{ marginTop: 'auto', fontSize: '0.85rem', fontWeight: 800, color: d.color, paddingTop: '0.5rem' }}>{d.cta} →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── The brands, in their own words ───────────────────────────────── */}
      <section style={{ padding: 'clamp(3rem, 7vw, 6rem) 0', background: INK, color: 'white', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="container">
          <p style={{ color: 'var(--servd-green)', fontWeight: 600, fontSize: '0.7rem', letterSpacing: '0.32em', textTransform: 'uppercase', marginBottom: '2.5rem' }}>
            Each kitchen, in its own words
          </p>
          <div>
            {VOICES.map((v, i) => (
              <Link
                key={v.slug}
                href={`/brand/${v.slug}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(160px, 0.35fr) 1fr auto',
                  gap: '1.5rem',
                  alignItems: 'baseline',
                  padding: '1.25rem 0',
                  borderTop: '1px solid rgba(255,255,255,0.08)',
                  borderBottom: i === VOICES.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                  textDecoration: 'none',
                  color: 'white',
                }}
              >
                <h3 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', fontWeight: 700, letterSpacing: '-0.03em', color: v.color }}>
                  {v.brand}
                </h3>
                <p style={{ fontSize: 'clamp(0.9rem, 1.5vw, 1.1rem)', color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', fontWeight: 300, lineHeight: 1.4 }}>
                  {v.line}
                </p>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: v.color, letterSpacing: '0.1em', whiteSpace: 'nowrap' }}>
                  Order →
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── How servd works — three things, simply said ──────────────────── */}
      <section style={{ padding: 'clamp(3rem, 7vw, 6rem) 0', borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
            How it works
          </p>
          <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', fontWeight: 300, letterSpacing: '0.02em', marginBottom: '3rem', maxWidth: '32rem' }}>
            One cart across as many kitchens as you want.
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0' }}>
            {[
              { num: '01', title: 'Pick your kitchens', body: 'Browse seven brands. Add dishes from any of them to a single cart — there\'s no switching between apps.' },
              { num: '02', title: 'One checkout', body: 'One order, one delivery fee, one driver. We coordinate the kitchen timing so everything arrives hot.' },
              { num: '03', title: 'Fresh, to your door', body: 'Nothing leaves the kitchen early. Your order is cooked when it\'s time to go, not when it\'s convenient.' },
            ].map((s, i) => (
              <div key={s.num} style={{ padding: '0 3rem 0 0', borderLeft: i > 0 ? '1px solid var(--servd-line)' : 'none', paddingLeft: i > 0 ? '3rem' : 0 }}>
                <p style={{ fontSize: '2.5rem', fontWeight: 900, color: 'var(--servd-green)', letterSpacing: '-0.06em', lineHeight: 1, marginBottom: '1.25rem' }}>{s.num}</p>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, letterSpacing: '-0.01em', marginBottom: '0.5rem' }}>{s.title}</h3>
                <p style={{ color: 'var(--servd-mute)', fontSize: '0.92rem', lineHeight: 1.55 }}>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Social proof ─────────────────────────────────────────────────── */}
      <section style={{ padding: 'clamp(3rem, 7vw, 6rem) 0', borderBottom: '1px solid var(--servd-line)', background: '#fafaf9' }}>
        <div className="container">
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '0.5rem', textAlign: 'center' }}>
            From regulars
          </p>
          <h2 style={{ fontSize: 'clamp(1.75rem, 3.5vw, 2.5rem)', fontWeight: 300, letterSpacing: '0.02em', textAlign: 'center', marginBottom: '2.5rem' }}>
            What the table says.
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
            {REVIEWS.map((r, i) => (
              <div key={i} style={{
                background: 'white', border: '1px solid var(--servd-line)',
                padding: '2rem 1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem',
              }}>
                <div style={{ color: '#c9a961', letterSpacing: '0.1em', fontSize: '0.9rem' }} aria-label="5 stars">★★★★★</div>
                <p style={{ fontSize: '0.97rem', lineHeight: 1.65, color: INK, fontStyle: 'italic' }}>{r.text}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', marginTop: 'auto' }}>
                  <div style={{ width: '2.2rem', height: '2.2rem', borderRadius: '50%', background: 'var(--servd-green-soft)', color: 'var(--servd-green-dark)', fontWeight: 800, display: 'grid', placeItems: 'center', fontSize: '0.85rem' }}>
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

      {/* ── Pull quote ───────────────────────────────────────────────────── */}
      <section style={{ padding: 'clamp(4rem, 8vw, 7rem) 0', background: INK, color: 'white' }}>
        <div className="container" style={{ textAlign: 'center', maxWidth: '48rem' }}>
          <p style={{ color: 'var(--servd-green)', fontWeight: 600, fontSize: '0.7rem', letterSpacing: '0.28em', textTransform: 'uppercase', marginBottom: '1.75rem' }}>
            The point of servd
          </p>
          <p style={{ fontSize: 'clamp(1.5rem, 3.5vw, 2.5rem)', fontWeight: 300, lineHeight: 1.45, letterSpacing: '0.01em', color: 'rgba(255,255,255,0.85)' }}>
            Smashburger for you, karahi for your wife,<br />
            grain bowl for the friend who&rsquo;s &ldquo;being good&rdquo;.<br />
            <span style={{ color: 'var(--servd-green)', fontWeight: 600 }}>One cart. One driver. One bag.</span>
          </p>
          <div style={{ marginTop: '3rem', display: 'flex', justifyContent: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
            <Link href="/browse" style={{
              padding: '1rem 2.25rem',
              background: 'var(--servd-green)', color: INK,
              fontWeight: 700, fontSize: '0.9rem',
              letterSpacing: '0.04em', textTransform: 'uppercase',
              textDecoration: 'none', borderRadius: '4px',
            }}>
              Start an order →
            </Link>
          </div>
        </div>
      </section>

      {/* ── How to reach us ──────────────────────────────────────────────── */}
      <section style={{ padding: 'clamp(2.5rem, 5vw, 4rem) 0', borderTop: '1px solid var(--servd-line)' }}>
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0' }}>
            {[
              { kicker: 'Delivery', title: 'Order in',  body: 'Direct from any kitchen.', cta: 'Browse kitchens', href: '/browse' },
              { kicker: 'Dine-in',  title: 'Come sit',  body: 'Table service at Simmer.',  cta: 'Reserve a table',  href: '/reserve/simmer' },
              { kicker: 'Walk-up',  title: 'Walk up',   body: 'Garnish Station at events and the padel court.', cta: 'Find the cart', href: '/brand/garnish-station' },
            ].map((card, i) => (
              <Link key={card.title} href={card.href} style={{
                padding: '2rem',
                paddingLeft: i === 0 ? 0 : '2rem',
                borderLeft: i > 0 ? '1px solid var(--servd-line)' : 'none',
                textDecoration: 'none', color: 'inherit',
                display: 'flex', flexDirection: 'column', gap: '0.4rem',
              }}>
                <p style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.2em', color: 'var(--servd-mute)', textTransform: 'uppercase' }}>{card.kicker}</p>
                <h3 style={{ fontSize: '1.3rem', fontWeight: 600, letterSpacing: '-0.02em' }}>{card.title}</h3>
                <p style={{ color: 'var(--servd-mute)', fontSize: '0.88rem', lineHeight: 1.4 }}>{card.body}</p>
                <span style={{ marginTop: '0.75rem', fontWeight: 700, color: 'var(--servd-green-dark)', fontSize: '0.82rem' }}>{card.cta} →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

    </div>
  )
}

function BrandCard({ concept }: { concept: Concept }) {
  return (
    <Link
      href={`/brand/${concept.slug}`}
      aria-label={`Visit ${concept.name}`}
      style={{
        textDecoration: 'none', color: 'inherit',
        display: 'flex', flexDirection: 'column',
        border: '1px solid var(--servd-line)',
        background: 'white',
        overflow: 'hidden',
      }}
    >
      <div style={{
        aspectRatio: '4/3', position: 'relative', overflow: 'hidden',
        background: `${concept.primaryColor ?? 'var(--servd-green-dark)'}`,
      }}>
        <img
          src={conceptHeroImage(concept)}
          alt={concept.name}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.6) 100%)' }} />
        <div style={{
          position: 'absolute', top: '0.85rem', left: '0.85rem',
          background: 'rgba(255,255,255,0.92)', color: INK,
          fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', padding: '0.25rem 0.6rem',
        }}>
          {typeIcon(concept.type)} {typeLabel(concept.type)}
        </div>
      </div>
      <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <h3 style={{ fontSize: '1.15rem', fontWeight: 700, letterSpacing: '-0.01em' }}>{concept.name}</h3>
        {concept.description && (
          <p style={{ color: 'var(--servd-mute)', fontSize: '0.875rem', lineHeight: 1.4 }}>
            {concept.description}
          </p>
        )}
      </div>
    </Link>
  )
}
