'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'

/**
 * SpeakeasyFridgeHero — the literal Simmer entrance, on the website.
 *
 * Concept (from the operator):
 *   "Simmer is in the basement of Stax. The entrance is the outer shell
 *    of a walk-in fridge with a pin pad. Customers tap in a code to get
 *    in. Inside: dark, moody, wood + green marble, mocktails + tapas."
 *
 * The web hero mirrors the physical entrance exactly:
 *   1. User lands on the page. A walk-in fridge door fills the viewport,
 *      brushed steel, with a small pin pad next to the handle.
 *   2. User taps the pin pad (touchscreen-style buttons 0-9). Four digits
 *      land in the readout. Wrong code → red flash + clear. Right code
 *      (1973 — Karachi's first speakeasy year, but really just a memorable
 *      4-digit) → the readout turns green and the door unlocks with a soft
 *      "click" + a brand-accent halo.
 *   3. The fridge door slowly swings open, revealing the speakeasy
 *      interior behind it: warm low light, wood panels, green-marble
 *      counter, glass shelves with mocktails, the brand logo wordmark
 *      glowing on the back wall.
 *   4. Menu categories (Small Plates, Large Plates, Desserts, Drinks)
 *      fade up over the interior, with a reservations CTA.
 *
 * Fallback for scroll-only users: if the user scrolls past the door
 * without entering a code, the door opens automatically once they've
 * scrolled ~30% past the section. Nobody gets stuck.
 *
 * Code: 1973 (deliberately not displayed anywhere; the savvy customer
 * either learns it from word-of-mouth, or scrolls and the door yields).
 */

interface CategoryReveal {
  label: string
  emoji: string
  href:  string
}

interface Props {
  brandName:  string
  /** Hex of the brand accent (gold for Simmer). */
  accent:     string
  /** Outer ink — the brushed-steel exterior background. */
  ink:        string
  /** Deeper wood-tone for the interior reveal. */
  wood?:      string
  /** Marble swatch for the back-bar counter. */
  marble?:    string
  /** "Cream" tone used on label text inside. */
  cream?:     string
  reserveHref: string
  menuHref:    string
  categories?: CategoryReveal[]
  /** The unlock code. Default 1973. */
  code?:       string
}

const DEFAULT_CATEGORIES: CategoryReveal[] = [
  { label: 'Small plates', emoji: '🥄', href: '#small' },
  { label: 'Large plates', emoji: '🍽',  href: '#large' },
  { label: 'Desserts',     emoji: '🍰', href: '#desserts' },
  { label: 'Drinks',       emoji: '🍸', href: '#drinks' },
]

export function SpeakeasyFridgeHero({
  brandName, accent, ink,
  wood   = '#2a1d12',
  marble = '#22382f',
  cream  = '#f4ede0',
  reserveHref, menuHref,
  categories = DEFAULT_CATEGORIES,
  code = '1973',
}: Props) {
  const [entered, setEntered]     = useState('')        // digits the user has tapped so far
  const [unlocked, setUnlocked]   = useState(false)     // door opens once true
  const [errorTick, setErrorTick] = useState(0)         // bumped on wrong-code to trigger shake
  const [autoUnlock, setAutoUnlock] = useState(false)   // fallback once user scrolls past
  const sectionRef = useRef<HTMLDivElement | null>(null)

  // Fallback unlock — if the user scrolls into the page without engaging
  // the pin pad, ease the door open once they've crossed ~70% of viewport
  // height past the section top. We don't punish people for not knowing
  // there's a code; the interaction is a delight for those who try it.
  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    function onScroll() {
      const rect = el!.getBoundingClientRect()
      if (rect.top < -window.innerHeight * 0.3) {
        setAutoUnlock(true)
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  function pressKey(d: string) {
    if (unlocked) return
    if (d === 'C') { setEntered(''); return }
    if (d === '⌫') { setEntered((cur) => cur.slice(0, -1)); return }
    setEntered((cur) => {
      const next = (cur + d).slice(0, code.length)
      // Validate as soon as we've got the full code length
      if (next.length === code.length) {
        if (next === code) {
          // tiny delay so the user reads "✓" before the door opens
          setTimeout(() => setUnlocked(true), 350)
        } else {
          setErrorTick((t) => t + 1)
          setTimeout(() => setEntered(''), 600)
        }
      }
      return next
    })
  }

  const open = unlocked || autoUnlock

  return (
    <section
      ref={sectionRef}
      style={{
        position: 'relative',
        minHeight: '100vh',
        background: ink,
        color: cream,
        overflow: 'hidden',
        ['--brand-accent' as string]: accent,
        ['--simmer-wood' as string]:  wood,
        ['--simmer-marble' as string]: marble,
      } as React.CSSProperties}
    >
      {/* Brushed-steel wall — the exterior surface the fridge sits in.
          Subtle vertical brushing pattern + a long horizontal seam line
          across the middle gives it the "industrial wall" feel. */}
      <div aria-hidden="true" style={{
        position: 'absolute', inset: 0,
        background: `
          linear-gradient(180deg, #2a2f31 0%, #1a1d1f 100%),
          repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 4px)
        `,
        backgroundBlendMode: 'overlay',
      }} />
      {/* Horizontal seam line — a thin highlight band crossing the wall */}
      <div aria-hidden="true" style={{
        position: 'absolute', left: 0, right: 0, top: '52%',
        height: 1, background: 'rgba(255,255,255,0.06)',
      }} />

      {/* Brand label etched into the wall above the door — small, almost
          missable. The whole point of a speakeasy. */}
      <p className="eyebrow"
        style={{
          position: 'absolute', top: '6vh', left: '50%',
          transform: 'translateX(-50%)',
          color: 'rgba(255,255,255,0.4)',
          letterSpacing: '0.55em',
          fontSize: '0.68rem',
        }}>
        below stax · {brandName.toLowerCase()}
      </p>

      <div className="container relative z-10" style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(6rem, 12vw, 9rem) 1rem 4rem',
      }}>

        {/* The fridge door + pin pad assembly */}
        <div style={{
          position: 'relative',
          width: 'min(560px, 86vw)',
          aspectRatio: '3 / 4.4',
          perspective: 1400,
        }}>

          {/* INTERIOR — behind the door. Becomes visible only after the
              door opens; otherwise hidden by the door's z-index. */}
          <div
            aria-hidden={!open}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '14px',
              background: `
                radial-gradient(ellipse 80% 60% at 50% 70%, ${accent}30 0%, transparent 70%),
                linear-gradient(180deg, #0e1612 0%, ${wood} 100%)
              `,
              overflow: 'hidden',
              boxShadow: 'inset 0 30px 80px rgba(0,0,0,0.7)',
              opacity: open ? 1 : 0,
              transition: 'opacity 800ms ease 600ms',
            }}>
            {/* Wood-panel slat texture */}
            <div aria-hidden="true" style={{
              position: 'absolute', inset: 0,
              background: `repeating-linear-gradient(180deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 64px)`,
            }} />
            {/* Green marble back-bar — bottom 40% */}
            <div aria-hidden="true" style={{
              position: 'absolute',
              left: 0, right: 0, bottom: 0,
              height: '42%',
              background: `
                radial-gradient(ellipse at 30% 50%, ${marble}cc 0%, transparent 60%),
                radial-gradient(ellipse at 70% 30%, ${marble} 0%, transparent 70%),
                linear-gradient(180deg, ${marble} 0%, #0d1813 100%)
              `,
              borderTop: `1px solid ${accent}45`,
            }}>
              {/* Bottle silhouettes on the back bar */}
              <div style={{
                position: 'absolute', bottom: '20%', left: 0, right: 0,
                display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end',
                gap: '6px',
                padding: '0 8%',
              }}>
                {[80, 110, 70, 95, 120, 75, 100].map((h, i) => (
                  <div key={i} style={{
                    width: 14, height: h,
                    background: 'linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.9) 100%)',
                    borderRadius: '4px 4px 2px 2px',
                    boxShadow: `0 0 8px ${accent}55`,
                  }} />
                ))}
              </div>
            </div>
            {/* Brand wordmark glowing on the back wall */}
            <p
              className="display-italic"
              style={{
                position: 'absolute',
                top: '20%', left: 0, right: 0,
                textAlign: 'center',
                color: accent,
                fontSize: 'clamp(2rem, 5vw, 3.5rem)',
                textShadow: `0 0 24px ${accent}aa`,
                letterSpacing: '-0.01em',
              }}
            >
              {brandName.toLowerCase()}.
            </p>
            {/* Welcome eyebrow */}
            <p className="eyebrow" style={{
              position: 'absolute', top: '34%', left: 0, right: 0,
              textAlign: 'center', color: 'rgba(244,237,224,0.55)',
              letterSpacing: '0.45em',
              fontSize: '0.7rem',
            }}>
              you're in
            </p>
            {/* Cold-air drift on first open — light stream pouring out */}
            <div aria-hidden="true" style={{
              position: 'absolute',
              top: 0, left: '40%', width: '20%', height: '40%',
              background: `linear-gradient(180deg, ${accent}20 0%, transparent 100%)`,
              filter: 'blur(20px)',
              opacity: open ? 0.7 : 0,
              transition: 'opacity 700ms ease 600ms',
            }} />
          </div>

          {/* THE DOOR — sits on top of the interior. Swings open along its
              left hinge (rotateY) when unlocked. */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              transformOrigin: 'left center',
              transform: open
                ? 'rotateY(-78deg) translateX(-2px)'
                : `rotateY(0deg) translateX(${errorTick % 2 ? '8px' : '0'})`,
              transformStyle: 'preserve-3d',
              transition: open
                ? 'transform 1500ms cubic-bezier(0.22, 1, 0.36, 1)'
                : 'transform 90ms cubic-bezier(0.7, 0, 0.7, 1)',
              zIndex: 2,
            }}
          >
            {/* Door face — brushed steel, big handle on the right, label
                up top, vent slats at the bottom. */}
            <div style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '14px',
              background: `
                linear-gradient(180deg, #4a5054 0%, #2a2f31 50%, #1d2122 100%),
                repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 3px)
              `,
              backgroundBlendMode: 'overlay',
              boxShadow: open
                ? '0 0 0 1px rgba(255,255,255,0.06), 0 30px 60px rgba(0,0,0,0.6)'
                : '0 0 0 1px rgba(255,255,255,0.08), 0 18px 40px rgba(0,0,0,0.5)',
              overflow: 'hidden',
            }}>
              {/* Top label plate — "PROVISIONS" or just an industrial sticker */}
              <div style={{
                position: 'absolute',
                top: '5%', left: '10%', right: '32%',
                padding: '0.5rem 0.85rem',
                background: 'rgba(0,0,0,0.55)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '4px',
              }}>
                <p style={{ fontSize: '0.6rem', letterSpacing: '0.5em', color: 'rgba(255,255,255,0.55)', fontWeight: 700 }}>
                  WALK-IN · 002
                </p>
                <p style={{ fontSize: '0.85rem', fontWeight: 800, color: cream, marginTop: '0.15rem' }}>
                  PROVISIONS
                </p>
              </div>
              {/* Door handle — long vertical bar on the right side */}
              <div style={{
                position: 'absolute',
                top: '20%', bottom: '20%', right: '7%',
                width: '14px',
                background: 'linear-gradient(90deg, #5a5f62 0%, #8a9094 30%, #c5c9cc 50%, #8a9094 70%, #5a5f62 100%)',
                borderRadius: '999px',
                boxShadow: '0 4px 14px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.1)',
              }} />
              {/* Latch — small fixture above the handle */}
              <div style={{
                position: 'absolute',
                top: '14%', right: '6%',
                width: '18px', height: '38px',
                background: 'linear-gradient(180deg, #8a9094 0%, #4a5054 100%)',
                borderRadius: '3px',
                boxShadow: '0 2px 6px rgba(0,0,0,0.6)',
              }} />
              {/* Bottom vent slats */}
              <div style={{
                position: 'absolute',
                bottom: '8%', left: '14%', right: '14%',
                height: '90px',
                background: `repeating-linear-gradient(180deg, rgba(0,0,0,0.6) 0 4px, rgba(255,255,255,0.04) 4px 12px)`,
                borderRadius: '6px',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.05)',
              }} />

              {/* Pin pad — middle-left of the door. This is what the user
                  taps. Each button is a small steel square with the
                  number etched in. Wrong code = brief red glow + shake. */}
              <div
                style={{
                  position: 'absolute',
                  top: '36%',
                  left: '10%',
                  width: 'clamp(160px, 38%, 200px)',
                  padding: '0.85rem',
                  background: 'linear-gradient(180deg, #1a1d1f 0%, #0d0f10 100%)',
                  border: `1px solid ${entered.length === code.length && entered === code ? accent : 'rgba(255,255,255,0.12)'}`,
                  borderRadius: '10px',
                  boxShadow: '0 6px 16px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.05)',
                  transition: 'border-color 200ms ease',
                }}>
                {/* Readout — shows entered digits as dots, flashes red on wrong */}
                <div style={{
                  background: '#0a0c0d',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '4px',
                  padding: '0.4rem 0.6rem',
                  marginBottom: '0.65rem',
                  minHeight: '32px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: '0.4rem',
                  fontFamily: 'var(--font-display), monospace',
                  color: errorTick && entered.length === code.length
                    ? '#ff4d4f'
                    : entered === code ? accent : cream,
                  letterSpacing: '0.6em',
                  fontSize: '1.1rem',
                  fontWeight: 800,
                  textShadow: errorTick && entered.length === code.length
                    ? '0 0 8px rgba(255,77,79,0.7)'
                    : entered === code ? `0 0 8px ${accent}aa` : 'none',
                  transition: 'color 200ms, text-shadow 200ms',
                }}>
                  {entered === code
                    ? '✓'
                    : Array.from({ length: code.length }).map((_, i) => entered[i] ? '●' : '○').join(' ')}
                </div>

                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '0.35rem',
                }}>
                  {['1','2','3','4','5','6','7','8','9','C','0','⌫'].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => pressKey(d)}
                      onMouseDown={(e) => e.preventDefault()}
                      style={{
                        aspectRatio: '1 / 1',
                        background: 'linear-gradient(180deg, #2a2f31 0%, #1a1d1f 100%)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '5px',
                        color: cream,
                        fontFamily: 'var(--font-display), monospace',
                        fontWeight: 800,
                        fontSize: '0.95rem',
                        cursor: 'pointer',
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04), 0 1px 0 rgba(255,255,255,0.06)',
                        transition: 'transform 80ms ease, background 120ms ease',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'linear-gradient(180deg, #353a3c 0%, #232728 100%)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(180deg, #2a2f31 0%, #1a1d1f 100%)' }}
                      onMouseDownCapture={(e) => { e.currentTarget.style.transform = 'scale(0.94)' }}
                      onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)' }}
                    >
                      {d}
                    </button>
                  ))}
                </div>

                {/* Hint — appears subtly under the pad. The savvy user gets
                    it; everyone else can scroll past and the door opens. */}
                <p style={{
                  marginTop: '0.65rem',
                  fontSize: '0.6rem',
                  letterSpacing: '0.18em',
                  color: 'rgba(255,255,255,0.32)',
                  textAlign: 'center',
                  textTransform: 'uppercase',
                }}>
                  {entered.length === code.length && entered !== code
                    ? 'try again'
                    : entered === code
                      ? 'access granted'
                      : 'enter to dine'}
                </p>
              </div>

              {/* Frost / condensation effect on the steel — gradient bands
                  to imply temperature. */}
              <div aria-hidden="true" style={{
                position: 'absolute', inset: 0,
                background: `
                  radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.05) 0%, transparent 50%),
                  radial-gradient(ellipse at 80% 90%, rgba(255,255,255,0.04) 0%, transparent 60%)
                `,
                pointerEvents: 'none',
              }} />
            </div>
          </div>

          {/* Door frame casing — a darker outer rectangle around the door */}
          <div aria-hidden="true" style={{
            position: 'absolute',
            inset: '-14px',
            border: '14px solid #0a0c0d',
            borderRadius: '24px',
            boxShadow: '0 24px 60px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.06)',
            pointerEvents: 'none',
            zIndex: 3,
          }} />
        </div>

        {/* Reveal — menu categories + CTA. Stacked below the door, fades
            in once the door is open. Sits OUTSIDE the door's 3D rotation
            so it stays flat to the screen. */}
        <div
          style={{
            marginTop: 'clamp(2rem, 4vw, 3rem)',
            textAlign: 'center',
            opacity: open ? 1 : 0,
            transform: open ? 'translateY(0)' : 'translateY(28px)',
            transition: 'opacity 800ms ease 900ms, transform 800ms ease 900ms',
            pointerEvents: open ? 'auto' : 'none',
            maxWidth: '720px',
          }}>
          <p className="eyebrow" style={{ color: accent, marginBottom: '0.85rem' }}>
            inside · ready for you
          </p>
          <h2 className="display" style={{
            fontSize: 'clamp(2rem, 4vw, 3rem)',
            color: cream,
            marginBottom: '1.5rem',
          }}>
            Welcome to {brandName}<span style={{ color: accent }}>.</span>
          </h2>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: '0.65rem',
            marginBottom: '1.75rem',
          }}>
            {categories.map((c) => (
              <a
                key={c.label}
                href={c.href}
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${accent}40`,
                  backdropFilter: 'blur(8px)',
                  borderRadius: '0.9rem',
                  padding: '0.95rem 0.5rem',
                  textDecoration: 'none',
                  color: cream,
                  transition: 'border-color 180ms ease, transform 180ms ease',
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: '0.95rem',
                  letterSpacing: '-0.01em',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.transform = 'translateY(-2px)' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = `${accent}40`; e.currentTarget.style.transform = 'translateY(0)' }}
              >
                <span style={{ fontSize: '1.4rem', display: 'block', marginBottom: '0.35rem' }}>{c.emoji}</span>
                {c.label}
              </a>
            ))}
          </div>

          <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.7rem', justifyContent: 'center' }}>
            <Link href={reserveHref} className="brand-pill">
              Reserve a table →
            </Link>
            <Link href={menuHref} className="brand-pill-outline" style={{ borderColor: cream, color: cream }}>
              See the menu
            </Link>
          </div>
        </div>

        {/* Subtle scroll-or-tap hint near the bottom, before the door opens */}
        {!open && (
          <p style={{
            position: 'absolute', bottom: '4vh', left: 0, right: 0,
            textAlign: 'center',
            color: 'rgba(255,255,255,0.35)',
            fontSize: '0.72rem',
            letterSpacing: '0.32em',
            textTransform: 'uppercase',
          }}>
            tap a code · or scroll past
          </p>
        )}
      </div>
    </section>
  )
}
