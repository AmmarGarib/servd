'use client'
import type { CSSProperties } from 'react'

/**
 * Shapes3D — a library of SVG shapes built with multi-stop gradients,
 * specular highlights, and stacked shadows so they read as 3D objects on
 * a flat page. No three.js, no .glb assets — just hand-tuned SVG that
 * survives any tint colour and any size.
 *
 * Each shape takes:
 *   - color:  the brand accent that drives gradients + halos
 *   - size:   pixels; the SVG is square and viewBox-scaled
 *   - style:  position the shape via top/left/right/bottom on the parent
 *   - spin / float / pulse: motion modifiers (CSS keyframes)
 *
 * Don't reach for `<KineticShape variant="emoji">` for the hero anymore —
 * use one of these. The emoji version stays available for tertiary
 * decorations like menu cards.
 */

type MotionMode = 'float' | 'spin' | 'pulse' | 'orbit' | 'none'

interface CommonProps {
  color?:  string
  size?:   number
  style?:  CSSProperties
  className?: string
  motion?: MotionMode
  /** Horizontal/vertical sway distance for float. Defaults to 20px. */
  sway?:   number
}

// Shared motion class lookup — the keyframes live in globals.css under
// the `kinetic-*` namespace.
const motionClass = (m?: MotionMode) =>
  m === 'spin'   ? 'kinetic-spin'   :
  m === 'pulse'  ? 'kinetic-pulse'  :
  m === 'orbit'  ? 'kinetic-orbit'  :
  m === 'float'  ? 'kinetic-float'  : ''

function wrap(child: React.ReactNode, props: CommonProps, defaults: { size: number }) {
  const { size = defaults.size, style, className = '', motion: m = 'float', sway = 20 } = props
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute ${motionClass(m)} ${className}`}
      style={{
        width:  size,
        height: size,
        ['--sway' as string]: `${sway}px`,
        ...style,
      }}
    >
      {child}
    </span>
  )
}

// ─── 1. Perforated Sphere ─────────────────────────────────────────────
// Buzz's most iconic motif — a glossy sphere with circular holes punched
// through it. Multi-stop gradient + specular highlight + cast shadow.

export function PerforatedSphere(props: CommonProps) {
  const c = props.color ?? 'var(--brand-accent)'
  const id = useId('sphere')
  return wrap(
    <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}-fill`} cx="35%" cy="30%" r="75%">
          <stop offset="0%"   stopColor="white"   stopOpacity="0.95" />
          <stop offset="22%"  stopColor={c}        stopOpacity="0.95" />
          <stop offset="78%"  stopColor={c}        stopOpacity="1" />
          <stop offset="100%" stopColor="black"    stopOpacity="0.85" />
        </radialGradient>
        <radialGradient id={`${id}-hi`} cx="30%" cy="22%" r="22%">
          <stop offset="0%"   stopColor="white" stopOpacity="1" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <pattern id={`${id}-dots`} x="0" y="0" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="11" cy="11" r="3.6" fill="rgba(0,0,0,0.55)" />
        </pattern>
        <mask id={`${id}-mask`}>
          <circle cx="100" cy="100" r="90" fill="white" />
        </mask>
      </defs>
      {/* cast shadow underneath */}
      <ellipse cx="100" cy="186" rx="62" ry="9" fill="rgba(0,0,0,0.35)" filter="blur(4px)" />
      <g mask={`url(#${id}-mask)`}>
        <circle cx="100" cy="100" r="90" fill={`url(#${id}-fill)`} />
        <rect x="0" y="0" width="200" height="200" fill={`url(#${id}-dots)`} opacity="0.85" />
        <circle cx="100" cy="100" r="90" fill={`url(#${id}-hi)`} />
      </g>
    </svg>,
    props,
    { size: 220 },
  )
}

// ─── 2. Liquid Blob ───────────────────────────────────────────────────
// Glossy blob with chrome-style highlight + multi-layer gradient — fakes
// a wet 3D resin shape. Looks great over photography.

export function LiquidBlob(props: CommonProps) {
  const c = props.color ?? 'var(--brand-accent)'
  const id = useId('blob')
  return wrap(
    <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}-fill`} cx="38%" cy="32%" r="80%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.95" />
          <stop offset="18%"  stopColor={c}     stopOpacity="1" />
          <stop offset="68%"  stopColor={c}     stopOpacity="1" />
          <stop offset="100%" stopColor="black" stopOpacity="0.75" />
        </radialGradient>
        <radialGradient id={`${id}-hi1`} cx="32%" cy="24%" r="18%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.95" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}-hi2`} cx="64%" cy="64%" r="14%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.55" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="14" stdDeviation="10" floodOpacity="0.35" />
        </filter>
      </defs>
      <path
        d="M100 14
           C 148 14, 186 48, 186 96
           C 186 132, 168 154, 142 168
           C 116 182, 92 192, 64 178
           C 36 164, 14 134, 14 102
           C 14 58, 52 14, 100 14 Z"
        fill={`url(#${id}-fill)`}
        filter={`url(#${id}-shadow)`}
      />
      <path
        d="M100 14
           C 148 14, 186 48, 186 96
           C 186 132, 168 154, 142 168
           C 116 182, 92 192, 64 178
           C 36 164, 14 134, 14 102
           C 14 58, 52 14, 100 14 Z"
        fill={`url(#${id}-hi1)`}
      />
      <circle cx="128" cy="128" r="22" fill={`url(#${id}-hi2)`} />
    </svg>,
    props,
    { size: 220 },
  )
}

// ─── 3. Twisted Ribbon ────────────────────────────────────────────────
// A coiled ribbon that reads as a stretched 3D form. Useful as an
// off-axis accent element in section headers.

export function TwistedRibbon(props: CommonProps) {
  const c = props.color ?? 'var(--brand-accent)'
  const id = useId('ribbon')
  return wrap(
    <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={`${id}-grad`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.85" />
          <stop offset="20%"  stopColor={c} />
          <stop offset="55%"  stopColor={c} />
          <stop offset="80%"  stopColor="black" stopOpacity="0.75" />
        </linearGradient>
        <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="12" stdDeviation="8" floodOpacity="0.3" />
        </filter>
      </defs>
      <path
        d="M30 60
           C 70 20, 130 100, 170 60
           S 80 180, 30 140
           S 130 60, 170 110"
        fill="none"
        stroke={`url(#${id}-grad)`}
        strokeWidth="28"
        strokeLinecap="round"
        filter={`url(#${id}-shadow)`}
      />
    </svg>,
    props,
    { size: 240 },
  )
}

// ─── 4. Glossy Spiral / Spring ────────────────────────────────────────
// A coiled spring rendered with stacked overlapping discs to fake
// 3D depth. Looks identical to Buzz's "coiled spring" motif.

export function GlossySpring(props: CommonProps) {
  const c = props.color ?? 'var(--brand-accent)'
  const id = useId('spring')
  return wrap(
    <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}-ring`} cx="35%" cy="35%" r="65%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.9" />
          <stop offset="40%"  stopColor={c} />
          <stop offset="100%" stopColor="black" stopOpacity="0.6" />
        </radialGradient>
        <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" floodOpacity="0.25" />
        </filter>
      </defs>
      {[40, 60, 80, 100, 120, 140, 160].map((cy, i) => (
        <ellipse
          key={cy}
          cx={100 + (i - 3) * 6}
          cy={cy}
          rx={42 - Math.abs(i - 3) * 1.5}
          ry={12}
          fill={`url(#${id}-ring)`}
          filter={`url(#${id}-shadow)`}
          opacity={0.95}
        />
      ))}
    </svg>,
    props,
    { size: 240 },
  )
}

// ─── 5. Holographic Ring ──────────────────────────────────────────────
// Rainbow-tinted ring with the brand colour dominating one quadrant.
// Pulse motion suits this best — looks like a portal opening.

export function HoloRing(props: CommonProps) {
  const c = props.color ?? 'var(--brand-accent)'
  const id = useId('holo')
  return wrap(
    <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={`${id}-grad`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor={c} />
          <stop offset="30%"  stopColor="#a855f7" />
          <stop offset="60%"  stopColor="#3b82f6" />
          <stop offset="100%" stopColor={c} />
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r="80" fill="none" stroke={`url(#${id}-grad)`} strokeWidth="14" opacity="0.85" />
      <circle cx="100" cy="100" r="58" fill="none" stroke={c} strokeWidth="2" opacity="0.6" />
      <circle cx="100" cy="100" r="100" fill="none" stroke={c} strokeWidth="1" opacity="0.25" strokeDasharray="3 8" />
    </svg>,
    props,
    { size: 220 },
  )
}

// ─── 6. Squiggle Arrow ────────────────────────────────────────────────
// Hand-drawn-feeling zigzag arrow — same vibe as Buzz's pink zigzags.

export function SquiggleArrow(props: CommonProps) {
  const c = props.color ?? 'var(--brand-accent)'
  return wrap(
    <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <path
        d="M20 100 L60 70 L60 130 L100 100 L100 130 L140 70 L180 100"
        fill="none"
        stroke={c}
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.25))' }}
      />
      <polygon points="160,85 195,100 160,115" fill={c} style={{ filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.25))' }} />
    </svg>,
    props,
    { size: 220 },
  )
}

// ─── 7. Chrome Burst (asterisk-flower) ───────────────────────────────
// Buzz's chrysanthemum-style burst with a chrome / metallic finish.

export function ChromeBurst(props: CommonProps) {
  const c = props.color ?? 'var(--brand-accent)'
  const id = useId('burst')
  return wrap(
    <svg viewBox="0 0 200 200" width="100%" height="100%" style={{ overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}-petal`} cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.8" />
          <stop offset="50%"  stopColor={c} />
          <stop offset="100%" stopColor="black" stopOpacity="0.6" />
        </radialGradient>
        <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="10" stdDeviation="6" floodOpacity="0.3" />
        </filter>
      </defs>
      <g filter={`url(#${id}-shadow)`} transform="translate(100, 100)">
        {Array.from({ length: 8 }).map((_, i) => (
          <ellipse
            key={i}
            cx="0" cy="0" rx="20" ry="70"
            fill={`url(#${id}-petal)`}
            transform={`rotate(${(i * 360) / 8})`}
            opacity="0.92"
          />
        ))}
        <circle cx="0" cy="0" r="16" fill="white" opacity="0.9" />
        <circle cx="0" cy="0" r="10" fill={c} />
      </g>
    </svg>,
    props,
    { size: 240 },
  )
}

// ─── 8. Glossy Pill (chrome capsule) ──────────────────────────────────
// Floating chrome pill — great as an off-axis hero accent.

export function GlossyPill(props: CommonProps) {
  const c = props.color ?? 'var(--brand-accent)'
  const id = useId('pill')
  return wrap(
    <svg viewBox="0 0 200 100" width="100%" height="100%" preserveAspectRatio="none" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={`${id}-grad`} x1="50%" y1="0%" x2="50%" y2="100%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.95" />
          <stop offset="25%"  stopColor={c} />
          <stop offset="75%"  stopColor={c} />
          <stop offset="100%" stopColor="black" stopOpacity="0.7" />
        </linearGradient>
        <radialGradient id={`${id}-hi`} cx="50%" cy="22%" r="40%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.85" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-shadow`} x="-20%" y="-30%" width="140%" height="180%">
          <feDropShadow dx="0" dy="10" stdDeviation="8" floodOpacity="0.3" />
        </filter>
      </defs>
      <rect x="5" y="10" width="190" height="80" rx="40" fill={`url(#${id}-grad)`} filter={`url(#${id}-shadow)`} />
      <ellipse cx="100" cy="30" rx="80" ry="14" fill={`url(#${id}-hi)`} />
    </svg>,
    props,
    { size: 240 },
  )
}

// Tiny stable-id helper. Each shape needs unique <defs> ids so multiple
// instances on a page don't share masks/gradients.
let _seq = 0
function useId(prefix: string): string {
  // Bump module-level counter on each call — render is deterministic per
  // shape instance because instances mount in order. SSR-safe for ids
  // that don't need to be hydration-stable (these are SVG-internal).
  _seq += 1
  return `${prefix}-${_seq}`
}

/**
 * ShapeFloor — a static cluster of 3 shapes for cheap "hero corner
 * decoration". When you just want something flashy without composing
 * shapes manually, drop this and pick the variants.
 */
export function ShapeFloor({
  color, variant = 'mixed',
}: {
  color?: string
  variant?: 'mixed' | 'spheres' | 'ribbons'
}) {
  if (variant === 'spheres') {
    return (
      <>
        <PerforatedSphere color={color} size={260} motion="float" sway={28} style={{ top: '-10%', right: '-8%' }} />
        <LiquidBlob       color={color} size={170} motion="float" sway={18} style={{ bottom: '8%', left: '-6%' }} />
        <HoloRing         color={color} size={120} motion="pulse"          style={{ top: '60%', right: '20%' }} />
      </>
    )
  }
  if (variant === 'ribbons') {
    return (
      <>
        <TwistedRibbon color={color} size={300} motion="float" sway={22} style={{ top: '-6%', left: '-10%' }} />
        <GlossySpring  color={color} size={200} motion="spin"             style={{ bottom: '4%', right: '6%' }} />
        <SquiggleArrow color={color} size={140} motion="float" sway={14}  style={{ top: '40%', right: '14%' }} />
      </>
    )
  }
  // mixed — the most useful default
  return (
    <>
      <PerforatedSphere color={color} size={240} motion="float" sway={26} style={{ top: '-8%', right: '-6%' }} />
      <TwistedRibbon    color={color} size={260} motion="float" sway={18} style={{ bottom: '-6%', left: '-8%' }} />
      <ChromeBurst      color={color} size={130} motion="spin"            style={{ top: '52%', right: '14%' }} />
      <SquiggleArrow    color={color} size={140} motion="float" sway={12} style={{ top: '20%', left: '8%' }} />
    </>
  )
}
