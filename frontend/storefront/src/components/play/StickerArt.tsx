// Hand-drawn sticker art. Each of the twelve stickers is a die-cut shape: a
// white border with a 2px ink edge, the sticker's party colour inside, and a
// simple motif on top. Pure SVG, no hooks, no emoji; safe to render anywhere.
//
// `muted` draws the locked state: a dashed silhouette with a faint motif.

import type { JSX, ReactNode } from 'react'
import { getSticker, STICKER_COLORS, type StickerId } from '../../lib/play/stickers'

const INK = '#2A1A2B'
const PAPER = '#FFFFFF'

type Shape = 'blob' | 'lozenge' | 'octo'

const OUTLINES: Record<Shape, string> = {
  blob: 'M32 4.5C47.5 3.5 60.2 15.8 59.6 31.4C60.4 47.2 47.4 60.1 31.6 59.6C16.1 60.4 3.6 47.6 4.4 32.2C3.8 16.7 16.4 5.2 32 4.5Z',
  lozenge: 'M15 6.2H49.4C55.4 6 58.2 9.2 58 15.2V48.6C58.3 54.8 55 58.1 48.8 57.9H15.4C9.2 58.2 5.9 55 6.1 48.8V15C5.8 9.1 9.1 6 15 6.2Z',
  octo: 'M22.4 4.8H41.8L59.2 22.3V41.9L41.7 59.3H22.2L4.8 41.8V22.2Z',
}

const SHAPE: Record<StickerId, Shape> = {
  'crowd-poke': 'blob',
  'crowd-toss': 'lozenge',
  'doodle-pop': 'blob',
  'deck-flip': 'lozenge',
  'gate-13': 'octo',
  'pass-swing': 'blob',
  'lucky-pull': 'lozenge',
  'peel': 'octo',
  'grand-tour': 'lozenge',
  'first-toss': 'blob',
  'wait-game': 'blob',
  'claw-prize': 'octo',
}

/** A tiny, fixed tilt per sticker so a row of them never looks machine-set. */
const TILT: Record<StickerId, number> = {
  'crowd-poke': -4,
  'crowd-toss': 3,
  'doodle-pop': -2,
  'deck-flip': 4,
  'gate-13': 0,
  'pass-swing': -3,
  'lucky-pull': 2,
  'peel': -5,
  'grand-tour': 3,
  'first-toss': -2,
  'wait-game': 4,
  'claw-prize': -3,
}

function starPath(cx: number, cy: number, outer: number, inner: number, points: number): string {
  const d: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = (Math.PI * i) / points - Math.PI / 2
    d.push(`${i === 0 ? 'M' : 'L'}${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`)
  }
  return `${d.join(' ')}Z`
}

const BURST = starPath(32, 32, 17, 7.5, 8)
const SPARK = starPath(0, 0, 4, 1.6, 4)

interface Ink {
  line: string
  /** Paper-coloured fill for cards, passes and the peel fold. */
  paper: string
  /** Solid accent fill (knobs, balls). */
  solid: string
}

function motif(id: StickerId, k: Ink): ReactNode {
  switch (id) {
    case 'crowd-poke':
      return (
        <>
          <path d="M32 9.5V21" />
          <path d="M25.5 21.5Q32 28 38.5 21.5" />
          <path d="M25.5 21.5V29M32 23.5V30.5M38.5 21.5V29" />
          <circle cx="32" cy="44" r="9" fill={k.paper} />
          <circle cx="29" cy="43" r="1.3" fill={k.line} stroke="none" />
          <circle cx="35" cy="43" r="1.3" fill={k.line} stroke="none" />
          <path d="M29.5 47.5Q32 49.5 34.5 47.5" />
          <path d="M18.5 35.5L22 37.5M45.5 35.5L42 37.5" />
        </>
      )
    case 'crowd-toss':
      return (
        <>
          <path d="M16 45Q28 8 47 36" strokeDasharray="3 4.5" />
          <path d="M41.5 35.5L47.5 37L48.5 30.5" />
          <circle cx="16" cy="46" r="5" fill={k.solid} />
          <path d="M20 53L24 51.5M13 53.5L12 57" />
        </>
      )
    case 'doodle-pop':
      return (
        <>
          <path d={BURST} fill={k.paper} />
          <circle cx="32" cy="32" r="3" fill={k.line} stroke="none" />
          <path d={SPARK} transform="translate(15 16)" fill={k.line} stroke="none" />
          <path d={SPARK} transform="translate(49 47) scale(.8)" fill={k.line} stroke="none" />
        </>
      )
    case 'deck-flip':
      return (
        <>
          <rect x="15" y="14" width="20" height="28" rx="3" transform="rotate(-10 25 28)" />
          <path d="M19 19L31 35M31 19L19 35" transform="rotate(-10 25 28)" strokeWidth="1.5" />
          <rect x="27" y="19" width="20" height="28" rx="3" transform="rotate(8 37 33)" fill={k.paper} />
          <path d={SPARK} transform="translate(37 33) scale(1.3)" fill={k.solid} stroke="none" />
          <path d="M13 47Q18 55 27 53" />
          <path d="M23 50.5L27.5 53L24.5 57" />
        </>
      )
    case 'gate-13':
      return (
        <>
          <path d="M21 40V51M43 40V51" />
          <rect x="13" y="17" width="38" height="23" rx="3.5" fill={k.paper} />
          <text
            x="32"
            y="34"
            textAnchor="middle"
            fontFamily="'Bricolage Grotesque', Inter, system-ui, sans-serif"
            fontWeight={800}
            fontSize="15"
            fill={k.line}
            stroke="none"
          >
            13
          </text>
          <path d="M16 51H48" />
        </>
      )
    case 'pass-swing':
      return (
        <>
          <path d="M19 7L31 29M45 7L33 29" />
          <rect x="28.5" y="28" width="7" height="5" rx="1" fill={k.solid} />
          <rect x="21" y="32" width="22" height="24" rx="3.5" fill={k.paper} />
          <path d="M28 36H36" strokeWidth="1.6" />
          <circle cx="32" cy="43" r="3.2" />
          <path d="M26.5 51H37.5" strokeWidth="1.6" />
        </>
      )
    case 'lucky-pull':
      return (
        <>
          <rect x="10" y="25" width="31" height="26" rx="4.5" fill={k.paper} />
          <rect x="14" y="31" width="7" height="11" rx="1.5" />
          <rect x="22" y="31" width="7" height="11" rx="1.5" />
          <rect x="30" y="31" width="7" height="11" rx="1.5" />
          <path d="M41 42H46L50 19" />
          <circle cx="50.5" cy="16" r="4.5" fill={k.solid} />
          <path d="M16 47H35" strokeWidth="1.6" />
        </>
      )
    case 'peel':
      return (
        <>
          <path d="M20 16H36L48 28V44Q48 48 44 48H20Q16 48 16 44V20Q16 16 20 16Z" />
          <path d="M36 16Q35.5 27.5 48 28Q40 23 36 16Z" fill={k.paper} />
          <path d="M22 26H31M22 32H40M22 38H36" strokeWidth="1.6" />
        </>
      )
    case 'grand-tour':
      return (
        <>
          <rect x="18" y="11" width="28" height="42" rx="3.5" fill={k.paper} />
          <path d="M22 11V53" strokeWidth="1.4" />
          <circle cx="33" cy="29" r="8" />
          <path d="M25 29H41" strokeWidth="1.4" />
          <ellipse cx="33" cy="29" rx="3.6" ry="8" strokeWidth="1.4" />
          <path d="M27 44H39M29 48H37" strokeWidth="1.6" />
        </>
      )
    case 'first-toss':
      return (
        <>
          <path d="M19 32Q32 14 45 32" />
          <path d="M13 32H51L46 51H18Z" fill={k.paper} />
          <path d="M25 35V48M32 35V48M39 35V48" strokeWidth="1.6" />
          <circle cx="47" cy="15" r="4.5" fill={k.solid} />
          <path d="M40 10L37 8M41 17L37.5 17.5" strokeWidth="1.6" />
        </>
      )
    case 'wait-game':
      return (
        <>
          <path d="M28.5 12H35.5M32 12V20.5" />
          <path d="M43 20L46.5 16.5" />
          <circle cx="32" cy="36" r="14.5" fill={k.paper} />
          <path d="M32 36L38.5 28.5" />
          <path d="M32 25V27M43 36H41M32 47V45M21 36H23" strokeWidth="1.6" />
          <circle cx="32" cy="36" r="2" fill={k.line} stroke="none" />
        </>
      )
    case 'claw-prize':
      return (
        <>
          <path d="M32 5V17" />
          <rect x="25" y="17" width="14" height="7.5" rx="2" fill={k.paper} />
          <path d="M27 24.5Q18.5 32 24.5 41.5M37 24.5Q45.5 32 39.5 41.5" />
          <circle cx="32" cy="42" r="7" fill={k.solid} />
          <path d="M29 39.5Q30.5 37.8 32.5 37.8" strokeWidth="1.5" />
        </>
      )
  }
}

export interface StickerArtProps {
  id: StickerId
  size?: number
  muted?: boolean
  className?: string
}

export function StickerArt(p: StickerArtProps): JSX.Element {
  const size = p.size ?? 64
  const def = getSticker(p.id)
  const outline = OUTLINES[SHAPE[p.id]]
  const onDark = def.color === STICKER_COLORS.plum
  const ink: Ink = p.muted
    ? { line: INK, paper: 'none', solid: 'none' }
    : {
        line: onDark ? STICKER_COLORS.cream : INK,
        paper: onDark ? 'none' : PAPER,
        solid: onDark ? STICKER_COLORS.butter : STICKER_COLORS.tomato === def.color ? STICKER_COLORS.plum : STICKER_COLORS.tomato,
      }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={p.className}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <g transform={`rotate(${TILT[p.id]} 32 32)`}>
        {p.muted ? (
          <path
            d={outline}
            fill="none"
            stroke={INK}
            strokeOpacity={0.5}
            strokeWidth={2}
            strokeDasharray="4 4"
            strokeLinejoin="round"
          />
        ) : (
          <>
            {/* die-cut paper edge, then the printed sticker inside it */}
            <path d={outline} fill={PAPER} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
            <path d={outline} fill={def.color} transform="translate(32 32) scale(0.84) translate(-32 -32)" />
          </>
        )}
        <g
          fill="none"
          stroke={ink.line}
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={p.muted ? 0.32 : 1}
          transform={p.muted ? undefined : 'translate(32 32) scale(0.86) translate(-32 -32)'}
        >
          {motif(p.id, ink)}
        </g>
      </g>
    </svg>
  )
}

export default StickerArt
