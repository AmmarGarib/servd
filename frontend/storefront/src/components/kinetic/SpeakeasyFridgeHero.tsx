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
  /** Interior wood-tone. */
  wood?:       string
  /** Green marble for the back-bar. */
  marble?:     string
  cream?:      string
  reserveHref: string
  /** Optional menu link for inside-the-speakeasy navigation. */
  menuHref?:   string
}

export function SpeakeasyFridgeHero({
  brandName, accent, ink,
  wood   = '#2a1d12',
  marble = '#22382f',
  cream  = '#f4ede0',
  reserveHref, menuHref,
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
            <CoolerInterior accent={accent} cream={cream} marble={marble} wood={wood} />
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
// 1-point perspective interior of an empty walk-in cooler. Vanishing
// point at center back. Built from a single SVG so the rack geometry,
// floor reflection, and ceiling refrigeration unit all stay aligned at
// any size. Text overlays are absolutely-positioned divs on top so we
// can stagger their reveal with scroll progress.
//
// The interior is COLD — cool blue-grey palette, polished aluminum
// surfaces, a single overhead LED light. The only warmth is the gold
// glow on the words themselves, hinting at what's beyond the cooler
// without showing it.

function CoolerInterior({ accent, cream, marble: _marble, wood: _wood }: {
  accent: string
  cream:  string
  marble: string
  wood:   string
}) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {/* SVG renders the perspective room — walls, ceiling, floor,
          racks, refrigeration unit. Text sits in a separate layer above. */}
      <svg
        viewBox="0 0 800 1100"
        preserveAspectRatio="xMidYMid slice"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <defs>
          {/* Cool aluminum wall gradient — bright at the light source, fades to dark */}
          <linearGradient id="coolerWall" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#dbe2e7" />
            <stop offset="35%"  stopColor="#b1bcc3" />
            <stop offset="100%" stopColor="#4d585f" />
          </linearGradient>
          {/* Floor — polished aluminum with deeper reflection */}
          <linearGradient id="coolerFloor" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#3a4348" />
            <stop offset="50%"  stopColor="#252b2f" />
            <stop offset="100%" stopColor="#1a1d20" />
          </linearGradient>
          {/* Ceiling — slightly brighter than walls */}
          <linearGradient id="coolerCeiling" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#9aa4ac" />
            <stop offset="100%" stopColor="#cdd5da" />
          </linearGradient>
          {/* Back wall — picks up the light from the LED */}
          <radialGradient id="coolerBack" cx="50%" cy="40%" r="70%">
            <stop offset="0%"   stopColor="#e5ecf0" />
            <stop offset="60%"  stopColor="#aab4bc" />
            <stop offset="100%" stopColor="#5c6a72" />
          </radialGradient>
          {/* Aluminum rack pillar — vertical brushed metal */}
          <linearGradient id="rackPillar" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%"   stopColor="#5a646b" />
            <stop offset="35%"  stopColor="#b5bec5" />
            <stop offset="65%"  stopColor="#dbe2e7" />
            <stop offset="100%" stopColor="#5a646b" />
          </linearGradient>
          {/* Rack shelf — horizontal brushed metal */}
          <linearGradient id="rackShelf" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#dbe2e7" />
            <stop offset="50%"  stopColor="#a0aab2" />
            <stop offset="100%" stopColor="#4a545b" />
          </linearGradient>
          {/* Refrigeration unit — darker steel */}
          <linearGradient id="fridgeUnit" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor="#5a646b" />
            <stop offset="60%"  stopColor="#2a3035" />
            <stop offset="100%" stopColor="#1a1d20" />
          </linearGradient>
          <filter id="ledGlow">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        {/* Vanishing-point geometry. viewBox is 800 wide, 1100 tall.
            Back wall is the central rectangle at x=170-630, y=240-720.
            Everything else trapezoids out from there. */}

        {/* Ceiling — trapezoid from top edge to back-wall top */}
        <polygon
          points="0,0 800,0 630,240 170,240"
          fill="url(#coolerCeiling)"
        />

        {/* Left wall — trapezoid */}
        <polygon
          points="0,0 170,240 170,720 0,1100"
          fill="url(#coolerWall)"
        />

        {/* Right wall — trapezoid (mirror of left) */}
        <polygon
          points="800,0 800,1100 630,720 630,240"
          fill="url(#coolerWall)"
        />

        {/* Floor — bottom trapezoid */}
        <polygon
          points="0,1100 800,1100 630,720 170,720"
          fill="url(#coolerFloor)"
        />
        {/* Floor reflection of the back wall light — soft elongated highlight */}
        <ellipse cx="400" cy="850" rx="280" ry="40" fill="rgba(255,255,255,0.06)" />

        {/* Back wall — the brightest surface */}
        <rect x="170" y="240" width="460" height="480" fill="url(#coolerBack)" />
        {/* Vertical seam line down the back wall — where two panels meet */}
        <line x1="400" y1="240" x2="400" y2="720" stroke="rgba(0,0,0,0.1)" strokeWidth="1" />

        {/* ── CEILING REFRIGERATION UNIT ──
            Big square unit hanging from the centre of the ceiling, with
            a fan grille below it. */}
        <g transform="translate(400, 145)">
          {/* Mounting plate */}
          <rect x="-130" y="-45" width="260" height="90" rx="3" fill="url(#fridgeUnit)" />
          {/* Fan grille — concentric circles + crosshatch */}
          <circle cx="0" cy="55" r="36" fill="#0a0c0d" />
          <circle cx="0" cy="55" r="34" fill="none" stroke="#5a646b" strokeWidth="1" />
          {Array.from({ length: 8 }).map((_, i) => (
            <line
              key={i}
              x1="0" y1="55"
              x2={Math.cos((i * Math.PI) / 4) * 30}
              y2={55 + Math.sin((i * Math.PI) / 4) * 30}
              stroke="#5a646b" strokeWidth="1"
            />
          ))}
          {/* Fan center hub */}
          <circle cx="0" cy="55" r="6" fill="#3a4348" />
          {/* Brand sticker on the unit */}
          <rect x="-50" y="-30" width="100" height="14" rx="2" fill="rgba(255,255,255,0.08)" />
        </g>

        {/* ── LED CEILING LIGHT ──
            Long horizontal strip across the ceiling, near the front. */}
        <rect x="280" y="40" width="240" height="14" rx="3" fill="#f5fbff" />
        <rect x="280" y="40" width="240" height="14" rx="3" fill="white" opacity="0.7" filter="url(#ledGlow)" />
        {/* Light spill onto the ceiling around the strip */}
        <ellipse cx="400" cy="60" rx="200" ry="32" fill="rgba(255,255,255,0.18)" />

        {/* ── LEFT RACK ──
            Two vertical pillars + three horizontal shelves on the left.
            Front pillar near x=15, back pillar near x=160. Pillars
            recede in perspective: front taller than back. */}
        {/* Front pillar — full viewport height */}
        <rect x="15" y="120" width="14" height="940" fill="url(#rackPillar)" />
        {/* Back pillar — shorter (matches back-wall height) */}
        <rect x="155" y="260" width="10" height="450" fill="url(#rackPillar)" />
        {/* Top connector — runs front-back along the top of the rack */}
        <polygon points="20,118 162,258 162,266 20,128" fill="url(#rackShelf)" opacity="0.85" />
        {/* Three shelves — each a thin polygon spanning front to back at different y's */}
        {([
          [320, 380],   // top shelf (front-y, back-y)
          [560, 480],   // middle shelf
          [820, 600],   // bottom shelf
        ] as Array<[number, number]>).map(([fy, by], i) => (
          <g key={i}>
            <polygon points={`20,${fy} 162,${by} 162,${by + 8} 20,${fy + 12}`} fill="url(#rackShelf)" />
            {/* Shelf underside shadow */}
            <polygon points={`20,${fy + 12} 162,${by + 8} 162,${by + 14} 20,${fy + 24}`} fill="rgba(0,0,0,0.35)" />
          </g>
        ))}

        {/* ── RIGHT RACK ── mirror of left */}
        <rect x="771" y="120" width="14" height="940" fill="url(#rackPillar)" />
        <rect x="635" y="260" width="10" height="450" fill="url(#rackPillar)" />
        <polygon points="780,118 638,258 638,266 780,128" fill="url(#rackShelf)" opacity="0.85" />
        {([
          [320, 380],
          [560, 480],
          [820, 600],
        ] as Array<[number, number]>).map(([fy, by], i) => (
          <g key={i}>
            <polygon points={`780,${fy} 638,${by} 638,${by + 8} 780,${fy + 12}`} fill="url(#rackShelf)" />
            <polygon points={`780,${fy + 12} 638,${by + 8} 638,${by + 14} 780,${fy + 24}`} fill="rgba(0,0,0,0.35)" />
          </g>
        ))}

        {/* Cold-air vapour drifting up from the floor */}
        <ellipse cx="400" cy="780" rx="180" ry="22" fill="rgba(255,255,255,0.07)" />
      </svg>

      {/* ── TYPOGRAPHY OVERLAYS in the empty rack gaps ───────────────
            Each phrase is staggered to fade in at a different scroll
            progress threshold. The cool fridge palette is interrupted
            by warm gold typography — the only "speakeasy" cue. */}

      {/* CRAFTED — left rack, top gap */}
      <FridgeWord
        text="CRAFTED"
        fireAt={0.58}
        color={cream}
        style={{
          top: '24%', left: '6%',
          fontSize: 'clamp(1.4rem, 3.2vw, 2.4rem)',
          letterSpacing: '0.18em',
        }}
      />
      {/* MOCKTAILS — left rack, middle gap */}
      <FridgeWord
        text="MOCKTAILS"
        fireAt={0.62}
        color={accent}
        glow
        style={{
          top: '46%', left: '5%',
          fontSize: 'clamp(1.7rem, 4vw, 3rem)',
          fontStyle: 'italic',
          letterSpacing: '0.04em',
          fontWeight: 600,
        }}
      />

      {/* RESERVATIONS ONLY — dead-center on the back wall, biggest */}
      <FridgeWord
        text="RESERVATIONS"
        fireAt={0.50}
        color={cream}
        style={{
          top: '36%', left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: 'clamp(2rem, 5vw, 3.6rem)',
          letterSpacing: '0.08em',
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
          top: '46%', left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: 'clamp(1.5rem, 4vw, 2.8rem)',
          fontStyle: 'italic',
          letterSpacing: '0.02em',
          textAlign: 'center',
          fontWeight: 500,
        }}
      />

      {/* ELEGANT — right rack, top gap */}
      <FridgeWord
        text="ELEGANT"
        fireAt={0.66}
        color={cream}
        style={{
          top: '24%', right: '6%',
          fontSize: 'clamp(1.4rem, 3.2vw, 2.4rem)',
          letterSpacing: '0.18em',
          textAlign: 'right',
        }}
      />
      {/* PLATES — right rack, middle gap */}
      <FridgeWord
        text="PLATES"
        fireAt={0.70}
        color={accent}
        glow
        style={{
          top: '46%', right: '5%',
          fontSize: 'clamp(1.7rem, 4vw, 3rem)',
          fontStyle: 'italic',
          letterSpacing: '0.04em',
          textAlign: 'right',
          fontWeight: 600,
        }}
      />

      {/* Smaller etched details — operating hours / occupancy / brand
          mark — laid into the bottom shelves */}
      <FridgeWord
        text="open 7pm — late · thu–sun"
        fireAt={0.78}
        color="rgba(255,255,255,0.55)"
        style={{
          bottom: '20%', left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 'clamp(0.65rem, 1.2vw, 0.85rem)',
          letterSpacing: '0.42em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}
      />
    </div>
  )
}

// Small helper that handles the staggered fade-in for each fridge word.
// fireAt = scroll-progress threshold beyond which the word becomes
// visible. Glow optional — adds a soft accent-coloured halo behind the
// type (for the gold words only).
function FridgeWord({
  text, fireAt, color, glow, style,
}: {
  text:   string
  fireAt: number
  color:  string
  glow?:  boolean
  style?: React.CSSProperties
}) {
  return (
    <p
      className="display"
      style={{
        position: 'absolute',
        margin: 0,
        color,
        textShadow: glow ? `0 0 22px ${color}aa, 0 0 4px ${color}66` : '0 1px 2px rgba(0,0,0,0.4)',
        opacity: `calc(max(0, var(--scroll-progress, 0) - ${fireAt}) * 6)`,
        // Each word lifts up a few pixels as it lands.
        // Encode via inline calc so React's CSSProperties type accepts it.
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
