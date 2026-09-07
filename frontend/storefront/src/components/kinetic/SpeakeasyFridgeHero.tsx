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
  marble = '#06392F',
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
        {/* BLUEPRINT BACKDROP. We can't render a photoreal walk-in
            chiller in CSS+SVG (already proven). Instead we lean into a
            deliberate architectural-drawing aesthetic: deep ink paper
            with a faint grid + gold-cream technical lines drawing the
            cooler. Reads as "schematic of the entrance" — intentional,
            on-brand for the speakeasy mood, doesn't pretend to be
            something it isn't. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: '#06392F',
        }} />
        {/* Faint blueprint grid — 40px squares, thin gold-cream stroke */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          backgroundImage: `
            linear-gradient(rgba(237,230,211,0.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(237,230,211,0.06) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px, 40px 40px',
        }} />
        {/* Heavier major grid every 200px so the page has visual
            structure without the grid feeling busy */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          backgroundImage: `
            linear-gradient(rgba(237,230,211,0.10) 1px, transparent 1px),
            linear-gradient(90deg, rgba(237,230,211,0.10) 1px, transparent 1px)
          `,
          backgroundSize: '200px 200px, 200px 200px',
        }} />
        {/* Vignette so the centre of the drawing feels lit. Kept off the TOP
            edge (lit zone centred high, gentle edge darkening) so the chiller
            surroundings stay #06392F where they meet the header — otherwise the
            old strong vignette darkened the top and clashed with the flat nav. */}
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse 120% 85% at 50% 24%, transparent 0%, transparent 52%, rgba(0,0,0,0.28) 100%)',
        }} />

        {/* TITLE BLOCK — top-left corner. Same convention every real
            engineering drawing uses: project name + drawing number +
            scale. Sells the "this is a deliberate schematic" framing. */}
        <div style={{
          position: 'absolute', top: '3vh', left: '4vw',
          color: 'rgba(237,230,211,0.7)',
          fontFamily: 'var(--font-display)',
          fontSize: '0.62rem',
          letterSpacing: '0.32em',
          lineHeight: 1.55,
          zIndex: 6,
          textTransform: 'uppercase',
        }}>
          <p style={{ color: 'rgba(237,230,211,0.45)' }}>· PROJECT</p>
          <p style={{ color: '#EDE6D3', fontWeight: 700 }}>{brandName.toUpperCase()} · BELOW STAX</p>
          <p style={{ color: 'rgba(237,230,211,0.45)', marginTop: '0.6rem' }}>· SHEET A-02 / ENTRANCE</p>
        </div>
        {/* TITLE BLOCK — top-right corner: scale + revision */}
        <div style={{
          position: 'absolute', top: '3vh', right: '4vw',
          color: 'rgba(237,230,211,0.7)',
          fontFamily: 'var(--font-display)',
          fontSize: '0.62rem',
          letterSpacing: '0.32em',
          lineHeight: 1.55,
          zIndex: 6,
          textTransform: 'uppercase',
          textAlign: 'right',
        }}>
          <p style={{ color: 'rgba(237,230,211,0.45)' }}>SCALE 1 : 24</p>
          <p style={{ color: 'rgba(237,230,211,0.45)' }}>REV · {new Date().getFullYear()}.05</p>
          <p style={{ color: '#EDE6D3', fontWeight: 700, marginTop: '0.6rem' }}>↓ SCROLL · OPEN</p>
        </div>

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
                speakeasy. Stays disguised even when the door opens.
                The speakeasy hint is the "RESERVATIONS only." headline
                on the back wall, the simmer wordmark, and the Reserve
                / Menu CTAs that fade in as the door opens. */}
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
                progresses. Goes from 0deg (closed) to -120deg (folded back
                past the frame, the way a real walk-in door sits when
                someone props it). Swinging past 90° means the viewer sees
                the door's INNER side, so the panel is two faces with
                backface-visibility hidden on each — otherwise the blueprint
                front would show mirrored. */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              transformOrigin: 'left center',
              transform: 'rotateY(calc(var(--scroll-progress, 0) * -120deg))',
              transformStyle: 'preserve-3d',
              transition: 'transform 80ms linear',
              zIndex: 3,
              // Tiny depth shadow that grows as door opens
              boxShadow: 'calc(var(--scroll-progress, 0) * 30px) 0 60px rgba(0,0,0,0.6)',
            } as React.CSSProperties}
          >
            {/* Front face — the blueprint drawing */}
            <div style={{
              position: 'absolute', inset: 0,
              backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
            }}>
              <BlueprintCoolerDoor accent={accent} />
            </div>
            {/* Inner face — the same blueprint sheet as everything else:
                tiber green, the 40px/200px grid, cream line work. Drawn as
                the door's inside (gasket + interior safety release) so the
                language holds when the door swings past perpendicular.
                Pre-rotated 180° so it faces the viewer at that point. */}
            <div aria-hidden="true" style={{
              position: 'absolute', inset: 0,
              transform: 'rotateY(180deg)',
              backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
              background: '#06392F',
              overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute', inset: 0,
                backgroundImage: `
                  linear-gradient(rgba(237,230,211,0.06) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(237,230,211,0.06) 1px, transparent 1px),
                  linear-gradient(rgba(237,230,211,0.10) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(237,230,211,0.10) 1px, transparent 1px)
                `,
                backgroundSize: '40px 40px, 40px 40px, 200px 200px, 200px 200px',
              }} />
              <BlueprintDoorInside />
            </div>
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
                doorway. Just a ring; nothing filled in the middle. The
                previous version had a `background` gradient that filled
                everything inside the border, painting over the entire
                door and interior (which is what you saw — "a metal
                plate blocking everything"). Border-image alone draws
                the steel ring without covering the contents. */}
          <div aria-hidden="true" style={{
            position: 'absolute',
            inset: '-12px',
            border: '12px solid transparent',
            borderImage: 'linear-gradient(135deg, #e5ebee 0%, #989fa4 25%, #6a7077 50%, #989fa4 75%, #e5ebee 100%) 1',
            borderRadius: '4px',
            boxShadow: '0 28px 60px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.18), 0 0 0 1px rgba(0,0,0,0.25)',
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

        {/* Reveal layer — once door is mostly open (~progress > 0.65),
            the brand wordmark + the Reserve/Menu CTAs fade in INSIDE
            the cooler. Sits at top 48% so the wordmark sits just under
            the RESERVATIONS headline (38%) and the two pills clear the
            "open 7pm" floor sticker at bottom 4% even on a 390px-tall
            mobile cooler. */}
        <div
          style={{
            position: 'absolute',
            top: '48%', left: 0, right: 0,
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
            simmer down.
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

        {/* Bottom annotation row — the standard engineering-drawing
            footer with dimension callouts. Static; doesn't fade. */}
        <div style={{
          position: 'absolute',
          bottom: '3vh', left: '4vw', right: '4vw',
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          color: 'rgba(237,230,211,0.55)',
          fontFamily: 'var(--font-display)',
          fontSize: '0.6rem',
          letterSpacing: '0.32em',
          textTransform: 'uppercase',
          zIndex: 6,
          pointerEvents: 'none',
        }}>
          <span>↳ DOOR · 1900 × 800 MM · INSULATED</span>
          <span style={{
            opacity: 'calc(1 - var(--scroll-progress, 0) * 2)',
          } as React.CSSProperties}>
            ENTRANCE · MEMBERS ONLY
          </span>
          <span>WIC-002 · ─2.4°C</span>
        </div>
      </div>
    </div>
  )
}

// ─── Blueprint cooler door ──────────────────────────────────────────
// Technical-drawing aesthetic. We can't render a photoreal walk-in
// chiller in CSS+SVG. Instead this is a clean architectural schematic:
// thin gold-cream strokes on the dark ink background, every part
// labelled with a callout line + dimension annotations. Reads as
// "drawing of the cooler door" rather than "failed attempt at a photo."
//
// Includes the same anatomical parts a real commercial walk-in door
// has (panel, perimeter trim, hinges, handle, viewing window, kick
// plate, manufacturer plate) but rendered as line art with annotations.

// ── The door's INSIDE face, in the same blueprint hand as the front. A walk-in
//    door's interior is plain: the insulated panel, the gasket that seals
//    against the frame, and the safety-release knob that lets someone shut
//    inside push their way out. Same 600×880 viewbox so it aligns with the
//    front face exactly.
function BlueprintDoorInside() {
  const line  = 'rgba(237,230,211,0.85)'
  const fine  = 'rgba(237,230,211,0.45)'
  const label = '#EDE6D3'
  return (
    <svg
      viewBox="0 0 600 880"
      preserveAspectRatio="xMidYMid meet"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
    >
      {/* Panel outline */}
      <rect x="40" y="40" width="520" height="800" fill="rgba(237,230,211,0.03)" stroke={line} strokeWidth="1.5" />
      {/* Gasket — the sealing strip, dashed, inset from the edge */}
      <rect x="62" y="62" width="476" height="756" fill="none" stroke={fine} strokeWidth="1" strokeDasharray="6 4" rx="3" />
      {/* Insulation core — faint hatched band to read as a section */}
      <rect x="86" y="86" width="428" height="708" fill="none" stroke={fine} strokeWidth="0.7" strokeDasharray="2 3" />

      {/* Interior safety release — knob on the hinge-opposite side, waist height.
          Mirrors the paddle handle's position on the front face. */}
      <circle cx="120" cy="446" r="22" fill="none" stroke={line} strokeWidth="1.5" />
      <circle cx="120" cy="446" r="9"  fill="rgba(237,230,211,0.10)" stroke={line} strokeWidth="1" />
      <line x1="142" y1="446" x2="200" y2="446" stroke={fine} strokeWidth="0.8" />
      <text x="206" y="442" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
        06 —— SAFETY RELEASE
      </text>
      <text x="206" y="454" fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
        interior · push to open
      </text>
      {/* No sheet label down here — at full swing this corner sits over the
          page's own "↳ DOOR · 1900 × 800 MM" caption and the two collide. */}
    </svg>
  )
}

function BlueprintCoolerDoor({ accent }: { accent: string }) {
  const line   = 'rgba(237,230,211,0.85)'   // primary line colour
  const fine   = 'rgba(237,230,211,0.45)'   // thinner reference lines + dimension ticks
  const dim    = 'rgba(237,230,211,0.35)'   // dimension extension lines
  const label  = '#EDE6D3'                  // callout label text
  // Viewbox is 600 × 880 — door aspect roughly 1 : 1.47, matching a
  // real walk-in cooler door (e.g. 800mm wide × 1900mm tall).
  return (
    <svg
      viewBox="0 0 600 880"
      preserveAspectRatio="xMidYMid meet"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        overflow: 'visible',
      }}
    >
      {/* ── DOOR PANEL — the outer rectangle ─────────────────────── */}
      <rect
        x="40" y="40" width="520" height="800"
        fill="rgba(237,230,211,0.04)"
        stroke={line}
        strokeWidth="2"
        rx="4"
      />
      {/* Stainless perimeter trim — inner offset rectangle */}
      <rect
        x="56" y="56" width="488" height="768"
        fill="none"
        stroke={line}
        strokeWidth="1.2"
        rx="3"
      />
      {/* Cross-hatch corners suggesting the trim's reflective surface */}
      {([[60, 60], [528, 60], [60, 808], [528, 808]] as Array<[number, number]>).map(([x, y], i) => (
        <g key={i} stroke={fine} strokeWidth="0.7">
          <line x1={x} y1={y} x2={x + 12} y2={y + 12} />
          <line x1={x + 4} y1={y} x2={x + 12} y2={y + 8} />
          <line x1={x} y1={y + 4} x2={x + 8} y2={y + 12} />
        </g>
      ))}

      {/* ── HINGES — three on the left edge ──────────────────────── */}
      {[150, 440, 690].map((y, i) => (
        <g key={i}>
          {/* Hinge body */}
          <rect x="24" y={y} width="40" height="56" fill="rgba(237,230,211,0.05)" stroke={line} strokeWidth="1.4" rx="2" />
          {/* Two knuckle circles */}
          <circle cx="44" cy={y + 16} r="6" fill="none" stroke={line} strokeWidth="1.2" />
          <circle cx="44" cy={y + 40} r="6" fill="none" stroke={line} strokeWidth="1.2" />
          {/* Hinge pin centre line */}
          <line x1="44" y1={y + 4} x2="44" y2={y + 52} stroke={fine} strokeWidth="0.7" strokeDasharray="2 2" />
          {/* Callout line + label, only on the top hinge */}
          {i === 0 && (
            <>
              <line x1="22" y1={y + 28} x2="-30" y2={y + 28} stroke={fine} strokeWidth="0.7" />
              <text x="-34" y={y + 26} fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5" textAnchor="end">
                03 ── HINGE
              </text>
              <text x="-34" y={y + 38} fill={fine as string} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2" textAnchor="end">
                heavy-duty × 3
              </text>
            </>
          )}
        </g>
      ))}

      {/* ── VIEWING WINDOW — upper third ─────────────────────────── */}
      <g>
        <rect x="140" y="160" width="320" height="160" fill="rgba(237,230,211,0.05)" stroke={line} strokeWidth="1.6" rx="3" />
        {/* Glass inner rectangle */}
        <rect x="150" y="170" width="300" height="140" fill="none" stroke={fine} strokeWidth="1" rx="2" strokeDasharray="3 2" />
        {/* Diagonal reflection lines so it reads as glass not a hole */}
        <line x1="160" y1="180" x2="190" y2="180" stroke={fine} strokeWidth="0.7" />
        <line x1="160" y1="180" x2="160" y2="210" stroke={fine} strokeWidth="0.7" />
        {/* Callout */}
        <line x1="460" y1="240" x2="540" y2="240" stroke={fine} strokeWidth="0.7" />
        <text x="546" y="238" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
          02 ── VIEW PANE
        </text>
        <text x="546" y="250" fill={fine as string} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
          double-glaze
        </text>
      </g>

      {/* ── PADDLE HANDLE — right side, waist height ─────────────── */}
      <g>
        {/* Backing plate */}
        <rect x="320" y="430" width="220" height="80" fill="rgba(237,230,211,0.05)" stroke={line} strokeWidth="1.4" rx="3" />
        {/* The lever — capsule */}
        <rect x="336" y="454" width="188" height="28" rx="14" fill="rgba(237,230,211,0.10)" stroke={accent} strokeWidth="1.6" />
        {/* Pivot dot */}
        <circle cx="358" cy="468" r="6" fill={accent} />
        <circle cx="358" cy="468" r="3" fill="#06392F" />
        {/* Lock cylinder underneath */}
        <rect x="436" y="490" width="40" height="14" fill="none" stroke={fine} strokeWidth="1" rx="2" />
        <circle cx="456" cy="497" r="2.5" fill={fine} />
        {/* Callout */}
        <line x1="540" y1="468" x2="600" y2="468" stroke={fine} strokeWidth="0.7" />
        <text x="-540" y="466" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5" transform="scale(-1,1)">
          ── PADDLE HANDLE ── 01
        </text>
      </g>

      {/* ── MANUFACTURER PLATE — top-left of the door panel ──────── */}
      <g>
        <rect x="80" y="80" width="180" height="46" fill="rgba(237,230,211,0.04)" stroke={line} strokeWidth="1" rx="2" />
        <text x="90" y="98" fill={label} fontFamily="var(--font-display)" fontSize="9" letterSpacing="3.2" fontWeight="700">
          WIC-002 · PROVISIONS
        </text>
        <text x="90" y="114" fill={fine as string} fontFamily="var(--font-display)" fontSize="8" letterSpacing="2.5">
          MODEL: WIC-300 / CLASS C
        </text>
        <text x="90" y="124" fill={fine as string} fontFamily="var(--font-display)" fontSize="7" letterSpacing="2.5">
          BUILT 2026 · KARACHI
        </text>
      </g>

      {/* ── KICK PLATE — bottom 18% of the door ─────────────────── */}
      <g>
        <rect x="80" y="720" width="440" height="100" fill="rgba(237,230,211,0.05)" stroke={line} strokeWidth="1.4" rx="2" />
        {/* Brushed-steel striations rendered as thin dashed lines */}
        {[745, 760, 775, 790, 805].map((y) => (
          <line key={y} x1="100" y1={y} x2="500" y2={y} stroke={fine} strokeWidth="0.5" strokeDasharray="2 4" />
        ))}
        {/* Corner screws */}
        {[[95, 735], [505, 735], [95, 805], [505, 805]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3" fill="none" stroke={line} strokeWidth="0.9" />
        ))}
        {/* Callout */}
        <line x1="520" y1="770" x2="580" y2="770" stroke={fine} strokeWidth="0.7" />
        <text x="586" y="768" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
          04 ── KICK PLATE
        </text>
        <text x="586" y="780" fill={fine as string} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
          stainless 16ga
        </text>
      </g>

      {/* ── DIMENSION LINES — left side height + bottom width ───── */}
      <g stroke={dim} strokeWidth="0.7" fontFamily="var(--font-display)">
        {/* Height — left side, outside the door */}
        <line x1="-18" y1="40" x2="-18" y2="840" />
        <line x1="-22" y1="40" x2="-14" y2="40" />
        <line x1="-22" y1="840" x2="-14" y2="840" />
        <text x="-30" y="446" fill={label} fontSize="11" letterSpacing="2" textAnchor="middle" transform="rotate(-90, -30, 446)">
          1900 mm
        </text>
        {/* Width — bottom, outside the door */}
        <line x1="40" y1="858" x2="560" y2="858" />
        <line x1="40" y1="854" x2="40" y2="862" />
        <line x1="560" y1="854" x2="560" y2="862" />
        <text x="300" y="876" fill={label} fontSize="11" letterSpacing="2" textAnchor="middle">
          800 mm
        </text>
      </g>
    </svg>
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

      {/* Gold halo at the back-wall centre — only over the operator's
          photo (the blueprint SVG is already gold-on-ink, so a screen-
          blended gold layer would just wash out the dark ink). */}
      {imageUrl && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0,
            background: `radial-gradient(ellipse 40% 30% at 50% 40%, ${accent}30 0%, transparent 70%)`,
            mixBlendMode: 'screen',
          }}
        />
      )}

      {/* ── TYPOGRAPHY OVERLAYS sitting in the empty shelves of the
            photo. Positions are tuned for a typical walk-in cooler shot
            where racks sit on the left + right side and the back wall is
            roughly centre. Each phrase is staggered to fade in at a
            different scroll-progress threshold. Heavy drop shadows so
            the type reads against any photo we swap in. */}

      {/* HEADLINE — RESERVATIONS only. as one phrase */}
      <div
        style={{
          position: 'absolute',
          top: '38%', left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-display)',
          lineHeight: 1,
          opacity: 'calc(max(0, var(--scroll-progress, 0) - 0.50) * 6)',
          transition: 'opacity 80ms linear',
          zIndex: 2,
        } as React.CSSProperties}
      >
        <span style={{
          color: cream,
          fontSize: 'clamp(2rem, 4.8vw, 3.6rem)',
          letterSpacing: '0.06em',
          fontWeight: 800,
          textShadow: '0 2px 4px rgba(0,0,0,0.85), 0 6px 16px rgba(0,0,0,0.65)',
        }}>
          RESERVATIONS
        </span>
        <span style={{
          color: accent,
          fontSize: 'clamp(1.7rem, 4.2vw, 3rem)',
          fontStyle: 'italic',
          letterSpacing: '-0.01em',
          fontWeight: 500,
          marginLeft: '0.32em',
          textShadow: `0 0 22px ${accent}cc, 0 0 6px ${accent}99, 0 2px 6px rgba(0,0,0,0.5)`,
        }}>
          only.
        </span>
      </div>

      {/* Operating hours — etched along the cooler floor at the very
          bottom of the visible section, just above the SVG's "2400 mm ·
          cooler width" dimension callout. Previously at bottom: 12%
          which crashed straight into the Reserve/Menu CTA cluster
          that lives at top: 80%. Pushed down to bottom: 4% so it sits
          on the floor like a vinyl sticker, not stacked under the CTAs. */}
      <FridgeWord
        text="open 7pm — late · tue–sun"
        fireAt={0.78}
        color="rgba(255,255,255,0.55)"
        heavyShadow
        style={{
          bottom: '4%', left: '50%',
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

// ─── Blueprint cooler interior ──────────────────────────────────────
// Matches the schematic aesthetic of BlueprintCoolerDoor — thin gold
// lines on dark ink with annotations and dimension callouts. Renders
// the "view inside the cooler" as an architectural drawing: back wall
// rectangle, side walls drawn as receding trapezoids, two wire-rack
// schematics against the side walls, ceiling refrigeration unit, LED
// strip, floor dimension line. Numbered callouts so the picture reads
// like a working drawing.

function CoolerInteriorSVG() {
  const line  = 'rgba(237,230,211,0.85)'
  const fine  = 'rgba(237,230,211,0.42)'
  const dim   = 'rgba(237,230,211,0.28)'
  const label = '#EDE6D3'
  return (
    <svg
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      {/* Vanishing-point construction lines — extending from corners
          to the centre. Like a perspective grid actually drawn by hand. */}
      <g stroke={dim} strokeWidth="0.6" strokeDasharray="3 4">
        <line x1="0"    y1="0"    x2="800" y2="460" />
        <line x1="1600" y1="0"    x2="800" y2="460" />
        <line x1="0"    y1="1000" x2="800" y2="460" />
        <line x1="1600" y1="1000" x2="800" y2="460" />
      </g>
      {/* Vanishing point cross-hair */}
      <g stroke={fine} strokeWidth="0.8">
        <line x1="788" y1="460" x2="812" y2="460" />
        <line x1="800" y1="448" x2="800" y2="472" />
      </g>
      <text x="816" y="456" fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">VP</text>

      {/* Room outlines — no fill */}
      <polygon points="0,0 1600,0 1080,240 520,240"
        fill="none" stroke={line} strokeWidth="1.6" />
      <polygon points="0,0 520,240 520,680 0,1000"
        fill="none" stroke={line} strokeWidth="1.6" />
      <polygon points="1600,0 1600,1000 1080,680 1080,240"
        fill="none" stroke={line} strokeWidth="1.6" />
      <polygon points="0,1000 1600,1000 1080,680 520,680"
        fill="none" stroke={line} strokeWidth="1.6" />
      {/* Back wall with subtle hatched fill */}
      <rect x="520" y="240" width="560" height="440"
        fill="rgba(237,230,211,0.03)" stroke={line} strokeWidth="1.6" />
      <line x1="708" y1="240" x2="708" y2="680" stroke={fine} strokeWidth="0.8" />
      <line x1="892" y1="240" x2="892" y2="680" stroke={fine} strokeWidth="0.8" />

      {/* Ceiling evaporator (schematic plan-view) */}
      <g transform="translate(800, 120)">
        <rect x="-160" y="-30" width="320" height="70"
          fill="rgba(237,230,211,0.04)" stroke={line} strokeWidth="1.4" rx="2" />
        <line x1="-140" y1="-36" x2="140" y2="-36" stroke={fine} strokeWidth="1" />
        {[-70, 70].map((cx) => (
          <g key={cx}>
            <circle cx={cx} cy="14" r="20" fill="none" stroke={line} strokeWidth="1.2" />
            <circle cx={cx} cy="14" r="4" fill={line} />
            {Array.from({ length: 4 }).map((_, i) => (
              <line key={i}
                x1={cx} y1="14"
                x2={cx + Math.cos((i * Math.PI) / 2) * 16}
                y2={14 + Math.sin((i * Math.PI) / 2) * 16}
                stroke={fine} strokeWidth="0.8" />
            ))}
          </g>
        ))}
        <line x1="170" y1="0" x2="240" y2="0" stroke={fine} strokeWidth="0.7" />
        <text x="246" y="-2" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
          05 ── EVAPORATOR
        </text>
        <text x="246" y="10" fill={fine} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
          ceiling-mount
        </text>
      </g>

      {/* LED ceiling strip */}
      <line x1="600" y1="50" x2="1000" y2="50" stroke={line} strokeWidth="3" strokeLinecap="round" />
      <line x1="540" y1="200" x2="600" y2="50" stroke={fine} strokeWidth="0.7" />
      <text x="430" y="200" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
        06 ── LED · 4000K
      </text>

      {/* LEFT + RIGHT racks */}
      <BlueprintRack side="left"  lineColor={line} fineColor={fine} labelColor={label} />
      <BlueprintRack side="right" lineColor={line} fineColor={fine} labelColor={label} />

      {/* Floor width dimension callout */}
      <g stroke={dim} strokeWidth="0.7">
        <line x1="40" y1="970" x2="1560" y2="970" />
        <line x1="40" y1="965" x2="40" y2="975" />
        <line x1="1560" y1="965" x2="1560" y2="975" />
      </g>
      <text x="800" y="990" fill={label} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5" textAnchor="middle">
        2400 mm · cooler width
      </text>

      {/* North arrow (bottom-right corner) */}
      <g transform="translate(1500, 920)">
        <circle cx="0" cy="0" r="24" fill="none" stroke={fine} strokeWidth="0.8" />
        <line x1="0" y1="-22" x2="0" y2="22" stroke={fine} strokeWidth="0.6" />
        <line x1="-22" y1="0" x2="22" y2="0" stroke={fine} strokeWidth="0.6" />
        <polygon points="0,-22 -5,-8 5,-8" fill={label} />
        <text x="0" y="-30" fill={label} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2" textAnchor="middle">
          N
        </text>
      </g>
    </svg>
  )
}

// Wire-rack schematic — front + back vertical poles with four shelves
// drawn as foreshortened quadrilaterals plus thin wire-grid lines.
function BlueprintRack({ side, lineColor, fineColor, labelColor }: {
  side:       'left' | 'right'
  lineColor:  string
  fineColor:  string
  labelColor: string
}) {
  const isLeft = side === 'left'
  // Left rack — front edge near viewport-left, back edge near back-wall edge.
  const fx1 = isLeft ? 70   : 1130
  const fx2 = isLeft ? 240  : 1300
  const bx1 = isLeft ? 470  : 1150
  const bx2 = isLeft ? 530  : 1090
  const shelves: Array<[number, number]> = [
    [200, 320],
    [400, 440],
    [600, 560],
    [820, 660],
  ]
  return (
    <g>
      <line x1={fx1} y1="80"  x2={fx1} y2="940" stroke={lineColor} strokeWidth="1.4" />
      <line x1={fx2} y1="120" x2={fx2} y2="900" stroke={lineColor} strokeWidth="1.4" />
      <line x1={bx1} y1="260" x2={bx1} y2="680" stroke={fineColor} strokeWidth="1.1" />
      <line x1={bx2} y1="270" x2={bx2} y2="670" stroke={fineColor} strokeWidth="1.1" />
      {[fx1, fx2].map((x) => (
        <line key={x} x1={x - 6} y1="945" x2={x + 6} y2="945" stroke={lineColor} strokeWidth="2" />
      ))}
      {shelves.map(([fy, by], i) => (
        <polygon
          key={i}
          points={`${fx1},${fy} ${fx2},${fy} ${bx2},${by} ${bx1},${by}`}
          fill="rgba(237,230,211,0.03)"
          stroke={lineColor}
          strokeWidth="1.2"
        />
      ))}
      {/* Wire-grid lines on each shelf */}
      {shelves.map(([fy, by], i) => (
        <g key={i} stroke={fineColor} strokeWidth="0.5">
          <line x1={fx1 + 10} y1={fy + (by - fy) * 0.25} x2={fx2 - 10} y2={fy + (by - fy) * 0.25} />
          <line x1={fx1 + 10} y1={fy + (by - fy) * 0.5}  x2={fx2 - 10} y2={fy + (by - fy) * 0.5} />
          <line x1={fx1 + 10} y1={fy + (by - fy) * 0.75} x2={fx2 - 10} y2={fy + (by - fy) * 0.75} />
        </g>
      ))}
      {/* Callout — only on the left rack to avoid clutter */}
      {isLeft && (
        <>
          <line x1="240" y1="200" x2="380" y2="160" stroke={fineColor} strokeWidth="0.7" />
          <text x="386" y="158" fill={labelColor} fontFamily="var(--font-display)" fontSize="11" letterSpacing="2.5">
            07 ── WIRE RACK
          </text>
          <text x="386" y="170" fill={fineColor} fontFamily="var(--font-display)" fontSize="9" letterSpacing="2">
            4-shelf × 2
          </text>
        </>
      )}
    </g>
  )
}
