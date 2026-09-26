'use client'
// MiniBuild — the same burger, built over and over.
//
// A small looping version of the hero's build, on a bone plate with the
// book's line running round the rim: heel, patty (flipped), aioli, jam,
// crown drop in and seat, it holds, the parts lift off, and it builds again
// — identically. "Same burger, every time", as a loop.
//
// Pure CSS keyframes (transform/opacity), paused off-screen. Reduced motion
// shows the finished burger, still.

import type { CSSProperties } from 'react'
import { useSectionMotion } from './useFlipdMotion'
import m from './mini.module.css'

// Crown-first for layout; `step` is the build order (heel = 0).
const PARTS = [
  { art: 'crown', w: 0.884, step: 4, tilt: -10 },
  { art: 'lettuce', w: 0.957, step: 3, tilt: 12 },
  { art: 'wing', w: 1.0, step: 2, tilt: -8 },
  { art: 'patty', w: 0.803, step: 1, tilt: 7, flip: true },
  { art: 'heel', w: 0.861, step: 0, tilt: -6 },
] as const

export function MiniBuild({ ring = 'SAME BURGER · EVERY TIME · SAME BURGER · EVERY TIME · ', className }: { ring?: string; className?: string }) {
  const ref = useSectionMotion<HTMLDivElement>(0)
  return (
    <div ref={ref} className={`${m.plate} ${className ?? ''}`} aria-hidden>
      <svg className={m.ring} viewBox="0 0 200 200">
        <defs>
          <path id="flipd-mini-ring" d="M100 100 m-86 0 a86 86 0 1 1 172 0 a86 86 0 1 1 -172 0" />
        </defs>
        <text fill="#294375" fontFamily="Poppins, system-ui, sans-serif" fontWeight="700" fontSize="12.5" letterSpacing="3.2">
          <textPath href="#flipd-mini-ring">{ring}</textPath>
        </text>
      </svg>
      <div className={m.stack}>
        {PARTS.map((p, i) => (
          <div
            key={p.art}
            className={m.part}
            style={{ '--step': p.step, '--w': `${p.w * 100}%`, '--tilt': `${p.tilt}deg`, zIndex: PARTS.length - i } as CSSProperties}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/brand/parts/${p.art}.png`}
              alt=""
              loading="lazy"
              className={'flip' in p && p.flip ? m.flip : undefined}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
