'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { PromoBar } from '../parts/PromoBar'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { BottomCTA } from '../parts/BottomCTA'
import { OpenStatusBadge, useHoursData } from '../parts/OpenStatusBadge'

// StaxLayout — formerly FlipdLayout. Per CEO 2026-05-12: the lighter,
// hand-drawn cream + mustard design originally drawn for Flipd reads
// better on Stax, so the layout was moved here. Warm cream + mustard
// yellow + smoke black, tilted cards, pencil borders. Family-pack
// section drives bulk conversion.
//
// Heads-up: the hardcoded PIECES + BUCKETS data below still references
// Flipd's chicken menu ("Hot Honey Tenders", "buttermilk brine", etc.).
// Re-author the product copy from /content/{slug} (storefront CMS) to
// match Stax's burger build-your-own pitch.

interface Props {
  concept: Concept
  concepts: Concept[]
}

const FLIPD_MUSTARD = '#E5A100'
const FLIPD_CREAM   = '#fcf6e8'
const FLIPD_BLACK   = '#1a1410'
const FLIPD_RED     = '#b8351c'

const PIECES = [
  { name: 'Classic Crispy Sandwich',    price: 890,  emoji: '🥪', body: 'Buttermilk-brined breast, pickles, brioche, Flipd sauce.' },
  { name: 'Hot Honey Tenders (4 pc)',   price: 950,  emoji: '🍗', body: 'Hand-breaded tenders, hot honey drizzle. The fan favourite.' },
  { name: 'Loaded Chicken Fries',       price: 1050, emoji: '🍟', body: 'Fries, cheese, jalapeño, tender pieces, ranch.' },
  { name: 'Smoked Maple Sandwich',      price: 990,  emoji: '🥪', body: 'Cherry-wood smoke, maple glaze, jalapeño slaw.' },
]

const BUCKETS = [
  { name: 'The Lunch Bucket',  feeds: 1, body: 'Sandwich + fries + drink. Done.', price: 1200, badge: 'Solo' },
  { name: 'The Squad Bucket',  feeds: 3, body: '3 sandwiches · 8 tenders · 2 large fries · 4 sauces.', price: 3450, badge: 'Most ordered' },
  { name: 'The Family Coop',   feeds: 5, body: '5 sandwiches · 16 tenders · large fries · slaw · 6 sauces.', price: 5800, badge: 'Save Rs. 600' },
  { name: 'The Tender Trove',  feeds: 4, body: '20 tenders · 4 sauces · 2 large fries · pickles. Tender-only menu.', price: 4500, badge: 'Tender-heads' },
]

export function StaxLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  return (
    <div style={{ background: FLIPD_CREAM, color: FLIPD_BLACK }}>
      <PromoBar brandName={concept.name} brandSlug={concept.slug} accent={FLIPD_MUSTARD} />

      {/* HERO — friendly slab + butcher-paper feel */}
      <section style={{
        position: 'relative',
        padding: 'clamp(3rem, 7vw, 5rem) 0 clamp(2.5rem, 5vw, 4rem)',
        background: `repeating-linear-gradient(45deg, ${FLIPD_CREAM} 0 12px, ${FLIPD_MUSTARD}0c 12px 24px)`,
        borderBottom: `3px solid ${FLIPD_BLACK}`,
      }}>
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '3rem', alignItems: 'center' }}>
            <div>
              <p style={{ color: FLIPD_RED, fontWeight: 800, fontSize: '0.78rem', letterSpacing: '0.24em', textTransform: 'uppercase', marginBottom: '1rem' }}>
                Buttermilk · brined · for 24 hours · no shortcut
              </p>
              <h1 style={{
                fontSize: 'clamp(3rem, 9vw, 7rem)',
                fontWeight: 900,
                letterSpacing: '-0.04em',
                lineHeight: 0.92,
                margin: 0,
                color: FLIPD_BLACK,
              }}>
                Hot. Crispy.<br />
                <span style={{ color: FLIPD_MUSTARD, textShadow: `2px 2px 0 ${FLIPD_BLACK}` }}>Hand-breaded.</span>
              </h1>
              <div style={{ marginTop: '1rem' }}>
                <OpenStatusBadge hoursData={hoursData} accentColor={FLIPD_MUSTARD} />
              </div>
              <p style={{ marginTop: '1.5rem', fontSize: '1.1rem', color: `${FLIPD_BLACK}cc`, lineHeight: 1.55, maxWidth: '34rem' }}>
                Every piece made-to-order. Brioche pressed on the flat-top. Hot honey drizzled in front of you. {concept.name} doesn&rsquo;t reheat. {concept.name} doesn&rsquo;t apologise.
              </p>
              <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Link href={`/${concept.slug}`} style={{
                  padding: '1.1rem 2rem',
                  background: FLIPD_BLACK,
                  color: FLIPD_MUSTARD,
                  fontWeight: 900,
                  fontSize: '1rem',
                  textDecoration: 'none',
                  borderRadius: '4px',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  border: `3px solid ${FLIPD_BLACK}`,
                  boxShadow: `4px 4px 0 0 ${FLIPD_MUSTARD}`,
                }}>
                  Pick a piece →
                </Link>
                <Link href="#buckets" style={{
                  padding: '1.1rem 2rem',
                  background: FLIPD_MUSTARD,
                  color: FLIPD_BLACK,
                  fontWeight: 900,
                  fontSize: '1rem',
                  textDecoration: 'none',
                  borderRadius: '4px',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  border: `3px solid ${FLIPD_BLACK}`,
                  boxShadow: `4px 4px 0 0 ${FLIPD_BLACK}`,
                }}>
                  Family bucket
                </Link>
              </div>
            </div>

            <div style={{
              background: 'white',
              border: `3px solid ${FLIPD_BLACK}`,
              borderRadius: '4px',
              padding: '2rem',
              transform: 'rotate(-1.2deg)',
              boxShadow: `8px 8px 0 0 ${FLIPD_MUSTARD}`,
            }}>
              <p style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.32em', color: FLIPD_RED, textTransform: 'uppercase', marginBottom: '1rem' }}>
                What&rsquo;s on the spec
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                {[
                  { num: '24h', label: 'buttermilk + spice brine' },
                  { num: '7×',  label: 'hand-bread, never machine' },
                  { num: '180°', label: 'fryer temp, every single piece' },
                  { num: '0',   label: 'reheats. ever.' },
                ].map((s) => (
                  <li key={s.num} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '1rem', alignItems: 'baseline' }}>
                    <span style={{ fontSize: '1.6rem', fontWeight: 900, color: FLIPD_MUSTARD, letterSpacing: '-0.02em', minWidth: '3rem' }}>{s.num}</span>
                    <span style={{ fontSize: '0.95rem', color: FLIPD_BLACK }}>{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* THE LINEUP */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5rem) 0', borderBottom: `3px solid ${FLIPD_BLACK}` }}>
        <div className="container">
          <h2 style={{
            fontSize: 'clamp(2rem, 5vw, 3.5rem)',
            fontWeight: 900,
            letterSpacing: '-0.03em',
            textTransform: 'uppercase',
            marginBottom: '0.75rem',
          }}>
            The lineup
          </h2>
          <p style={{ color: `${FLIPD_BLACK}99`, fontSize: '1rem', marginBottom: '2.5rem', maxWidth: '36rem' }}>
            Tap any piece — your basket follows you into checkout.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.25rem' }}>
            {PIECES.map((p, i) => (
              <Link key={p.name} href={`/${concept.slug}`} style={{
                display: 'flex', flexDirection: 'column',
                background: 'white', border: `2px solid ${FLIPD_BLACK}`,
                borderRadius: '4px', textDecoration: 'none', color: 'inherit',
                overflow: 'hidden',
                transform: `rotate(${(i % 2 === 0 ? -0.5 : 0.5)}deg)`,
                boxShadow: `4px 4px 0 0 ${FLIPD_MUSTARD}`,
              }}>
                <div style={{ aspectRatio: '4/3', background: `linear-gradient(135deg, ${FLIPD_MUSTARD} 0%, ${FLIPD_RED} 100%)`, display: 'grid', placeItems: 'center', fontSize: '4.5rem' }}>
                  <span aria-hidden="true">{p.emoji}</span>
                </div>
                <div style={{ padding: '1.25rem 1.4rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 900, letterSpacing: '-0.01em' }}>{p.name}</h3>
                    <span style={{ fontSize: '0.95rem', fontWeight: 900, color: FLIPD_RED, whiteSpace: 'nowrap' }}>Rs. {p.price.toLocaleString()}</span>
                  </div>
                  <p style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: `${FLIPD_BLACK}99`, lineHeight: 1.5 }}>{p.body}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* BUCKETS — the conversion path. Family bucket front and center. */}
      <section id="buckets" style={{ padding: 'clamp(3rem, 7vw, 5rem) 0', background: FLIPD_BLACK, color: FLIPD_CREAM }}>
        <div className="container">
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '2.5rem' }}>
            <div>
              <p style={{ color: FLIPD_MUSTARD, fontWeight: 800, fontSize: '0.78rem', letterSpacing: '0.32em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                Buckets · made for groups
              </p>
              <h2 style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', fontWeight: 900, letterSpacing: '-0.03em', textTransform: 'uppercase', lineHeight: 1.05 }}>
                Order for the<br /><span style={{ color: FLIPD_MUSTARD }}>whole table.</span>
              </h2>
            </div>
            <p style={{ color: 'rgba(252,246,232,0.55)', fontSize: '0.9rem', maxWidth: '20rem' }}>
              All buckets cooked-to-order. Allow 18–22 minutes for the family-size.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
            {BUCKETS.map((b) => (
              <Link key={b.name} href={`/${concept.slug}`} style={{
                background: 'rgba(252,246,232,0.04)',
                border: `1px solid ${FLIPD_MUSTARD}55`,
                padding: '1.75rem 1.5rem',
                borderRadius: '4px',
                textDecoration: 'none', color: FLIPD_CREAM,
                display: 'flex', flexDirection: 'column', gap: '0.6rem',
              }}>
                <span style={{ alignSelf: 'flex-start', fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.18em', color: FLIPD_MUSTARD, padding: '0.2rem 0.55rem', border: `1px solid ${FLIPD_MUSTARD}55`, borderRadius: '4px' }}>
                  {b.badge}
                </span>
                <h3 style={{ fontSize: '1.4rem', fontWeight: 900, letterSpacing: '-0.02em', marginTop: '0.4rem' }}>{b.name}</h3>
                <p style={{ fontSize: '0.78rem', color: 'rgba(252,246,232,0.55)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Feeds {b.feeds}</p>
                <p style={{ fontSize: '0.9rem', color: 'rgba(252,246,232,0.85)', lineHeight: 1.5 }}>{b.body}</p>
                <p style={{ marginTop: 'auto', fontSize: '1.5rem', fontWeight: 900, color: FLIPD_MUSTARD, letterSpacing: '-0.02em', paddingTop: '0.5rem' }}>
                  Rs. {b.price.toLocaleString()}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* THE BUTTERMILK STORY */}
      <section style={{ padding: 'clamp(4rem, 8vw, 7rem) 0' }}>
        <div className="container" style={{ maxWidth: '38rem', textAlign: 'center' }}>
          <p style={{ color: FLIPD_RED, fontWeight: 800, fontSize: '0.7rem', letterSpacing: '0.32em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            The brine story
          </p>
          <h2 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.75rem)', fontWeight: 900, letterSpacing: '-0.02em', lineHeight: 1.1, marginBottom: '1.5rem' }}>
            24 hours of buttermilk.<br /><span style={{ color: FLIPD_MUSTARD }}>That&rsquo;s the whole secret.</span>
          </h2>
          <p style={{ fontSize: '1.05rem', color: `${FLIPD_BLACK}cc`, lineHeight: 1.7 }}>
            Every piece sits in our buttermilk + spice brine for a full 24 hours before it hits the breading station. That&rsquo;s why the chicken is juicy on the inside, even when the crust is loud. There&rsquo;s no shortcut for this. We&rsquo;ve tried.
          </p>
          <p style={{ marginTop: '1.25rem', fontSize: '1rem', color: `${FLIPD_BLACK}88`, fontStyle: 'italic' }}>
            Cooked in our own kitchens · delivered by our own riders · made the second you tap order.
          </p>
        </div>
      </section>

      <CrossBrandStrip current={concept} concepts={concepts} accent={FLIPD_MUSTARD} kicker="In the same neighbourhood" heading="Other GS Foods kitchens you might like" />
      <BottomCTA brandName={concept.name} brandSlug={concept.slug} accent={FLIPD_MUSTARD} />
    </div>
  )
}
