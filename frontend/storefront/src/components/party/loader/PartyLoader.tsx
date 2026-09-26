// PartyLoader — the servd hub route loader in the "food crowd" direction.
//
// The crowd from the home hero, redrawn as flat-but-rich SVG so it paints
// from the very first byte of HTML (no JS, no WebGL, no network assets).
// Six characters stand on the butter floor and run a stadium wave: each
// one crouches, springs up with its arms in the air and lands with a squash,
// a sparkle popping over its head. Everyone's eyes follow the wave along the
// row, glance back at you, and blink on their own clocks. Under them the
// servd. wordmark ripples as the wave passes and a cheeky status line cycles.
//
// Pure SVG + CSS keyframes, server-renderable. Reduced motion shows the
// crowd standing still with the first status line.

import type { CSSProperties, ReactNode } from 'react'
import s from './loader.module.css'

const LINES = ['firing the grill…', 'warming the brioche…', 'salting the fries…', 'whipping the shake…', 'plating up…']

type V = CSSProperties & Record<`--${string}`, string | number>

/* ── Face: two glossy eyes (blink + glance), open smile, cheeks ──────── */
const q = (v: number) => Math.round(v * 10) / 10

function Face({ y, gap, r, mouth }: { y: number; gap: number; r: number; mouth: number }) {
  return (
    <>
      <g className={s.blink}>
        {[-gap, gap].map((x) => (
          <g key={x} transform={`translate(${x} ${y})`}>
            <circle r={r} fill="url(#pl-eye)" stroke="#2A1A2B" strokeOpacity=".28" />
            <g className={s.look}>
              <g className={s.up}>
                <circle r={q(r * 0.58)} fill="#4A2A18" />
                <circle r={q(r * 0.36)} fill="#0E0908" />
                <circle cx={q(-r * 0.22)} cy={q(-r * 0.24)} r={q(r * 0.2)} fill="#fff" />
                <circle cx={q(r * 0.2)} cy={q(r * 0.2)} r={q(r * 0.08)} fill="#fff" />
              </g>
            </g>
            <ellipse cx={q(-r * 0.42)} cy={q(-r * 0.5)} rx={q(r * 0.26)} ry={q(r * 0.14)} fill="#fff" opacity=".85" transform={`rotate(-30 ${q(-r * 0.42)} ${q(-r * 0.5)})`} />
          </g>
        ))}
      </g>
      <ellipse cx={q(-gap - r * 0.9)} cy={mouth - 2} rx={q(r * 0.5)} ry={q(r * 0.3)} fill="#FF6B7A" opacity=".45" />
      <ellipse cx={q(gap + r * 0.9)} cy={mouth - 2} rx={q(r * 0.5)} ry={q(r * 0.3)} fill="#FF6B7A" opacity=".45" />
      <path d={`M-7 ${mouth - 2}Q0 ${mouth - 3.5} 7 ${mouth - 2}Q6 ${mouth + 7} 0 ${mouth + 7}Q-6 ${mouth + 7} -7 ${mouth - 2}Z`} fill="#3A1420" />
      <ellipse cx="0" cy={mouth + 4.6} rx="3.6" ry="2" fill="#FF7E8C" />
    </>
  )
}

/* ── Limbs: stubby legs + arms that swing up at the top of the hop ───── */
function Limbs({ c, sx, sy, legs = 11 }: { c: string; sx: number; sy: number; legs?: number }) {
  return (
    <>
      <rect x={-legs - 4.5} y="-15" width="9" height="15" rx="4.5" fill={c} />
      <rect x={legs - 4.5} y="-15" width="9" height="15" rx="4.5" fill={c} />
      <g transform={`translate(${-sx} ${sy})`}><rect className={s.armL} x="-4" y="-2" width="8" height="25" rx="4" fill={c} /></g>
      <g transform={`translate(${sx} ${sy})`}><rect className={s.armR} x="-4" y="-2" width="8" height="25" rx="4" fill={c} /></g>
    </>
  )
}

const croissant = (
  <>
    <Limbs c="#A9561A" sx={36} sy={-34} />
    {[-1, 1].map((k) => (
      <g key={k} transform={`scale(${k} 1)`} stroke="#A34E16" strokeWidth="1.5">
        <ellipse cx="44" cy="-20" rx="13" ry="9" fill="url(#pl-pastry)" transform="rotate(40 44 -20)" />
        <ellipse cx="27" cy="-32" rx="17" ry="20" fill="url(#pl-pastry)" transform="rotate(20 27 -32)" />
      </g>
    ))}
    <ellipse cx="0" cy="-40" rx="24" ry="28" fill="url(#pl-pastry)" stroke="#A34E16" strokeWidth="1.5" />
    <path d="M-21 -52Q0 -44 21 -52M-22 -26Q0 -18 22 -26" stroke="#B85E1E" strokeWidth="1.6" fill="none" strokeLinecap="round" opacity=".55" />
    <path d="M-15 -62Q-5 -67 8 -64" stroke="#FFE3A8" strokeWidth="3" fill="none" strokeLinecap="round" opacity=".7" />
    <Face y={-45} gap={9.5} r={8} mouth={-30} />
  </>
)

const fries = (
  <>
    <Limbs c="#B8231C" sx={27} sy={-48} />
    <path d="M-33 -74Q0 -86 33 -74Q0 -64 -33 -74Z" fill="#8E1D17" />
    {[-24, -16, -8, 0, 8, 16, 24].map((x, i) => (
      <rect key={x} x={x - 4} y={-100 + (i % 3) * 6 - (i === 3 ? 6 : 0)} width="8" height="40" rx="3" fill="url(#pl-fry)" stroke="#D08A1E" strokeWidth=".8" transform={`rotate(${(i - 3) * 4} ${x} -70)`} />
    ))}
    <path d="M-25 -12L25 -12L33 -74Q0 -58 -33 -74Z" fill="url(#pl-red)" stroke="#8E1D17" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M-26.6 -25q3.3 -3 6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0t6.6 0L25 -12L-25 -12Z" fill="#FFE6B0" />
    <Face y={-50} gap={11} r={9.5} mouth={-36} />
  </>
)

const burger = (
  <>
    <Limbs c="#8A4A22" sx={41} sy={-38} legs={12} />
    <rect x="-40" y="-31" width="80" height="18" rx="8" fill="url(#pl-bunLow)" />
    <path d="M-47 -31q4 7 8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0L47 -36L-47 -36Z" fill="#46B02A" />
    <rect x="-45" y="-43" width="90" height="13" rx="6.5" fill="url(#pl-patty)" />
    <path d="M-45 -45L45 -45L45 -40L33 -40Q31 -29 27 -40L-12 -40Q-15 -26 -19 -40L-45 -40Z" fill="#FFB81C" />
    <rect x="-41" y="-49" width="82" height="5" rx="2.5" fill="#E8402C" />
    <path d="M-45 -47C-45 -82 -24 -96 0 -96C24 -96 45 -82 45 -47Z" fill="url(#pl-bunTop)" />
    {[[-26, -84, -30], [-6, -90, 10], [16, -88, 40], [32, -76, 60], [-36, -68, -60], [36, -60, 70], [-38, -56, -70]].map(([x, y, a]) => (
      <ellipse key={`${x}`} cx={x} cy={y} rx="3.4" ry="1.8" fill="#FFF3D2" transform={`rotate(${a} ${x} ${y})`} />
    ))}
    <Face y={-68} gap={13} r={10.5} mouth={-55} />
  </>
)

const shake = (
  <>
    <Limbs c="#D9487A" sx={23} sy={-52} />
    <line x1="10" y1="-92" x2="24" y2="-140" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
    <line x1="10" y1="-92" x2="24" y2="-140" stroke="#E8392F" strokeWidth="6" strokeDasharray="5 6" />
    <path d="M-20 -12L20 -12L27 -86L-27 -86Z" fill="url(#pl-pink)" stroke="#B8305F" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M-25.4 -70L25.4 -70L25 -65L-25 -65Z" fill="#FF9DC0" />
    <ellipse cx="0" cy="-86" rx="28" ry="4" fill="#FF9DC0" />
    <ellipse cx="0" cy="-92" rx="28" ry="10" fill="url(#pl-cream)" />
    <ellipse cx="-2" cy="-102" rx="20" ry="9" fill="url(#pl-cream)" />
    <ellipse cx="1" cy="-111" rx="11" ry="7" fill="url(#pl-cream)" />
    <path d="M3 -118Q4 -128 12 -131" stroke="#4E7A22" strokeWidth="2" fill="none" strokeLinecap="round" />
    <circle cx="2" cy="-120" r="7" fill="url(#pl-cherry)" />
    <circle cx="-0.5" cy="-122.5" r="2" fill="#fff" opacity=".85" />
    <Face y={-56} gap={11} r={9.5} mouth={-42} />
  </>
)

const coffee = (
  <>
    <Limbs c="#7A4A2A" sx={23} sy={-44} />
    <path d="M-19 -12L19 -12L26 -96L-26 -96Z" fill="url(#pl-cup)" stroke="#CDBBA0" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="M-21.2 -46L21.2 -46L19.4 -22L-19.4 -22Z" fill="url(#pl-sleeve)" />
    <circle cx="0" cy="-34" r="6" fill="none" stroke="#FFF1DC" strokeWidth="2" />
    <path d="M-30 -96L30 -96Q32 -103 27 -106L-27 -106Q-32 -103 -30 -96Z" fill="#3C2320" />
    <path d="M-24 -106Q0 -119 24 -106Z" fill="#5A3530" />
    <rect x="4" y="-113" width="10" height="3" rx="1.5" fill="#1B0F0D" />
    <Face y={-72} gap={10.5} r={9.5} mouth={-58} />
  </>
)

const SLICE = 'M-34 -14Q-44 -14 -40 -24L-6 -104Q0 -114 6 -104L40 -24Q44 -14 34 -14Z'
const sandwich = (
  <>
    <Limbs c="#B56C2A" sx={41} sy={-34} />
    <path d={SLICE} fill="none" stroke="#46B02A" strokeWidth="17" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="0 6" />
    <path d={SLICE} fill="none" stroke="#46B02A" strokeWidth="13" strokeLinejoin="round" />
    <path d={SLICE} fill="none" stroke="#F08A95" strokeWidth="10" strokeLinejoin="round" />
    <path d="M26 -46L50 -30L34 -20Z" fill="#FFB81C" strokeLinejoin="round" />
    <path d={SLICE} fill="url(#pl-crumb)" stroke="#BD6A26" strokeWidth="6" strokeLinejoin="round" />
    {[[-18, -26], [14, -24], [-4, -80], [22, -34], [-24, -38]].map(([x, y]) => (
      <circle key={x} cx={x} cy={y} r="1.3" fill="#D9A55A" />
    ))}
    <Face y={-48} gap={11} r={9.5} mouth={-34} />
  </>
)

const CAST: { body: ReactNode; blink: string }[] = [
  { body: croissant, blink: '3.4s' },
  { body: fries, blink: '4.3s' },
  { body: burger, blink: '3.8s' },
  { body: shake, blink: '4.9s' },
  { body: coffee, blink: '3.6s' },
  { body: sandwich, blink: '4.6s' },
]

const STAR = 'M0 -12L3 -3L12 0L3 3L0 12L-3 3L-12 0L-3 -3Z'

function Crowd() {
  return (
    <svg className={s.crowd} viewBox="0 -12 680 224" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="pl-eye" cx=".38" cy=".32" r=".75"><stop offset="0" stopColor="#fff" /><stop offset=".7" stopColor="#FBF8FC" /><stop offset="1" stopColor="#DCD3E0" /></radialGradient>
        <radialGradient id="pl-pastry" cx=".38" cy=".3" r=".8"><stop offset="0" stopColor="#FBD892" /><stop offset=".55" stopColor="#E9A14C" /><stop offset="1" stopColor="#B85E1E" /></radialGradient>
        <linearGradient id="pl-red"><stop offset="0" stopColor="#A81F18" /><stop offset=".35" stopColor="#E8402C" /><stop offset=".55" stopColor="#F4604A" /><stop offset="1" stopColor="#B8231C" /></linearGradient>
        <linearGradient id="pl-fry" x2="1"><stop offset="0" stopColor="#FFE07A" /><stop offset="1" stopColor="#EBA531" /></linearGradient>
        <linearGradient id="pl-bunLow" x2="0" y2="1"><stop offset="0" stopColor="#F2BB6A" /><stop offset="1" stopColor="#C06A26" /></linearGradient>
        <radialGradient id="pl-bunTop" cx=".38" cy=".25" r=".85"><stop offset="0" stopColor="#FCD690" /><stop offset=".5" stopColor="#E49A48" /><stop offset="1" stopColor="#B4531A" /></radialGradient>
        <linearGradient id="pl-patty" x2="0" y2="1"><stop offset="0" stopColor="#7E4428" /><stop offset="1" stopColor="#4A2414" /></linearGradient>
        <linearGradient id="pl-pink"><stop offset="0" stopColor="#C43A6C" /><stop offset=".4" stopColor="#F2679A" /><stop offset=".6" stopColor="#FF8DB5" /><stop offset="1" stopColor="#CF4577" /></linearGradient>
        <radialGradient id="pl-cream" cx=".4" cy=".3" r=".8"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#EFDCCB" /></radialGradient>
        <radialGradient id="pl-cherry" cx=".35" cy=".3" r=".8"><stop offset="0" stopColor="#FF4B5E" /><stop offset="1" stopColor="#A10E22" /></radialGradient>
        <linearGradient id="pl-cup"><stop offset="0" stopColor="#E3D3BB" /><stop offset=".45" stopColor="#FFFBF3" /><stop offset="1" stopColor="#D8C6AA" /></linearGradient>
        <linearGradient id="pl-sleeve"><stop offset="0" stopColor="#8A5227" /><stop offset=".45" stopColor="#C07F44" /><stop offset="1" stopColor="#8F5629" /></linearGradient>
        <radialGradient id="pl-crumb" cx=".42" cy=".4" r=".7"><stop offset="0" stopColor="#FFF0C8" /><stop offset="1" stopColor="#F0CD88" /></radialGradient>
      </defs>
      <ellipse cx="340" cy="186" rx="336" ry="18" fill="#F4C22E" />
      {CAST.map(({ body, blink }, i) => {
        const x = 60 + i * 112
        const v: V = { '--i': i, '--b': blink }
        return (
          <g key={i} style={v}>
            <ellipse className={s.shadow} cx={x} cy="184" rx="34" ry="6" fill="#2A1A2B" opacity=".16" />
            <g transform={`translate(${x + (i % 2 ? 30 : -30)} ${i % 2 ? 44 : 30})`}>
              <path className={s.spark} d={STAR} fill={i % 2 ? '#FF5A3C' : '#4E2A4F'} />
            </g>
            <g transform={`translate(${x} 184)`}>
              <g className={s.hop}>{body}</g>
            </g>
          </g>
        )
      })}
    </svg>
  )
}

/** The loader. `screen` = full-viewport butter stage (route loading).
 *  `inline` = compact crowd on whatever surface it sits on. Passing `label`
 *  shows that line instead of the cycling status lines. */
export function PartyLoader({ variant = 'screen', label }: { variant?: 'screen' | 'inline'; label?: string }) {
  return (
    <div className={variant === 'screen' ? s.screen : s.inline} role="status" aria-live="polite">
      <span className="sr-only">{label ?? 'Loading…'}</span>
      {variant === 'screen' && (
        <>
          <svg className={`${s.doodle} ${s.dStar}`} aria-hidden="true" viewBox="-13 -13 26 26"><path d={STAR} /></svg>
          <svg className={`${s.doodle} ${s.dDot}`} aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" /></svg>
          <svg className={`${s.doodle} ${s.dSquig}`} aria-hidden="true" viewBox="0 0 80 24"><path d="M2 12C12 2 22 22 32 12S52 2 62 12S76 20 78 12" /></svg>
        </>
      )}
      {variant === 'screen' && <div className={s.burst} aria-hidden="true" />}
      <div className={s.stage}><Crowd /></div>
      <div className={s.brand} aria-hidden="true">
        <p className={s.wordmark}>
          {'servd'.split('').map((ch, i) => (
            <span key={i} style={{ '--l': i } as V}>{ch}</span>
          ))}
          <span className={s.dot} style={{ '--l': 5 } as V} />
        </p>
        <p className={s.status}>
          {label ? (
            <span className={s.fixed}>{label}</span>
          ) : (
            LINES.map((t, i) => (
              <span key={t} style={{ '--n': i } as V}>{t}</span>
            ))
          )}
        </p>
      </div>
    </div>
  )
}

export default PartyLoader
