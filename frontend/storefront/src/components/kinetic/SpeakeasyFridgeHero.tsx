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
        {/* Concrete + brushed-steel wall the fridge is mounted in.
            Includes a horizontal trim seam, a few stray rivets, and
            faint scuff marks so it reads as a real industrial wall. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: `
            linear-gradient(180deg, #1d2022 0%, #0d0f10 100%),
            repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 6px)
          `,
          backgroundBlendMode: 'overlay',
        }} />
        {/* Subtle wear marks at the door's footprint */}
        <div aria-hidden="true" style={{
          position: 'absolute', left: '50%', bottom: '8vh',
          width: 'min(640px, 80vw)', height: '60px',
          transform: 'translateX(-50%)',
          background: 'radial-gradient(ellipse 60% 40% at 50% 50%, rgba(0,0,0,0.55) 0%, transparent 70%)',
          filter: 'blur(8px)',
        }} />
        {/* Wall trim — horizontal accent line where the floor meets wall */}
        <div aria-hidden="true" style={{
          position: 'absolute', left: 0, right: 0, bottom: '8vh',
          height: 1, background: 'rgba(255,255,255,0.06)',
        }} />

        {/* Tiny etched label above the door. Almost missable. */}
        <p className="eyebrow"
          style={{
            position: 'absolute', top: '6vh', left: '50%',
            transform: 'translateX(-50%)',
            color: 'rgba(255,255,255,0.32)',
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

          {/* ── FRAME — the casing around the doorway. Always visible
                because it doesn't rotate. Heavy black border with bolt
                heads in each corner. */}
          <div aria-hidden="true" style={{
            position: 'absolute',
            inset: '-18px',
            border: '18px solid #0a0c0d',
            borderRadius: '8px',
            boxShadow: '0 28px 70px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(255,255,255,0.06)',
            pointerEvents: 'none',
            zIndex: 4,
          }}>
            {/* Mounting bolts — one in each corner */}
            {[['8px', '8px'], ['8px', 'auto', '8px', 'auto'], [null, '8px', '8px', 'auto'], [null, 'auto', '8px', '8px']].map((coords, i) => {
              const [top, right, bottom, left] = coords as Array<string | null | undefined>
              return (
                <div key={i} style={{
                  position: 'absolute',
                  top: top ?? undefined,
                  right: right ?? undefined,
                  bottom: bottom ?? undefined,
                  left: left ?? undefined,
                  width: 10, height: 10,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle at 30% 30%, #6a6f72 0%, #1a1d1f 80%)',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.1)',
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
            bottom: '4vh', left: 0, right: 0,
            textAlign: 'center',
            color: 'rgba(255,255,255,0.35)',
            fontSize: '0.7rem',
            letterSpacing: '0.45em',
            textTransform: 'uppercase',
            opacity: 'calc(1 - var(--scroll-progress, 0) * 2)',
            zIndex: 5,
            pointerEvents: 'none',
          } as React.CSSProperties}
        >
          ↓ scroll to enter
        </p>
      </div>
    </div>
  )
}

// ─── Realistic walk-in fridge door ──────────────────────────────────
// Layered detail: brushed-steel face, riveted edges, label plate up top,
// industrial hinges down the left, polished handle on the right, latch
// mechanism + safety lock above the handle, vent slats at the bottom,
// condensation marks across the surface, an inspection sticker.

function RealisticFridgeDoor({ cream }: { cream: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: '4px',
        // Brushed steel — vertical brush striations + a slight bevel
        background: `
          linear-gradient(180deg, #4a4f52 0%, #2e3234 35%, #2a2e30 65%, #1a1d1f 100%),
          repeating-linear-gradient(90deg, rgba(255,255,255,0.06) 0 1px, transparent 1px 3px)
        `,
        backgroundBlendMode: 'overlay',
        overflow: 'hidden',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08), 0 14px 30px rgba(0,0,0,0.45)',
      }}
    >
      {/* Hinges — three on the left side */}
      {[12, 38, 78].map((topPct) => (
        <Hinge key={topPct} style={{ position: 'absolute', left: '-6px', top: `${topPct}%` }} />
      ))}

      {/* Top label plate — "WALK-IN · 002 / PROVISIONS" */}
      <div style={{
        position: 'absolute', top: '6%', left: '10%', right: '36%',
        padding: '0.6rem 0.85rem',
        background: 'rgba(10,12,13,0.7)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '3px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.04)',
      }}>
        <p style={{
          fontFamily: 'var(--font-display)',
          fontSize: '0.58rem', letterSpacing: '0.55em',
          color: 'rgba(255,255,255,0.55)', fontWeight: 700,
        }}>
          WALK-IN · 002
        </p>
        <p style={{
          fontFamily: 'var(--font-display)',
          fontSize: '0.92rem', fontWeight: 800,
          color: cream, marginTop: '0.18rem', letterSpacing: '0.02em',
        }}>
          PROVISIONS
        </p>
      </div>

      {/* Inspection sticker — small circular sticker, slightly off-axis */}
      <div style={{
        position: 'absolute',
        top: '11%', right: '12%',
        width: 56, height: 56,
        borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 30%, #c9a961 0%, #8a6e2e 70%, #4d3d18 100%)',
        boxShadow: '0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.15)',
        transform: 'rotate(-6deg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        fontFamily: 'var(--font-display)',
      }}>
        <span style={{ fontSize: '0.55rem', fontWeight: 800, color: '#1a1410', letterSpacing: '0.18em' }}>
          INSP
        </span>
        <span style={{ fontSize: '0.7rem', fontWeight: 900, color: '#1a1410', lineHeight: 1 }}>
          ★
        </span>
        <span style={{ fontSize: '0.45rem', fontWeight: 700, color: '#1a1410', letterSpacing: '0.1em' }}>
          PASSED
        </span>
      </div>

      {/* Handle assembly — long polished vertical bar on the right */}
      <div style={{
        position: 'absolute',
        top: '32%', bottom: '32%', right: '7%',
        width: '16px',
        background: 'linear-gradient(90deg, #4a4f52 0%, #8a9094 30%, #d5d9dc 50%, #8a9094 70%, #4a4f52 100%)',
        borderRadius: '999px',
        boxShadow: '0 6px 14px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.12)',
      }} />
      {/* Handle mounting brackets — top + bottom */}
      <div style={{
        position: 'absolute', top: '30%', right: '6%',
        width: '20px', height: '14px',
        background: 'linear-gradient(180deg, #6a6f72 0%, #2e3234 100%)',
        borderRadius: '3px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
      }} />
      <div style={{
        position: 'absolute', bottom: '30%', right: '6%',
        width: '20px', height: '14px',
        background: 'linear-gradient(180deg, #6a6f72 0%, #2e3234 100%)',
        borderRadius: '3px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
      }} />

      {/* Latch / safety lock — above the handle */}
      <div style={{
        position: 'absolute',
        top: '22%', right: '6%',
        width: '22px', height: '46px',
        background: 'linear-gradient(180deg, #9a9fa3 0%, #4a4f52 100%)',
        borderRadius: '3px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.12)',
      }}>
        {/* Tiny keyhole dot */}
        <span style={{
          position: 'absolute', top: '60%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 4, height: 4, borderRadius: '50%',
          background: '#0a0c0d',
          boxShadow: '0 0 0 1.5px rgba(255,255,255,0.2)',
        }} />
      </div>

      {/* Bottom vent slats — louvered air vent */}
      <div style={{
        position: 'absolute',
        bottom: '7%', left: '14%', right: '14%',
        height: '12%',
        background: `repeating-linear-gradient(180deg,
          rgba(0,0,0,0.65) 0 4px,
          rgba(255,255,255,0.04) 4px 11px)`,
        borderRadius: '4px',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.05), inset 0 4px 12px rgba(0,0,0,0.6)',
      }} />

      {/* Surface condensation — faint vertical streaks of moisture */}
      <div aria-hidden="true" style={{
        position: 'absolute', inset: 0,
        background: `
          radial-gradient(ellipse at 30% 35%, rgba(255,255,255,0.06) 0%, transparent 35%),
          radial-gradient(ellipse at 75% 65%, rgba(255,255,255,0.05) 0%, transparent 40%),
          radial-gradient(ellipse at 20% 80%, rgba(255,255,255,0.04) 0%, transparent 35%)
        `,
        pointerEvents: 'none',
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
        <>
          {/* FALLBACK PATH ───────────────────────────────────────
              No photo supplied yet. Paint a deliberate stainless-steel
              cavity with CSS so the page looks intentional, not broken.
              Drop a real photo at /public/simmer-cooler.jpg and pass
              coolerImageUrl="/simmer-cooler.jpg" to swap in. */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              background: `
                radial-gradient(ellipse 90% 55% at 50% 35%, #4a545b 0%, #2a3035 45%, #15191c 100%)
              `,
            }}
          />
          {/* Front-to-back lighter wash so the back of the room feels
              recessed and lit, not flat */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              background: `
                linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 30%, transparent 70%, rgba(0,0,0,0.45) 100%)
              `,
            }}
          />
          {/* Subtle brushed-steel vertical striations on the side walls */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              background: `
                linear-gradient(90deg,
                  rgba(255,255,255,0.06) 0%,
                  rgba(255,255,255,0.06) 12%,
                  transparent 25%,
                  transparent 75%,
                  rgba(255,255,255,0.06) 88%,
                  rgba(255,255,255,0.06) 100%),
                repeating-linear-gradient(90deg,
                  rgba(255,255,255,0.025) 0 1px,
                  transparent 1px 4px)
              `,
              mixBlendMode: 'overlay',
            }}
          />
          {/* Soft cold-light from above */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute', inset: 0,
              background: `radial-gradient(ellipse 50% 25% at 50% 5%, rgba(255,255,255,0.18) 0%, transparent 70%)`,
            }}
          />
        </>
      )}

      {/* Subtle accent wash at the centre — gold halo bleeding into the
          back wall as if light is escaping from somewhere behind. Same
          for both photo and fallback paths. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse 40% 30% at 50% 40%, ${accent}28 0%, transparent 70%)`,
          mixBlendMode: 'screen',
        }}
      />

      {/* ── TYPOGRAPHY OVERLAYS sitting in the empty shelves of the
            photo. Positions are tuned for a typical walk-in cooler shot
            where racks sit on the left + right side and the back wall is
            roughly centre. Each phrase is staggered to fade in at a
            different scroll-progress threshold. Heavy drop shadows so
            the type reads against any photo we swap in. */}

      {/* CRAFTED — left rack, upper shelf gap */}
      <FridgeWord
        text="CRAFTED"
        fireAt={0.58}
        color={cream}
        heavyShadow
        style={{
          top: '22%', left: '4%',
          fontSize: 'clamp(1.2rem, 2.8vw, 2rem)',
          letterSpacing: '0.32em',
        }}
      />
      {/* MOCKTAILS — left rack, mid shelf gap, gold italic */}
      <FridgeWord
        text="mocktails."
        fireAt={0.62}
        color={accent}
        glow
        style={{
          top: '36%', left: '3%',
          fontSize: 'clamp(1.8rem, 4.5vw, 3.4rem)',
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
          top: '30%', left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: 'clamp(2.2rem, 5.5vw, 4rem)',
          letterSpacing: '0.06em',
          textAlign: 'center',
          whiteSpace: 'nowrap',
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
          fontSize: 'clamp(1.6rem, 4.5vw, 3rem)',
          fontStyle: 'italic',
          letterSpacing: '-0.01em',
          textAlign: 'center',
          fontWeight: 500,
        }}
      />

      {/* ELEGANT — right rack, upper shelf gap */}
      <FridgeWord
        text="ELEGANT"
        fireAt={0.66}
        color={cream}
        heavyShadow
        style={{
          top: '22%', right: '4%',
          fontSize: 'clamp(1.2rem, 2.8vw, 2rem)',
          letterSpacing: '0.32em',
          textAlign: 'right',
        }}
      />
      {/* PLATES — right rack, mid shelf gap, gold italic */}
      <FridgeWord
        text="plates."
        fireAt={0.70}
        color={accent}
        glow
        style={{
          top: '36%', right: '3%',
          fontSize: 'clamp(1.8rem, 4.5vw, 3.4rem)',
          fontStyle: 'italic',
          letterSpacing: '-0.01em',
          textAlign: 'right',
          fontWeight: 600,
        }}
      />

      {/* Operating hours — etched along the bottom shelf */}
      <FridgeWord
        text="open 7pm — late · thu–sun"
        fireAt={0.78}
        color="rgba(255,255,255,0.75)"
        heavyShadow
        style={{
          bottom: '18%', left: '50%',
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
