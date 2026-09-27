// Art for act iv, "one bag". Every piece is flat SVG so it paints from the
// first byte, and none of it has a face: these are props, not cast members.
//
//   PastryArt  stackd: a croissant in a plum bakery sleeve with a cream sticker
//   PlateArt   simmer: a lidded small plate in bone line art on a tiber tag
//              (the simmer bible allows no characters, gradients or white)
//   BurgerArt  Flipd: a burger half-wrapped in blue paper with a mustard band
//   BagBack / BagFront  the kraft bag, split in two so items drop BETWEEN the
//              back wall and the front panel
//
// The bag is drawn in a 200 × 240 box; RIM_Y is the front rim's height in it,
// which the scene uses to aim each item at the bag mouth.

import { formatBrandName } from '../../../../lib/concept'

export const BAG_W = 200
export const BAG_H = 240
export const RIM_Y = 62

const INK = '#2A1A2B'
const PLUM = '#4E2A4F'

export function PastryArt() {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden focusable="false">
      {/* croissant, peeking out of the sleeve */}
      <path d="M14 50 C 18 20, 82 20, 86 50 C 74 40, 26 40, 14 50 Z" fill="#E6A14A" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <path d="M33 29 C 36 36, 36 41, 34 45 M50 25 V43 M67 29 C 64 36, 64 41, 66 45" fill="none" stroke="#B8702A" strokeWidth="3" strokeLinecap="round" />
      {/* plum sleeve */}
      <path d="M17 46 H83 L77 92 Q76 96 72 96 H28 Q24 96 23 92 Z" fill="#7C2946" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <path d="M17 46 H83" stroke="#5E1F35" strokeWidth="4" />
      {/* cream sticker, set slightly off-square */}
      <g transform="rotate(-6 50 70)">
        <rect x="27" y="60" width="46" height="20" rx="10" fill="#FCE8CE" stroke={INK} strokeWidth="2" />
        <text x="50" y="74.5" textAnchor="middle" fontSize="11" fontWeight="800" fill="#7C2946" style={{ fontFamily: 'var(--stackd-display, var(--font-display))' }}>
          {formatBrandName('stackd')}
        </text>
      </g>
      <circle cx="72" cy="87" r="3.6" fill="#9BD3DD" stroke={INK} strokeWidth="1.5" />
    </svg>
  )
}

export function PlateArt() {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden focusable="false">
      {/* string */}
      <path d="M86 50 C 94 40, 96 26, 90 14" fill="none" stroke="#EDE6D3" strokeWidth="1.6" strokeLinecap="round" />
      {/* the tiber tag */}
      <path d="M14 18 H72 L90 50 L72 82 H14 Q8 82 8 76 V24 Q8 18 14 18 Z" fill="#06392F" stroke="#EDE6D3" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="80" cy="50" r="4" fill="none" stroke="#EDE6D3" strokeWidth="1.6" />
      {/* lidded small plate, bone line art */}
      <g fill="none" stroke="#EDE6D3" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="41" cy="31" r="3" />
        <path d="M22 54 C 22 36, 60 36, 60 54" />
        <path d="M16 55 H66" />
        <path d="M20 59 Q41 65 62 59" />
      </g>
      <text x="41" y="75" textAnchor="middle" fontSize="10" fill="#EDE6D3" style={{ fontFamily: 'var(--simmer-display, Times, serif)', letterSpacing: '0.08em' }}>
        {formatBrandName('simmer')}
      </text>
    </svg>
  )
}

export function BurgerArt() {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden focusable="false">
      {/* bun top + seeds */}
      <path d="M17 50 C 17 20, 83 20, 83 50 Z" fill="#E9A447" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <g fill="#FFF4D6">
        <ellipse cx="36" cy="33" rx="2.6" ry="1.4" transform="rotate(-20 36 33)" />
        <ellipse cx="50" cy="28" rx="2.6" ry="1.4" />
        <ellipse cx="63" cy="33" rx="2.6" ry="1.4" transform="rotate(20 63 33)" />
        <ellipse cx="44" cy="41" rx="2.6" ry="1.4" transform="rotate(10 44 41)" />
        <ellipse cx="58" cy="42" rx="2.6" ry="1.4" transform="rotate(-10 58 42)" />
      </g>
      {/* lettuce */}
      <path d="M14 51 Q20 58 26 51 T38 51 T50 51 T62 51 T74 51 T86 51 L86 56 H14 Z" fill="#7BC043" stroke={INK} strokeWidth="2.4" strokeLinejoin="round" />
      {/* blue wrapper with the mustard band */}
      <path d="M12 55 H88 L81 92 Q80 96 76 96 H24 Q20 96 19 92 Z" fill="#2092E9" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
      <path d="M14.3 66 H85.7 L83.6 78 H16.4 Z" fill="#FED561" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <text x="50" y="75.6" textAnchor="middle" fontSize="10.5" fontWeight="900" fill="#294375" style={{ fontFamily: 'var(--flipd-display, var(--font-display))' }}>
        {formatBrandName('Flipd')}
      </text>
      <path d="M12 55 L30 62 L50 56 L70 62 L88 55" fill="none" stroke="#1668B0" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  )
}

/** Back wall + the dark interior visible above the front rim. */
export function BagBack() {
  return (
    <svg viewBox={`0 0 ${BAG_W} ${BAG_H}`} width="100%" height="100%" aria-hidden focusable="false">
      <path d="M22 36 H178 L186 66 H14 Z" fill="#A87A4C" stroke={PLUM} strokeWidth="5" strokeLinejoin="round" />
      <path d="M30 44 H170 L175 62 H25 Z" fill="#8C6239" />
    </svg>
  )
}

// A serrated rim, like a torn-open bakery bag: 20 teeth across the top.
const RIM_PATH = (() => {
  const x0 = 14
  const x1 = 186
  const n = 20
  const step = (x1 - x0) / n
  let d = `M${x0} ${RIM_Y}`
  for (let i = 0; i < n; i++) {
    const mid = x0 + step * (i + 0.5)
    const end = x0 + step * (i + 1)
    d += ` L${mid.toFixed(1)} ${RIM_Y - 5} L${end.toFixed(1)} ${RIM_Y}`
  }
  return d
})()

// The side walls taper from x=14 at the rim to x=24 at the base.
const sideL = (y: number) => 14 + (10 * (y - RIM_Y)) / (232 - RIM_Y)
const sideR = (y: number) => BAG_W - sideL(y)

/** Front panel: kraft, plum outline, butter band, servd. wordmark. */
export function BagFront() {
  const b0 = 118
  const b1 = 158
  return (
    <svg viewBox={`0 0 ${BAG_W} ${BAG_H}`} width="100%" height="100%" aria-hidden focusable="false">
      <path
        d={`${RIM_PATH} L176 232 Q175 236 170 236 H30 Q25 236 24 232 Z`}
        fill="#D9AA73"
        stroke={PLUM}
        strokeWidth="5"
        strokeLinejoin="round"
      />
      {/* gusset creases */}
      <path d="M42 64 L47 230 M158 64 L153 230" stroke="#B98552" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M26 212 H174" stroke="#B98552" strokeWidth="2" strokeDasharray="5 6" />
      {/* butter band */}
      <path
        d={`M${sideL(b0).toFixed(1)} ${b0} H${sideR(b0).toFixed(1)} L${sideR(b1).toFixed(1)} ${b1} H${sideL(b1).toFixed(1)} Z`}
        fill="#FFD447"
        stroke={PLUM}
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <text x="100" y="148" textAnchor="middle" fontSize="30" fontWeight="800" fill={PLUM} letterSpacing="-1.2" style={{ fontFamily: 'var(--font-wordmark, var(--font-display))' }}>
        servd<tspan fill="#FF5A3C">.</tspan>
      </text>
    </svg>
  )
}

/** One of the two corner tabs that fold down over the rim at the wrap. */
export function BagTab() {
  return (
    <svg viewBox="0 0 44 32" width="100%" height="100%" preserveAspectRatio="none" aria-hidden focusable="false">
      <path d="M2 32 V10 Q2 2 10 2 H34 Q42 2 42 10 V32 Z" fill="#C8955E" stroke={PLUM} strokeWidth="3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** The rubber stamp that lands on the bag at the wrap. */
export function StampArt() {
  return (
    <svg viewBox="0 0 120 120" width="100%" height="100%" aria-hidden focusable="false">
      <circle cx="60" cy="60" r="54" fill="none" stroke="#FF5A3C" strokeWidth="5" />
      <circle cx="60" cy="60" r="44" fill="none" stroke="#FF5A3C" strokeWidth="2" strokeDasharray="3 5" />
      <text x="60" y="70" textAnchor="middle" fontSize="30" fontWeight="800" fill="#FF5A3C" letterSpacing="-1" style={{ fontFamily: 'var(--font-wordmark, var(--font-display))' }}>
        servd.
      </text>
      <text x="60" y="90" textAnchor="middle" fontSize="9" fontWeight="700" fill="#FF5A3C" letterSpacing="2">
        ONE BAG
      </text>
      <text x="60" y="40" textAnchor="middle" fontSize="9" fontWeight="700" fill="#FF5A3C" letterSpacing="2">
        PACKED
      </text>
    </svg>
  )
}
