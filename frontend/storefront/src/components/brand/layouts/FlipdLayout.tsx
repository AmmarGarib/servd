'use client'
// Flipd — old-school American diner microsite.
//
// Reads like the awning + window of a 1950s-60s roadside diner: red
// candy-stripe awning, Lobster cursive headlines, Bungee marquee for
// the wordmark + signage, Special Elite typewriter for the today's-
// special board. Sky blue + cream stay from the previous palette so
// it still feels like Flipd; red is the new signal colour.
//
// All the visual treatments (awning, neon, tile floor, chrome rule)
// live as utility classes in globals.css.

import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'
import { brandStory } from '../../../lib/concept'

interface Props {
  concept: Concept
  concepts: Concept[]
}

// Static menu of placeholder specials. The /brand/flipd/menu route
// has the live items wired through; this is just for visual texture
// on the "tonight's board" strip.
const TODAYS_BOARD: { item: string; price: string }[] = [
  { item: 'The Court Classic',  price: 'Rs 1,200' },
  { item: 'Double Smash',       price: 'Rs 1,500' },
  { item: 'Bacon Smash',        price: 'Rs 1,650' },
  { item: 'Hand-cut Fries',     price: 'Rs   500' },
  { item: 'Smash Sauce Wings',  price: 'Rs   850' },
  { item: 'Mango Lassi Shake',  price: 'Rs   700' },
]

export function FlipdLayout({ concept, concepts }: Props) {
  const hoursData = useHoursData(concept.slug)
  const story = brandStory(concept.slug)
  const reservations = concept.reservationsEnabled !== false

  return (
    <div className="flipd-page">
      {concept.announcementBanner && (
        <div role="status" style={{
          background: 'var(--flipd-ink)', color: 'var(--flipd-cream)',
          padding: '0.7rem 1.5rem', textAlign: 'center',
          fontFamily: 'var(--flipd-type)', fontSize: '0.85rem',
          letterSpacing: '0.18em', textTransform: 'uppercase',
        }}>
          {concept.announcementBanner}
        </div>
      )}

      {/* ── HERO ─ checkered wrapper background; FLIPD wordmark rides
          on a plain white sign panel so it pops off the busy print
          (no sky drop-shadow). Everything else floats directly on the
          tile pattern. */}
      <section
        className="flipd-tile"
        style={{
          padding: 'clamp(4rem, 10vh, 7rem) clamp(1.5rem, 5vw, 3rem) clamp(3rem, 7vh, 5rem)',
          position: 'relative', overflow: 'hidden',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: '64rem', margin: '0 auto', position: 'relative', zIndex: 2 }}>
          {/* Wordmark card — single white box now contains both the
              Karachi locale stamp (small, top) and the big sky-blue
              FLIPD wordmark. Pulls the two pieces into one logo unit
              so the stack is fewer, bolder shapes. */}
          <div style={{
            display: 'inline-block',
            background: 'white',
            padding: 'clamp(0.7rem, 2vh, 1.4rem) clamp(1rem, 3vw, 1.8rem) clamp(0.9rem, 2.2vh, 1.6rem)',
            margin: '0 0 0.6rem',
            border: '2px solid var(--flipd-ink)',
            borderRadius: '0.6rem',
            boxShadow: '0 6px 0 var(--flipd-ink), 0 14px 30px rgba(14,26,42,0.22)',
          }}>
            <p className="flipd-eyebrow" style={{ margin: '0 0 0.4rem' }}>
              Karachi · Est. &apos;26
            </p>
            <h1 className="flipd-marquee" style={{
              fontSize: 'clamp(5rem, 17vw, 13rem)',
              margin: 0,
              lineHeight: 0.9,
              color: 'var(--flipd-sky)',
              // Ink ledge keeps the wordmark grounded the way the
              // jersey-patch stitching does on the round badge below.
              textShadow: '0 4px 0 var(--flipd-ink)',
            }}>
              FLIPD
            </h1>
          </div>

          {/* Tagline panel — three Lobster cursive lines in sky-deep
              sitting inside a paper card on the wrapper. Replaces the
              previous concept-note copy + duplicate inline tagline +
              OPEN-NOW pill (the operator decided the pill carries no
              real info, and the body copy was redundant with the
              tagline above it). */}
          {/* Tagline badge — perfect circle (border-radius 50%) tilted
              slightly right. Three lines centred. The disc-shaped seal
              breaks the linear stack the same way you'd see a round
              court-side patch on a sports jersey. */}
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--flipd-cream)',
            border: '2px solid var(--flipd-ink)',
            borderRadius: '50%',
            width: 'clamp(15rem, 40vw, 27rem)',
            aspectRatio: '1 / 1',
            marginTop: '1.8rem',
            padding: '1.2rem',
            textAlign: 'center',
            transform: 'rotate(3deg)',
            boxShadow: '0 6px 0 var(--flipd-ink), 0 14px 30px rgba(14,26,42,0.22)',
          }}>
            <p className="flipd-display" style={{
              fontSize: 'clamp(1.5rem, 5.2vw, 2.3rem)',
              margin: 0,
              color: 'var(--flipd-sky-deep)',
              lineHeight: 1.15,
              textTransform: 'uppercase',
              letterSpacing: '0.02em',
            }}>
              Game<br />
              Set<br />
              Smash
            </p>
          </div>

          <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
            <Link href={`/${concept.slug}`} className="flipd-btn">Order now</Link>
            <Link href={`/brand/${concept.slug}/menu`} className="flipd-btn flipd-btn-ghost">See the menu</Link>
          </div>
        </div>
      </section>

      {/* ── TONIGHT'S BOARD ─ a chalkboard-style today's specials list
          rendered as a paper board with typewritten copy ── */}
      <section style={{
        background: 'var(--flipd-ink)',
        color: 'var(--flipd-cream)',
        padding: 'clamp(3.5rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)',
        position: 'relative',
      }}>
        <div style={{ maxWidth: '44rem', margin: '0 auto', textAlign: 'center' }}>
          <p className="flipd-eyebrow" style={{ color: 'var(--flipd-sky)', marginBottom: '0.6rem' }}>
            Court-side board
          </p>
          <h2 className="flipd-display" style={{
            fontSize: 'clamp(2.4rem, 6vw, 3.8rem)',
            color: 'var(--flipd-sky)',
            margin: 0,
          }}>
            now serving
          </h2>

          <div style={{
            marginTop: '2rem',
            padding: '1.8rem 1.4rem',
            background: 'rgba(255,253,247,0.04)',
            border: '1.5px dashed rgba(251,253,255,0.32)',
            borderRadius: '0.6rem',
          }}>
            {TODAYS_BOARD.map((row, i) => (
              <div
                key={row.item}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: '1rem',
                  padding: '0.55rem 0',
                  borderBottom: i === TODAYS_BOARD.length - 1 ? 0 : '1px dotted rgba(251,253,255,0.18)',
                  fontFamily: 'var(--flipd-type)',
                  letterSpacing: '0.04em',
                }}
              >
                <span style={{ textAlign: 'left' }}>{row.item}</span>
                <span style={{ color: 'var(--flipd-sky)', whiteSpace: 'nowrap' }}>{row.price}</span>
              </div>
            ))}
          </div>

          <p className="flipd-type" style={{
            fontSize: '0.78rem', marginTop: '1.4rem',
            color: 'rgba(251,253,255,0.55)',
            letterSpacing: '0.2em', textTransform: 'uppercase',
          }}>
            full menu inside
          </p>
        </div>
      </section>


      {/* ── THE LONG WAY ─ how-we-cook spec strip, retro counter style ── */}
      <section style={{
        padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)',
      }}>
        <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
          <p className="flipd-eyebrow" style={{ marginBottom: '0.8rem' }}>How we cook</p>
          <h2 className="flipd-display" style={{
            fontSize: 'clamp(2.4rem, 5vw, 3.8rem)', margin: '0 0 2.6rem',
            color: 'var(--flipd-ink)',
            maxWidth: '24ch',
          }}>
            cast-iron, court-side.
          </h2>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: '1.1rem',
          }}>
            <Spec value="2x" label="Smash patties, dry-aged beef." />
            <Spec value="260°C" label="Cast-iron flat-top, every smash." />
            <Spec value="0" label="Reheats. Smashed to order only." />
            <Spec value="100%" label="Brioche toasted court-side." />
          </div>
        </div>
      </section>


      {/* ── HIGHLIGHTS / WRAPPER ─ full-bleed checkered diner-floor as
            the entire section background. Reads like the brand's
            takeout-paper print: pattern fills the surface, formica
            cards sit on top like food in the basket. This is one of
            the two "big checkered backgrounds" — see also the final
            CTA section below. */}
      <section
        className="flipd-tile"
        style={{ padding: 'clamp(5rem, 12vh, 8rem) clamp(1.5rem, 5vw, 3rem)' }}
      >
        <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
          {/* Paper label sitting on the wrapper — solid cream backdrop
              so the headline reads cleanly against the busy tile pattern,
              like a sticker on the takeout box. */}
          <div style={{
            display: 'inline-block',
            background: 'var(--flipd-cream)',
            padding: 'clamp(1.2rem, 3vw, 2rem) clamp(1.4rem, 3.5vw, 2.4rem)',
            border: '2px solid var(--flipd-ink)',
            borderRadius: '0.5rem',
            boxShadow: '0 4px 0 var(--flipd-ink), 0 10px 28px rgba(14,26,42,0.18)',
            marginBottom: '2.5rem',
            maxWidth: '100%',
          }}>
            <p className="flipd-eyebrow" style={{ marginBottom: '0.8rem' }}>The court, the smash, the shake</p>
            <h2 className="flipd-display" style={{
              fontSize: 'clamp(2.2rem, 4.5vw, 3.4rem)',
              margin: 0, color: 'var(--flipd-ink)',
              maxWidth: '20ch',
            }}>
              burgers, smashed court-side.
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.1rem' }}>
            {story.highlights.map((h) => (
              <div key={h} className="flipd-card">
                <p className="flipd-type" style={{
                  fontSize: '0.7rem', letterSpacing: '0.32em', textTransform: 'uppercase',
                  color: 'var(--flipd-sky-deep)', margin: '0 0 0.6rem',
                }}>
                  · Today
                </p>
                <p style={{
                  fontFamily: 'var(--flipd-marquee)',
                  fontSize: '1.15rem',
                  lineHeight: 1.3,
                  letterSpacing: '0.02em',
                  margin: 0,
                  color: 'var(--flipd-ink)',
                }}>
                  {h}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── STORY ── */}
      <section style={{
        padding: 'clamp(4rem, 10vh, 7rem) clamp(1.5rem, 5vw, 3rem)',
        background: 'var(--flipd-cream)',
      }}>
        <div style={{ maxWidth: '46rem', margin: '0 auto' }}>
          <p className="flipd-eyebrow" style={{ marginBottom: '0.9rem' }}>Court-side notes</p>
          <p className="flipd-display" style={{
            fontSize: 'clamp(1.6rem, 3.4vw, 2.4rem)',
            lineHeight: 1.35,
            color: 'var(--flipd-ink)',
            margin: 0,
          }}>
            “{story.long}”
          </p>
        </div>
      </section>


      {/* ── HOURS + LOCATION ── */}
      <section style={{ padding: 'clamp(4rem, 9vh, 6rem) clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ maxWidth: '72rem', margin: '0 auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(2rem, 5vw, 4rem)' }} className="flipd-visit-grid">

          <div>
            <p className="flipd-eyebrow" style={{ marginBottom: '1rem' }}>Hours</p>
            <div style={{ marginBottom: '1.4rem' }}><OpenStatusBadge hoursData={hoursData} /></div>
            <div className="flipd-type" style={{ fontSize: '0.95rem' }}>
              {hoursData?.hours && hoursData.hours.length > 0 ? (
                <HoursGrid hoursData={hoursData} />
              ) : (
                <p style={{ opacity: 0.6 }}>Hours not published yet.</p>
              )}
            </div>
          </div>

          <div>
            <p className="flipd-eyebrow" style={{ marginBottom: '1rem' }}>Where</p>
            <p className="flipd-display" style={{
              fontSize: '1.7rem', lineHeight: 1.3,
              margin: '0 0 1rem', color: 'var(--flipd-ink)',
            }}>
              {concept.address ?? 'Karachi · address TBA'}
            </p>
            {concept.phone && (
              <p style={{ fontFamily: 'var(--flipd-type)', fontSize: '1rem', margin: 0 }}>
                <a href={`tel:${concept.phone.replace(/\s/g, '')}`} style={{
                  color: 'var(--flipd-sky-deep)', textDecoration: 'none',
                  borderBottom: '1.5px solid currentColor', fontWeight: 700,
                }}>
                  {concept.phone}
                </a>
              </p>
            )}
            {reservations && (
              <div style={{ marginTop: '2rem' }}>
                <Link href={`/reserve/${concept.slug}`} className="flipd-btn flipd-btn-ghost">Book a court</Link>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── CROSS-BRAND STRIP ── */}
      <CrossBrandStrip
        current={concept}
        concepts={concepts}
        accent="var(--flipd-sky-deep)"
        kicker="Also from the operator"
        heading="More from the same kitchen group."
      />

      {/* ── FINAL CTA / WRAPPER ─ second big full-bleed checkered
            background. The CTA content rides in a solid ink sign panel
            sitting on top of the tile so the wordmark is legible
            against the busy print. Together with the Highlights wrapper
            above, this gives the page two "wrapper-scale" checkered
            surfaces that match the brand's packaging. */}
      <section
        className="flipd-tile"
        style={{
          padding: 'clamp(5rem, 14vh, 9rem) clamp(1.5rem, 5vw, 3rem)',
          textAlign: 'center',
        }}
      >
        <div style={{
          position: 'relative',
          maxWidth: '38rem',
          margin: '0 auto',
          background: 'var(--flipd-ink)',
          color: 'var(--flipd-cream)',
          padding: 'clamp(2.4rem, 6vh, 4rem) clamp(1.8rem, 4vw, 2.8rem)',
          border: '3px solid var(--flipd-ink)',
          borderRadius: '0.8rem',
          boxShadow: '0 6px 0 var(--flipd-sky), 0 16px 40px rgba(14,26,42,0.32)',
        }}>
          <p className="flipd-eyebrow" style={{ color: 'var(--flipd-sky)', marginBottom: '0.8rem' }}>
            Hungry now?
          </p>
          {/* Solid cream marquee. The 4px sky-blue ledge under each
              glyph is the same offset used on the hero FLIPD wordmark —
              keeps the diner-sign weight without any glow. */}
          <h2 className="flipd-marquee" style={{
            fontSize: 'clamp(2.8rem, 6.5vw, 4.6rem)',
            margin: '0 0 0.4rem',
            color: 'var(--flipd-cream)',
            textShadow: '0 4px 0 var(--flipd-sky)',
          }}>
            SMASH IT
          </h2>
          <p className="flipd-display" style={{
            fontSize: 'clamp(1.6rem, 4vw, 2.4rem)',
            margin: '0 0 2.4rem',
            color: 'var(--flipd-sky)',
          }}>
            between sets.
          </p>
          <Link href={`/${concept.slug}`} className="flipd-btn">Order from Flipd →</Link>
        </div>
      </section>

    </div>
  )
}

function Spec({ value, label }: { value: string; label: string }) {
  return (
    <div className="flipd-card" style={{ padding: '1.3rem 1.4rem' }}>
      <span className="flipd-marquee" style={{
        display: 'block',
        fontSize: 'clamp(2.4rem, 4.5vw, 3.4rem)',
        color: 'var(--flipd-ink)',
        lineHeight: 0.95,
      }}>
        {value}
      </span>
      <span className="flipd-type" style={{
        display: 'block',
        marginTop: '0.6rem',
        fontSize: '0.84rem',
        color: 'rgba(14,26,42,0.78)',
        lineHeight: 1.4,
      }}>
        {label}
      </span>
    </div>
  )
}
