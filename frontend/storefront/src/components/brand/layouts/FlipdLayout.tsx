'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { PromoBar } from '../parts/PromoBar'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { BottomCTA } from '../parts/BottomCTA'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'
import { useScrollReveal } from '../../kinetic/motionHooks'

// FlipdLayout — formerly StaxLayout. Per CEO 2026-05-12: the elaborate
// build-your-own design originally drawn for Stax fits Flipd better, so the
// layout was moved here. Visual structure is loud, urban, dark, slab type,
// with the "you build / we build" two-track flow.
//
// Heads-up: the hardcoded category names + product copy below still read
// "Stax" / "Pub Stax" / "Stax sauce" etc. from the original brand. Those
// should be re-authored from /content/{slug} (storefront CMS) to match
// Flipd's chicken-led menu — the design swap intentionally didn't touch
// product data so we don't lose the original brand reference if it comes
// back in a future iteration.

interface Props {
  concept: Concept
  concepts: Concept[]
}

const STAX_DARK   = '#0d0a09'
const STAX_FIRE   = '#D4581A'
const STAX_CREAM  = '#f6f1e8'

interface StaxCategory {
  slug: string
  kicker: string
  name: string
  emoji: string                              // food emoji shown big on the card
  tagline: string                            // 1-line description
  toppingsLine: string                       // "Top with 5 of 18 · brioche bun"
  texture: 'brioche-thick' | 'brioche-smash' | 'focaccia' | 'croissant' | 'fries' | 'drinks' | 'desserts'
  heat?: number                              // 1-5 fire-pip rating
  fromCents: number
}

const STAX_CATEGORIES: StaxCategory[] = [
  {
    slug:    'pub-stax',
    kicker:  '01 · Brioche · Thick patty',
    name:    'PUB STAX',
    emoji:   '🍔',
    tagline: 'A 7oz pub-style patty, properly thick. Built for big stacks.',
    toppingsLine: 'Pick 5+ from 18 toppings · brioche bun',
    texture: 'brioche-thick',
    heat: 3,
    fromCents: 145000,
  },
  {
    slug:    'smash-stax',
    kicker:  '02 · Brioche · Smash patty',
    name:    'SMASH STAX',
    emoji:   '🍔',
    tagline: 'Hot griddle, paper-thin patty, lacy edges, double or single.',
    toppingsLine: 'Pick 5+ from 18 toppings · brioche bun',
    texture: 'brioche-smash',
    heat: 4,
    fromCents: 110000,
  },
  {
    slug:    'golden-stax',
    kicker:  '03 · Focaccia',
    name:    'GOLDEN STAX',
    emoji:   '🥪',
    tagline: 'Hand-dimpled focaccia, olive-oil-rich, pressed warm.',
    toppingsLine: 'Pick 4+ from 18 toppings · focaccia',
    texture: 'focaccia',
    fromCents: 95000,
  },
  {
    slug:    'flaky-stax',
    kicker:  '04 · Croissant',
    name:    'FLAKY STAX',
    emoji:   '🥐',
    tagline: 'Laminated 27 layers. Buttery shatter, savoury or sweet.',
    toppingsLine: 'Pick 4+ from 18 toppings · croissant',
    texture: 'croissant',
    fromCents: 85000,
  },
  {
    slug:    'fries-sides',
    kicker:  '05 · Spuds & sauces',
    name:    'FRIES & SIDES',
    emoji:   '🍟',
    tagline: 'Layered pressed pommes, hand-cut, golden roasties — fried à la minute.',
    toppingsLine: '4 styles · 6 dipping sauces · all in-house',
    texture: 'fries',
    heat: 2,
    fromCents: 45000,
  },
  {
    slug:    'drinks',
    kicker:  '06 · Pour',
    name:    'DRINKS',
    emoji:   '🥤',
    tagline: 'House sodas, espresso, a couple of pours that hold up to a stack.',
    toppingsLine: '12 pours · house-made syrups',
    texture: 'drinks',
    fromCents: 25000,
  },
  {
    slug:    'desserts',
    kicker:  '07 · Sweet',
    name:    'DESSERTS',
    emoji:   '🍰',
    tagline: 'Soft-serve flights, brown-butter cookie, basque burnt cheesecake.',
    toppingsLine: 'Top with 6 sweet toppings · 4 sauce drizzles',
    texture: 'desserts',
    fromCents: 35000,
  },
]

// Chef pairings — curated stacks for the "don't want to choose" crowd.
// Each one is a finished combo: base + 5-6 toppings + a sauce. Shown in the
// "WE BUILD" section as a counterweight to the build-your-own flow.
interface ChefStack {
  slug: string
  name: string
  emoji: string
  base: string                 // base bread name
  toppings: string[]           // human-readable list of toppings
  blurb: string                // one-line pitch
  heat: number
  priceCents: number
  badge?: 'NEW' | 'BESTSELLER' | 'CHEF\'S PICK' | 'VEGETARIAN'
  accent: string
}

const CHEF_STACKS: ChefStack[] = [
  {
    slug: 'classic',
    name: 'THE STAX CLASSIC',
    emoji: '🍔',
    base: 'Brioche · Smash patty',
    toppings: ['Aged cheddar', 'Pickles', 'Caramelised onion', 'Stax sauce'],
    blurb: 'The original. The reason we opened. Every other stack is measured against this.',
    heat: 2,
    priceCents: 125000,
    badge: 'BESTSELLER',
    accent: STAX_FIRE,
  },
  {
    slug: 'ghost-rider',
    name: 'GHOST RIDER',
    emoji: '👻',
    base: 'Brioche · Smash patty',
    toppings: ['Pepper jack', 'Jalapeños', 'Pickled onion', 'Ghost ranch', 'Hot honey'],
    blurb: 'Triple-fire. We will not warn you again. Comes with a glass of milk.',
    heat: 5,
    priceCents: 135000,
    badge: 'CHEF\'S PICK',
    accent: '#a02020',
  },
  {
    slug: 'sunday-roast',
    name: 'SUNDAY ROAST',
    emoji: '🍳',
    base: 'Brioche · Pub patty',
    toppings: ['Aged cheddar', 'Beef bacon', 'Fried egg', 'Caramelised onion', 'Stax sauce'],
    blurb: '7oz pub patty, all the breakfast trim. The post-match recovery stack.',
    heat: 2,
    priceCents: 165000,
    accent: '#c47845',
  },
  {
    slug: 'breakfast-flake',
    name: 'BREAKFAST FLAKE',
    emoji: '🥐',
    base: 'Croissant',
    toppings: ['Beef bacon', 'Fried egg', 'Aged cheddar', 'Hot honey'],
    blurb: '27 layers, soft scrambled, the kind of breakfast that ruins all other breakfasts.',
    heat: 1,
    priceCents: 105000,
    badge: 'NEW',
    accent: '#dba85a',
  },
  {
    slug: 'garden-burnt',
    name: 'GARDEN BURNT',
    emoji: '🍄',
    base: 'Focaccia',
    toppings: ['Sautéed mushrooms', 'Swiss', 'Caramelised onion', 'Confit garlic aioli', 'Roasted corn salsa'],
    blurb: 'Warm-pressed focaccia. The vegetarian stack the carnivores still order.',
    heat: 1,
    priceCents: 110000,
    badge: 'VEGETARIAN',
    accent: '#7a9a2e',
  },
  {
    slug: 'crispy-chick-flake',
    name: 'CRISPY CHICK FLAKE',
    emoji: '🍗',
    base: 'Croissant',
    toppings: ['Buttermilk-fried thigh', 'House pickles', 'Slaw', 'Hot honey', 'Stax sauce'],
    blurb: 'The crunch-on-flake combo. People order this for the crackle alone.',
    heat: 3,
    priceCents: 115000,
    accent: STAX_FIRE,
  },
]

// 18 toppings — what gets you a custom Stax. Emoji + name + price delta in PKR.
// Shown in the Toppings Bar section so the build-your-own pitch is concrete.
const STAX_TOPPINGS = [
  { emoji: '🧀', name: 'Aged cheddar',          delta: 100 },
  { emoji: '🧀', name: 'Swiss',                  delta: 120 },
  { emoji: '🥬', name: 'Crisp lettuce',          delta: 0   },
  { emoji: '🍅', name: 'Tomato',                 delta: 50  },
  { emoji: '🧅', name: 'Caramelised onion',      delta: 80  },
  { emoji: '🧅', name: 'Pickled onion',          delta: 60  },
  { emoji: '🥒', name: 'House pickles',          delta: 40  },
  { emoji: '🥓', name: 'Beef bacon',             delta: 250 },
  { emoji: '🍳', name: 'Fried egg',              delta: 120 },
  { emoji: '🥑', name: 'Avocado',                delta: 200 },
  { emoji: '🌶', name: 'Jalapeños',              delta: 60  },
  { emoji: '🍄', name: 'Sautéed mushrooms',     delta: 100 },
  { emoji: '🧄', name: 'Confit garlic aioli',   delta: 50  },
  { emoji: '🍯', name: 'Hot honey',              delta: 60  },
  { emoji: '⚡', name: 'Stax sauce',             delta: 0   },
  { emoji: '👻', name: 'Ghost ranch',            delta: 80  },
  { emoji: '🌽', name: 'Roasted corn salsa',     delta: 80  },
  { emoji: '🥒', name: 'Cucumber raita',         delta: 60  },
]

function HeatPips({ level }: { level: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: '0.15rem', fontSize: '0.95rem', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }} aria-label={`Heat ${level} of 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} style={{ opacity: i < level ? 1 : 0.25 }} aria-hidden="true">🔥</span>
      ))}
    </span>
  )
}

export function FlipdLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const heroRef = useScrollReveal<HTMLElement>()
  return (
    <div
      style={{
        background: STAX_CREAM,
        color: STAX_DARK,
        ['--brand-accent' as string]:      STAX_FIRE,
        ['--brand-accent-dark' as string]: STAX_FIRE,
        ['--brand-ink' as string]:         STAX_DARK,
      } as React.CSSProperties}
    >
      <style>{`
        @keyframes staxCardIn {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes staxEmojiFloat {
          0%, 100% { transform: translateY(0) rotate(-2deg); }
          50%      { transform: translateY(-6px) rotate(2deg); }
        }
        .stax-cat-card {
          opacity: 0;
          animation: staxCardIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.35s ease;
          will-change: transform;
        }
        .stax-cat-card:hover { transform: translateY(-6px); box-shadow: 0 20px 40px -12px rgba(0,0,0,0.35); }
        .stax-cat-card:hover .stax-cat-cta { transform: translateX(4px); }
        .stax-cat-card:hover .stax-emoji { animation: staxEmojiFloat 1.2s ease-in-out infinite; }
        .stax-cat-cta { transition: transform 0.25s ease; }
        .stax-cat-card .stax-texture { transition: transform 1.2s cubic-bezier(0.16, 1, 0.3, 1); }
        .stax-cat-card:hover .stax-texture { transform: scale(1.06); }
        .stax-topping-chip {
          transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease;
        }
        .stax-topping-chip:hover {
          transform: translateY(-2px);
          background: ${STAX_FIRE}1f;
          border-color: ${STAX_FIRE};
        }
      `}</style>

      <PromoBar brandName={concept.name} brandSlug={concept.slug} accent={STAX_FIRE} />

      {/* HERO — slab type, fire wash. Decorative noise removed; the
          identity comes from the slab typography + stats grid below. */}
      <section ref={heroRef} style={{
        position: 'relative',
        background: STAX_DARK,
        color: 'white',
        padding: 'clamp(3rem, 8vw, 6rem) 0 clamp(2.5rem, 6vw, 4rem)',
        overflow: 'hidden',
      }}>
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at 90% 10%, ${STAX_FIRE}66 0%, transparent 45%), radial-gradient(circle at 5% 90%, ${STAX_FIRE}33 0%, transparent 35%)`,
        }} />

        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '3rem', alignItems: 'center' }}>
            <div>
              <p style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.42em', color: STAX_FIRE, textTransform: 'uppercase', marginBottom: '1.25rem' }}>
                Karachi · Build your own
              </p>
              <h1 style={{
                fontSize: 'clamp(4rem, 12vw, 9rem)',
                fontWeight: 900,
                letterSpacing: '-0.06em',
                lineHeight: 0.85,
                textTransform: 'uppercase',
                margin: 0,
              }}>
                PICK A BASE.<br/>
                STACK IT.<br/>
                <span style={{ color: STAX_FIRE }}>SAUCE IT.</span>
              </h1>
              <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <OpenStatusBadge hoursData={hoursData} accentColor={STAX_FIRE} />
              </div>
              {hoursData && hoursData.hours.length > 0 && (
                <div style={{ marginTop: '1.25rem' }}>
                  <p style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', marginBottom: '0.5rem' }}>Hours (PKT)</p>
                  <HoursGrid hoursData={hoursData} accentColor={STAX_FIRE} />
                </div>
              )}
              <p style={{ marginTop: '2rem', fontSize: 'clamp(1.05rem, 1.6vw, 1.25rem)', maxWidth: '38rem', lineHeight: 1.4, color: 'rgba(255,255,255,0.78)' }}>
                Brioche, focaccia, or 27-layer croissant. Smash patty or pub patty. <strong style={{ color: 'white' }}>18 in-house toppings.</strong> Pile them how you want — we cook the second you tap order.
              </p>

              {/* Quick stats — drives home that this is build-your-own at scale */}
              <div style={{ display: 'flex', gap: '2.25rem', flexWrap: 'wrap', marginTop: '2rem' }}>
                <div>
                  <p style={{ fontSize: 'clamp(2.2rem, 4vw, 3rem)', fontWeight: 900, color: STAX_FIRE, lineHeight: 1, letterSpacing: '-0.04em' }}>4</p>
                  <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginTop: '0.35rem' }}>Bread bases</p>
                </div>
                <div>
                  <p style={{ fontSize: 'clamp(2.2rem, 4vw, 3rem)', fontWeight: 900, color: STAX_FIRE, lineHeight: 1, letterSpacing: '-0.04em' }}>18</p>
                  <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginTop: '0.35rem' }}>Toppings</p>
                </div>
                <div>
                  <p style={{ fontSize: 'clamp(2.2rem, 4vw, 3rem)', fontWeight: 900, color: STAX_FIRE, lineHeight: 1, letterSpacing: '-0.04em' }}>3</p>
                  <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginTop: '0.35rem' }}>House sauces</p>
                </div>
                <div>
                  <p style={{ fontSize: 'clamp(2.2rem, 4vw, 3rem)', fontWeight: 900, color: STAX_FIRE, lineHeight: 1, letterSpacing: '-0.04em' }}>∞</p>
                  <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginTop: '0.35rem' }}>Combos</p>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '2.5rem' }}>
                <Link href={`/${concept.slug}`} style={{
                  padding: '1.25rem 2.5rem',
                  background: STAX_FIRE,
                  color: 'white',
                  fontWeight: 900,
                  fontSize: '1.05rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  textDecoration: 'none',
                  borderRadius: '4px',
                  boxShadow: `0 8px 0 0 ${STAX_DARK}`,
                }}>
                  Build your stack →
                </Link>
                <Link href={`/brand/${concept.slug}/menu`} style={{
                  padding: '1.25rem 2.5rem',
                  background: 'transparent',
                  border: '2px solid rgba(255,255,255,0.4)',
                  color: 'white',
                  fontWeight: 800,
                  fontSize: '1rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  textDecoration: 'none',
                  borderRadius: '4px',
                }}>
                  Browse bases
                </Link>
              </div>
            </div>

            {/* Right side — visual recipe builder mockup, no photo */}
            <div style={{
              position: 'relative', borderRadius: '8px', overflow: 'hidden',
              border: `3px solid ${STAX_FIRE}`,
              background: `linear-gradient(155deg, #1a120b 0%, #0d0a09 100%)`,
              padding: 'clamp(1.75rem, 3vw, 2.25rem)',
              minHeight: '380px',
              display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
            }}>
              <div>
                <p style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.32em', color: STAX_FIRE, textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                  How it works
                </p>
                <h2 style={{ fontSize: 'clamp(1.5rem, 2.5vw, 1.85rem)', fontWeight: 900, color: 'white', textTransform: 'uppercase', letterSpacing: '-0.02em', lineHeight: 1.1, marginBottom: '1.5rem' }}>
                  Three taps. Your stack.
                </h2>
                {[
                  { n: '01', t: 'Pick a base',     d: 'Brioche · Focaccia · Croissant',           icon: '🍞' },
                  { n: '02', t: 'Add toppings',    d: '4–8 from 18 in-house options',             icon: '🥬' },
                  { n: '03', t: 'Sauce it',        d: 'Stax · Hot Honey · Ghost Ranch',           icon: '🌶' },
                ].map((s) => (
                  <div key={s.n} style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: '0.85rem', alignItems: 'center', padding: '0.5rem 0', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 900, color: STAX_FIRE, letterSpacing: '0.1em' }}>{s.n}</span>
                    <span style={{ fontSize: '1.4rem' }} aria-hidden="true">{s.icon}</span>
                    <div>
                      <p style={{ fontSize: '0.95rem', fontWeight: 800, color: 'white', textTransform: 'uppercase', letterSpacing: '0.02em' }}>{s.t}</p>
                      <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.55)' }}>{s.d}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)' }}>
                  Cooked à la minute
                </p>
                <span style={{ fontSize: '1.6rem' }} aria-hidden="true">🔥</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PATH SPLIT — the two ways to order: build-your-own or chef pairing */}
      <section style={{ padding: 'clamp(2.5rem, 5vw, 4rem) 0 clamp(1rem, 2vw, 1.5rem)', borderBottom: `1px dashed ${STAX_DARK}33` }}>
        <div className="container">
          <p style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.42em', color: STAX_FIRE, textTransform: 'uppercase', marginBottom: '1rem', textAlign: 'center' }}>
            Two ways to order
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem', maxWidth: '52rem', margin: '0 auto' }}>
            <a href="#you-build" style={{
              display: 'block', padding: '1.5rem 1.75rem', textDecoration: 'none', color: STAX_DARK,
              border: `2px solid ${STAX_DARK}`, borderRadius: '6px', background: 'white',
              transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = `0 10px 0 -2px ${STAX_DARK}` }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}>
              <p style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.32em', color: STAX_FIRE, textTransform: 'uppercase' }}>You build</p>
              <h3 style={{ fontSize: 'clamp(1.4rem, 2.5vw, 1.8rem)', fontWeight: 900, letterSpacing: '-0.03em', textTransform: 'uppercase', marginTop: '0.4rem' }}>
                Pick a base. Stack it.
              </h3>
              <p style={{ fontSize: '0.85rem', color: `${STAX_DARK}99`, marginTop: '0.5rem', lineHeight: 1.45 }}>
                4 breads · 18 toppings · 3 sauces. Nothing&rsquo;s off-limits.
              </p>
            </a>
            <a href="#we-build" style={{
              display: 'block', padding: '1.5rem 1.75rem', textDecoration: 'none', color: STAX_CREAM,
              border: `2px solid ${STAX_DARK}`, borderRadius: '6px', background: STAX_DARK,
              transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = `0 10px 0 -2px ${STAX_FIRE}` }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}>
              <p style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.32em', color: STAX_FIRE, textTransform: 'uppercase' }}>We build</p>
              <h3 style={{ fontSize: 'clamp(1.4rem, 2.5vw, 1.8rem)', fontWeight: 900, letterSpacing: '-0.03em', textTransform: 'uppercase', marginTop: '0.4rem', color: 'white' }}>
                Chef&rsquo;s stacks. One tap.
              </h3>
              <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', marginTop: '0.5rem', lineHeight: 1.45 }}>
                6 curated combos. Tested by the kitchen, ranked by bestseller.
              </p>
            </a>
          </div>
        </div>
      </section>

      {/* YOU BUILD · STEP 1 — base cards */}
      <section id="you-build" style={{ padding: 'clamp(3rem, 7vw, 6rem) 0', borderBottom: `2px solid ${STAX_DARK}`, position: 'relative', overflow: 'hidden', scrollMarginTop: '80px' }}>
        <div className="container" style={{ position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '1rem', marginBottom: '2.5rem' }}>
            <div>
              <p style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.42em', color: STAX_FIRE, textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                You build · Step 1 — Pick your base
              </p>
              <h2 style={{ fontSize: 'clamp(2.5rem, 8vw, 5rem)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '-0.04em', lineHeight: 0.95, margin: 0 }}>
                FOUR BREADS.<br /><span style={{ color: STAX_FIRE }}>EVERY DAMN COMBO.</span>
              </h2>
            </div>
            <p style={{ fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.32em', textTransform: 'uppercase', color: STAX_FIRE, maxWidth: '18rem' }}>
              Tap a card · jump to that section in the order screen
            </p>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '1.5rem',
          }}>
            {STAX_CATEGORIES.map((cat, i) => (
              <CategoryCard key={cat.slug} cat={cat} conceptSlug={concept.slug} delayMs={i * 90} />
            ))}
          </div>
        </div>
      </section>

      {/* YOU BUILD · STEP 2 — 18 toppings shown as chips */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5rem) 0', background: STAX_DARK, color: 'white', position: 'relative', overflow: 'hidden' }}>
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(circle at 80% 20%, ${STAX_FIRE}33 0%, transparent 40%)`,
        }} />
        <div className="container" style={{ position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '1rem', marginBottom: '2.5rem' }}>
            <div>
              <p style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.42em', color: STAX_FIRE, textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                You build · Step 2 — Stack it
              </p>
              <h2 style={{ fontSize: 'clamp(2.5rem, 8vw, 5rem)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '-0.04em', lineHeight: 0.95, margin: 0 }}>
                <span style={{ color: STAX_FIRE }}>18 TOPPINGS.</span><br/>YOUR CALL.
              </h2>
            </div>
            <p style={{ fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.32em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', maxWidth: '18rem' }}>
              Cheese, sauces, pickled, smoked. Pile them all if you want — extra on us above 6.
            </p>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '0.65rem',
          }}>
            {STAX_TOPPINGS.map((t) => (
              <div key={t.name} className="stax-topping-chip" style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.7rem',
                padding: '0.7rem 0.85rem',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '999px',
              }}>
                <span style={{ fontSize: '1.1rem' }} aria-hidden="true">{t.emoji}</span>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, flex: 1 }}>{t.name}</span>
                <span style={{ fontSize: '0.72rem', fontWeight: 800, color: t.delta === 0 ? '#79e0a4' : STAX_FIRE, whiteSpace: 'nowrap' }}>
                  {t.delta === 0 ? 'FREE' : `+${t.delta}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WE BUILD — chef-curated stacks for the don't-want-to-think crowd */}
      <section id="we-build" style={{ padding: 'clamp(3rem, 7vw, 6rem) 0', borderBottom: `2px solid ${STAX_DARK}`, position: 'relative', overflow: 'hidden', scrollMarginTop: '80px' }}>
        <div className="container">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '1rem', marginBottom: '2.5rem' }}>
            <div>
              <p style={{ fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.42em', color: STAX_FIRE, textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                We build · Chef&rsquo;s stacks
              </p>
              <h2 style={{ fontSize: 'clamp(2.5rem, 8vw, 5rem)', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '-0.04em', lineHeight: 0.95, margin: 0 }}>
                DON&rsquo;T WANT TO CHOOSE?<br/><span style={{ color: STAX_FIRE }}>WE&rsquo;VE ALREADY DECIDED.</span>
              </h2>
            </div>
            <p style={{ fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.32em', textTransform: 'uppercase', color: STAX_FIRE, maxWidth: '18rem' }}>
              6 combos · ranked by what&rsquo;s flying out the kitchen
            </p>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '1.5rem',
          }}>
            {CHEF_STACKS.map((s, i) => (
              <ChefStackCard key={s.slug} stack={s} conceptSlug={concept.slug} delayMs={i * 80} />
            ))}
          </div>
        </div>
      </section>

      {/* THE SAUCE STORY — short, punchy, no precious paragraphs */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5rem) 0', borderBottom: `2px solid ${STAX_DARK}` }}>
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '2.5rem', alignItems: 'start' }}>
          <div>
            <p style={{ color: STAX_FIRE, fontWeight: 800, fontSize: '0.7rem', letterSpacing: '0.32em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
              The house sauces
            </p>
            <h2 style={{ fontSize: 'clamp(2rem, 5vw, 3.25rem)', fontWeight: 900, letterSpacing: '-0.03em', lineHeight: 1.05, textTransform: 'uppercase' }}>
              Three sauces.<br />Made in-house.<br /><span style={{ color: STAX_FIRE }}>That&rsquo;s it.</span>
            </h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {[
              { tag: '01', emoji: '⚡', title: 'STAX SAUCE',     body: 'The original. Mayo-mustard base, smoked paprika, pickle brine. Goes on everything.' },
              { tag: '02', emoji: '🍯', title: 'HOT HONEY',      body: 'Local honey, cayenne, chili crisp. For the spicy chicken stack and the brave.' },
              { tag: '03', emoji: '👻', title: 'GHOST RANCH',    body: 'Buttermilk ranch + ghost pepper. Triple Fire only. Don&rsquo;t say we didn&rsquo;t warn you.' },
            ].map((s) => (
              <div key={s.tag} style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr', gap: '1rem', alignItems: 'center' }}>
                <span style={{ fontSize: '1rem', fontWeight: 900, color: STAX_FIRE, letterSpacing: '0.1em' }}>{s.tag}</span>
                <span style={{ fontSize: '1.6rem' }} aria-hidden="true">{s.emoji}</span>
                <div>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 900, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{s.title}</h3>
                  <p style={{ fontSize: '0.95rem', color: `${STAX_DARK}99`, marginTop: '0.25rem', lineHeight: 1.45 }}
                    dangerouslySetInnerHTML={{ __html: s.body }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CALLOUT — stax squad voices */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5rem) 0' }}>
        <div className="container">
          <p style={{ color: STAX_FIRE, fontWeight: 800, fontSize: '0.7rem', letterSpacing: '0.32em', textTransform: 'uppercase', marginBottom: '0.75rem', textAlign: 'center' }}>
            Stax squad
          </p>
          <h2 style={{ fontSize: 'clamp(2rem, 5vw, 3.25rem)', fontWeight: 900, letterSpacing: '-0.03em', textAlign: 'center', textTransform: 'uppercase', marginBottom: '2.5rem' }}>
            Loud customers, hot reviews
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
            {[
              { quote: 'BUILT MY OWN STACK WITH 9 TOPPINGS. ZERO REGRETS.',                               who: 'Sara K.',  area: 'DHA Phase 6' },
              { quote: 'LOADED FRIES + GHOST RANCH = DANGER. ORDERED THRICE THIS WEEK.',                  who: 'Imran R.', area: 'Clifton'      },
              { quote: 'CROISSANT + FRIED EGG + HOT HONEY. BREAKFAST OF CHAMPIONS.',                       who: 'Hira M.',  area: 'Bahria Town' },
            ].map((r, i) => (
              <div key={i} style={{
                background: 'white',
                border: `1px solid ${STAX_DARK}1a`,
                padding: '2rem 1.75rem',
                display: 'flex', flexDirection: 'column', gap: '1.25rem',
                borderRadius: '4px',
              }}>
                <p style={{ fontSize: '1.1rem', fontWeight: 900, letterSpacing: '-0.01em', lineHeight: 1.25, textTransform: 'uppercase' }}>{r.quote}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <div style={{ width: '2.2rem', height: '2.2rem', borderRadius: '50%', background: STAX_FIRE, color: 'white', fontWeight: 900, display: 'grid', placeItems: 'center', fontSize: '0.85rem' }}>
                    {r.who[0]}
                  </div>
                  <div>
                    <p style={{ fontSize: '0.85rem', fontWeight: 700 }}>{r.who}</p>
                    <p style={{ fontSize: '0.78rem', color: `${STAX_DARK}99` }}>{r.area}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CrossBrandStrip current={concept} concepts={concepts} accent={STAX_FIRE} kicker="Other GS Foods kitchens" heading="After the burger? Try one of these." />
      <BottomCTA brandName={concept.name} brandSlug={concept.slug} accent={STAX_FIRE} />
    </div>
  )
}

// ─── Category card — emoji on top, SVG texture as background ────────────────

function CategoryCard({ cat, conceptSlug, delayMs }: { cat: StaxCategory; conceptSlug: string; delayMs: number }) {
  const palette = TEXTURE_PALETTE[cat.texture]
  return (
    <Link
      href={`/${conceptSlug}#cat-${cat.slug}`}
      className="stax-cat-card"
      style={{
        animationDelay: `${delayMs}ms`,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: '340px',
        padding: '1.75rem',
        borderRadius: '6px',
        overflow: 'hidden',
        textDecoration: 'none',
        color: palette.fg,
        background: palette.base,
        border: `1px solid ${STAX_DARK}1f`,
        boxShadow: '0 4px 12px -4px rgba(0,0,0,0.15)',
        cursor: 'pointer',
      }}
    >
      {/* Texture layer — bread/pastry pattern, full bleed, no blend mode (cross-browser reliable) */}
      <div
        aria-hidden="true"
        className="stax-texture"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: palette.texture,
          backgroundSize: palette.size,
          backgroundRepeat: 'repeat',
          backgroundPosition: 'center',
        }}
      />
      {/* Bottom darken so type stays legible — heavier shade so type pops over busy textures */}
      <div aria-hidden="true" style={{
        position: 'absolute', inset: 0,
        background: `linear-gradient(180deg, ${palette.shade.replace(/[\d.]+\)$/, '0.10)')} 0%, ${palette.shade.replace(/[\d.]+\)$/, '0.55)')} 55%, ${palette.shade} 100%)`,
      }} />

      {/* Top — kicker + heat + giant emoji */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
        <div>
          <p style={{
            fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.32em', textTransform: 'uppercase',
            color: palette.kicker, marginBottom: '0.4rem', textShadow: palette.kickerShadow,
          }}>
            {cat.kicker}
          </p>
          {cat.heat && <HeatPips level={cat.heat} />}
        </div>
        <span
          aria-hidden="true"
          className="stax-emoji"
          style={{
            fontSize: 'clamp(3rem, 6vw, 4.5rem)',
            lineHeight: 1,
            display: 'inline-block',
            filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.4))',
            transform: 'rotate(-2deg)',
          }}
        >
          {cat.emoji}
        </span>
      </div>

      {/* Bottom — name + tagline + toppings line + price/CTA */}
      <div style={{ position: 'relative', zIndex: 1, marginTop: '1.5rem' }}>
        <h3 style={{
          fontSize: 'clamp(1.6rem, 3.5vw, 2.2rem)', fontWeight: 900, letterSpacing: '-0.04em',
          textTransform: 'uppercase', margin: 0, lineHeight: 0.95, color: palette.heading,
          textShadow: palette.headingShadow,
        }}>
          {cat.name}
        </h3>
        <p style={{
          marginTop: '0.65rem', fontSize: '0.92rem', lineHeight: 1.4, maxWidth: '24rem',
          color: palette.fg, opacity: 0.92, textShadow: palette.bodyShadow,
        }}>
          {cat.tagline}
        </p>
        <p style={{
          marginTop: '0.65rem', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: palette.kicker, opacity: 0.95,
          textShadow: palette.kickerShadow,
        }}>
          {cat.toppingsLine}
        </p>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginTop: '1.25rem', gap: '0.75rem',
        }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: palette.kicker }}>
            From Rs. {(cat.fromCents / 100).toLocaleString()}
          </span>
          <span className="stax-cat-cta" style={{
            fontSize: '0.85rem', fontWeight: 900, letterSpacing: '0.04em', textTransform: 'uppercase',
            color: palette.heading, display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
          }}>
            Build it →
          </span>
        </div>
      </div>
    </Link>
  )
}

// ─── Chef stack card — for "WE BUILD" pre-curated combos ─────────────────────
// Different shape from CategoryCard: dark bg, accent border, full ingredient
// list visible. The point is to telegraph "this is a finished decision" so
// the customer doesn't feel like they need to do work.

function ChefStackCard({ stack, conceptSlug, delayMs }: { stack: ChefStack; conceptSlug: string; delayMs: number }) {
  return (
    <Link
      href={`/${conceptSlug}?stack=${stack.slug}`}
      className="stax-cat-card"
      style={{
        animationDelay: `${delayMs}ms`,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: '380px',
        padding: '1.75rem',
        borderRadius: '6px',
        overflow: 'hidden',
        textDecoration: 'none',
        color: 'white',
        background: STAX_DARK,
        border: `2px solid ${stack.accent}`,
        boxShadow: '0 4px 12px -4px rgba(0,0,0,0.25)',
      }}
    >
      {/* Top — badge + heat + emoji */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '1.25rem' }}>
        <div>
          {stack.badge && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 900, letterSpacing: '0.18em', textTransform: 'uppercase',
              padding: '0.3rem 0.6rem', borderRadius: '3px',
              background: stack.accent, color: 'white',
              display: 'inline-block', marginBottom: '0.6rem',
            }}>
              {stack.badge}
            </span>
          )}
          <p style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.32em', textTransform: 'uppercase', color: stack.accent }}>
            {stack.base}
          </p>
        </div>
        <span aria-hidden="true" className="stax-emoji" style={{
          fontSize: 'clamp(2.6rem, 5vw, 3.6rem)', lineHeight: 1, display: 'inline-block',
          filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.5))', transform: 'rotate(-3deg)',
        }}>
          {stack.emoji}
        </span>
      </div>

      {/* Middle — name */}
      <h3 style={{
        fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, letterSpacing: '-0.04em',
        textTransform: 'uppercase', margin: 0, lineHeight: 0.95, color: 'white',
      }}>
        {stack.name}
      </h3>

      {/* Heat */}
      <div style={{ marginTop: '0.6rem' }}>
        <HeatPips level={stack.heat} />
      </div>

      {/* Toppings list */}
      <ul style={{ marginTop: '1rem', padding: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
        {stack.toppings.map((t) => (
          <li key={t} style={{
            fontSize: '0.72rem', fontWeight: 700,
            padding: '0.3rem 0.65rem', borderRadius: '999px',
            background: 'rgba(255,255,255,0.08)',
            color: 'rgba(255,255,255,0.85)',
            border: '1px solid rgba(255,255,255,0.12)',
          }}>
            {t}
          </li>
        ))}
      </ul>

      {/* Blurb */}
      <p style={{ marginTop: '1rem', fontSize: '0.88rem', color: 'rgba(255,255,255,0.65)', lineHeight: 1.45, flex: 1 }}>
        {stack.blurb}
      </p>

      {/* Footer — price + CTA */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)',
        gap: '0.75rem',
      }}>
        <span style={{ fontSize: 'clamp(1.4rem, 2.5vw, 1.8rem)', fontWeight: 900, color: stack.accent, letterSpacing: '-0.02em' }}>
          Rs. {(stack.priceCents / 100).toLocaleString()}
        </span>
        <span className="stax-cat-cta" style={{
          fontSize: '0.85rem', fontWeight: 900, letterSpacing: '0.04em', textTransform: 'uppercase',
          color: 'white', display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        }}>
          Order this →
        </span>
      </div>
    </Link>
  )
}

// ─── Texture palette ─────────────────────────────────────────────────────────
// Each card gets a base colour + an SVG-encoded texture that simulates the
// surface of that bread/pastry — focaccia dimples, croissant lamination,
// stacked fries, brioche crumb, etc. Patterns scale crisply at any size and
// don't depend on a CDN.

interface Palette {
  base: string
  fg: string
  heading: string
  kicker: string
  shade: string
  texture: string
  size: string
  opacity: number
  blend: 'multiply' | 'overlay' | 'normal' | 'screen'
  bodyShadow: string
  headingShadow: string
  kickerShadow: string
}

const TEXTURE_PALETTE: Record<StaxCategory['texture'], Palette> = {
  'brioche-thick': {
    base: '#3a2418',
    fg: 'rgba(255,235,215,0.95)',
    heading: '#fff5e6',
    kicker: STAX_FIRE,
    shade: 'rgba(20,12,6,0.85)',
    texture: briocheSvg('#d18a4a', '#7a3f1c'),
    size: '380px 380px',
    opacity: 0.7,
    blend: 'overlay',
    bodyShadow: '0 1px 2px rgba(0,0,0,0.6)',
    headingShadow: '0 2px 8px rgba(0,0,0,0.55)',
    kickerShadow: '0 1px 4px rgba(0,0,0,0.6)',
  },
  'brioche-smash': {
    base: '#1f140d',
    fg: 'rgba(255,225,200,0.95)',
    heading: '#fff',
    kicker: STAX_FIRE,
    shade: 'rgba(13,10,9,0.9)',
    texture: briocheSvg('#c47845', '#6a3815'),
    size: '320px 320px',
    opacity: 0.65,
    blend: 'overlay',
    bodyShadow: '0 1px 2px rgba(0,0,0,0.7)',
    headingShadow: '0 2px 10px rgba(0,0,0,0.65)',
    kickerShadow: '0 1px 4px rgba(0,0,0,0.7)',
  },
  focaccia: {
    base: '#e8c270',
    fg: '#3a2410',
    heading: STAX_DARK,
    kicker: '#7a4416',
    shade: 'rgba(160,100,30,0.4)',
    texture: focacciaSvg('#9a6420'),
    size: '420px 420px',
    opacity: 0.78,
    blend: 'multiply',
    bodyShadow: 'none',
    headingShadow: '0 1px 0 rgba(255,240,210,0.4)',
    kickerShadow: 'none',
  },
  croissant: {
    base: '#dba85a',
    fg: '#2a1808',
    heading: STAX_DARK,
    kicker: '#7a3a0e',
    shade: 'rgba(150,85,20,0.45)',
    texture: croissantSvg('#8c4f1e'),
    size: '320px 320px',
    opacity: 0.85,
    blend: 'multiply',
    bodyShadow: 'none',
    headingShadow: '0 1px 0 rgba(255,235,200,0.5)',
    kickerShadow: 'none',
  },
  fries: {
    base: '#e3a64a',
    fg: '#2a1808',
    heading: STAX_DARK,
    kicker: '#7a3a0e',
    shade: 'rgba(140,75,15,0.5)',
    texture: friesSvg('#7a3a0e', '#fff2c8'),
    size: '300px 300px',
    opacity: 0.78,
    blend: 'multiply',
    bodyShadow: 'none',
    headingShadow: '0 1px 0 rgba(255,235,200,0.5)',
    kickerShadow: 'none',
  },
  drinks: {
    base: 'linear-gradient(135deg, #1a3340 0%, #0d1f29 100%)',
    fg: 'rgba(220,240,250,0.95)',
    heading: '#fff',
    kicker: '#5ab8d8',
    shade: 'rgba(8,18,28,0.55)',
    texture: bubblesSvg('#5ab8d8'),
    size: '300px 300px',
    opacity: 0.45,
    blend: 'screen',
    bodyShadow: '0 1px 2px rgba(0,0,0,0.5)',
    headingShadow: '0 2px 10px rgba(0,0,0,0.4)',
    kickerShadow: '0 1px 4px rgba(0,0,0,0.5)',
  },
  desserts: {
    base: 'linear-gradient(135deg, #c1486f 0%, #6a1f38 100%)',
    fg: 'rgba(255,225,235,0.95)',
    heading: '#fff',
    kicker: '#ffd6e0',
    shade: 'rgba(60,15,30,0.5)',
    texture: dotsSvg('#ffd6e0'),
    size: '260px 260px',
    opacity: 0.4,
    blend: 'screen',
    bodyShadow: '0 1px 2px rgba(0,0,0,0.45)',
    headingShadow: '0 2px 10px rgba(0,0,0,0.4)',
    kickerShadow: '0 1px 4px rgba(0,0,0,0.5)',
  },
}

// ─── SVG texture helpers ─────────────────────────────────────────────────────
// Seeded PRNG so SSR + client renders produce identical SVG bytes (no hydration
// mismatch). Each texture targets the actual visual characteristic of that
// bread/pastry: focaccia dimples, croissant lamination, fry sticks, etc.

function url(svg: string): string {
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`
}

function makeRand(seed: number) {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Brioche — soft, warm-glow crumb. Field of elliptical "crumb pockets" over a
// solid base + radial sheen so the card has a finished bun look.
function briocheSvg(highlight: string, shadow: string, base: string = shadow): string {
  const rand = makeRand(0xB7C0E0 + highlight.length * 31 + shadow.length)
  const cells = []
  for (let i = 0; i < 80; i++) {
    const cx = Math.floor(rand() * 200)
    const cy = Math.floor(rand() * 200)
    const r  = 5 + Math.floor(rand() * 10)
    cells.push(`<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${(r * 0.65).toFixed(2)}" fill="${highlight}" opacity="${(0.35 + rand() * 0.25).toFixed(2)}"/>`)
    cells.push(`<ellipse cx="${cx}" cy="${cy}" rx="${(r * 0.55).toFixed(2)}" ry="${(r * 0.35).toFixed(2)}" fill="#fff" opacity="${(0.08 + rand() * 0.1).toFixed(2)}"/>`)
  }
  return url(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice">
    <defs>
      <radialGradient id="g" cx="50%" cy="35%" r="80%">
        <stop offset="0%" stop-color="${highlight}" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="${shadow}" stop-opacity="1"/>
      </radialGradient>
    </defs>
    <rect width="200" height="200" fill="${base}"/>
    <rect width="200" height="200" fill="url(#g)"/>
    ${cells.join('')}
  </svg>`)
}

// Focaccia — characteristic finger-pressed dimples + olive flecks.
function focacciaSvg(shadowHex: string): string {
  const rand = makeRand(0xF0CC1A + shadowHex.length)
  const dimples = []
  for (let r = 0; r < 14; r++) {
    for (let c = 0; c < 14; c++) {
      const jitterX = (rand() - 0.5) * 14
      const jitterY = (rand() - 0.5) * 14
      const cx = c * 22 + 12 + jitterX
      const cy = r * 22 + 12 + jitterY
      const radius = 3 + rand() * 2.5
      dimples.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="${shadowHex}" opacity="${(0.35 + rand() * 0.4).toFixed(2)}" />`)
      dimples.push(`<circle cx="${(cx + 1).toFixed(1)}" cy="${(cy - 1).toFixed(1)}" r="${(radius - 1.2).toFixed(1)}" fill="#fff" opacity="0.18" />`)
    }
  }
  return url(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
    ${dimples.join('')}
    <circle cx="60"  cy="80"  r="6" fill="#3a4a14" opacity="0.55"/>
    <circle cx="220" cy="40"  r="5" fill="#2a3010" opacity="0.55"/>
    <circle cx="180" cy="200" r="7" fill="#3a4a14" opacity="0.5"/>
    <circle cx="280" cy="260" r="5" fill="#3a4a14" opacity="0.55"/>
    <circle cx="40"  cy="240" r="6" fill="#2a3010" opacity="0.55"/>
  </svg>`)
}

// Croissant — laminated layers as parallel curved bands rotated to mimic the
// crescent. Alternating opacity simulates flake-shadow under each layer.
function croissantSvg(shadowHex: string): string {
  const stripes = []
  for (let i = 0; i < 32; i++) {
    const y = i * 8
    const op = i % 2 === 0 ? 0.42 : 0.18
    stripes.push(`<rect x="-20" y="${y}" width="280" height="3" fill="${shadowHex}" opacity="${op}" transform="rotate(-12 120 ${y})" />`)
  }
  const ridges = []
  for (let i = 0; i < 16; i++) {
    const y = i * 16 + 4
    ridges.push(`<rect x="-20" y="${y}" width="280" height="1.5" fill="#fff" opacity="0.18" transform="rotate(-12 120 ${y})" />`)
  }
  return url(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">
    ${stripes.join('')}
    ${ridges.join('')}
  </svg>`)
}

// Fries — vertical sticks of fried potato with rotation jitter so they look
// hand-stacked. Top-edge highlight fakes the cut-edge gloss.
function friesSvg(shadowHex: string, highlightHex: string): string {
  const rand = makeRand(0xF8E5A0 + shadowHex.length + highlightHex.length)
  const sticks: string[] = []
  for (let col = 0; col < 12; col++) {
    for (let i = 0; i < 4; i++) {
      const x = col * 22 + 4 + (rand() - 0.5) * 4
      const y = 8 + i * 64 + (rand() - 0.5) * 12
      const w = 8 + rand() * 4
      const h = 50 + rand() * 14
      const rot = (rand() - 0.5) * 18
      sticks.push(`<g transform="rotate(${rot.toFixed(1)} ${(x + w / 2).toFixed(1)} ${(y + h / 2).toFixed(1)})">
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${shadowHex}" opacity="${(0.32 + rand() * 0.25).toFixed(2)}"/>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="2" fill="${highlightHex}" opacity="0.45"/>
      </g>`)
    }
  }
  return url(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 280">${sticks.join('')}</svg>`)
}

function bubblesSvg(hl: string): string {
  const rand = makeRand(0xBBBB10 + hl.length)
  const circles = []
  for (let i = 0; i < 18; i++) {
    const cx = Math.floor(rand() * 240)
    const cy = Math.floor(rand() * 240)
    const r  = 4 + Math.floor(rand() * 14)
    circles.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${hl}" stroke-width="1.5" opacity="${(0.4 + rand() * 0.4).toFixed(2)}" />`)
  }
  return url(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">${circles.join('')}</svg>`)
}

function dotsSvg(hl: string): string {
  const rand = makeRand(0xD0775E + hl.length)
  const dots = []
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 12; c++) {
      const cx = c * 18 + 9 + (rand() - 0.5) * 6
      const cy = r * 18 + 9 + (rand() - 0.5) * 6
      dots.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(1.2 + rand() * 1.4).toFixed(1)}" fill="${hl}" opacity="${(0.3 + rand() * 0.4).toFixed(2)}" />`)
    }
  }
  return url(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220">${dots.join('')}</svg>`)
}
