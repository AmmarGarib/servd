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

import { useEffect } from 'react'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { CrossBrandStrip } from '../parts/CrossBrandStrip'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../parts/OpenStatusBadge'
import { brandStory, conceptHeroImage } from '../../../lib/concept'
import { Reveal } from '../../motion/Motion'
import { FlipdRallyHero } from '../../kinetic/FlipdRallyHero'

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

  // Snap each checkered section's height to a whole number of 36px tiles so the
  // diner pattern never clips a partial row at the bottom. Paired with
  // background-repeat:repeat (crisp, integer 18px cells), this keeps every row —
  // top and bottom — exactly the same size on any display.
  useEffect(() => {
    const fit = () => {
      document.querySelectorAll<HTMLElement>('.flipd-tile').forEach((el) => {
        el.style.paddingBottom = ''
        const base = parseFloat(getComputedStyle(el).paddingBottom) || 0
        const h = el.getBoundingClientRect().height
        const extra = (36 - (h % 36)) % 36
        if (extra > 0.5) el.style.paddingBottom = `${base + extra}px`
      })
    }
    fit()
    const raf = requestAnimationFrame(fit)
    const t = setTimeout(fit, 800)
    window.addEventListener('resize', fit)
    return () => { cancelAnimationFrame(raf); clearTimeout(t); window.removeEventListener('resize', fit) }
  }, [])

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

      {/* ── HERO ─ the rally: perspective court, scroll-driven bouncing
          ball, GAME → SET → SMASH stamps, burger finale. sr-only H1 for
          SEO/a11y; the brand mark lives in the nav. */}
      <h1 style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}>
        {concept.name}
      </h1>
      <FlipdRallyHero
        img={conceptHeroImage(concept)}
        orderHref={`/${concept.slug}`}
        menuHref={`/brand/${concept.slug}/menu`}
      />

      {/* ── TONIGHT'S BOARD ─ a chalkboard-style today's specials list
          rendered as a paper board with typewritten copy ── */}
      <section className="flipd-turf-ink" style={{
        color: 'var(--flipd-cream)',
        padding: 'clamp(3.5rem, 8vh, 5rem) clamp(1.5rem, 5vw, 3rem)',
        position: 'relative',
      }}>
        <div style={{ maxWidth: '44rem', margin: '0 auto', textAlign: 'center' }}>
          <Reveal y={24}>
            <p className="flipd-eyebrow" style={{ color: 'var(--flipd-optic)', marginBottom: '0.6rem' }}>
              Court-side board
            </p>
            <h2 className="flipd-display" style={{
              fontSize: 'clamp(2.4rem, 6vw, 3.8rem)',
              color: 'var(--flipd-cream)',
              margin: 0,
            }}>
              now serving
            </h2>
          </Reveal>

          <Reveal y={30} delay={0.1}>
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
                <span style={{ color: 'var(--flipd-optic)', whiteSpace: 'nowrap' }}>{row.price}</span>
              </div>
            ))}
          </div>

          </Reveal>

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
          <Reveal y={24}>
            <p className="flipd-eyebrow" style={{ marginBottom: '0.8rem' }}>How we cook</p>
            <h2 className="flipd-display" style={{
              fontSize: 'clamp(2.4rem, 5vw, 3.8rem)', margin: '0 0 2.6rem',
              color: 'var(--flipd-ink)',
              maxWidth: '24ch',
            }}>
              cast-iron, court-side.
            </h2>
          </Reveal>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: '1.1rem',
          }}>
            {[
              { value: '2x',    label: 'Smash patties, dry-aged beef.' },
              { value: '260°C', label: 'Cast-iron flat-top, every smash.' },
              { value: '0',     label: 'Reheats. Smashed to order only.' },
              { value: '100%',  label: 'Brioche toasted court-side.' },
            ].map((s, i) => (
              <Reveal key={s.value} delay={i * 0.09} y={34}>
                <Spec value={s.value} label={s.label} />
              </Reveal>
            ))}
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
        className="flipd-turf-ink"
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
            {story.highlights.map((h, i) => (
              <Reveal key={h} delay={i * 0.1} y={36}>
              <div className="flipd-card">
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
              </Reveal>
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
        <Reveal y={44} blur amount={0.35}>
        <div className="flipd-turf-ink" style={{
          position: 'relative',
          maxWidth: '38rem',
          margin: '0 auto',
          color: 'var(--flipd-cream)',
          padding: 'clamp(2.4rem, 6vh, 4rem) clamp(1.8rem, 4vw, 2.8rem)',
          border: '3px solid var(--flipd-ink)',
          borderRadius: '0.8rem',
          boxShadow: '0 6px 0 var(--flipd-sky), 0 16px 40px rgba(14,26,42,0.32)',
        }}>
          <p className="flipd-eyebrow" style={{ color: 'var(--flipd-optic)', marginBottom: '0.8rem' }}>
            Hungry now?
          </p>
          {/* Solid cream marquee. The 4px sky-blue ledge under each
              glyph is the same offset used on the hero FLIPD wordmark —
              keeps the diner-sign weight without any glow. */}
          <h2 className="flipd-marquee" style={{
            fontSize: 'clamp(2.8rem, 6.5vw, 4.6rem)',
            margin: '0 0 0.4rem',
            color: 'var(--flipd-cream)',
            textShadow: '0 4px 0 var(--flipd-optic)',
          }}>
            SMASH IT
          </h2>
          <p className="flipd-display" style={{
            fontSize: 'clamp(1.6rem, 4vw, 2.4rem)',
            margin: '0 0 2.4rem',
            color: 'var(--flipd-cream)',
          }}>
            between sets.
          </p>
          <Link href={`/${concept.slug}`} className="flipd-btn">Order from Flipd →</Link>
        </div>
        </Reveal>
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
