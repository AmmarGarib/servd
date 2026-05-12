'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { PromoBar } from '../parts/PromoBar'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { BottomCTA } from '../parts/BottomCTA'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'

// Simmer — fine-casual mocktail bar and small-plates kitchen. Dark green +
// saffron gold. Warm, intimate, specific. Karachi evenings, plated softly.
// Reservations are first-class. The bar story is the brand story.

interface Props {
  concept: Concept
  concepts: Concept[]
}

const SIMMER_INK   = '#15201c'
const SIMMER_GREEN = '#2d4a3e'
const SIMMER_CREAM = '#f4ede0'
const SIMMER_GOLD  = '#c9a961'

const DRINKS = [
  { name: 'The Garden Fizz',  desc: 'Cucumber ribbons pressed in elderflower syrup, torn mint, long squeeze of lemon, topped sparkling. Light, pale, cleaner than you expect.',                                         price: 750 },
  { name: 'Midnight Bloom',   desc: 'Butterfly pea flower steeped overnight, shaken with lemon and raw honey, lengthened with tonic. Pours indigo. Brightens to violet when the citrus hits.',                         price: 780 },
  { name: 'Stone Rose',       desc: 'Rose water, fresh lychee, sliced ginger, lime, soda. Floral but not sweet. The one everyone orders twice.',                                                                       price: 800 },
  { name: 'Morning After',    desc: 'Cold-pressed ginger and raw turmeric, brightened with lemon and honey, finished sparkling. Tastes like it means well — and it does.',                                             price: 750 },
  { name: 'Simmer Signature', desc: 'The bar\'s current house blend — rotating weekly, never written down. Ask what\'s in it. It\'s always better than you expect.',                                                   price: 850 },
]

const PLATES = [
  { name: 'Smoked Labneh',          desc: 'Our labneh sits in the smoker for six hours before service — dense, cool, carrying a low wood note. Za\'atar oil pooled on top, warm pita alongside, olives that have been sitting in oil since Tuesday.',                                                                         price: 900 },
  { name: 'Burrata & Peach',        desc: 'Stracciatella torn at the table over ripe peach, two thin slices of prosciutto, a long pour of aged balsamic, torn basil. Looks like it took ten minutes. Tastes like it took forty.',                                                                                           price: 1300 },
  { name: 'Crispy Calamari',        desc: 'Flash-fried at 190°C, out in ninety seconds — stays crisp the whole way through the plate. House-made lemon aioli, a pinch of chilli flakes, torn flat-leaf parsley.',                                                                                                          price: 1150 },
  { name: 'Chicken Skewers',        desc: 'Thigh pieces marinated 24 hours in our harissa blend, charred until they hold a crust. Served over harissa yoghurt with pomegranate seeds that pop against the heat.',                                                                                                          price: 1200 },
  { name: 'Slow-Roast Lamb',        desc: 'The shoulder goes in at 10 PM. It comes out at 10 AM — twelve hours, low heat, its own juices. Pulled, plated, finished with a pomegranate jus reduced since prep began. The root vegetables have been in the same pan the whole time.',                                        price: 1950 },
  { name: 'Mushroom Risotto',       desc: 'Arborio cooked long and loose, wild mushrooms folded in at the end so they stay tender rather than disappearing into the rice. Truffle oil, parmesan, cracked black pepper. Vegetarian. The kitchen\'s most reordered plate.',                                                   price: 1500 },
  { name: 'Dark Chocolate Fondant', desc: 'The centre is still liquid when it reaches the table — that\'s the whole point. Vanilla bean ice cream alongside, caramel tuile on top, a dusting of cocoa. You will not share this one.',                                                                                       price: 800 },
]

const FEATURED_PLATES = [
  {
    name: 'Slow-Roast Lamb',
    desc: 'The shoulder goes in at 10 PM. Twelve hours, low heat. Pulled, plated, finished with pomegranate jus. The room smells of it by 9 PM.',
    img: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=700&q=85',
    price: 1950,
  },
  {
    name: 'Midnight Bloom',
    desc: 'Butterfly pea flower steeped overnight, shaken with lemon and honey, tonic to finish. Pours indigo. Brightens to violet when the citrus hits.',
    img: 'https://images.unsplash.com/photo-1544145945-f90425340c7e?w=700&q=85',
    price: 780,
  },
  {
    name: 'Dark Chocolate Fondant',
    desc: 'The centre is still liquid when it reaches the table — that\'s the whole point. Vanilla bean ice cream alongside. You will not share this one.',
    img: 'https://images.unsplash.com/photo-1563729784474-d77dbb933a9e?w=700&q=85',
    price: 800,
  },
]

export function SimmerLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  return (
    <div style={{ background: SIMMER_CREAM, color: SIMMER_INK }}>
      <PromoBar brandName={concept.name} brandSlug={concept.slug} accent={SIMMER_GOLD} />

      {/* HERO — food-split. Right panel: signature dish. Left panel: room copy. */}
      <section style={{
        position: 'relative',
        background: `linear-gradient(170deg, ${SIMMER_INK} 0%, ${SIMMER_GREEN} 100%)`,
        color: 'white',
        overflow: 'hidden',
      }}>
        {/* Warm ambient glow */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: [
            `radial-gradient(ellipse 60% 40% at 75% 20%, ${SIMMER_GOLD}44 0%, transparent 60%)`,
            `radial-gradient(ellipse 40% 60% at 15% 80%, ${SIMMER_GREEN}88 0%, transparent 50%)`,
          ].join(', '),
          zIndex: 1,
        }} />
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'stretch', gap: 0 }}>
            {/* Copy */}
            <div style={{ padding: 'clamp(3rem, 7vw, 5rem) 0 clamp(4rem, 8vw, 6rem)', paddingRight: 'clamp(1.5rem, 4vw, 4rem)' }}>
              <p style={{
                fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.55em',
                color: SIMMER_GOLD, textTransform: 'uppercase', marginBottom: '2rem',
              }}>
                GS Foods · evenings only · no spirits served
              </p>
              <h1 style={{
                fontSize: 'clamp(2.75rem, 8vw, 6.5rem)',
                fontWeight: 300,
                letterSpacing: '0.03em',
                lineHeight: 1.06,
                textTransform: 'uppercase',
                margin: 0,
              }}>
                A room that<br />
                <em style={{ fontStyle: 'italic', fontWeight: 400, color: SIMMER_GOLD }}>
                  doesn&rsquo;t hurry.
                </em>
              </h1>
              <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <OpenStatusBadge hoursData={hoursData} accentColor={SIMMER_GOLD} />
              </div>
              {hoursData && hoursData.hours.length > 0 && (
                <div style={{ marginTop: '1.5rem' }}>
                  <p style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', marginBottom: '0.5rem' }}>Hours (PKT)</p>
                  <HoursGrid hoursData={hoursData} accentColor={SIMMER_GOLD} />
                </div>
              )}
              <p style={{
                marginTop: '2rem',
                fontSize: 'clamp(1rem, 1.6vw, 1.25rem)',
                lineHeight: 1.75,
                color: 'rgba(255,255,255,0.72)',
                fontWeight: 300,
                maxWidth: '36rem',
              }}>
                Twelve tables. A bar that doesn&rsquo;t serve spirits. Hand-built mocktails, seasonal small plates, and a kitchen that takes its time.
              </p>
              <div style={{ marginTop: '2.75rem', display: 'flex', gap: '0.85rem', flexWrap: 'wrap' }}>
                {concept.reservationsEnabled !== false && (
                  <Link href={`/reserve/${concept.slug}`} style={{
                    padding: '1.1rem 2.25rem',
                    background: SIMMER_GOLD,
                    color: SIMMER_INK,
                    fontWeight: 700,
                    fontSize: '0.9rem',
                    letterSpacing: '0.2em',
                    textTransform: 'uppercase',
                    textDecoration: 'none',
                  }}>
                    Reserve a table
                  </Link>
                )}
                <Link href={`/${concept.slug}`} style={{
                  padding: '1.1rem 2.25rem',
                  background: 'transparent',
                  color: 'white',
                  border: '1px solid rgba(255,255,255,0.35)',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  textDecoration: 'none',
                }}>
                  Order in
                </Link>
              </div>
              <div style={{ marginTop: '3rem', display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                {['Tue – Sat · 7pm–midnight', 'Reservations recommended', 'No spirits served'].map((s) => (
                  <span key={s} style={{ fontSize: '0.75rem', fontWeight: 500, color: 'rgba(255,255,255,0.45)', letterSpacing: '0.1em' }}>
                    {s}
                  </span>
                ))}
              </div>
            </div>
            {/* Food image panel */}
            <div style={{ minHeight: 'min(65vh, 620px)', overflow: 'hidden', position: 'relative' }}>
              <img
                src="https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=900&q=85"
                alt="Plated dish at Simmer"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: 0.85 }}
              />
              <div aria-hidden="true" style={{
                position: 'absolute', inset: 0,
                background: `linear-gradient(90deg, ${SIMMER_INK}cc 0%, transparent 40%, transparent 100%)`,
              }} />
              <div style={{
                position: 'absolute', bottom: '2rem', left: '1.5rem',
                background: `${SIMMER_INK}cc`,
                border: `1px solid ${SIMMER_GOLD}44`,
                padding: '0.75rem 1.25rem',
                backdropFilter: 'blur(8px)',
              }}>
                <p style={{ fontSize: '0.78rem', fontWeight: 300, color: SIMMER_GOLD, letterSpacing: '0.18em', textTransform: 'uppercase' }}>
                  Tonight&rsquo;s feature
                </p>
                <p style={{ fontSize: '1rem', fontWeight: 500, color: 'white', marginTop: '0.2rem' }}>Slow-Roast Lamb</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ON THE PLATE — food leads. Three dishes before any brand copy. */}
      <section style={{ padding: 'clamp(4rem, 8vw, 7rem) 0', background: SIMMER_CREAM, borderBottom: `1px solid ${SIMMER_INK}14` }}>
        <div className="container">
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '3rem' }}>
            <div>
              <p style={{ color: SIMMER_GOLD, fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.42em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
                Tonight on the plate
              </p>
              <h2 style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1.1, margin: 0 }}>
                The food.
              </h2>
            </div>
            <Link href={`/brand/${concept.slug}/menu`} style={{ fontSize: '0.82rem', fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: SIMMER_GREEN, textDecoration: 'none', borderBottom: `1px solid ${SIMMER_GOLD}`, paddingBottom: '0.2rem' }}>
              Full menu →
            </Link>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            {FEATURED_PLATES.map((d) => (
              <Link key={d.name} href={`/${concept.slug}`} style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', background: 'white', border: `1px solid ${SIMMER_INK}0f` }}>
                <div style={{ aspectRatio: '4/3', overflow: 'hidden' }}>
                  <img
                    src={d.img}
                    alt={d.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                </div>
                <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 500, letterSpacing: '0.02em' }}>{d.name}</h3>
                  <p style={{ fontSize: '0.9rem', color: `${SIMMER_INK}88`, lineHeight: 1.55, fontStyle: 'italic', flex: 1 }}>{d.desc}</p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '0.75rem', borderTop: `1px solid ${SIMMER_INK}0f` }}>
                    <span style={{ fontSize: '0.95rem', fontWeight: 600, color: SIMMER_GREEN }}>Rs. {d.price.toLocaleString()}</span>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, letterSpacing: '0.18em', color: SIMMER_GOLD, textTransform: 'uppercase' }}>Order →</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* THE BAR — the brand's main differentiator. Lead with the drinks. */}
      <section style={{ padding: 'clamp(4rem, 8vw, 7rem) 0', borderBottom: `1px solid ${SIMMER_INK}14` }}>
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '4rem', alignItems: 'start' }}>

            <div style={{ position: 'sticky', top: '2rem' }}>
              <p style={{ color: SIMMER_GOLD, fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.42em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>
                The bar
              </p>
              <h2 style={{ fontSize: 'clamp(2rem, 4.5vw, 3.25rem)', fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1.1, margin: '0 0 1.5rem' }}>
                No spirit.<br /><em style={{ fontStyle: 'italic', fontWeight: 400, color: SIMMER_GOLD }}>All theatre.</em>
              </h2>
              <p style={{ fontSize: '1rem', color: `${SIMMER_INK}cc`, lineHeight: 1.7, fontWeight: 300, maxWidth: '28rem' }}>
                Every drink is hand-built — steam-smoked, shaken, or slowly stirred. The bar doesn&rsquo;t serve spirits by choice, not constraint. You won&rsquo;t miss them.
              </p>
              <Link href={`/${concept.slug}`} style={{
                display: 'inline-block', marginTop: '1.75rem',
                fontSize: '0.82rem', fontWeight: 600,
                letterSpacing: '0.28em', textTransform: 'uppercase',
                color: SIMMER_GREEN, textDecoration: 'none',
                borderBottom: `1px solid ${SIMMER_GOLD}`,
                paddingBottom: '0.2rem',
              }}>
                Order drinks
              </Link>
            </div>

            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {DRINKS.map((d) => (
                <li key={d.name} style={{
                  padding: '1.6rem 0',
                  borderBottom: `1px solid ${SIMMER_INK}0f`,
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: '1.5rem',
                  alignItems: 'baseline',
                }}>
                  <div>
                    <p style={{ fontSize: '1.05rem', fontWeight: 500, letterSpacing: '0.02em' }}>{d.name}</p>
                    <p style={{ marginTop: '0.3rem', fontSize: '0.9rem', fontStyle: 'italic', color: `${SIMMER_INK}77`, lineHeight: 1.5 }}>{d.desc}</p>
                  </div>
                  <span style={{ fontSize: '0.95rem', fontWeight: 600, color: SIMMER_GREEN, whiteSpace: 'nowrap' }}>
                    Rs. {d.price.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>

          </div>
        </div>
      </section>

      {/* THE KITCHEN — food plates. Mains take time. */}
      <section style={{ padding: 'clamp(4rem, 8vw, 7rem) 0', background: `${SIMMER_INK}04`, borderBottom: `1px solid ${SIMMER_INK}14` }}>
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '3rem 5rem', alignItems: 'start' }}>
            <div>
              <p style={{ color: SIMMER_GOLD, fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.42em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>
                The kitchen
              </p>
              <h2 style={{ fontSize: 'clamp(2rem, 4.5vw, 3.25rem)', fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1.1, margin: '0 0 1.5rem' }}>
                Plates that<br /><em style={{ fontStyle: 'italic', fontWeight: 400, color: SIMMER_GOLD }}>take their time.</em>
              </h2>
              <p style={{ fontSize: '1rem', color: `${SIMMER_INK}cc`, lineHeight: 1.7, fontWeight: 300 }}>
                Small plates to share, mains to linger over, desserts worth saving room for. The menu rotates with the season — these are tonight&rsquo;s features.
              </p>
              <Link href={`/brand/${concept.slug}/menu`} style={{
                display: 'inline-block', marginTop: '1.75rem',
                fontSize: '0.82rem', fontWeight: 600,
                letterSpacing: '0.28em', textTransform: 'uppercase',
                color: SIMMER_GREEN, textDecoration: 'none',
                borderBottom: `1px solid ${SIMMER_GOLD}`,
                paddingBottom: '0.2rem',
              }}>
                Full menu →
              </Link>
            </div>

            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {PLATES.map((p) => (
                <li key={p.name} style={{
                  padding: '1.5rem 0',
                  borderBottom: `1px solid ${SIMMER_INK}0f`,
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: '1.5rem',
                  alignItems: 'baseline',
                }}>
                  <div>
                    <p style={{ fontSize: '1.05rem', fontWeight: 500, letterSpacing: '0.01em' }}>{p.name}</p>
                    <p style={{ marginTop: '0.3rem', fontSize: '0.9rem', fontStyle: 'italic', color: `${SIMMER_INK}77`, lineHeight: 1.45 }}>{p.desc}</p>
                  </div>
                  <span style={{ fontSize: '0.95rem', fontWeight: 600, color: SIMMER_GREEN, whiteSpace: 'nowrap' }}>
                    Rs. {p.price.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* THE ROOM — atmosphere, story, who we are */}
      <section style={{ padding: 'clamp(4rem, 8vw, 7rem) 0', background: SIMMER_INK, color: SIMMER_CREAM }}>
        <div className="container" style={{ maxWidth: '44rem', textAlign: 'center' }}>
          <p style={{ color: SIMMER_GOLD, fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.42em', textTransform: 'uppercase', marginBottom: '1.5rem' }}>
            The room
          </p>
          <h2 style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1.15, margin: '0 0 2rem' }}>
            Built for the kind of night<br /><em style={{ fontStyle: 'italic', fontWeight: 400, color: SIMMER_GOLD }}>that becomes a story.</em>
          </h2>
          <p style={{ fontSize: '1.05rem', lineHeight: 1.9, color: 'rgba(244,237,224,0.78)', fontWeight: 300 }}>
            Low light. Hand-thrown ceramics. Music that doesn&rsquo;t shout you down. Twelve tables — no walk-ins on weekends. One menu, written each week with whatever&rsquo;s fresh. Service that lets the food do the talking.
          </p>
          <p style={{ marginTop: '1.5rem', fontSize: '1rem', lineHeight: 1.8, color: 'rgba(244,237,224,0.55)', fontWeight: 300, fontStyle: 'italic' }}>
            Cooked in our kitchen. Served by our team. No third party between the plate and the table.
          </p>

          <div style={{ marginTop: '3rem', display: 'flex', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {concept.reservationsEnabled !== false && (
              <Link href={`/reserve/${concept.slug}`} style={{
                padding: '1.1rem 2.25rem',
                border: `1px solid ${SIMMER_GOLD}`,
                background: SIMMER_GOLD,
                color: SIMMER_INK,
                fontWeight: 700,
                fontSize: '0.88rem',
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                textDecoration: 'none',
              }}>
                Reserve a table
              </Link>
            )}
            <Link href={`/${concept.slug}`} style={{
              padding: '1.1rem 2.25rem',
              background: 'transparent',
              color: SIMMER_CREAM,
              border: `1px solid rgba(244,237,224,0.3)`,
              fontWeight: 600,
              fontSize: '0.88rem',
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              textDecoration: 'none',
            }}>
              Order in
            </Link>
          </div>
        </div>
      </section>

      {/* VOICES — Karachi regulars */}
      <section style={{ padding: 'clamp(3rem, 7vw, 5rem) 0' }}>
        <div className="container">
          <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
            <p style={{ color: SIMMER_GOLD, fontWeight: 600, fontSize: '0.72rem', letterSpacing: '0.42em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
              Regulars
            </p>
            <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.25rem)', fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              What the table says.
            </h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.25rem' }}>
            {[
              { quote: '"The mocktails are better than most cocktails I\'ve had anywhere in Karachi. The Stone Rose should be illegal."', who: 'Zara A.', area: 'DHA Phase VI' },
              { quote: '"Twelve-hour lamb. I don\'t have words. I just come back every two weeks."',                                       who: 'Bilal H.', area: 'Clifton'     },
              { quote: '"First restaurant in the city where I genuinely don\'t miss alcohol. That\'s a compliment."',                      who: 'Maryam K.', area: 'PECHS'     },
            ].map((r, i) => (
              <div key={i} style={{
                background: 'white',
                border: `1px solid ${SIMMER_INK}14`,
                padding: '2rem 1.75rem',
                display: 'flex', flexDirection: 'column', gap: '1.25rem',
              }}>
                <div style={{ color: SIMMER_GOLD, letterSpacing: '0.1em', fontSize: '0.9rem' }} aria-label="5 out of 5 stars">★★★★★</div>
                <p style={{ fontSize: '0.98rem', lineHeight: 1.65, fontStyle: 'italic', color: `${SIMMER_INK}dd` }}>{r.quote}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', marginTop: 'auto' }}>
                  <div style={{
                    width: '2.25rem', height: '2.25rem', borderRadius: '50%',
                    background: `${SIMMER_GOLD}22`, color: SIMMER_GREEN,
                    fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: '0.85rem',
                  }}>
                    {r.who[0]}
                  </div>
                  <div>
                    <p style={{ fontSize: '0.85rem', fontWeight: 700 }}>{r.who}</p>
                    <p style={{ fontSize: '0.78rem', color: `${SIMMER_INK}88` }}>{r.area}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CrossBrandStrip current={concept} concepts={concepts} accent={SIMMER_GOLD} kicker="GS Foods kitchens" heading="Other nights, other kitchens." />
      <BottomCTA brandName={concept.name} brandSlug={concept.slug} accent={SIMMER_GOLD} />
    </div>
  )
}
