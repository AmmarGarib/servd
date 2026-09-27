'use client'
// CrowdCameo — the servd cast as instant, server-rendered SVG.
//
// The six food characters (burger, fries, coffee, sandwich, shake, croissant)
// were first drawn for the route loader. They live here now so every surface
// (the loader, the buddy, the footer crew, the kitchen doors, the board,
// empty states, stackd and Flipd cameos) draws them from ONE source.
//
// Each character sits in its own viewBox with its feet at the bottom; every
// kind shares one vertical scale (VB_H units), so a row of mixed kinds at the
// same `size` reads as one crowd standing on one floor. `size` is the rendered
// height in px; the width follows the character.
//
// Poses are pure CSS, keyed on `data-pose` on the root, and only animate
// transform and opacity. Gradient ids are made unique per instance with
// useId, so any number of cameos can share a page. `'use client'` is only for
// useId; the SVG still renders on the server and paints from the first byte.
//
// Night: `nightPose` lets a cameo switch pose from CSS alone when the server
// stamps html[data-world-dark='1'], so the first paint is already right at
// 2am without waiting for hydration.

import { useId, type CSSProperties, type ReactNode } from 'react'
import type { CharacterKind } from '../../characters/types'
import s from './cameo.module.css'

export type CameoPose = 'idle' | 'wave' | 'cheer' | 'sleep' | 'peek' | 'catch' | 'worried' | 'point' | 'sip'
export type CameoLook = 'center' | 'left' | 'right' | 'up' | 'down'
/** Poses a cameo may take over from CSS when the world is dark. */
export type CameoNightPose = 'sleep' | 'point' | 'idle'

export interface CrowdCameoProps {
  kind: CharacterKind
  /** Rendered height in px. Default 96. */
  size?: number
  /** Default 'idle'. 'sip' is coffee-only; other kinds fall back to idle. */
  pose?: CameoPose
  look?: CameoLook
  /** Default true. false (or prefers-reduced-motion) renders a static pose. */
  animate?: boolean
  /** ms. Desyncs the idle loops (bob, blink) between cameos. */
  delay?: number
  className?: string
  style?: CSSProperties
  /** Set → role="img" + aria-label. Unset → aria-hidden. */
  title?: string
  /** Extension: the pose to take when html[data-world-dark='1'] (CSS only). */
  nightPose?: CameoNightPose
  /** Extension: hang a lit lantern from the right hand. Shows in the point pose only. */
  lantern?: boolean
}

type Vars = CSSProperties & Record<`--${string}`, string | number>
type Url = (name: string) => string

/** Shared vertical scale: feet at y=0, room for the tallest (shake) above. */
const VB_TOP = -128
const VB_H = 136

const q = (v: number) => Math.round(v * 10) / 10

/* ── Gradients (verbatim from the loader, ids made per-instance) ───────── */
const GRADS: Record<string, (id: string) => JSX.Element> = {
  eye: (id) => <radialGradient key={id} id={id} cx=".38" cy=".32" r=".75"><stop offset="0" stopColor="#fff" /><stop offset=".7" stopColor="#FBF8FC" /><stop offset="1" stopColor="#DCD3E0" /></radialGradient>,
  pastry: (id) => <radialGradient key={id} id={id} cx=".38" cy=".3" r=".8"><stop offset="0" stopColor="#FBD892" /><stop offset=".55" stopColor="#E9A14C" /><stop offset="1" stopColor="#B85E1E" /></radialGradient>,
  red: (id) => <linearGradient key={id} id={id}><stop offset="0" stopColor="#A81F18" /><stop offset=".35" stopColor="#E8402C" /><stop offset=".55" stopColor="#F4604A" /><stop offset="1" stopColor="#B8231C" /></linearGradient>,
  fry: (id) => <linearGradient key={id} id={id} x2="1"><stop offset="0" stopColor="#FFE07A" /><stop offset="1" stopColor="#EBA531" /></linearGradient>,
  bunLow: (id) => <linearGradient key={id} id={id} x2="0" y2="1"><stop offset="0" stopColor="#F2BB6A" /><stop offset="1" stopColor="#C06A26" /></linearGradient>,
  bunTop: (id) => <radialGradient key={id} id={id} cx=".38" cy=".25" r=".85"><stop offset="0" stopColor="#FCD690" /><stop offset=".5" stopColor="#E49A48" /><stop offset="1" stopColor="#B4531A" /></radialGradient>,
  patty: (id) => <linearGradient key={id} id={id} x2="0" y2="1"><stop offset="0" stopColor="#7E4428" /><stop offset="1" stopColor="#4A2414" /></linearGradient>,
  pink: (id) => <linearGradient key={id} id={id}><stop offset="0" stopColor="#C43A6C" /><stop offset=".4" stopColor="#F2679A" /><stop offset=".6" stopColor="#FF8DB5" /><stop offset="1" stopColor="#CF4577" /></linearGradient>,
  cream: (id) => <radialGradient key={id} id={id} cx=".4" cy=".3" r=".8"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#EFDCCB" /></radialGradient>,
  cherry: (id) => <radialGradient key={id} id={id} cx=".35" cy=".3" r=".8"><stop offset="0" stopColor="#FF4B5E" /><stop offset="1" stopColor="#A10E22" /></radialGradient>,
  cup: (id) => <linearGradient key={id} id={id}><stop offset="0" stopColor="#E3D3BB" /><stop offset=".45" stopColor="#FFFBF3" /><stop offset="1" stopColor="#D8C6AA" /></linearGradient>,
  sleeve: (id) => <linearGradient key={id} id={id}><stop offset="0" stopColor="#8A5227" /><stop offset=".45" stopColor="#C07F44" /><stop offset="1" stopColor="#8F5629" /></linearGradient>,
  crumb: (id) => <radialGradient key={id} id={id} cx=".42" cy=".4" r=".7"><stop offset="0" stopColor="#FFF0C8" /><stop offset="1" stopColor="#F0CD88" /></radialGradient>,
}

/* ── Face: glossy eyes (blink, look, wide), brows, three mouths, cheeks ── */
function Face({ u, y, gap, r, mouth }: { u: Url; y: number; gap: number; r: number; mouth: number }) {
  return (
    <>
      <g className={s.eyes}>
        <g className={s.wide}>
          {[-gap, gap].map((x) => (
            <g key={x} transform={`translate(${x} ${y})`}>
              <circle r={r} fill={u('eye')} stroke="#2A1A2B" strokeOpacity=".28" />
              <g className={s.pupil}>
                <circle r={q(r * 0.58)} fill="#4A2A18" />
                <circle r={q(r * 0.36)} fill="#0E0908" />
                <circle cx={q(-r * 0.22)} cy={q(-r * 0.24)} r={q(r * 0.2)} fill="#fff" />
                <circle cx={q(r * 0.2)} cy={q(r * 0.2)} r={q(r * 0.08)} fill="#fff" />
              </g>
              <ellipse cx={q(-r * 0.42)} cy={q(-r * 0.5)} rx={q(r * 0.26)} ry={q(r * 0.14)} fill="#fff" opacity=".85" transform={`rotate(-30 ${q(-r * 0.42)} ${q(-r * 0.5)})`} />
            </g>
          ))}
        </g>
      </g>
      {/* Closed lids for sleep: soft downward arcs. */}
      <g className={s.shut} fill="none" stroke="#3A1420" strokeWidth="2.2" strokeLinecap="round">
        {[-gap, gap].map((x) => (
          <path key={x} d={`M${q(x - r * 0.75)} ${q(y + 1)}Q${x} ${q(y + r * 0.7)} ${q(x + r * 0.75)} ${q(y + 1)}`} />
        ))}
      </g>
      {/* Brows for worried: inner ends lifted. */}
      <g className={s.brows} fill="none" stroke="#3A1420" strokeWidth="2.2" strokeLinecap="round">
        {[-gap, gap].map((x) => (
          <path
            key={x}
            d={`M${q(x - r * 0.7)} ${q(y - r * 1.5)}L${q(x + r * 0.7)} ${q(y - r * 1.5)}`}
            transform={`rotate(${x < 0 ? -16 : 16} ${x} ${q(y - r * 1.5)})`}
          />
        ))}
      </g>
      <ellipse cx={q(-gap - r * 0.9)} cy={mouth - 2} rx={q(r * 0.5)} ry={q(r * 0.3)} fill="#FF6B7A" opacity=".45" />
      <ellipse cx={q(gap + r * 0.9)} cy={mouth - 2} rx={q(r * 0.5)} ry={q(r * 0.3)} fill="#FF6B7A" opacity=".45" />
      <g className={s.smile}>
        <path d={`M-7 ${mouth - 2}Q0 ${mouth - 3.5} 7 ${mouth - 2}Q6 ${mouth + 7} 0 ${mouth + 7}Q-6 ${mouth + 7} -7 ${mouth - 2}Z`} fill="#3A1420" />
        <ellipse cx="0" cy={mouth + 4.6} rx="3.6" ry="2" fill="#FF7E8C" />
      </g>
      <ellipse className={s.oMouth} cx="0" cy={mouth + 2} rx="3.2" ry="4" fill="#3A1420" />
      <path className={s.rest} d={`M-4.5 ${mouth + 1}Q0 ${mouth + 4} 4.5 ${mouth + 1}`} fill="none" stroke="#3A1420" strokeWidth="2" strokeLinecap="round" />
    </>
  )
}

/* ── Lantern: hangs from the right hand; counter-rotated so it hangs level
      when the arm points out (the point pose). ─────────────────────────── */
function Lantern() {
  return (
    <g transform="translate(0 23) rotate(90) scale(1.4)">
      <g className={s.lantern} data-cast-part="lantern">
        <circle cx="0" cy="15" r="16" fill="#FFD447" opacity=".24" />
        <path d="M0 0v5" stroke="#2A1A2B" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M-4 5h8l1.2 3h-10.4Z" fill="#2A1A2B" />
        <rect x="-5.5" y="8" width="11" height="13" rx="3" fill="#FFE9A0" stroke="#2A1A2B" strokeWidth="1.4" />
        <ellipse className={s.flame} cx="0" cy="15.5" rx="2.4" ry="3.6" fill="#FF9F43" />
        <rect x="-5" y="21" width="10" height="2.6" rx="1.2" fill="#2A1A2B" />
      </g>
    </g>
  )
}

/* ── Limbs: stubby legs + arms (armL/armR are the pose hooks) ──────────── */
function Limbs({ c, sx, sy, legs = 11, lantern }: { c: string; sx: number; sy: number; legs?: number; lantern: boolean }) {
  return (
    <>
      <rect x={-legs - 4.5} y="-15" width="9" height="15" rx="4.5" fill={c} />
      <rect x={legs - 4.5} y="-15" width="9" height="15" rx="4.5" fill={c} />
      <g transform={`translate(${-sx} ${sy})`}>
        <g className={s.armL} data-cast-part="armL"><rect x="-4" y="-2" width="8" height="25" rx="4" fill={c} /></g>
      </g>
      <g transform={`translate(${sx} ${sy})`}>
        <g className={s.armR} data-cast-part="armR">
          <rect x="-4" y="-2" width="8" height="25" rx="4" fill={c} />
          {lantern && <Lantern />}
        </g>
      </g>
    </>
  )
}

type Body = (u: Url, lantern: boolean) => ReactNode

const croissant: Body = (u, l) => (
  <>
    <Limbs c="#A9561A" sx={36} sy={-34} lantern={l} />
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
)

const fries: Body = (u, l) => (
  <>
    <Limbs c="#B8231C" sx={27} sy={-48} lantern={l} />
    <path d="M-33 -74Q0 -86 33 -74Q0 -64 -33 -74Z" fill="#8E1D17" />
    {[-24, -16, -8, 0, 8, 16, 24].map((x, i) => (
      <rect key={x} x={x - 4} y={-100 + (i % 3) * 6 - (i === 3 ? 6 : 0)} width="8" height="40" rx="3" fill={u('fry')} stroke="#D08A1E" strokeWidth=".8" transform={`rotate(${(i - 3) * 4} ${x} -70)`} />
    ))}
    <path d="M-25 -12L25 -12L33 -74Q0 -58 -33 -74Z" fill={u('red')} stroke="#8E1D17" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M-26.6 -25q3.3 -3 6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0L25 -12L-25 -12Z" fill="#FFE6B0" />
    <Face u={u} y={-50} gap={11} r={9.5} mouth={-36} />
  </>
)

const burger: Body = (u, l) => (
  <>
    <Limbs c="#8A4A22" sx={41} sy={-38} legs={12} lantern={l} />
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
)

const shake: Body = (u, l) => (
  <>
    <Limbs c="#D9487A" sx={23} sy={-52} lantern={l} />
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
)

const coffee: Body = (u, l) => (
  <>
    <Limbs c="#7A4A2A" sx={23} sy={-44} lantern={l} />
    <path d="M-19 -12L19 -12L26 -96L-26 -96Z" fill={u('cup')} stroke="#CDBBA0" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M-21.2 -46L21.2 -46L19.4 -22L-19.4 -22Z" fill={u('sleeve')} />
    <circle cx="0" cy="-34" r="6" fill="none" stroke="#FFF1DC" strokeWidth="2" />
    <path d="M-30 -96L30 -96Q32 -103 27 -106L-27 -106Q-32 -103 -30 -96Z" fill="#3C2320" />
    <path d="M-24 -106Q0 -119 24 -106Z" fill="#5A3530" />
    <rect x="4" y="-113" width="10" height="3" rx="1.5" fill="#1B0F0D" />
    <Face u={u} y={-72} gap={10.5} r={9.5} mouth={-58} />
  </>
)

const SLICE = 'M-34 -14Q-44 -14 -40 -24L-6 -104Q0 -114 6 -104L40 -24Q44 -14 34 -14Z'
const sandwich: Body = (u, l) => (
  <>
    <Limbs c="#B56C2A" sx={41} sy={-34} lantern={l} />
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
)

interface Meta {
  body: Body
  /** Half-width of the layout box in viewBox units (arms may overflow it). */
  w: number
  grads: string[]
  /** Where the sleep z's start (beside the head). */
  z: [number, number]
  index: number
}

const META: Record<CharacterKind, Meta> = {
  croissant: { body: croissant, w: 58, grads: ['pastry'], z: [26, -62], index: 0 },
  fries: { body: fries, w: 38, grads: ['red', 'fry'], z: [28, -70], index: 1 },
  burger: { body: burger, w: 50, grads: ['bunLow', 'bunTop', 'patty'], z: [32, -90], index: 2 },
  shake: { body: shake, w: 32, grads: ['pink', 'cream', 'cherry'], z: [26, -74], index: 3 },
  coffee: { body: coffee, w: 33, grads: ['cup', 'sleeve'], z: [28, -90], index: 4 },
  sandwich: { body: sandwich, w: 52, grads: ['crumb'], z: [30, -70], index: 5 },
}

/** The sleep z: a drawn path, never a text glyph. */
const Z_PATH = 'M0 0h6l-6 7h6'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export function CrowdCameo({
  kind,
  size = 96,
  pose = 'idle',
  look = 'center',
  animate = true,
  delay = 0,
  className,
  style,
  title,
  nightPose,
  lantern = false,
}: CrowdCameoProps): JSX.Element {
  const raw = useId()
  const pre = `cc${raw.replace(/[^A-Za-z0-9_-]/g, '')}`
  const u: Url = (n) => `url(#${pre}-${n})`
  const m = META[kind]
  const effective: CameoPose = pose === 'sip' && kind !== 'coffee' ? 'idle' : pose
  const width = q((size * 2 * m.w) / VB_H)

  // Deterministic desync (same on server and client): bob 1.6–2.2s, blink 3–6s.
  const d = Math.abs(Math.round(delay))
  const h = (m.index * 3 + Math.round(d / 97)) % 7
  const vars: Vars = {
    '--cast-delay': `${-d}ms`,
    '--cast-bob': `${(1.6 + h * 0.1).toFixed(1)}s`,
    '--cast-blink': `${(3 + ((h * 5 + m.index) % 7) * 0.5).toFixed(1)}s`,
    ...style,
  }

  return (
    <svg
      className={cx(s.root, className)}
      viewBox={`${-m.w} ${VB_TOP} ${m.w * 2} ${VB_H}`}
      width={width}
      height={size}
      style={vars}
      data-cast="1"
      data-kind={kind}
      data-pose={effective}
      data-look={look}
      data-animate={animate ? '1' : '0'}
      data-night={nightPose}
      data-lantern={lantern ? '1' : undefined}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        {GRADS.eye!(`${pre}-eye`)}
        {m.grads.map((g) => GRADS[g]!(`${pre}-${g}`))}
      </defs>
      <ellipse className={s.shadow} data-cast-part="shadow" cx="0" cy="1" rx={q(m.w * 0.62)} ry="4.5" fill="#2A1A2B" opacity=".16" />
      <g className={s.pos}>
        <g className={s.act} data-cast-part="body">
          {m.body(u, lantern)}
          {kind === 'coffee' && (
            <g className={s.steam} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path className={s.puff1} d="M-7 -121c-4 -5 4 -8 0 -13" />
              <path className={s.puff2} d="M6 -120c-4 -5 4 -8 0 -13" />
            </g>
          )}
        </g>
        <g className={s.zz} transform={`translate(${m.z[0]} ${m.z[1]})`}>
          <path className={cx(s.z, s.z1)} d={Z_PATH} />
          <g transform="scale(1.3)"><path className={cx(s.z, s.z2)} d={Z_PATH} /></g>
          <g transform="scale(1.6)"><path className={cx(s.z, s.z3)} d={Z_PATH} /></g>
        </g>
      </g>
    </svg>
  )
}

export interface CrowdRowProps {
  kinds: CharacterKind[]
  size?: number
  pose?: CameoPose
  /** px between characters. Default 12. */
  gap?: number
  className?: string
  /** ms of idle-loop desync between neighbours. Default 280. */
  stagger?: number
  /** Extension: forwarded to each cameo. */
  nightPose?: CameoNightPose
}

/** A row of cameos on one baseline, loops desynced along the row. */
export function CrowdRow({ kinds, size = 96, pose = 'idle', gap = 12, className, stagger = 280, nightPose }: CrowdRowProps): JSX.Element {
  return (
    <div className={cx(s.row, className)} style={{ gap }} aria-hidden="true">
      {kinds.map((k, i) => (
        <CrowdCameo key={`${k}-${i}`} kind={k} size={size} pose={pose} delay={i * stagger} nightPose={nightPose} />
      ))}
    </div>
  )
}

export default CrowdCameo
