'use client'
import Link from 'next/link'
import { useScrollProgress } from './motionHooks'

/**
 * SpeakeasyFridgeHero — Simmer's web entrance, mirroring the physical one.
 *
 * IRL: Simmer is in the basement of Stax. The entrance — inside Stax —
 * looks like a walk-in fridge door, no signage, no labels. Customers
 * who know, know. They walk up to what looks like a chiller, pull on
 * the handle, and it opens into the speakeasy.
 *
 * On the web:
 *   1. First thing you see on /brand/simmer is the closed walk-in
 *      fridge door, full-bleed. Nothing else. Brushed steel, rivets,
 *      industrial hinges, a polished handle. Looks like a real fridge.
 *   2. As you scroll, the door slowly swings open along its hinge.
 *      Cold air pours out (light-blue glow at the top seam). The
 *      interior emerges from behind — dark wood, green-marble bar,
 *      candle-glow against the back wall.
 *   3. Once the door is fully open, a single line lands on the
 *      interior: "RESERVATIONS ONLY." Below it, the brand wordmark
 *      and the Reserve CTA.
 *
 * Pure scroll-driven. No pin pad, no clicks. The whole hero is a
 * sticky 250vh section; CSS reads --scroll-progress to choreograph the
 * door rotation + the interior reveal + the text cascade.
 */

interface Props {
  brandName:   string
  /** Saffron gold accent. */
  accent:      string
  /** Outer ink — the brushed-steel wall colour. */
  ink:         string
  /** (legacy, ignored by the photo-backed interior — kept for prop compat) */
  wood?:       string
  marble?:     string
  cream?:      string
  reserveHref: string
  /** Optional menu link for inside-the-speakeasy navigation. */
  menuHref?:   string
  /** Optional URL of a walk-in cooler interior photo to use as the
   *  reveal backdrop. When omitted, the component renders a deliberate
   *  dark stainless-steel fallback that won't surprise anyone — no
   *  guessed stock photo. Drop a real photo (1600px wide JPG/WebP) at
   *  `/public/simmer-cooler.jpg` and pass `/simmer-cooler.jpg` here. */
  coolerImageUrl?: string
}

export function SpeakeasyFridgeHero({
  brandName, accent, ink,
  wood   = '#2a1d12',
  marble = '#22382f',
  cream  = '#f4ede0',
  reserveHref, menuHref,
  coolerImageUrl,
}: Props) {
  const { ref } = useScrollProgress<HTMLDivElement>()

  return (
    <div
      ref={ref}
      style={{
        height: '260vh',                       // generous runway for the open
        position: 'relative',
        background: ink,
        color: cream,
        ['--brand-accent' as string]: accent,
        ['--simmer-wood' as string]:  wood,
        ['--simmer-marble' as string]: marble,
      } as React.CSSProperties}
    >
      <div className="sticky overflow-hidden"
        style={{
          top: 0,
          height: '100vh',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* The cooler's EXTERIOR wall — white insulated panel
            construction. This is what a real walk-in chiller looks
            like from outside: prefab insulated panels, white/cream
            face, vertical seam lines every ~24" where the panels meet,
            slight cool tint at the edges from the room lighting around
            it. NOT brushed steel — that was the wrong material entirely. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `
            radial-gradient(ellipse 100% 80% at 50% 50%, #e8e9eb 0%, #c8cbd0 60%, #9aa0a8 100%)
          `,
        }} />
        {/* Vertical insulated-panel seams — every ~24" of the wall. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `
            linear-gradient(90deg,
              transparent 0%,
              transparent calc(50% - 360px), rgba(0,0,0,0.10) calc(50% - 360px), rgba(0,0,0,0.10) calc(50% - 358px), transparent calc(50% - 358px),
              transparent calc(50% - 130px), rgba(0,0,0,0.08) calc(50% - 130px), rgba(0,0,0,0.08) calc(50% - 128px), transparent calc(50% - 128px),
              transparent calc(50% + 128px), rgba(0,0,0,0.08) calc(50% + 128px), rgba(0,0,0,0.08) calc(50% + 130px), transparent calc(50% + 130px),
              transparent calc(50% + 358px), rgba(0,0,0,0.10) calc(50% + 358px), rgba(0,0,0,0.10) calc(50% + 360px), transparent calc(50% + 360px),
              transparent 100%)
          `,
        }} />
        {/* Floor strip — darker concrete / floor tile band running
            across the bottom of the viewport. Makes the cooler "sit
            on" something instead of floating. */}
        <div aria-hidden="true" style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          height: '12vh',
          background: 'linear-gradient(180deg, #5a6066 0%, #2a3034 40%, #14181b 100%)',
          borderTop: '1px solid rgba(0,0,0,0.4)',
          boxShadow: 'inset 0 6px 12px rgba(0,0,0,0.45)',
        }} />
        {/* Soft cast shadow from the cooler onto the floor */}
        <div aria-hidden="true" style={{
          position: 'absolute', left: '50%', bottom: '11vh',
          width: 'min(720px, 88vw)', height: '24px',
          transform: 'translateX(-50%)',
          background: 'radial-gradient(ellipse 60% 100% at 50% 50%, rgba(0,0,0,0.6) 0%, transparent 70%)',
          filter: 'blur(6px)',
        }} />

        {/* Tiny etched label above the door — almost missable. Dark
            grey on the white wall so it reads like vinyl signage. */}
        <p className="eyebrow"
          style={{
            position: 'absolute', top: '4vh', left: '50%',
            transform: 'translateX(-50%)',
            color: 'rgba(40,46,52,0.4)',
            letterSpacing: '0.6em',
            fontSize: '0.66rem',
            zIndex: 5,
          }}>
          below stax · {brandName.toLowerCase()}
        </p>

        {/* THE DOOR ASSEMBLY ──────────────────────────────────────────
            Three layers, back-to-front:
              1. Interior — visible only as door rotates open
              2. Door — rotates open on left hinge based on scroll
              3. Frame — fixed casing around the doorway
        */}
        <div
          style={{
            position: 'relative',
            width: 'min(680px, 90vw)',
            aspectRatio: '3 / 4.6',
            perspective: 1800,
            zIndex: 2,
          }}
        >
          {/* ── INTERIOR — empty walk-in cooler, NOT a wood-marble
                speakeasy. Stays disguised even when the door opens —
                stainless steel racks, polished aluminum floor, LED
                strip and refrigeration unit on the ceiling. The
                speakeasy hint is only the typography in the empty
                rack gaps: RESERVATIONS ONLY / CRAFTED MOCKTAILS /
                ELEGANT PLATES. Brightens as door opens. */}
          <div
            aria-hidden={true}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '4px',
              overflow: 'hidden',
              opacity: 'calc(var(--scroll-progress, 0) * 1.8)',
              transition: 'opacity 80ms linear',
            }}>
            <CoolerInterior accent={accent} cream={cream} imageUrl={coolerImageUrl ?? null} />
          </div>

          {/* ── THE DOOR — rotates open along its left hinge as scroll
                progresses. Goes from 0deg (closed) to -85deg (wide open). */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              transformOrigin: 'left center',
              transform: 'rotateY(calc(var(--scroll-progress, 0) * -85deg))',
              transformStyle: 'preserve-3d',
              transition: 'transform 80ms linear',
              zIndex: 3,
              // Tiny depth shadow that grows as door opens
              boxShadow: 'calc(var(--scroll-progress, 0) * 30px) 0 60px rgba(0,0,0,0.6)',
            } as React.CSSProperties}
          >
            <RealisticFridgeDoor cream={cream} />
          </div>

          {/* ── DIGITAL THERMOMETER — mounted above the door frame.
                Black housing with a small LCD/LED readout showing the
                actual cooler temperature. Brand plate to its right.
                This is what makes the whole thing read as a real
                walk-in cooler from across the room. */}
          <div aria-hidden="true" style={{
            position: 'absolute',
            top: '-86px', left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', gap: '10px',
            zIndex: 5,
          }}>
            {/* The thermometer unit */}
            <div style={{
              background: 'linear-gradient(180deg, #1f2326 0%, #0d0f10 100%)',
              borderRadius: '4px',
              padding: '6px 10px',
              boxShadow: '0 3px 8px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.08)',
              display: 'flex', alignItems: 'center', gap: '6px',
            }}>
              <span style={{
                fontFamily: 'monospace',
                fontSize: '0.62rem',
                color: '#7a8489',
                letterSpacing: '0.18em',
              }}>WIC-002</span>
              <span style={{
                background: '#050708',
                padding: '2px 6px',
                borderRadius: '2px',
                fontFamily: 'monospace',
                fontWeight: 700,
                fontSize: '0.92rem',
                color: '#3fda86',
                textShadow: '0 0 6px rgba(63,218,134,0.65)',
                letterSpacing: '0.04em',
              }}>-2.4°C</span>
            </div>
            {/* Small green status LED */}
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: '#3fda86',
              boxShadow: '0 0 8px rgba(63,218,134,0.8)',
            }} />
          </div>

          {/* ── FRAME — slim stainless steel framework around the
                doorway. Heavy enough to read as commercial-grade but
                NOT a fat black border. Polished steel with subtle
                chrome highlights at the corners. */}
          <div aria-hidden="true" style={{
            position: 'absolute',
            inset: '-12px',
            border: '12px solid transparent',
            borderImage: 'linear-gradient(135deg, #cfd4d8 0%, #6a7077 50%, #cfd4d8 100%) 1',
            background: `
              linear-gradient(135deg, #cfd4d8 0%, #898f94 25%, #6a7077 50%, #898f94 75%, #cfd4d8 100%)
            `,
            backgroundClip: 'border-box',
            borderRadius: '4px',
            boxShadow: '0 28px 60px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.18)',
            pointerEvents: 'none',
            zIndex: 4,
          }}>
            {/* Mounting bolts — one in each corner of the frame */}
            {[['6px', '6px'], ['6px', 'auto', '6px', 'auto'], [null, '6px', '6px', 'auto'], [null, 'auto', '6px', '6px']].map((coords, i) => {
              const [top, right, bottom, left] = coords as Array<string | null | undefined>
              return (
                <div key={i} style={{
                  position: 'absolute',
                  top: top ?? undefined,
                  right: right ?? undefined,
                  bottom: bottom ?? undefined,
                  left: left ?? undefined,
                  width: 8, height: 8,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle at 30% 30%, #e5ebee 0%, #898f94 60%, #2a2e30 100%)',
                  boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.4)',
                }} />
              )
            })}
          </div>
        </div>

        {/* Reveal layer — once door is mostly open (~progress > 0.7),
            the Reserve CTA + brand wordmark fade up below the doorway. */}
        <div
          style={{
            position: 'absolute',
            bottom: '4vh', left: 0, right: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: '0.9rem',
            opacity: 'calc(max(0, var(--scroll-progress, 0) - 0.65) * 3)',
            transform: 'translateY(calc((1 - var(--scroll-progress, 0)) * 20px))',
            transition: 'opacity 100ms linear',
            zIndex: 10,
            pointerEvents: 'auto',
          } as React.CSSProperties}
        >
          <p
            className="display-italic"
            style={{
              fontSize: 'clamp(1.5rem, 3vw, 2.2rem)',
              color: accent,
              textShadow: `0 0 16px ${accent}99`,
            }}
          >
            {brandName.toLowerCase()}.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.7rem', justifyContent: 'center' }}>
            <Link href={reserveHref} className="brand-pill">
              Reserve a table →
            </Link>
            {menuHref && (
              <Link href={menuHref} className="brand-pill-outline" style={{ borderColor: cream, color: cream }}>
                See the menu
              </Link>
            )}
          </div>
        </div>

        {/* "↓ scroll" hint at the bottom — only while door is still closed */}
        <p
          style={{
            position: 'absolute',
            bottom: '14vh', left: 0, right: 0,
            textAlign: 'center',
            color: 'rgba(40,46,52,0.55)',
            fontSize: '0.7rem',
            letterSpacing: '0.45em',
            textTransform: 'uppercase',
            opacity: 'calc(1 - var(--scroll-progress, 0) * 2)',
            zIndex: 5,
            pointerEvents: 'none',
            fontWeight: 700,
          } as React.CSSProperties}
        >
          ↓ scroll to enter
        </p>
      </div>
    </div>
  )
}

// ─── Realistic walk-in cooler door ──────────────────────────────────
// Modelled after an actual commercial walk-in cooler door, not a
// stand-alone metal slab:
//
//   - White insulated panel construction matching the cooler's
//     exterior wall (so the door is flush with the wall, just slightly
//     recessed)
//   - Stainless steel perimeter trim (~18px wide) framing the door
//   - Three heavy-duty industrial hinges down the left
//   - Big horizontal paddle/lever handle on the right side
//   - Small viewing window in the upper third (you'd peek through it
//     to check the cooler before opening)
//   - Stainless steel kick plate at the bottom (protects the panel
//     from carts hitting it)
//   - Manufacturer's plate
//
// LED digital thermometer + brand plate sit ABOVE the door (drawn by
// the parent component since they're outside the rotating door).

function RealisticFridgeDoor({ cream }: { cream: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        // The door is white insulated panel — same construction as the
        // cooler wall it's mounted in. Slight cool tint at the edges
        // implies the panel is recessed slightly into the wall.
        background: `
          radial-gradient(ellipse 100% 100% at 50% 50%, #ecedef 0%, #d8dadd 60%, #b4b8bd 100%)
        `,
        boxShadow: `
          inset 0 0 0 1px rgba(0,0,0,0.08),
          inset 0 -8px 18px rgba(0,0,0,0.10),
          0 14px 30px rgba(0,0,0,0.4)
        `,
      }}
    >
      {/* STAINLESS STEEL PERIMETER TRIM — a band of polished steel
          framing the door. This is the most visually distinctive part
          of a walk-in cooler: the door is INSET into a steel surround. */}
      {/* Top trim */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: '18px',
        background: 'linear-gradient(180deg, #f3f5f7 0%, #b8bdc2 50%, #6a7077 100%)',
        boxShadow: 'inset 0 -1px 2px rgba(0,0,0,0.3)',
      }} />
      {/* Bottom trim */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: '18px',
        background: 'linear-gradient(180deg, #6a7077 0%, #b8bdc2 50%, #f3f5f7 100%)',
        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.25)',
      }} />
      {/* Left trim */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: 0, width: '18px',
        background: 'linear-gradient(90deg, #f3f5f7 0%, #b8bdc2 50%, #6a7077 100%)',
        boxShadow: 'inset -1px 0 2px rgba(0,0,0,0.3)',
      }} />
      {/* Right trim */}
      <div style={{
        position: 'absolute', top: 0, bottom: 0, right: 0, width: '18px',
        background: 'linear-gradient(90deg, #6a7077 0%, #b8bdc2 50%, #f3f5f7 100%)',
        boxShadow: 'inset 1px 0 2px rgba(0,0,0,0.25)',
      }} />

      {/* INDUSTRIAL HINGES — three down the left side. Each one is a
          rectangular hinge body with two visible "knuckles" stacked, so
          it reads as a heavy-duty cooler hinge not a residential one.
          They sit on top of the trim, slightly poking left so they
          look mounted to the doorframe. */}
      {[14, 44, 80].map((topPct) => (
        <CoolerHinge key={topPct} style={{ position: 'absolute', top: `${topPct}%`, left: '-4px' }} />
      ))}

      {/* VIEWING WINDOW — upper-third pane, double-glazed look.
          Frame is brushed steel, glass is dark with a subtle highlight
          reflection so it reads as glass, not a hole. */}
      <div style={{
        position: 'absolute',
        top: '14%', left: '24%', right: '24%',
        height: '22%',
        background: 'linear-gradient(180deg, #a8b0b7 0%, #6e757b 100%)',
        borderRadius: '4px',
        padding: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.18)',
      }}>
        {/* Glass pane */}
        <div style={{
          width: '100%', height: '100%',
          background: `
            linear-gradient(135deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.04) 20%, transparent 35%, transparent 100%),
            linear-gradient(180deg, #1a2024 0%, #0a0e11 100%)
          `,
          borderRadius: '2px',
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6), inset 0 2px 6px rgba(0,0,0,0.7)',
        }} />
      </div>

      {/* PADDLE HANDLE — long horizontal lever on the right side at
          waist height. Heavy industrial stainless. Bolted to a backing
          plate. This is THE recognisable cooler-door element. */}
      {/* Backing plate */}
      <div style={{
        position: 'absolute',
        top: '46%', right: '6%',
        width: '36%', height: '14%',
        background: 'linear-gradient(180deg, #cfd4d8 0%, #898f94 100%)',
        borderRadius: '4px',
        boxShadow: '0 3px 8px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.2)',
      }} />
      {/* The lever itself — long capsule shape with chrome gradient */}
      <div style={{
        position: 'absolute',
        top: '49%', right: '8%',
        width: '32%', height: '8%',
        background: 'linear-gradient(180deg, #f5f7f9 0%, #b8bec3 30%, #f5f7f9 50%, #b8bec3 70%, #6a7077 100%)',
        borderRadius: '999px',
        boxShadow: '0 4px 10px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.3)',
      }} />
      {/* Pivot anchor — circular hub where the lever attaches */}
      <div style={{
        position: 'absolute',
        top: '50%', right: '37%',
        width: '20px', height: '20px',
        background: 'radial-gradient(circle at 35% 30%, #f5f7f9 0%, #898f94 70%, #3a4045 100%)',
        borderRadius: '999px',
        transform: 'translateY(-2px)',
        boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
      }} />
      {/* Lock cylinder under the handle */}
      <div style={{
        position: 'absolute',
        top: '62%', right: '12%',
        width: '24px', height: '18px',
        background: 'linear-gradient(180deg, #b8bec3 0%, #6a7077 100%)',
        borderRadius: '3px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(0,0,0,0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{
          width: 5, height: 5, borderRadius: '50%',
          background: '#0a0c0d',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.3)',
        }} />
      </div>

      {/* MANUFACTURER PLATE — small stainless plate in the upper left */}
      <div style={{
        position: 'absolute',
        top: '5%', left: '5%',
        width: '36%', height: '6%',
        background: 'linear-gradient(180deg, #cfd4d8 0%, #898f94 100%)',
        borderRadius: '2px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.3), inset 0 0 0 1px rgba(255,255,255,0.25)',
        display: 'flex', flexDirection: 'column',
        justifyContent: 'center', padding: '0 0.55rem',
      }}>
        <p style={{
          fontFamily: 'var(--font-display)',
          fontSize: '0.42rem', letterSpacing: '0.42em',
          color: '#3a4045', fontWeight: 700,
        }}>
          WALK-IN · 002 · PROVISIONS
        </p>
        <p style={{
          fontFamily: 'var(--font-display)',
          fontSize: '0.55rem', letterSpacing: '0.04em',
          color: '#1a1d20', fontWeight: 800, marginTop: '0.1rem',
        }}>
          MODEL WIC-300
        </p>
      </div>

      {/* KICK PLATE — stainless plate across the bottom 18% of the door,
          protects the panel from cart strikes / mop bucket bashes */}
      <div style={{
        position: 'absolute',
        bottom: '4%', left: '6%', right: '6%',
        height: '18%',
        background: `
          linear-gradient(180deg, #d5dadd 0%, #989fa4 50%, #6a7077 100%),
          repeating-linear-gradient(90deg, rgba(255,255,255,0.06) 0 1px, transparent 1px 4px)
        `,
        backgroundBlendMode: 'overlay',
        borderRadius: '3px',
        boxShadow: '0 4px 10px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.18)',
      }}>
        {/* A few corner screw heads on the kick plate */}
        {[
          { top: 4, left: 4 }, { top: 4, right: 4 },
          { bottom: 4, left: 4 }, { bottom: 4, right: 4 },
        ].map((pos, i) => (
          <span key={i} style={{
            position: 'absolute', ...pos,
            width: 6, height: 6, borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 30%, #898f94 0%, #1a1d20 80%)',
            boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.3)',
          }} />
        ))}
      </div>

      {/* SUBTLE PANEL SHEEN — diagonal light streak across the door */}
      <div aria-hidden="true" style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(120deg, transparent 38%, rgba(255,255,255,0.06) 50%, transparent 62%)',
        pointerEvents: 'none',
      }} />
      {/* Tiny scuffs near the kick plate to break the perfection */}
      <div aria-hidden="true" style={{
        position: 'absolute',
        bottom: '25%', left: '18%',
        width: '8px', height: '14px',
        background: 'rgba(0,0,0,0.10)',
        borderRadius: '50%',
        filter: 'blur(2px)',
      }} />
      <div aria-hidden="true" style={{
        position: 'absolute',
        bottom: '28%', right: '24%',
        width: '12px', height: '8px',
        background: 'rgba(0,0,0,0.08)',
        borderRadius: '50%',
        filter: 'blur(2px)',
      }} />
      {/* Avoid the eslint "_cream is unused" — keep the prop for parent
          compatibility even if we don't render any cream-coloured text
          on the door itself anymore. */}
      <span style={{ display: 'none' }}>{cream}</span>
    </div>
  )
}

// CoolerHinge — heavy industrial hinge with two visible knuckles.
function CoolerHinge({ style }: { style: React.CSSProperties }) {
  return (
    <div aria-hidden="true" style={{
      width: 30, height: 64,
      background: 'linear-gradient(90deg, #4a4f52 0%, #989fa4 30%, #cfd4d8 50%, #989fa4 70%, #4a4f52 100%)',
      borderRadius: '3px',
      boxShadow: '0 4px 10px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.18)',
      display: 'flex', flexDirection: 'column',
      justifyContent: 'space-around', alignItems: 'center',
      ...style,
    }}>
      {/* Two knuckle rings */}
      <span style={{
        width: 14, height: 14, borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #f3f5f7 0%, #6a7077 70%, #2a2e30 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)',
      }} />
      <span style={{
        width: 14, height: 14, borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #f3f5f7 0%, #6a7077 70%, #2a2e30 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)',
      }} />
    </div>
  )
}

// ─── CoolerInterior ─────────────────────────────────────────────────
// Backdrop behind the door when it opens. Two paths:
//   1. imageUrl provided  → operator's real photo of the cooler.
//                           Photo gets a brightness + cool-tone wash so
//                           gold typography reads against it.
//   2. imageUrl is null   → deliberate CSS-painted fallback that looks
//                           like a dark stainless-steel cavity. No
//                           random stock photo. Honest about being
//                           "not a real photo yet" without breaking
//                           the page.
//
// Typography overlays sit on top either way, fade-staggered to scroll
// progress.

function CoolerInterior({ accent, cream, imageUrl }: {
  accent:   string
  cream:    string
  imageUrl: string | null
}) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {imageUrl ? (
        <>
          {/* OPERATOR-SUPPLIED PHOTO PATH ────────────────────────── */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              backgroundImage: `url(${imageUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              filter: 'brightness(0.72) saturate(0.85) contrast(1.05) hue-rotate(-6deg)',
            }}
          />
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              background: `
                radial-gradient(ellipse 75% 55% at 50% 40%, transparent 0%, transparent 40%, rgba(0,0,0,0.55) 100%),
                linear-gradient(180deg, rgba(0,0,0,0.20) 0%, transparent 25%, transparent 75%, rgba(0,0,0,0.45) 100%)
              `,
            }}
          />
        </>
      ) : (
        <CoolerInteriorSVG />
      )}

      {/* Gold halo at the back-wall centre — warm light hint bleeding
          into the dim cooler. Works for both photo + SVG fallback now
          that the SVG interior is dark again. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse 40% 30% at 50% 40%, ${accent}30 0%, transparent 70%)`,
          mixBlendMode: 'screen',
        }}
      />

      {/* ── TYPOGRAPHY OVERLAYS sitting in the empty shelves of the
            photo. Positions are tuned for a typical walk-in cooler shot
            where racks sit on the left + right side and the back wall is
            roughly centre. Each phrase is staggered to fade in at a
            different scroll-progress threshold. Heavy drop shadows so
            the type reads against any photo we swap in. */}

      {/* ── TYPOGRAPHY in the negative space of the racks ──────────
            Now that the racks have FOUR shelves (matching the IndiaMART
            reference), the gaps are at roughly y = 18%, 32%, 50%, 70%.
            We park "CRAFTED" + "mocktails." in the left rack's upper-
            two gaps and "ELEGANT" + "plates." mirrored on the right.
            "RESERVATIONS only." goes on the back wall (centre, around
            30-42% from top). */}

      <FridgeWord
        text="CRAFTED"
        fireAt={0.58}
        color={cream}
        heavyShadow
        style={{
          top: '20%', left: '3%',
          fontSize: 'clamp(1.1rem, 2.4vw, 1.7rem)',
          letterSpacing: '0.35em',
          fontWeight: 800,
        }}
      />
      <FridgeWord
        text="mocktails."
        fireAt={0.62}
        color={accent}
        glow
        style={{
          top: '36%', left: '2%',
          fontSize: 'clamp(1.8rem, 4.4vw, 3.2rem)',
          fontStyle: 'italic',
          letterSpacing: '-0.01em',
          fontWeight: 600,
        }}
      />

      {/* RESERVATIONS — back wall centre */}
      <FridgeWord
        text="RESERVATIONS"
        fireAt={0.50}
        color={cream}
        heavyShadow
        style={{
          top: '32%', left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: 'clamp(2.2rem, 5.2vw, 3.8rem)',
          letterSpacing: '0.08em',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          fontWeight: 800,
        }}
      />
      <FridgeWord
        text="only."
        fireAt={0.54}
        color={accent}
        glow
        style={{
          top: '42%', left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: 'clamp(1.6rem, 4vw, 2.8rem)',
          fontStyle: 'italic',
          letterSpacing: '-0.01em',
          textAlign: 'center',
          fontWeight: 500,
        }}
      />

      <FridgeWord
        text="ELEGANT"
        fireAt={0.66}
        color={cream}
        heavyShadow
        style={{
          top: '20%', right: '3%',
          fontSize: 'clamp(1.1rem, 2.4vw, 1.7rem)',
          letterSpacing: '0.35em',
          textAlign: 'right',
          fontWeight: 800,
        }}
      />
      <FridgeWord
        text="plates."
        fireAt={0.70}
        color={accent}
        glow
        style={{
          top: '36%', right: '2%',
          fontSize: 'clamp(1.8rem, 4.4vw, 3.2rem)',
          fontStyle: 'italic',
          letterSpacing: '-0.01em',
          textAlign: 'right',
          fontWeight: 600,
        }}
      />

      {/* Operating hours — etched along the cooler floor near the
          bottom, mimicking a vinyl sticker laid on the polished steel */}
      <FridgeWord
        text="open 7pm — late · thu–sun"
        fireAt={0.78}
        color="rgba(255,255,255,0.55)"
        heavyShadow
        style={{
          bottom: '12%', left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 'clamp(0.65rem, 1.2vw, 0.85rem)',
          letterSpacing: '0.42em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          fontWeight: 700,
        }}
      />
    </div>
  )
}

// Staggered fade-in helper for each fridge word.
//   fireAt       — scroll-progress threshold past which the word fades in
//   glow         — soft accent-coloured halo around the type (for gold
//                  italics, makes them feel like neon)
//   heavyShadow  — strong stacked drop-shadow so neutral-cream type
//                  reads cleanly against busy photography
function FridgeWord({
  text, fireAt, color, glow, heavyShadow, style,
}: {
  text:         string
  fireAt:       number
  color:        string
  glow?:        boolean
  heavyShadow?: boolean
  style?:       React.CSSProperties
}) {
  const shadow = glow
    ? `0 0 22px ${color}cc, 0 0 6px ${color}99, 0 2px 6px rgba(0,0,0,0.5)`
    : heavyShadow
      ? '0 2px 4px rgba(0,0,0,0.85), 0 6px 16px rgba(0,0,0,0.65)'
      : '0 1px 2px rgba(0,0,0,0.6)'
  return (
    <p
      className="display"
      style={{
        position: 'absolute',
        margin: 0,
        color,
        textShadow: shadow,
        opacity: `calc(max(0, var(--scroll-progress, 0) - ${fireAt}) * 6)`,
        // Each word lifts up a few pixels as it lands.
        ['--lift' as string]: `calc((1 - max(0, min(1, (var(--scroll-progress, 0) - ${fireAt}) * 6))) * 14px)`,
        transition: 'opacity 80ms linear',
        ...style,
      } as React.CSSProperties}
    >
      <span style={{ display: 'inline-block', transform: 'translateY(var(--lift, 0))' }}>
        {text}
      </span>
    </p>
  )
}

// ─── CoolerInteriorSVG ──────────────────────────────────────────────
// Looks like an actual walk-in cooler interior (bright white walls,
// stainless steel solid-shelf racks against each side wall, polished
// floor, refrigeration unit + LED on the ceiling, back wall with panel
// seam). Built in proper 1-point perspective with the vanishing point
// at the centre of the back wall.
//
// The racks are modelled after the IndiaMART reference: four solid
// stainless shelves with chrome pipe verticals at each corner, visible
// shelf thickness on the front edge (so they read as 3D, not flat).
// Rendered front pole > back pole so the rack foreshortens correctly.
//
// Viewbox is 1600 × 1000. Back-wall rectangle sits at x=520–1080,
// y=240–680. Everything else trapezoids out from that.

function CoolerInteriorSVG() {
  return (
    <svg
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      <defs>
        {/* Dark mood interior palette. The exterior shell of the cooler
            is bright + realistic (white insulated panels). What's
            BEHIND the door, however, is dimmed — the cooler is "still
            cold but the lights are low," nudging the speakeasy vibe. */}
        <linearGradient id="ciWall" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#9aa4ac" />
          <stop offset="55%"  stopColor="#4d585f" />
          <stop offset="100%" stopColor="#1d2226" />
        </linearGradient>
        <radialGradient id="ciBack" cx="50%" cy="40%" r="70%">
          <stop offset="0%"   stopColor="#aab4bc" />
          <stop offset="50%"  stopColor="#5c6a72" />
          <stop offset="100%" stopColor="#1d262b" />
        </radialGradient>
        <linearGradient id="ciCeiling" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#6a747a" />
          <stop offset="100%" stopColor="#aab4bc" />
        </linearGradient>
        <linearGradient id="ciFloor" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#1d2226" />
          <stop offset="50%"  stopColor="#0e1114" />
          <stop offset="100%" stopColor="#050709" />
        </linearGradient>
        {/* Chrome pipe — dark/light/dark gradient for cylindrical sheen */}
        <linearGradient id="ciChrome" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stopColor="#1a1d1f" />
          <stop offset="35%"  stopColor="#7a8489" />
          <stop offset="50%"  stopColor="#bbc3c8" />
          <stop offset="65%"  stopColor="#7a8489" />
          <stop offset="100%" stopColor="#1a1d1f" />
        </linearGradient>
        <linearGradient id="ciShelfTop" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#a0aab2" />
          <stop offset="55%"  stopColor="#5c6770" />
          <stop offset="100%" stopColor="#1a1f23" />
        </linearGradient>
        <linearGradient id="ciShelfEdge" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#5a646b" />
          <stop offset="100%" stopColor="#1a1d1f" />
        </linearGradient>
        <linearGradient id="ciFridgeUnit" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#5a646b" />
          <stop offset="60%"  stopColor="#2a3035" />
          <stop offset="100%" stopColor="#0d1013" />
        </linearGradient>
        <filter id="ciLedGlow">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* ── ROOM SHELL ────────────────────────────────────────────── */}

      {/* Ceiling — trapezoid */}
      <polygon points="0,0 1600,0 1080,240 520,240" fill="url(#ciCeiling)" />
      {/* Left wall — trapezoid */}
      <polygon points="0,0 520,240 520,680 0,1000" fill="url(#ciWall)" />
      {/* Right wall */}
      <polygon points="1600,0 1600,1000 1080,680 1080,240" fill="url(#ciWall)" />
      {/* Floor — trapezoid */}
      <polygon points="0,1000 1600,1000 1080,680 520,680" fill="url(#ciFloor)" />
      {/* Subtle floor reflection band (lighter horizontal sheen) */}
      <ellipse cx="800" cy="840" rx="520" ry="34" fill="rgba(255,255,255,0.06)" />
      {/* Back wall */}
      <rect x="520" y="240" width="560" height="440" fill="url(#ciBack)" />
      {/* Back wall panel seams — two thin vertical lines split the panel into 3 */}
      <line x1="708" y1="240" x2="708" y2="680" stroke="rgba(0,0,0,0.08)" strokeWidth="1" />
      <line x1="892" y1="240" x2="892" y2="680" stroke="rgba(0,0,0,0.08)" strokeWidth="1" />

      {/* Wall-floor corner trim — darker line where wall meets floor (each side) */}
      <line x1="0"    y1="1000" x2="520"  y2="680" stroke="rgba(0,0,0,0.25)" strokeWidth="2" />
      <line x1="1600" y1="1000" x2="1080" y2="680" stroke="rgba(0,0,0,0.25)" strokeWidth="2" />
      <line x1="520"  y1="680"  x2="1080" y2="680" stroke="rgba(0,0,0,0.30)" strokeWidth="2" />
      {/* Wall-ceiling corner trim */}
      <line x1="0"    y1="0"    x2="520"  y2="240" stroke="rgba(0,0,0,0.08)" strokeWidth="1" />
      <line x1="1600" y1="0"    x2="1080" y2="240" stroke="rgba(0,0,0,0.08)" strokeWidth="1" />

      {/* ── CEILING REFRIGERATION UNIT ─────────────────────────────── */}
      <g transform="translate(800, 100)">
        {/* Housing — wider than tall, like the rectangular evaporator
            unit hanging from the ceiling in commercial coolers */}
        <rect x="-160" y="-30" width="320" height="78" rx="3" fill="url(#ciFridgeUnit)" />
        {/* Top mounting strap */}
        <rect x="-130" y="-38" width="260" height="10" fill="#2e3438" />
        {/* Air-vent grille on the underside */}
        <rect x="-130" y="40" width="260" height="22" rx="2" fill="#1a1f22" />
        <g transform="translate(0, 51)">
          {/* Concentric circles + spokes for the fan visible through the grille */}
          <circle cx="-60" cy="0" r="14" fill="none" stroke="#5a6266" strokeWidth="1" />
          <circle cx="-60" cy="0" r="4"  fill="#3a4045" />
          {Array.from({ length: 6 }).map((_, i) => (
            <line key={i}
              x1="-60" y1="0"
              x2={-60 + Math.cos((i * Math.PI) / 3) * 12}
              y2={Math.sin((i * Math.PI) / 3) * 12}
              stroke="#5a6266" strokeWidth="0.8" />
          ))}
          <circle cx="60" cy="0" r="14" fill="none" stroke="#5a6266" strokeWidth="1" />
          <circle cx="60" cy="0" r="4"  fill="#3a4045" />
          {Array.from({ length: 6 }).map((_, i) => (
            <line key={i}
              x1="60" y1="0"
              x2={60 + Math.cos((i * Math.PI) / 3) * 12}
              y2={Math.sin((i * Math.PI) / 3) * 12}
              stroke="#5a6266" strokeWidth="0.8" />
          ))}
          {/* Horizontal louver slats between the two fans */}
          {[0, 6, 12, -6, -12].map((y) => (
            <line key={y} x1="-35" y1={y} x2="35" y2={y} stroke="#5a6266" strokeWidth="0.6" />
          ))}
        </g>
        {/* Brand sticker / model plate on the front */}
        <rect x="-50" y="-10" width="100" height="14" rx="2" fill="rgba(255,255,255,0.10)" />
        <line x1="-44" y1="-3" x2="44" y2="-3" stroke="rgba(255,255,255,0.25)" strokeWidth="0.8" />
      </g>

      {/* ── LED ceiling strip — long fluorescent across the front ── */}
      <rect x="600" y="40" width="400" height="18" rx="4" fill="#f8fbfd" />
      <rect x="600" y="40" width="400" height="18" rx="4" fill="white" opacity="0.7" filter="url(#ciLedGlow)" />
      <ellipse cx="800" cy="68" rx="320" ry="40" fill="rgba(255,255,255,0.22)" />

      {/* ── LEFT RACK ─────────────────────────────────────────────────
            Stands against the left wall. Two front poles + two back
            poles. Four solid shelves spanning between them. We render
            in z-order: back poles first, then shelves (with thickness
            edges), then front poles on top so they sit "in front" of
            the shelves visually. */}
      <LeftRack />

      {/* ── RIGHT RACK ── mirror */}
      <RightRack />

      {/* ── Faint cold-air vapour drifting along the floor ── */}
      <ellipse cx="800" cy="780" rx="200" ry="18" fill="rgba(255,255,255,0.05)" />
    </svg>
  )
}

// LeftRack — 4 chrome verticals (2 front, 2 back) + 4 stainless shelves
// against the left wall, perspectively foreshortened toward the back.
function LeftRack() {
  // Front-of-rack poles (closer to camera, full viewport-height span).
  // Back-of-rack poles (deeper, shorter span — clip to the back wall's
  // y range so they don't poke past the room corners).
  const polesFront: Array<[number, number]> = [[60, 5], [240, 5]]   // [x, width]
  const polesBack:  Array<[number, number]> = [[460, 4], [510, 4]]
  // Shelf-top y-coordinates: front y vs back y (different because the
  // shelf foreshortens). 4 shelves, top to bottom.
  // Pair format: [frontY, backY, thicknessFront, thicknessBack]
  const shelves: Array<[number, number, number, number]> = [
    [180,  280, 10, 7],   // top
    [380,  410, 11, 8],   // mid-upper
    [580,  540, 12, 8],   // mid-lower
    [820,  650, 14, 9],   // bottom
  ]

  return (
    <g>
      {/* Back poles render first (behind shelves) */}
      {polesBack.map(([x, w], i) => (
        <rect key={`bb-${i}`} x={x} y="260" width={w} height="400" fill="url(#ciChrome)" opacity="0.9" />
      ))}

      {/* Shelves — each is a perspective quad (top surface) + a thin
          front-edge rectangle showing the shelf's thickness + an
          underside shadow polygon. */}
      {shelves.map(([fy, by, ft], i) => {
        // Top surface polygon — from front-pole-1 to front-pole-2 (across
        // the rack's depth at the front) to back-pole-2 to back-pole-1.
        const fx1 = 60,  fx2 = 240
        const bx1 = 460, bx2 = 510
        return (
          <g key={i}>
            {/* Top surface */}
            <polygon
              points={`${fx1},${fy} ${fx2},${fy} ${bx2},${by} ${bx1},${by}`}
              fill="url(#ciShelfTop)"
            />
            {/* Front edge — visible vertical thickness of the shelf */}
            <rect x={fx1} y={fy} width={fx2 - fx1} height={ft} fill="url(#ciShelfEdge)" />
            {/* Underside shadow — small dark band under the front edge */}
            <rect x={fx1 - 4} y={fy + ft} width={fx2 - fx1 + 8} height={5} fill="rgba(0,0,0,0.32)" />
          </g>
        )
      })}

      {/* Front poles last so they appear in front of the shelves */}
      {polesFront.map(([x, w], i) => (
        <rect key={`fp-${i}`} x={x} y="80" width={w + 4} height="900" fill="url(#ciChrome)" />
      ))}

      {/* Foot caps at the bottom of front poles — small rubber pads */}
      {polesFront.map(([x, w], i) => (
        <rect key={`fc-${i}`} x={x - 2} y="970" width={w + 8} height="14" fill="#1a1d20" />
      ))}
    </g>
  )
}

// RightRack — mirror of LeftRack across the viewBox centre (x=800).
function RightRack() {
  // Mirror coordinates by reflecting across x=800.
  // Front poles originally at x=60, 240 → mirror to x = (1600-60-w) etc.
  const polesFront: Array<[number, number]> = [[1335, 5], [1515, 5]]
  const polesBack:  Array<[number, number]> = [[1090, 4], [1136, 4]]
  const shelves: Array<[number, number]> = [
    [180,  280],
    [380,  410],
    [580,  540],
    [820,  650],
  ]
  const fx1 = 1360, fx2 = 1540
  const bx1 = 1090, bx2 = 1140

  return (
    <g>
      {polesBack.map(([x, w], i) => (
        <rect key={`bb-${i}`} x={x} y="260" width={w} height="400" fill="url(#ciChrome)" opacity="0.9" />
      ))}
      {shelves.map(([fy, by], i) => (
        <g key={i}>
          <polygon
            points={`${fx1},${fy} ${fx2},${fy} ${bx2},${by} ${bx1},${by}`}
            fill="url(#ciShelfTop)"
          />
          <rect x={fx1} y={fy} width={fx2 - fx1} height={10 + i} fill="url(#ciShelfEdge)" />
          <rect x={fx1 - 4} y={fy + 10 + i} width={fx2 - fx1 + 8} height={5} fill="rgba(0,0,0,0.32)" />
        </g>
      ))}
      {polesFront.map(([x, w], i) => (
        <rect key={`fp-${i}`} x={x} y="80" width={w + 4} height="900" fill="url(#ciChrome)" />
      ))}
      {polesFront.map(([x, w], i) => (
        <rect key={`fc-${i}`} x={x - 2} y="970" width={w + 8} height="14" fill="#1a1d20" />
      ))}
    </g>
  )
}

function Hinge({ style }: { style: React.CSSProperties }) {
  return (
    <div aria-hidden="true" style={{
      width: 26, height: 36,
      background: 'linear-gradient(180deg, #6a6f72 0%, #2e3234 50%, #1a1d1f 100%)',
      borderRadius: '3px',
      boxShadow: '0 3px 8px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.1)',
      ...style,
    }}>
      {/* Hinge pin highlight */}
      <span style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 4, height: '70%',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.1) 100%)',
        borderRadius: '999px',
      }} />
    </div>
  )
}
