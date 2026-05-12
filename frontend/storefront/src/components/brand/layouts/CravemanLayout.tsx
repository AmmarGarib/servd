'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { PromoBar } from '../parts/PromoBar'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { BottomCTA } from '../parts/BottomCTA'
import { OpenStatusBadge, useHoursData } from '../parts/OpenStatusBadge'

// Craveman — Pakistani desi comfort food ghost kitchen. Karachi street-food
// energy meets delivery-first convenience. Karahi, kebabs, rice bowls.
// Urban, bold, unpretentious. Saffron does the work.

interface Props {
  concept: Concept
  concepts: Concept[]
}

const CRAVE_DARK    = '#0E0B00'
const CRAVE_SAFFRON = '#F5A623'
const CRAVE_RED     = '#C53030'
const CRAVE_CREAM   = '#FFF7E6'

const CRAVINGS = [
  { name: 'Butter Chicken Bowl',  price: 1200, desc: 'Basmati rice, rich butter chicken, raita, pickled onion' },
  { name: 'Seekh Kebab Bowl',     price: 1300, desc: 'Charred seekh, saffron rice, green chutney, naan crisps' },
  { name: 'Karahi Wrap',          price: 1100, desc: 'Slow-cooked karahi chicken, paratha wrap, chutney' },
  { name: 'Tikka Fusion Wrap',    price: 1150, desc: 'Tikka chicken, coleslaw, cheese, whole wheat tortilla' },
  { name: 'Daal Chawal Bowl',     price: 850,  desc: 'Masoor dal, basmati, tarka, achaar' },
  { name: 'The Craveman Combo',   price: 1950, desc: 'Seekh bowl + karahi wrap + lassi' },
]

const REVIEWS = [
  { quote: 'THE KARAHI WRAP HIT LIKE A FRIDAY NIGHT IN TARIQ ROAD.', name: 'Hamza K.', area: 'Gulshan-e-Iqbal' },
  { quote: 'DAAL CHAWAL AT MIDNIGHT. EVERY TIME. NO REGRETS.', name: 'Sana R.', area: 'North Nazimabad' },
  { quote: 'SEEKH KEBAB BOWL IS A WHOLE MOOD. THEY ACTUALLY CHAR IT.', name: 'Bilal A.', area: 'DHA Phase 6' },
]

export function CravemanLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  return (
    <div style={{ background: CRAVE_CREAM, color: CRAVE_DARK }}>
      <PromoBar brandName={concept.name} brandSlug={concept.slug} accent={CRAVE_SAFFRON} />

      {/* HERO */}
      <section style={{
        background: CRAVE_DARK,
        color: CRAVE_CREAM,
        padding: 'clamp(4rem, 9vw, 7rem) 0 clamp(3rem, 6vw, 5rem)',
        borderBottom: `4px solid ${CRAVE_SAFFRON}`,
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* texture stripe */}
        <div aria-hidden="true" style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `repeating-linear-gradient(90deg, ${CRAVE_SAFFRON}08 0 1px, transparent 1px 64px)`,
          pointerEvents: 'none',
        }} />
        <div className="container" style={{ position: 'relative' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '3rem', alignItems: 'center' }}>
            <div>
              <p style={{
                color: CRAVE_SAFFRON,
                fontWeight: 800,
                fontSize: '0.72rem',
                letterSpacing: '0.32em',
                textTransform: 'uppercase',
                marginBottom: '1.25rem',
              }}>
                Ghost kitchen · Karachi-native · Delivery-first
              </p>
              <h1 style={{
                fontSize: 'clamp(3.5rem, 10vw, 7rem)',
                fontWeight: 900,
                letterSpacing: '-0.04em',
                lineHeight: 0.88,
                margin: 0,
                textTransform: 'uppercase',
                color: CRAVE_CREAM,
              }}>
                KARAHI.<br />
                KEBAB.<br />
                <span style={{ color: CRAVE_SAFFRON, textShadow: `3px 3px 0 ${CRAVE_RED}` }}>KARACHI.</span>
              </h1>
              <div style={{ marginTop: '1.25rem' }}>
                <OpenStatusBadge hoursData={hoursData} accentColor={CRAVE_SAFFRON} />
              </div>
              <p style={{
                marginTop: '2rem',
                fontSize: 'clamp(1rem, 2vw, 1.2rem)',
                color: `${CRAVE_CREAM}bb`,
                lineHeight: 1.55,
                maxWidth: '38rem',
              }}>
                Slow-cooked, fast-delivered. Real desi flavour, ghost kitchen speed.
              </p>
              <div style={{ marginTop: '2.25rem', display: 'flex', gap: '0.875rem', flexWrap: 'wrap' }}>
                <Link href={`/${concept.slug}`} style={{
                  padding: '1.1rem 2.25rem',
                  background: CRAVE_SAFFRON,
                  color: CRAVE_DARK,
                  fontWeight: 900,
                  fontSize: '1rem',
                  textDecoration: 'none',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  border: `3px solid ${CRAVE_SAFFRON}`,
                  boxShadow: `5px 5px 0 0 ${CRAVE_RED}`,
                }}>
                  ORDER NOW →
                </Link>
                <Link href={`/brand/${concept.slug}/menu`} style={{
                  padding: '1.1rem 2.25rem',
                  background: 'transparent',
                  color: CRAVE_CREAM,
                  fontWeight: 900,
                  fontSize: '1rem',
                  textDecoration: 'none',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  border: `3px solid ${CRAVE_CREAM}55`,
                }}>
                  SEE THE MENU
                </Link>
              </div>
            </div>
            {/* Food image — the karahi itself */}
            <div style={{ position: 'relative', overflow: 'hidden', border: `3px solid ${CRAVE_SAFFRON}55` }}>
              <img
                src="https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800&q=85"
                alt="Seekh Kebab Bowl — charred seekh, saffron rice, green chutney"
                style={{ width: '100%', display: 'block', aspectRatio: '4/3', objectFit: 'cover' }}
              />
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: `linear-gradient(transparent, ${CRAVE_DARK}ee)`,
                padding: '2rem 1.25rem 1.25rem',
              }}>
                <p style={{ fontSize: '0.68rem', fontWeight: 800, letterSpacing: '0.24em', color: CRAVE_SAFFRON, textTransform: 'uppercase' }}>Most ordered</p>
                <p style={{ fontSize: '1.05rem', fontWeight: 900, color: CRAVE_CREAM, letterSpacing: '-0.01em' }}>Seekh Kebab Bowl · Rs. 1,300</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* THE CRAVINGS — vertical menu list */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5.5rem) 0', borderBottom: `3px solid ${CRAVE_DARK}` }}>
        <div className="container">
          <p style={{
            color: CRAVE_RED,
            fontWeight: 800,
            fontSize: '0.72rem',
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            marginBottom: '0.75rem',
          }}>
            What we cook
          </p>
          <h2 style={{
            fontSize: 'clamp(2rem, 5vw, 3.75rem)',
            fontWeight: 900,
            letterSpacing: '-0.04em',
            textTransform: 'uppercase',
            marginBottom: '2.75rem',
            lineHeight: 1,
          }}>
            THE CRAVINGS
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {CRAVINGS.map((item, i) => (
              <Link
                key={item.name}
                href={`/${concept.slug}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  alignItems: 'center',
                  gap: '1.5rem',
                  padding: '1.4rem 0',
                  borderTop: i === 0 ? `2px solid ${CRAVE_DARK}` : `1px solid ${CRAVE_DARK}33`,
                  borderBottom: i === CRAVINGS.length - 1 ? `2px solid ${CRAVE_DARK}` : 'none',
                  textDecoration: 'none',
                  color: 'inherit',
                  outline: `3px solid transparent`,
                  outlineOffset: '-3px',
                  transition: 'border-left 0.15s ease',
                  paddingLeft: '1rem',
                  borderLeft: `4px solid transparent`,
                }}
                onMouseEnter={(e) => {
                  ;(e.currentTarget as HTMLAnchorElement).style.borderLeftColor = CRAVE_SAFFRON
                }}
                onMouseLeave={(e) => {
                  ;(e.currentTarget as HTMLAnchorElement).style.borderLeftColor = 'transparent'
                }}
              >
                <div>
                  <h3 style={{
                    fontSize: 'clamp(1.2rem, 2.5vw, 1.75rem)',
                    fontWeight: 900,
                    letterSpacing: '-0.02em',
                    textTransform: 'uppercase',
                    marginBottom: '0.3rem',
                  }}>
                    {item.name}
                  </h3>
                  <p style={{
                    fontSize: '0.9rem',
                    color: `${CRAVE_DARK}88`,
                    lineHeight: 1.4,
                  }}>
                    {item.desc}
                  </p>
                </div>
                <span style={{
                  fontSize: 'clamp(1.1rem, 2vw, 1.4rem)',
                  fontWeight: 900,
                  color: CRAVE_RED,
                  letterSpacing: '-0.02em',
                  whiteSpace: 'nowrap',
                }}>
                  Rs. {item.price.toLocaleString()}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* THE KITCHEN — conviction copy on dark */}
      <section style={{
        background: CRAVE_DARK,
        color: CRAVE_CREAM,
        padding: 'clamp(4rem, 8vw, 6.5rem) 0',
        borderBottom: `4px solid ${CRAVE_SAFFRON}`,
      }}>
        <div className="container" style={{ textAlign: 'center', maxWidth: '44rem', marginInline: 'auto' }}>
          <p style={{
            color: CRAVE_SAFFRON,
            fontWeight: 800,
            fontSize: '0.72rem',
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            marginBottom: '1rem',
          }}>
            How we cook
          </p>
          <h2 style={{
            fontSize: 'clamp(1.75rem, 4vw, 3rem)',
            fontWeight: 900,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            textTransform: 'uppercase',
            marginBottom: '3rem',
          }}>
            Karachi&rsquo;s comfort food.<br />
            <span style={{ color: CRAVE_SAFFRON }}>Delivered.</span>
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '2rem',
            textAlign: 'left',
          }}>
            {[
              'Slow-cooked karahi, not simmered in a bag',
              'Freshly kneaded paratha wraps, not frozen',
              'Every bowl is cooked when you order',
            ].map((stmt, i) => (
              <div key={i} style={{
                padding: '1.5rem',
                borderTop: `3px solid ${CRAVE_SAFFRON}`,
                background: `${CRAVE_CREAM}06`,
              }}>
                <span style={{
                  display: 'block',
                  fontSize: '2.5rem',
                  fontWeight: 900,
                  color: CRAVE_SAFFRON,
                  letterSpacing: '-0.04em',
                  marginBottom: '0.75rem',
                  lineHeight: 1,
                }}>
                  0{i + 1}
                </span>
                <p style={{
                  fontSize: '1rem',
                  color: `${CRAVE_CREAM}cc`,
                  lineHeight: 1.55,
                  fontWeight: 600,
                }}>
                  {stmt}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* REVIEWS */}
      <section style={{ padding: 'clamp(3.5rem, 7vw, 5.5rem) 0', borderBottom: `3px solid ${CRAVE_DARK}` }}>
        <div className="container">
          <p style={{
            color: CRAVE_RED,
            fontWeight: 800,
            fontSize: '0.72rem',
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
            marginBottom: '0.75rem',
          }}>
            From the regulars
          </p>
          <h2 style={{
            fontSize: 'clamp(2rem, 4vw, 3rem)',
            fontWeight: 900,
            letterSpacing: '-0.04em',
            textTransform: 'uppercase',
            marginBottom: '2.5rem',
          }}>
            KARACHI APPROVED
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1.25rem',
          }}>
            {REVIEWS.map((r, i) => (
              <div key={i} style={{
                padding: '2rem 1.75rem',
                border: `2px solid ${CRAVE_DARK}`,
                background: i % 2 === 0 ? 'white' : CRAVE_DARK,
                color: i % 2 === 0 ? CRAVE_DARK : CRAVE_CREAM,
                boxShadow: `4px 4px 0 0 ${CRAVE_SAFFRON}`,
              }}>
                <p style={{
                  fontSize: 'clamp(0.95rem, 1.5vw, 1.05rem)',
                  fontWeight: 900,
                  letterSpacing: '-0.01em',
                  lineHeight: 1.45,
                  marginBottom: '1.25rem',
                  textTransform: 'uppercase',
                }}>
                  &ldquo;{r.quote}&rdquo;
                </p>
                <p style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: CRAVE_SAFFRON,
                }}>
                  {r.name} &mdash; {r.area}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CrossBrandStrip
        current={concept}
        concepts={concepts}
        accent={CRAVE_SAFFRON}
        kicker="More from GS Foods kitchens"
        heading="Other kitchens worth an order"
      />
      <BottomCTA brandName={concept.name} brandSlug={concept.slug} accent={CRAVE_SAFFRON} />
    </div>
  )
}
