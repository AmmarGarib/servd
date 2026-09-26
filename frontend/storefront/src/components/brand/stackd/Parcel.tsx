'use client'
// Wrapped, not plated. A parcel in stackd wrapping paper (the mascot is the
// print, as he is on the real paper) sits beside the story. Scroll and the
// seal peels off, the four flaps fold back one after another, and there's the
// sandwich — the paper is the plate. Reduced motion shows it already open.

import type { CSSProperties } from 'react'
import { Die } from './Die'
import { useViewProgress } from './hooks'
import s from './parcel.module.css'
import ui from './ui.module.css'

const INK = '#3D1122'
const CREAM = '#FCE8CE'
const PLUM = '#7C2946'
const SKY = '#9BD3DD'

function Sandwich() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden focusable="false">
      {/* left half */}
      <g>
        <path d="M14 18 C 14 12, 18 10, 24 10 L 76 10 C 82 10, 84 14, 80 18 L 22 76 C 18 80, 14 78, 14 72 Z" fill={CREAM} stroke={INK} strokeWidth="2.6" strokeLinejoin="round" />
        <path d="M20 20 C 20 17, 22 16, 25 16 L 70 16 L 20 66 Z" fill="none" stroke={INK} strokeWidth="1.4" strokeDasharray="1 4" strokeLinecap="round" />
        <path d="M80 20 C 72 22, 74 30, 64 32 C 58 40, 52 38, 48 46 C 40 50, 40 56, 32 60 C 28 66, 24 66, 22 74" fill="none" stroke={SKY} strokeWidth="5" strokeLinecap="round" />
        <path d="M78 24 L 24 78" stroke={PLUM} strokeWidth="4" strokeLinecap="round" />
      </g>
      {/* right half, nudged apart */}
      <g transform="translate(6 6)">
        <path d="M86 28 C 86 22, 82 20, 78 24 L 20 82 C 16 86, 18 90, 24 90 L 76 90 C 82 90, 86 88, 86 82 Z" fill={CREAM} stroke={INK} strokeWidth="2.6" strokeLinejoin="round" />
        <path d="M80 34 L 80 80 C 80 83, 78 84, 75 84 L 30 84 Z" fill="none" stroke={INK} strokeWidth="1.4" strokeDasharray="1 4" strokeLinecap="round" />
        <path d="M84 26 C 80 34, 72 32, 70 40 C 62 44, 62 50, 56 54 C 50 58, 48 64, 42 66 C 34 70, 32 76, 22 80" fill="none" stroke={SKY} strokeWidth="5" strokeLinecap="round" />
        <path d="M82 28 L 26 84" stroke={PLUM} strokeWidth="4" strokeLinecap="round" />
      </g>
    </svg>
  )
}

const FLAPS = ['top', 'right', 'bottom', 'left'] as const

// Each flap's triangle, front and back (the back is mirrored because the face
// is flipped 180deg about the flap's own axis before it is seen).
const TRI: Record<(typeof FLAPS)[number], [string, string]> = {
  top: ['0,0 100,0 50,50', '0,100 100,100 50,50'],
  right: ['100,0 100,100 50,50', '0,0 0,100 50,50'],
  bottom: ['0,100 100,100 50,50', '0,0 100,0 50,50'],
  left: ['0,0 0,100 50,50', '100,0 100,100 50,50'],
}

function Edge({ points }: { points: string }) {
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
      <polygon points={points} fill="none" stroke={INK} strokeWidth="3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Parcel({ story }: { story: string }) {
  const ref = useViewProgress<HTMLDivElement>({ start: 0.6, end: 0 })

  return (
    <section className={`${s.section} ${ui.onLight}`} aria-labelledby="stackd-wrapped">
      <div className={`${ui.wrap} ${s.grid}`}>
        <div ref={ref} className={s.stage} aria-hidden>
          <div className={s.parcel}>
            <div className={s.inside}>
              <div className={s.sandwich}><Sandwich /></div>
            </div>
            {FLAPS.map((f, i) => (
              <div key={f} className={`${s.flap} ${s[f]}`} style={{ '--k': i } as CSSProperties}>
                <div className={s.front}><Edge points={TRI[f][0]} /></div>
                <div className={s.back}><Edge points={TRI[f][1]} /></div>
              </div>
            ))}
            <div className={s.seal}>
              <Die face="#FFFFFF" keyline={PLUM} band={SKY} bandWidth={8} keylineWidth={3.5} />
              <span>stackd.</span>
            </div>
          </div>
        </div>

        <div className={s.copy}>
          <p className={ui.spec}>The room</p>
          <h2 id="stackd-wrapped" className={ui.h2}>Wrapped, <em>not plated.</em></h2>
          <p className={s.story}>{story}</p>
        </div>
      </div>
    </section>
  )
}
