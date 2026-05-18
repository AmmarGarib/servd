'use client'
import type { CSSProperties } from 'react'

/**
 * BurgerLayers — six stacked SVG "ingredients" that compose a side-view
 * burger illustration. Each layer is its own component so they can be
 * positioned + transformed independently (the whole point: scroll-driven
 * split, top bun lifts off, lettuce floats up, patty stays, bottom bun
 * slides down).
 *
 * Style is intentionally illustrative — multi-stop radial gradients +
 * specular highlights so the layers read as 3D rendered, not flat
 * vectors. Each layer's viewBox is the same so they all line up when
 * stacked on the same canvas.
 *
 * Sizes: all layers are designed at 800×220 viewBox. Rendered size is
 * controlled by the parent — the burger composition renders them inside
 * a 800px-wide container with z-index ordering.
 */

const VIEW = '0 0 800 220'

interface LayerProps {
  style?: CSSProperties
  className?: string
}

// ─── Top bun (sesame brioche) ────────────────────────────────────────
export function BurgerTopBun({ style, className = '' }: LayerProps) {
  return (
    <svg viewBox={VIEW} width="100%" preserveAspectRatio="xMidYMid meet"
      className={className}
      style={{ overflow: 'visible', ...style }}>
      <defs>
        <radialGradient id="topBunFill" cx="50%" cy="20%" r="80%">
          <stop offset="0%"   stopColor="#FFE3A8" />
          <stop offset="35%"  stopColor="#E0A95C" />
          <stop offset="75%"  stopColor="#B46F2A" />
          <stop offset="100%" stopColor="#7A4318" />
        </radialGradient>
        <radialGradient id="topBunHi" cx="50%" cy="12%" r="42%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.85" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <filter id="topBunShadow" x="-10%" y="-30%" width="120%" height="180%">
          <feDropShadow dx="0" dy="14" stdDeviation="10" floodOpacity="0.35" />
        </filter>
      </defs>
      {/* Dome shape — wide ellipse, asymmetric so it reads like a real bun */}
      <path
        d="M40 200
           Q 40 60, 200 30
           Q 400 -10, 600 30
           Q 760 60, 760 200
           Z"
        fill="url(#topBunFill)"
        filter="url(#topBunShadow)"
      />
      <path
        d="M40 200
           Q 40 60, 200 30
           Q 400 -10, 600 30
           Q 760 60, 760 200
           Z"
        fill="url(#topBunHi)"
      />
      {/* Sesame seeds — scatter randomly */}
      {SESAME_SEEDS.map((s, i) => (
        <ellipse key={i} cx={s.x} cy={s.y} rx="6" ry="9" fill="#F8E5B0"
          transform={`rotate(${s.r} ${s.x} ${s.y})`} opacity="0.9" />
      ))}
    </svg>
  )
}

const SESAME_SEEDS = [
  { x: 200, y: 50, r: -10 }, { x: 290, y: 38, r: 8 },  { x: 380, y: 32, r: -4 },
  { x: 460, y: 36, r: 12 },  { x: 540, y: 42, r: -8 }, { x: 610, y: 56, r: 6 },
  { x: 240, y: 72, r: 4 },   { x: 420, y: 60, r: -14 }, { x: 510, y: 76, r: 10 },
  { x: 340, y: 80, r: 18 },
]

// ─── Lettuce ─────────────────────────────────────────────────────────
export function BurgerLettuce({ style, className = '' }: LayerProps) {
  return (
    <svg viewBox={VIEW} width="100%" preserveAspectRatio="xMidYMid meet"
      className={className}
      style={{ overflow: 'visible', ...style }}>
      <defs>
        <linearGradient id="lettuceFill" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#A8E063" />
          <stop offset="55%"  stopColor="#56AB2F" />
          <stop offset="100%" stopColor="#2D5E18" />
        </linearGradient>
        <filter id="lettuceShadow" x="-10%" y="-30%" width="120%" height="180%">
          <feDropShadow dx="0" dy="8" stdDeviation="6" floodOpacity="0.3" />
        </filter>
      </defs>
      {/* Crinkly leaf outline — wavy bottom edge mimics ruffled lettuce */}
      <path
        d="M30 80
           Q 30 50, 80 40
           Q 200 30, 400 35
           Q 600 30, 720 40
           Q 770 50, 770 80
           Q 770 110, 730 130
           Q 700 145, 660 130
           Q 600 150, 540 125
           Q 480 145, 420 120
           Q 360 145, 300 125
           Q 240 145, 180 130
           Q 120 145, 80 130
           Q 40 110, 30 80 Z"
        fill="url(#lettuceFill)"
        filter="url(#lettuceShadow)"
      />
      {/* Highlight veins */}
      <path
        d="M120 60 Q 280 50, 420 60 Q 560 50, 680 65"
        fill="none" stroke="#C2EE92" strokeWidth="2" opacity="0.55"
      />
    </svg>
  )
}

// ─── Tomato ─────────────────────────────────────────────────────────
export function BurgerTomato({ style, className = '' }: LayerProps) {
  return (
    <svg viewBox={VIEW} width="100%" preserveAspectRatio="xMidYMid meet"
      className={className}
      style={{ overflow: 'visible', ...style }}>
      <defs>
        <linearGradient id="tomatoFill" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#FF6B5B" />
          <stop offset="60%"  stopColor="#D63B2A" />
          <stop offset="100%" stopColor="#8C1F12" />
        </linearGradient>
        <radialGradient id="tomatoHi" cx="30%" cy="20%" r="40%">
          <stop offset="0%"   stopColor="white" stopOpacity="0.6" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <filter id="tomatoShadow" x="-10%" y="-30%" width="120%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="5" floodOpacity="0.35" />
        </filter>
      </defs>
      {/* Wide flat slice */}
      <ellipse cx="400" cy="100" rx="370" ry="35"
        fill="url(#tomatoFill)" filter="url(#tomatoShadow)" />
      <ellipse cx="400" cy="100" rx="370" ry="35" fill="url(#tomatoHi)" />
      {/* Seeds */}
      {[200, 320, 440, 560].map((x) => (
        <ellipse key={x} cx={x} cy="95" rx="14" ry="6" fill="#F5DD8E" opacity="0.7" />
      ))}
    </svg>
  )
}

// ─── Cheese slice ────────────────────────────────────────────────────
export function BurgerCheese({ style, className = '' }: LayerProps) {
  return (
    <svg viewBox={VIEW} width="100%" preserveAspectRatio="xMidYMid meet"
      className={className}
      style={{ overflow: 'visible', ...style }}>
      <defs>
        <linearGradient id="cheeseFill" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#FFE066" />
          <stop offset="60%"  stopColor="#F2B71F" />
          <stop offset="100%" stopColor="#A4760E" />
        </linearGradient>
        <filter id="cheeseShadow" x="-10%" y="-30%" width="120%" height="180%">
          <feDropShadow dx="0" dy="6" stdDeviation="5" floodOpacity="0.35" />
        </filter>
      </defs>
      {/* Drippy cheese with melted edges */}
      <path
        d="M40 80
           L 760 80
           Q 770 95, 760 110
           Q 720 130, 680 105
           Q 640 135, 600 110
           Q 560 145, 520 110
           Q 460 140, 400 105
           Q 340 145, 280 110
           Q 220 140, 160 110
           Q 120 130, 80 105
           Q 30 95, 40 80 Z"
        fill="url(#cheeseFill)"
        filter="url(#cheeseShadow)"
      />
    </svg>
  )
}

// ─── Patty ──────────────────────────────────────────────────────────
export function BurgerPatty({ style, className = '' }: LayerProps) {
  return (
    <svg viewBox={VIEW} width="100%" preserveAspectRatio="xMidYMid meet"
      className={className}
      style={{ overflow: 'visible', ...style }}>
      <defs>
        <radialGradient id="pattyFill" cx="50%" cy="30%" r="70%">
          <stop offset="0%"   stopColor="#7B3A1A" />
          <stop offset="55%"  stopColor="#4A1F0C" />
          <stop offset="100%" stopColor="#1F0A04" />
        </radialGradient>
        <filter id="pattyShadow" x="-10%" y="-20%" width="120%" height="180%">
          <feDropShadow dx="0" dy="10" stdDeviation="8" floodOpacity="0.45" />
        </filter>
      </defs>
      {/* Thick patty with caramelised edge */}
      <rect x="40" y="40" width="720" height="140" rx="70"
        fill="url(#pattyFill)" filter="url(#pattyShadow)" />
      {/* Char marks */}
      {[160, 280, 400, 520, 640].map((x) => (
        <ellipse key={x} cx={x} cy="65" rx="40" ry="6" fill="#2A0D04" opacity="0.4" />
      ))}
      {/* Top-edge highlight (char crust) */}
      <path
        d="M70 50 Q 400 30, 730 50"
        fill="none" stroke="#9C5527" strokeWidth="6" opacity="0.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ─── Bottom bun ─────────────────────────────────────────────────────
export function BurgerBottomBun({ style, className = '' }: LayerProps) {
  return (
    <svg viewBox={VIEW} width="100%" preserveAspectRatio="xMidYMid meet"
      className={className}
      style={{ overflow: 'visible', ...style }}>
      <defs>
        <radialGradient id="botBunFill" cx="50%" cy="80%" r="80%">
          <stop offset="0%"   stopColor="#FFE3A8" />
          <stop offset="40%"  stopColor="#E0A95C" />
          <stop offset="80%"  stopColor="#A66524" />
          <stop offset="100%" stopColor="#6F3A14" />
        </radialGradient>
        <filter id="botBunShadow" x="-10%" y="-20%" width="120%" height="180%">
          <feDropShadow dx="0" dy="16" stdDeviation="12" floodOpacity="0.4" />
        </filter>
      </defs>
      <path
        d="M40 20
           L 760 20
           Q 760 160, 600 190
           Q 400 210, 200 190
           Q 40 160, 40 20 Z"
        fill="url(#botBunFill)"
        filter="url(#botBunShadow)"
      />
    </svg>
  )
}

// ─── Layered burger composition ──────────────────────────────────────
/**
 * Stacked-burger renderer. Reads --scroll-progress (0..1) off the
 * nearest ancestor and animates the six layers apart as progress climbs.
 *
 *   progress = 0      → fully assembled burger, ready
 *   progress = 0.5    → layers separating, gaps widening
 *   progress = 1      → fully exploded view, menu fully visible behind
 *
 * Each layer translates Y and rotates slightly to amplify the "blowing
 * apart" feeling. CSS `var(--scroll-progress, 0)` is the single source
 * of truth — no per-frame React renders, all transforms happen in CSS.
 */
export function BurgerStack({ className = '' }: { className?: string }) {
  return (
    <div className={`burger-stack ${className}`} style={{ width: '100%', maxWidth: 800, position: 'relative' }}>
      {/* Top bun — flies UP and rotates slightly counter-clockwise */}
      <div className="burger-layer" style={{
        position: 'relative',
        transform: 'translateY(calc(var(--scroll-progress, 0) * -52vh)) rotate(calc(var(--scroll-progress, 0) * -8deg))',
        zIndex: 7,
      }}>
        <BurgerTopBun />
      </div>
      {/* Lettuce — flies up, less than the bun */}
      <div className="burger-layer" style={{
        position: 'relative',
        marginTop: '-110px',
        transform: 'translateY(calc(var(--scroll-progress, 0) * -34vh)) rotate(calc(var(--scroll-progress, 0) * 5deg))',
        zIndex: 6,
      }}>
        <BurgerLettuce />
      </div>
      {/* Tomato — small drift */}
      <div className="burger-layer" style={{
        position: 'relative',
        marginTop: '-110px',
        transform: 'translateY(calc(var(--scroll-progress, 0) * -20vh)) rotate(calc(var(--scroll-progress, 0) * -3deg))',
        zIndex: 5,
      }}>
        <BurgerTomato />
      </div>
      {/* Cheese — tiny drift */}
      <div className="burger-layer" style={{
        position: 'relative',
        marginTop: '-150px',
        transform: 'translateY(calc(var(--scroll-progress, 0) * -8vh)) rotate(calc(var(--scroll-progress, 0) * 2deg))',
        zIndex: 4,
      }}>
        <BurgerCheese />
      </div>
      {/* Patty — anchors the center, barely moves */}
      <div className="burger-layer" style={{
        position: 'relative',
        marginTop: '-130px',
        transform: 'translateY(calc(var(--scroll-progress, 0) * 2vh))',
        zIndex: 3,
      }}>
        <BurgerPatty />
      </div>
      {/* Bottom bun — flies DOWN and rotates the other way */}
      <div className="burger-layer" style={{
        position: 'relative',
        marginTop: '-100px',
        transform: 'translateY(calc(var(--scroll-progress, 0) * 38vh)) rotate(calc(var(--scroll-progress, 0) * 6deg))',
        zIndex: 2,
      }}>
        <BurgerBottomBun />
      </div>
    </div>
  )
}
