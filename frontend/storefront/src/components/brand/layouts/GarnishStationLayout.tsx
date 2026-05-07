'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { PromoBar } from '../parts/PromoBar'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { BottomCTA } from '../parts/BottomCTA'

// Garnish Station — build-your-own bowls and wraps from an outdoor walk-up
// cart. Fresh, market-garden energy. Physical cart at events and outdoor
// spaces. Clean, minimal, friendly. Lime does the work.

interface Props {
  concept: Concept
  concepts: Concept[]
}

const GARNISH_GREEN = '#2D5016'
const GARNISH_LIME  = '#8CB82A'
const GARNISH_CREAM = '#F5F9F2'
const GARNISH_INK   = '#1A2B16'

const MENU_MAINS = [
  { name: 'Classic Bowl',  price: 650,  desc: 'Lettuce base, 3 toppings, house dressing',          img: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&q=85' },
  { name: 'Loaded Bowl',   price: 900,  desc: 'Grain base, 5 toppings, protein, premium sauce',    img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&q=85' },
  { name: 'Classic Wrap',  price: 750,  desc: 'Whole wheat tortilla, 3 fillings, house sauce',     img: 'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=600&q=85' },
  { name: 'Loaded Wrap',   price: 950,  desc: 'Tortilla, 4 fillings, protein, premium sauce',      img: 'https://images.unsplash.com/photo-1548869206-93b036288d7e?w=600&q=85' },
]

const ADDONS = [
  { name: 'Grilled Chicken (+)', price: 150 },
  { name: 'Avocado (+)',         price: 150 },
]

const STEPS = [
  { num: '01', heading: 'Pick a base', body: 'Crisp lettuce or warm grain — your call.' },
  { num: '02', heading: 'Build your bowl', body: 'Up to five toppings from the daily board.' },
  { num: '03', heading: 'Choose your sauce', body: 'House dressing or a premium upgrade.' },
]

export function GarnishStationLayout({ concept, concepts }: Props) {
  return (
    <div style={{ background: GARNISH_CREAM, color: GARNISH_INK }}>
      <PromoBar brandName={concept.name} brandSlug={concept.slug} accent={GARNISH_LIME} />

      {/* HERO */}
      <section style={{
        padding: 'clamp(4rem, 9vw, 7rem) 0 clamp(3rem, 6vw, 5rem)',
        borderBottom: `3px solid ${GARNISH_LIME}`,
        background: GARNISH_CREAM,
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* subtle grid texture */}
        <div aria-hidden="true" style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `
            linear-gradient(${GARNISH_LIME}18 1px, transparent 1px),
            linear-gradient(90deg, ${GARNISH_LIME}18 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
          pointerEvents: 'none',
        }} />
        <div className="container" style={{ position: 'relative' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '3rem',
            alignItems: 'center',
          }}>
            <div>
              <p style={{
                color: GARNISH_GREEN,
                fontWeight: 700,
                fontSize: '0.78rem',
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                marginBottom: '1.25rem',
              }}>
                Walk-up cart &middot; build your own &middot; Karachi
              </p>
              <h1 style={{
                fontSize: 'clamp(3rem, 10vw, 7.5rem)',
                fontWeight: 900,
                letterSpacing: '-0.04em',
                lineHeight: 0.9,
                margin: 0,
                color: GARNISH_INK,
              }}>
                Your bowl.<br />
                <span style={{ color: GARNISH_LIME }}>Fresh.</span>
              </h1>
              <p style={{
                marginTop: '1.75rem',
                fontSize: '1.1rem',
                color: `${GARNISH_INK}99`,
                lineHeight: 1.6,
                maxWidth: '34rem',
              }}>
                Pick your base, your build, your sauce. Walk up, take away, done.
              </p>
              <div style={{ marginTop: '2.25rem', display: 'flex', gap: '0.875rem', flexWrap: 'wrap' }}>
                <Link href={`/${concept.slug}`} style={{
                  padding: '1rem 2rem',
                  background: GARNISH_GREEN,
                  color: GARNISH_CREAM,
                  fontWeight: 800,
                  fontSize: '1rem',
                  textDecoration: 'none',
                  borderRadius: '999px',
                  letterSpacing: '0.01em',
                  border: `2px solid ${GARNISH_GREEN}`,
                }}>
                  Order ahead &rarr;
                </Link>
                <Link href="#find-us" style={{
                  padding: '1rem 2rem',
                  background: 'transparent',
                  color: GARNISH_GREEN,
                  fontWeight: 800,
                  fontSize: '1rem',
                  textDecoration: 'none',
                  borderRadius: '999px',
                  border: `2px solid ${GARNISH_GREEN}`,
                  letterSpacing: '0.01em',
                }}>
                  Find the cart
                </Link>
              </div>
            </div>

            {/* Hero bowl image */}
            <div style={{ borderRadius: '16px', overflow: 'hidden', border: `2px solid ${GARNISH_LIME}`, boxShadow: `0 4px 24px ${GARNISH_LIME}22`, position: 'relative' }}>
              <img
                src="https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=800&q=85"
                alt="Loaded Bowl — grain base, fresh toppings, your build"
                style={{ width: '100%', display: 'block', aspectRatio: '4/3', objectFit: 'cover' }}
              />
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: `linear-gradient(transparent, ${GARNISH_INK}dd)`,
                padding: '2rem 1.5rem 1.25rem',
              }}>
                <p style={{ fontSize: '0.68rem', fontWeight: 700, color: GARNISH_LIME, letterSpacing: '0.22em', textTransform: 'uppercase' }}>The bowl to beat</p>
                <p style={{ fontSize: '1.05rem', fontWeight: 800, color: 'white' }}>Loaded Bowl · Rs. 900</p>
                <p style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.65)', marginTop: '0.15rem' }}>Grain base · 5 toppings · protein · premium sauce</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS — 3-step strip */}
      <section style={{
        padding: 'clamp(3rem, 7vw, 5.5rem) 0',
        borderBottom: `2px solid ${GARNISH_LIME}44`,
      }}>
        <div className="container">
          <p style={{
            color: GARNISH_LIME,
            fontWeight: 700,
            fontSize: '0.72rem',
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            marginBottom: '0.75rem',
          }}>
            simple as
          </p>
          <h2 style={{
            fontSize: 'clamp(1.75rem, 4vw, 2.75rem)',
            fontWeight: 900,
            letterSpacing: '-0.03em',
            marginBottom: '3rem',
            color: GARNISH_INK,
          }}>
            how it works
          </h2>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 0,
            position: 'relative',
          }}>
            {/* connector line */}
            <div aria-hidden="true" style={{
              position: 'absolute',
              top: '2.2rem',
              left: '10%',
              right: '10%',
              height: '2px',
              background: `linear-gradient(90deg, ${GARNISH_LIME}, ${GARNISH_LIME}44)`,
              zIndex: 0,
            }} />

            {STEPS.map((step, i) => (
              <div key={step.num} style={{
                position: 'relative',
                zIndex: 1,
                padding: '0 1.5rem 1.5rem',
                textAlign: 'center',
              }}>
                <div style={{
                  width: '4rem',
                  height: '4rem',
                  borderRadius: '999px',
                  background: i === 1 ? GARNISH_GREEN : 'white',
                  border: `2px solid ${GARNISH_LIME}`,
                  display: 'grid',
                  placeItems: 'center',
                  marginInline: 'auto',
                  marginBottom: '1.25rem',
                  boxShadow: `0 0 0 6px ${GARNISH_CREAM}`,
                }}>
                  <span style={{
                    fontSize: '0.85rem',
                    fontWeight: 900,
                    letterSpacing: '0.04em',
                    color: i === 1 ? GARNISH_CREAM : GARNISH_GREEN,
                  }}>
                    {step.num}
                  </span>
                </div>
                <h3 style={{
                  fontSize: '1.1rem',
                  fontWeight: 800,
                  color: GARNISH_INK,
                  marginBottom: '0.5rem',
                  letterSpacing: '-0.01em',
                }}>
                  {step.heading}
                </h3>
                <p style={{
                  fontSize: '0.9rem',
                  color: `${GARNISH_INK}88`,
                  lineHeight: 1.5,
                  maxWidth: '16rem',
                  marginInline: 'auto',
                }}>
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MENU */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5.5rem) 0', borderBottom: `2px solid ${GARNISH_LIME}44` }}>
        <div className="container">
          <p style={{
            color: GARNISH_LIME,
            fontWeight: 700,
            fontSize: '0.72rem',
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            marginBottom: '0.75rem',
          }}>
            what&rsquo;s on the board
          </p>
          <h2 style={{
            fontSize: 'clamp(1.75rem, 4vw, 2.75rem)',
            fontWeight: 900,
            letterSpacing: '-0.03em',
            marginBottom: '2.5rem',
            color: GARNISH_INK,
          }}>
            the menu
          </h2>

          {/* main items grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '1.25rem',
            marginBottom: '1.5rem',
          }}>
            {MENU_MAINS.map((item) => (
              <Link key={item.name} href={`/${concept.slug}`} style={{
                display: 'flex',
                flexDirection: 'column',
                background: 'white',
                border: `1.5px solid ${GARNISH_LIME}66`,
                borderRadius: '12px',
                textDecoration: 'none',
                color: 'inherit',
                overflow: 'hidden',
                boxShadow: `0 2px 12px ${GARNISH_INK}0a`,
              }}>
                <div style={{ aspectRatio: '16/9', overflow: 'hidden' }}>
                  <img src={item.img} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                </div>
                <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', borderTop: `3px solid ${GARNISH_LIME}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
                  <h3 style={{
                    fontSize: '1.1rem',
                    fontWeight: 800,
                    color: GARNISH_INK,
                    letterSpacing: '-0.01em',
                    lineHeight: 1.3,
                  }}>
                    {item.name}
                  </h3>
                  <span style={{
                    fontSize: '1rem',
                    fontWeight: 900,
                    color: GARNISH_GREEN,
                    whiteSpace: 'nowrap',
                    letterSpacing: '-0.01em',
                  }}>
                    Rs. {item.price.toLocaleString()}
                  </span>
                </div>
                <p style={{
                  fontSize: '0.875rem',
                  color: `${GARNISH_INK}88`,
                  lineHeight: 1.5,
                }}>
                  {item.desc}
                </p>
                <span style={{
                  marginTop: 'auto',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  color: GARNISH_LIME,
                  letterSpacing: '0.04em',
                  paddingTop: '0.5rem',
                }}>
                  Add to order &rarr;
                </span>
                </div>
              </Link>
            ))}
          </div>

          {/* add-ons row */}
          <div style={{
            display: 'flex',
            gap: '1rem',
            flexWrap: 'wrap',
            padding: '1.25rem 1.5rem',
            background: `${GARNISH_LIME}12`,
            border: `1.5px dashed ${GARNISH_LIME}`,
            borderRadius: '12px',
            alignItems: 'center',
          }}>
            <span style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              color: GARNISH_GREEN,
              marginRight: '0.5rem',
            }}>
              Add-ons
            </span>
            {ADDONS.map((a) => (
              <div key={a.name} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
                padding: '0.5rem 1rem',
                background: 'white',
                border: `1.5px solid ${GARNISH_LIME}55`,
                borderRadius: '999px',
              }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 700, color: GARNISH_INK }}>{a.name}</span>
                <span style={{ fontSize: '0.85rem', fontWeight: 800, color: GARNISH_LIME }}>Rs. {a.price}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FIND US */}
      <section
        id="find-us"
        style={{
          background: GARNISH_GREEN,
          color: GARNISH_CREAM,
          padding: 'clamp(4rem, 8vw, 6.5rem) 0',
          borderBottom: `3px solid ${GARNISH_LIME}`,
        }}
      >
        <div className="container" style={{ maxWidth: '44rem', marginInline: 'auto', textAlign: 'center' }}>
          <p style={{
            color: GARNISH_LIME,
            fontWeight: 700,
            fontSize: '0.72rem',
            letterSpacing: '0.28em',
            textTransform: 'uppercase',
            marginBottom: '1rem',
          }}>
            where to find us
          </p>
          <h2 style={{
            fontSize: 'clamp(2rem, 5vw, 3.5rem)',
            fontWeight: 900,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            marginBottom: '1.5rem',
          }}>
            The cart is out there.
          </h2>
          <p style={{
            fontSize: '1.05rem',
            color: `${GARNISH_CREAM}cc`,
            lineHeight: 1.7,
            marginBottom: '2.5rem',
          }}>
            Garnish Station is a roving concept &mdash; we set up at markets, padel courts, corporate events, and wherever Karachi is hungry. Follow us to know where we are next.
          </p>
          <div style={{ display: 'flex', gap: '0.875rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <a
              href="https://instagram.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: '1rem 2rem',
                background: GARNISH_LIME,
                color: GARNISH_INK,
                fontWeight: 800,
                fontSize: '0.95rem',
                textDecoration: 'none',
                borderRadius: '999px',
                letterSpacing: '0.01em',
              }}
            >
              Follow on Instagram &rarr;
            </a>
            <Link href={`/${concept.slug}`} style={{
              padding: '1rem 2rem',
              background: 'transparent',
              color: GARNISH_CREAM,
              fontWeight: 800,
              fontSize: '0.95rem',
              textDecoration: 'none',
              borderRadius: '999px',
              border: `2px solid ${GARNISH_CREAM}55`,
              letterSpacing: '0.01em',
            }}>
              Book for an event
            </Link>
          </div>
        </div>
      </section>

      <CrossBrandStrip
        current={concept}
        concepts={concepts}
        accent={GARNISH_LIME}
        kicker="Other GS Foods kitchens"
        heading="More from the same family"
      />
      <BottomCTA brandName={concept.name} brandSlug={concept.slug} accent={GARNISH_GREEN} />
    </div>
  )
}
