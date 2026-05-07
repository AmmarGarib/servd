'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { PromoBar } from '../parts/PromoBar'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { BottomCTA } from '../parts/BottomCTA'

// Bukhari — heritage Pakistani. Saffron rice, lamb on the bone, family
// portions. Deep maroon + cream + saffron palette; classical serif feel via
// wide letter-spacing on titles; long-form story; family-platter focus;
// celebrations / catering inquiry as a lead path.

interface Props {
  concept: Concept
  concepts: Concept[]
}

const BUKHARI_MAROON  = '#7a1f24'
const BUKHARI_SAFFRON = '#e0a526'
const BUKHARI_INK     = '#2a1213'
const BUKHARI_CREAM   = '#fbf3e3'

const FAMILY_PLATTERS = [
  { name: 'Lamb Bukhari Rice',  body: 'Saffron rice · lamb on the bone · raita · salad. Slow-cooked over coals.', feeds: '2', price: 1650, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=600&q=85' },
  { name: 'Chicken Bukhari',    body: 'Slow-cooked chicken, fragrant rice, raita.',                                feeds: '1–2', price: 1250, img: 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=600&q=85' },
  { name: 'Family Platter',     body: 'Lamb · chicken · rice · sides · raita · kheer.',                            feeds: '4', price: 3250, img: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&q=85' },
  { name: 'The Wedding Tray',   body: 'Whole leg of lamb · biryani rice · 6 sides · 2 desserts. 24h notice.',      feeds: '8–10', price: 9800, img: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=600&q=85' },
]

const HERITAGE = [
  { era: '1953', body: 'Family kitchen, Saddar. Recipes from the Bukhara region passed down by the matriarch — Apa.' },
  { era: '1991', body: 'Second-generation hands take the recipes commercial; a single takeaway counter opens in Clifton.' },
  { era: '2024', body: 'Third generation brings Bukhari to the servd platform. Same recipes. Same brass dishes. Now to your door.' },
]

export function BukhariLayout({ concept, concepts }: Props) {
  return (
    <div style={{ background: BUKHARI_CREAM, color: BUKHARI_INK }}>
      <PromoBar brandName={concept.name} brandSlug={concept.slug} accent={BUKHARI_SAFFRON} />

      {/* HERO — gold-on-maroon, ornamental serif feel */}
      <section style={{
        position: 'relative',
        background: `linear-gradient(180deg, ${BUKHARI_MAROON} 0%, ${BUKHARI_INK} 100%)`,
        color: BUKHARI_CREAM,
        padding: 'clamp(4rem, 9vw, 7rem) 0',
        overflow: 'hidden',
      }}>
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at 80% 20%, ${BUKHARI_SAFFRON}33 0%, transparent 40%), radial-gradient(circle at 10% 80%, ${BUKHARI_SAFFRON}1a 0%, transparent 35%)`,
        }} />
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '4rem', alignItems: 'center' }}>

            {/* Left: heritage copy */}
            <div style={{ textAlign: 'center' }}>
              <p style={{ color: BUKHARI_SAFFRON, fontWeight: 600, fontSize: '0.75rem', letterSpacing: '0.6em', textTransform: 'uppercase', marginBottom: '2rem' }}>
                est. 1953 · Saddar · Karachi
              </p>
              <p style={{ color: BUKHARI_SAFFRON, fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic', fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', marginBottom: '0.75rem', fontWeight: 400 }}>
                ﷽
              </p>
              <h1 style={{
                fontFamily: 'Georgia, "Times New Roman", serif',
                fontSize: 'clamp(3rem, 9vw, 7rem)',
                fontWeight: 400,
                letterSpacing: '0.04em',
                lineHeight: 1.05,
                margin: 0,
                color: BUKHARI_CREAM,
              }}>
                Saffron. Lamb.<br /><em style={{ fontStyle: 'italic', color: BUKHARI_SAFFRON }}>Heritage.</em>
              </h1>
              <p style={{ marginTop: '2rem', fontSize: 'clamp(1.05rem, 1.6vw, 1.3rem)', lineHeight: 1.7, color: 'rgba(251,243,227,0.78)', fontWeight: 300, maxWidth: '40rem', marginInline: 'auto' }}>
                {concept.name} is the heritage menu — saffron rice, lamb on the bone, slow-cook patience. Built for the table. Served for the family. Made the way Apa made it, every time, without exception.
              </p>
              <div style={{ marginTop: '3rem', display: 'flex', justifyContent: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
                <Link href={`/${concept.slug}`} style={{
                  padding: '1.1rem 2.25rem',
                  background: BUKHARI_SAFFRON,
                  color: BUKHARI_INK,
                  fontWeight: 700,
                  fontSize: '0.9rem',
                  letterSpacing: '0.24em',
                  textTransform: 'uppercase',
                  textDecoration: 'none',
                  border: `1px solid ${BUKHARI_SAFFRON}`,
                }}>
                  Order tonight
                </Link>
                <Link href="#celebrations" style={{
                  padding: '1.1rem 2.25rem',
                  background: 'transparent',
                  color: BUKHARI_CREAM,
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  letterSpacing: '0.24em',
                  textTransform: 'uppercase',
                  textDecoration: 'none',
                  border: `1px solid ${BUKHARI_CREAM}55`,
                }}>
                  For celebrations
                </Link>
              </div>
            </div>

            {/* Right: signature dish image */}
            <div style={{ borderRadius: '8px', overflow: 'hidden', border: `2px solid ${BUKHARI_SAFFRON}44`, boxShadow: `0 24px 64px rgba(0,0,0,0.5)` }}>
              <img
                src="https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800&q=85"
                alt="Lamb Bukhari Rice — saffron rice, lamb on the bone"
                style={{ width: '100%', display: 'block', aspectRatio: '4/3', objectFit: 'cover' }}
              />
              <div style={{ background: BUKHARI_INK, padding: '1rem 1.25rem', borderTop: `1px solid ${BUKHARI_SAFFRON}33` }}>
                <p style={{ fontFamily: 'Georgia, serif', fontSize: '1rem', color: BUKHARI_CREAM, fontStyle: 'italic' }}>Lamb Bukhari Rice · Rs. 1,650</p>
                <p style={{ fontSize: '0.78rem', color: `${BUKHARI_CREAM}66`, marginTop: '0.2rem' }}>Slow-cooked over coals · serves 2</p>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* THE TABLE — family platters as the primary product */}
      <section style={{ padding: 'clamp(4rem, 8vw, 6rem) 0', borderBottom: `1px solid ${BUKHARI_MAROON}26` }}>
        <div className="container">
          <div style={{ textAlign: 'center', marginBottom: '3.5rem', maxWidth: '36rem', marginInline: 'auto' }}>
            <p style={{ color: BUKHARI_MAROON, fontWeight: 600, fontSize: '0.7rem', letterSpacing: '0.4em', textTransform: 'uppercase', marginBottom: '0.85rem' }}>
              The family table
            </p>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: 'clamp(2rem, 4.5vw, 3rem)', fontWeight: 400, letterSpacing: '0.02em', lineHeight: 1.15, margin: 0 }}>
              Built to feed <em style={{ color: BUKHARI_MAROON }}>the people you love.</em>
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
            {FAMILY_PLATTERS.map((p) => (
              <Link key={p.name} href={`/${concept.slug}`} style={{
                display: 'flex', flexDirection: 'column',
                background: 'white',
                border: `1px solid ${BUKHARI_MAROON}26`,
                textDecoration: 'none', color: 'inherit',
                overflow: 'hidden',
                position: 'relative',
              }}>
                <div style={{ aspectRatio: '16/9', overflow: 'hidden', position: 'relative' }}>
                  <img src={p.img} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  <div aria-hidden="true" style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0, height: '3px',
                    background: `linear-gradient(90deg, ${BUKHARI_MAROON}, ${BUKHARI_SAFFRON}, ${BUKHARI_MAROON})`,
                  }} />
                </div>
                <div style={{ padding: '1.75rem' }}>
                  <p style={{ fontSize: '0.7rem', fontWeight: 600, color: BUKHARI_SAFFRON, letterSpacing: '0.32em', textTransform: 'uppercase', marginBottom: '0.85rem' }}>
                    Feeds {p.feeds}
                  </p>
                  <h3 style={{ fontFamily: 'Georgia, serif', fontSize: '1.4rem', fontWeight: 500, letterSpacing: '0.01em', marginBottom: '0.6rem' }}>
                    {p.name}
                  </h3>
                  <p style={{ fontSize: '0.92rem', color: `${BUKHARI_INK}99`, fontStyle: 'italic', lineHeight: 1.6, marginBottom: '1.5rem' }}>{p.body}</p>
                  <p style={{ marginTop: 'auto', fontSize: '1.5rem', fontWeight: 600, color: BUKHARI_MAROON, letterSpacing: '0.02em' }}>
                    Rs. {p.price.toLocaleString()}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* THE HERITAGE — three-era timeline, long-form */}
      <section style={{ padding: 'clamp(4rem, 8vw, 7rem) 0', background: BUKHARI_MAROON, color: BUKHARI_CREAM }}>
        <div className="container">
          <div style={{ textAlign: 'center', marginBottom: '4rem' }}>
            <p style={{ color: BUKHARI_SAFFRON, fontWeight: 600, fontSize: '0.7rem', letterSpacing: '0.4em', textTransform: 'uppercase', marginBottom: '1rem' }}>
              Three generations
            </p>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: 'clamp(2rem, 4.5vw, 3rem)', fontWeight: 400, letterSpacing: '0.02em', lineHeight: 1.15, margin: 0 }}>
              A recipe doesn&rsquo;t go anywhere<br /><em style={{ color: BUKHARI_SAFFRON }}>without the cook.</em>
            </h2>
          </div>

          <div style={{ maxWidth: '38rem', marginInline: 'auto', display: 'flex', flexDirection: 'column', gap: '0' }}>
            {HERITAGE.map((h, i) => (
              <div key={h.era} style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '2rem',
                paddingTop: i === 0 ? 0 : '2rem',
                paddingBottom: '2rem',
                borderBottom: i === HERITAGE.length - 1 ? 'none' : '1px solid rgba(251,243,227,0.18)',
              }}>
                <span style={{
                  fontFamily: 'Georgia, serif',
                  fontSize: '2rem',
                  fontWeight: 400,
                  color: BUKHARI_SAFFRON,
                  letterSpacing: '0.04em',
                  minWidth: '4.5rem',
                }}>{h.era}</span>
                <p style={{ fontSize: '1.05rem', lineHeight: 1.75, color: 'rgba(251,243,227,0.85)', fontWeight: 300 }}>{h.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CELEBRATIONS — catering inquiry path */}
      <section id="celebrations" style={{ padding: 'clamp(4rem, 8vw, 6rem) 0' }}>
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '3rem', alignItems: 'center', maxWidth: '54rem', marginInline: 'auto' }}>
            <div>
              <p style={{ color: BUKHARI_MAROON, fontWeight: 600, fontSize: '0.7rem', letterSpacing: '0.4em', textTransform: 'uppercase', marginBottom: '1rem' }}>
                Celebrations · catering
              </p>
              <h2 style={{ fontFamily: 'Georgia, serif', fontSize: 'clamp(1.75rem, 4vw, 2.5rem)', fontWeight: 400, letterSpacing: '0.02em', lineHeight: 1.2 }}>
                Engagements. Eid. Mehndi.<br /><em style={{ color: BUKHARI_MAROON }}>The gathering kitchen.</em>
              </h2>
              <p style={{ marginTop: '1.25rem', fontSize: '1rem', color: `${BUKHARI_INK}cc`, lineHeight: 1.7 }}>
                We&rsquo;ve catered every milestone you can name. 24 hours of notice for the wedding tray; 48 hours for trays of 30+. Brass platters delivered, picked up the morning after. Family pricing on family-size orders.
              </p>
              <Link href={`/${concept.slug}`} style={{
                display: 'inline-block',
                marginTop: '1.75rem',
                padding: '1rem 2rem',
                background: BUKHARI_MAROON,
                color: BUKHARI_CREAM,
                fontWeight: 700,
                fontSize: '0.85rem',
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                textDecoration: 'none',
              }}>
                Inquire for an event
              </Link>
            </div>

            <div style={{
              background: 'white',
              border: `1px solid ${BUKHARI_MAROON}33`,
              padding: '2rem 1.75rem',
            }}>
              <p style={{ fontSize: '0.7rem', fontWeight: 600, color: BUKHARI_SAFFRON, letterSpacing: '0.32em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>
                Notice required
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {[
                  { for: 'Family Platter (4)',     time: 'Same day · 60 min lead' },
                  { for: 'Wedding Tray (8–10)',    time: '24 hours' },
                  { for: 'Catering · 30+',         time: '48 hours' },
                  { for: 'Brass-platter rental',   time: 'On request' },
                ].map((s) => (
                  <li key={s.for} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '1rem', paddingBottom: '0.75rem', borderBottom: `1px solid ${BUKHARI_MAROON}1a` }}>
                    <span style={{ fontFamily: 'Georgia, serif', fontSize: '0.95rem', fontWeight: 500 }}>{s.for}</span>
                    <span style={{ fontSize: '0.85rem', color: BUKHARI_MAROON, fontStyle: 'italic' }}>{s.time}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <CrossBrandStrip current={concept} concepts={concepts} accent={BUKHARI_SAFFRON} kicker="On the same platform" heading="Different night, different kitchen." />
      <BottomCTA brandName={concept.name} brandSlug={concept.slug} accent={BUKHARI_MAROON} />
    </div>
  )
}
