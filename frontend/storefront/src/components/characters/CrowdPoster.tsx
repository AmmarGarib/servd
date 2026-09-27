'use client'

/**
 * CrowdPoster — the food crowd as flat SVG. It paints with the first byte of
 * HTML (no WebGL, no network), so a crowd is never an empty box:
 *
 * - under FoodCrowd, it is the "before" frame that cross-fades into 3D;
 * - with reduced motion, no WebGL or a failed chunk, it is the crowd;
 * - `mode="shrug"` is the cast for empty, error and 404 states.
 *
 * Same left-to-right order and proportions as the 3D cast (burger wide,
 * fries tall, shake tallest), bottom-aligned on a soft floor shadow each.
 * Once measured it shows the same centred slice the 3D stage would at that
 * aspect ratio, and widens its gaps on wide stages the way the 3D crowd does.
 *
 * Decorative only (aria-hidden). Reduced motion always renders it still.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import s from './crowdPoster.module.css'
import { DEFAULT_CAST, isCharacterKind, visibleSlice, type CharacterKind } from './types'

export type CrowdPosterMode = 'waking' | 'still' | 'shrug'

export interface CrowdPosterProps {
  /** Left→right order. Default fries, burger, coffee, sandwich, shake, croissant. */
  cast?: CharacterKind[]
  /** waking = breathe + blink; shrug = head tilt + shoulder hop; still = static. */
  mode?: CrowdPosterMode
  className?: string
  style?: CSSProperties
}

type V = CSSProperties & Record<`--${string}`, string | number>
type U = (name: string) => string

const q = (v: number) => Math.round(v * 10) / 10

/* ── Face: two glossy eyes (blink), open smile, cheeks ─────────────────── */
function Face({ u, y, gap, r, mouth }: { u: U; y: number; gap: number; r: number; mouth: number }) {
  return (
    <>
      <g className={s.eyes}>
        {[-gap, gap].map((x) => (
          <g key={x} transform={`translate(${x} ${y})`}>
            <circle r={r} fill={u('eye')} stroke="#2A1A2B" strokeOpacity=".28" />
            <circle cy={q(r * 0.12)} r={q(r * 0.58)} fill="#4A2A18" />
            <circle cy={q(r * 0.12)} r={q(r * 0.36)} fill="#0E0908" />
            <circle cx={q(-r * 0.22)} cy={q(-r * 0.12)} r={q(r * 0.2)} fill="#fff" />
            <circle cx={q(r * 0.2)} cy={q(r * 0.3)} r={q(r * 0.08)} fill="#fff" />
            <ellipse cx={q(-r * 0.42)} cy={q(-r * 0.5)} rx={q(r * 0.26)} ry={q(r * 0.14)} fill="#fff" opacity=".85" transform={`rotate(-30 ${q(-r * 0.42)} ${q(-r * 0.5)})`} />
          </g>
        ))}
      </g>
      <ellipse cx={q(-gap - r * 0.9)} cy={mouth - 2} rx={q(r * 0.5)} ry={q(r * 0.3)} fill="#FF6B7A" opacity=".45" />
      <ellipse cx={q(gap + r * 0.9)} cy={mouth - 2} rx={q(r * 0.5)} ry={q(r * 0.3)} fill="#FF6B7A" opacity=".45" />
      <g className={s.mouth}>
        <path d={`M-7 ${mouth - 2}Q0 ${mouth - 3.5} 7 ${mouth - 2}Q6 ${mouth + 7} 0 ${mouth + 7}Q-6 ${mouth + 7} -7 ${mouth - 2}Z`} fill="#3A1420" />
        <ellipse cx="0" cy={mouth + 4.6} rx="3.6" ry="2" fill="#FF7E8C" />
      </g>
    </>
  )
}

/* ── Limbs: stubby legs, arms on a shoulder group (the shrug hops it) ──── */
function Limbs({ c, sx, sy, legs = 11 }: { c: string; sx: number; sy: number; legs?: number }) {
  return (
    <>
      <rect x={-legs - 4.5} y="-15" width="9" height="15" rx="4.5" fill={c} />
      <rect x={legs - 4.5} y="-15" width="9" height="15" rx="4.5" fill={c} />
      <g className={s.arms}>
        <rect x={-sx - 4} y={sy - 2} width="8" height="25" rx="4" fill={c} transform={`rotate(14 ${-sx} ${sy})`} />
        <rect x={sx - 4} y={sy - 2} width="8" height="25" rx="4" fill={c} transform={`rotate(-14 ${sx} ${sy})`} />
      </g>
    </>
  )
}

interface Art {
  /** Horizontal extent around the character's own x = 0. */
  left: number
  right: number
  /** Height above the floor. */
  h: number
  body: (u: U) => ReactNode
}

const SLICE = 'M-34 -14Q-44 -14 -40 -24L-6 -104Q0 -114 6 -104L40 -24Q44 -14 34 -14Z'

const ART: Record<CharacterKind, Art> = {
  croissant: {
    left: -57,
    right: 57,
    h: 70,
    body: (u) => (
      <>
        <Limbs c="#A9561A" sx={36} sy={-34} />
        {[-1, 1].map((k) => (
          <g key={k} transform={`scale(${k} 1)`} stroke="#A34E16" strokeWidth="1.5">
            <ellipse cx="44" cy="-20" rx="13" ry="9" fill={u('pastry')} transform="rotate(40 44 -20)" />
            <ellipse cx="27" cy="-32" rx="17" ry="20" fill={u('pastry')} transform="rotate(20 27 -32)" />
          </g>
        ))}
        <ellipse cx="0" cy="-40" rx="24" ry="28" fill={u('pastry')} stroke="#A34E16" strokeWidth="1.5" />
        <path d="M-21 -52Q0 -44 21 -52M-22 -26Q0 -18 22 -26" stroke="#B85E1E" strokeWidth="1.6" fill="none" strokeLinecap="round" opacity=".55" />
        <path d="M-15 -62Q-5 -67 8 -64" stroke="#FFE3A8" strokeWidth="3" fill="none" strokeLinecap="round" opacity=".7" />
        <Face u={u} y={-45} gap={9.5} r={8} mouth={-30} />
      </>
    ),
  },
  fries: {
    left: -34,
    right: 34,
    h: 106,
    body: (u) => (
      <>
        <Limbs c="#B8231C" sx={27} sy={-48} />
        <path d="M-33 -74Q0 -86 33 -74Q0 -64 -33 -74Z" fill="#8E1D17" />
        {[-24, -16, -8, 0, 8, 16, 24].map((x, i) => (
          <rect key={x} x={x - 4} y={-100 + (i % 3) * 6 - (i === 3 ? 6 : 0)} width="8" height="40" rx="3" fill={u('fry')} stroke="#D08A1E" strokeWidth=".8" transform={`rotate(${(i - 3) * 4} ${x} -70)`} />
        ))}
        <path d="M-25 -12L25 -12L33 -74Q0 -58 -33 -74Z" fill={u('red')} stroke="#8E1D17" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M-26.6 -25q3.3 -3 6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0L25 -12L-25 -12Z" fill="#FFE6B0" />
        <Face u={u} y={-50} gap={11} r={9.5} mouth={-36} />
      </>
    ),
  },
  burger: {
    left: -48,
    right: 48,
    h: 96,
    body: (u) => (
      <>
        <Limbs c="#8A4A22" sx={41} sy={-38} legs={12} />
        <rect x="-40" y="-31" width="80" height="18" rx="8" fill={u('bunLow')} />
        <path d="M-47 -31q4 7 8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0L47 -36L-47 -36Z" fill="#46B02A" />
        <rect x="-45" y="-43" width="90" height="13" rx="6.5" fill={u('patty')} />
        <path d="M-45 -45L45 -45L45 -40L33 -40Q31 -29 27 -40L-12 -40Q-15 -26 -19 -40L-45 -40Z" fill="#FFB81C" />
        <rect x="-41" y="-49" width="82" height="5" rx="2.5" fill="#E8402C" />
        <path d="M-45 -47C-45 -82 -24 -96 0 -96C24 -96 45 -82 45 -47Z" fill={u('bunTop')} />
        {[[-26, -84, -30], [-6, -90, 10], [16, -88, 40], [32, -76, 60], [-36, -68, -60], [36, -60, 70], [-38, -56, -70]].map(([x, y, a]) => (
          <ellipse key={`${x}`} cx={x} cy={y} rx="3.4" ry="1.8" fill="#FFF3D2" transform={`rotate(${a} ${x} ${y})`} />
        ))}
        <Face u={u} y={-68} gap={13} r={10.5} mouth={-55} />
      </>
    ),
  },
  shake: {
    left: -29,
    right: 29,
    h: 141,
    body: (u) => (
      <>
        <Limbs c="#D9487A" sx={23} sy={-52} />
        <line x1="10" y1="-92" x2="24" y2="-140" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
        <line x1="10" y1="-92" x2="24" y2="-140" stroke="#E8392F" strokeWidth="6" strokeDasharray="5 6" />
        <path d="M-20 -12L20 -12L27 -86L-27 -86Z" fill={u('pink')} stroke="#B8305F" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M-25.4 -70L25.4 -70L25 -65L-25 -65Z" fill="#FF9DC0" />
        <ellipse cx="0" cy="-86" rx="28" ry="4" fill="#FF9DC0" />
        <ellipse cx="0" cy="-92" rx="28" ry="10" fill={u('cream')} />
        <ellipse cx="-2" cy="-102" rx="20" ry="9" fill={u('cream')} />
        <ellipse cx="1" cy="-111" rx="11" ry="7" fill={u('cream')} />
        <path d="M3 -118Q4 -128 12 -131" stroke="#4E7A22" strokeWidth="2" fill="none" strokeLinecap="round" />
        <circle cx="2" cy="-120" r="7" fill={u('cherry')} />
        <circle cx="-0.5" cy="-122.5" r="2" fill="#fff" opacity=".85" />
        <Face u={u} y={-56} gap={11} r={9.5} mouth={-42} />
      </>
    ),
  },
  coffee: {
    left: -31,
    right: 31,
    h: 114,
    body: (u) => (
      <>
        <Limbs c="#7A4A2A" sx={23} sy={-44} />
        <path d="M-19 -12L19 -12L26 -96L-26 -96Z" fill={u('cup')} stroke="#CDBBA0" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M-21.2 -46L21.2 -46L19.4 -22L-19.4 -22Z" fill={u('sleeve')} />
        <circle cx="0" cy="-34" r="6" fill="none" stroke="#FFF1DC" strokeWidth="2" />
        <path d="M-30 -96L30 -96Q32 -103 27 -106L-27 -106Q-32 -103 -30 -96Z" fill="#3C2320" />
        <path d="M-24 -106Q0 -119 24 -106Z" fill="#5A3530" />
        <rect x="4" y="-113" width="10" height="3" rx="1.5" fill="#1B0F0D" />
        <Face u={u} y={-72} gap={10.5} r={9.5} mouth={-58} />
      </>
    ),
  },
  sandwich: {
    left: -46,
    right: 51,
    h: 114,
    body: (u) => (
      <>
        <Limbs c="#B56C2A" sx={41} sy={-34} />
        <path d={SLICE} fill="none" stroke="#46B02A" strokeWidth="17" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="0 6" />
        <path d={SLICE} fill="none" stroke="#46B02A" strokeWidth="13" strokeLinejoin="round" />
        <path d={SLICE} fill="none" stroke="#F08A95" strokeWidth="10" strokeLinejoin="round" />
        <path d="M26 -46L50 -30L34 -20Z" fill="#FFB81C" strokeLinejoin="round" />
        <path d={SLICE} fill={u('crumb')} stroke="#BD6A26" strokeWidth="6" strokeLinejoin="round" />
        {[[-18, -26], [14, -24], [-4, -80], [22, -34], [-24, -38]].map(([x, y]) => (
          <circle key={x} cx={x} cy={y} r="1.3" fill="#D9A55A" />
        ))}
        <Face u={u} y={-48} gap={11} r={9.5} mouth={-34} />
      </>
    ),
  },
}

/** Blink clocks, so no two characters blink together (3–5s). */
const BLINK: Record<CharacterKind, string> = {
  fries: '4.3s',
  burger: '3.8s',
  coffee: '3.6s',
  sandwich: '4.6s',
  shake: '4.9s',
  croissant: '3.4s',
}

const MIN_GAP = 24
const MAX_GAP = 56
const HEADROOM = 24
const FLOOR = 10
const SIDE = 12

function Defs({ id }: { id: string }) {
  const i = (n: string) => `${id}-${n}`
  return (
    <defs>
      <radialGradient id={i('eye')} cx=".38" cy=".32" r=".75"><stop offset="0" stopColor="#fff" /><stop offset=".7" stopColor="#FBF8FC" /><stop offset="1" stopColor="#DCD3E0" /></radialGradient>
      <radialGradient id={i('pastry')} cx=".38" cy=".3" r=".8"><stop offset="0" stopColor="#FBD892" /><stop offset=".55" stopColor="#E9A14C" /><stop offset="1" stopColor="#B85E1E" /></radialGradient>
      <linearGradient id={i('red')}><stop offset="0" stopColor="#A81F18" /><stop offset=".35" stopColor="#E8402C" /><stop offset=".55" stopColor="#F4604A" /><stop offset="1" stopColor="#B8231C" /></linearGradient>
      <linearGradient id={i('fry')} x2="1"><stop offset="0" stopColor="#FFE07A" /><stop offset="1" stopColor="#EBA531" /></linearGradient>
      <linearGradient id={i('bunLow')} x2="0" y2="1"><stop offset="0" stopColor="#F2BB6A" /><stop offset="1" stopColor="#C06A26" /></linearGradient>
      <radialGradient id={i('bunTop')} cx=".38" cy=".25" r=".85"><stop offset="0" stopColor="#FCD690" /><stop offset=".5" stopColor="#E49A48" /><stop offset="1" stopColor="#B4531A" /></radialGradient>
      <linearGradient id={i('patty')} x2="0" y2="1"><stop offset="0" stopColor="#7E4428" /><stop offset="1" stopColor="#4A2414" /></linearGradient>
      <linearGradient id={i('pink')}><stop offset="0" stopColor="#C43A6C" /><stop offset=".4" stopColor="#F2679A" /><stop offset=".6" stopColor="#FF8DB5" /><stop offset="1" stopColor="#CF4577" /></linearGradient>
      <radialGradient id={i('cream')} cx=".4" cy=".3" r=".8"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#EFDCCB" /></radialGradient>
      <radialGradient id={i('cherry')} cx=".35" cy=".3" r=".8"><stop offset="0" stopColor="#FF4B5E" /><stop offset="1" stopColor="#A10E22" /></radialGradient>
      <linearGradient id={i('cup')}><stop offset="0" stopColor="#E3D3BB" /><stop offset=".45" stopColor="#FFFBF3" /><stop offset="1" stopColor="#D8C6AA" /></linearGradient>
      <linearGradient id={i('sleeve')}><stop offset="0" stopColor="#8A5227" /><stop offset=".45" stopColor="#C07F44" /><stop offset="1" stopColor="#8F5629" /></linearGradient>
      <radialGradient id={i('crumb')} cx=".42" cy=".4" r=".7"><stop offset="0" stopColor="#FFF0C8" /><stop offset="1" stopColor="#F0CD88" /></radialGradient>
      <radialGradient id={i('floor')}><stop offset="0" stopColor="#2A1A2B" stopOpacity=".26" /><stop offset=".6" stopColor="#2A1A2B" stopOpacity=".12" /><stop offset="1" stopColor="#2A1A2B" stopOpacity="0" /></radialGradient>
    </defs>
  )
}

export function CrowdPoster({ cast, mode = 'waking', className, style }: CrowdPosterProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const rawId = useId()
  const id = `cp${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const u: U = (name) => `url(#${id}-${name})`

  // Aspect of the box we fill: null until measured (SSR shows the whole cast).
  const [aspect, setAspect] = useState<number | null>(null)
  useEffect(() => {
    const el = svgRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 1 && r.height > 1) {
        const a = Math.round((r.width / r.height) * 50) / 50
        setAspect((prev) => (prev === a ? prev : a))
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const full = (cast && cast.length ? cast : DEFAULT_CAST).filter(isCharacterKind)
  const unique = full.filter((k, i) => full.indexOf(k) === i)
  const kinds = aspect ? visibleSlice(unique, aspect) : unique

  // Row geometry, bottom-aligned on y = 0.
  const maxH = kinds.reduce((m, k) => Math.max(m, ART[k].h), 0)
  const vbH = maxH + HEADROOM + FLOOR
  const sum = kinds.reduce((w, k) => w + (ART[k].right - ART[k].left), 0)
  const gaps = Math.max(1, kinds.length - 1)
  const gap = aspect ? Math.max(MIN_GAP, Math.min(MAX_GAP, (aspect * vbH - sum - SIDE * 2) / gaps)) : MIN_GAP + 6
  const rowW = sum + gap * (kinds.length - 1)
  let x = 0
  const placed = kinds.map((k) => {
    const a = ART[k]
    const cx = x - a.left
    x += a.right - a.left + gap
    return { k, cx, a }
  })
  const vb = `${-SIDE} ${-(maxH + HEADROOM)} ${Math.max(1, rowW + SIDE * 2)} ${vbH}`
  const modeClass = mode === 'waking' ? s.waking : mode === 'shrug' ? s.shrug : s.still

  return (
    <svg
      ref={svgRef}
      className={[s.poster, modeClass, className].filter(Boolean).join(' ')}
      style={style}
      viewBox={vb}
      preserveAspectRatio="xMidYMax meet"
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
    >
      <Defs id={id} />
      {placed.map(({ k, cx, a }, i) => {
        const v: V = { '--i': i, '--b': BLINK[k] }
        const w = a.right - a.left
        return (
          <g key={k} transform={`translate(${q(cx)} 0)`} style={v}>
            <ellipse className={s.shadow} cx={q((a.left + a.right) / 2)} cy="1" rx={q(w * 0.46)} ry="7" fill={u('floor')} />
            <g className={s.body} data-kind={k}>
              {a.body(u)}
            </g>
          </g>
        )
      })}
    </svg>
  )
}

export default CrowdPoster
