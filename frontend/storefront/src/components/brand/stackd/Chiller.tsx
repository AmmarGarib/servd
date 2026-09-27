'use client'
// The grab-and-go chiller. Its glass door is fogged with condensation (someone
// has written in it); scroll and the door swings open, the fog clears, cold
// air rolls out — and the food crowd is standing on the top shelf. They cheer
// every time the door comes all the way open (scroll it shut and open again
// and they cheer again), and lean after your pointer while it is over the
// cabinet. It keeps the café's hours: the LED is lit while stackd is open and
// off when it is closed, and after hours the crowd inside is asleep.

import Link from 'next/link'
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { emitCrowd } from '../../characters/crowdBus'
import { CrowdRow } from '../../world/cast/CrowdCameo'
import { useKitchen } from '../../../lib/world/kitchens'
import { LazyCrowd } from './LazyCrowd'
import { useViewProgress } from './hooks'
import s from './chiller.module.css'
import ui from './ui.module.css'

const INK = '#3D1122'
const CREAM = '#FCE8CE'
const PLUM = '#7C2946'
const SKY = '#9BD3DD'

function Wrapped({ tilt = 0 }: { tilt?: number }) {
  // A half sandwich in branded paper: the cut face peeks out of the top.
  return (
    <svg viewBox="0 0 100 90" aria-hidden focusable="false" style={{ rotate: `${tilt}deg` }}>
      <path d="M16 40 L 50 10 L 84 40 Z" fill={CREAM} stroke={INK} strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M26 36 L 50 16 L 74 36" fill="none" stroke={PLUM} strokeWidth="5" strokeLinejoin="round" />
      <path d="M30 38 C 36 32, 42 40, 50 32 C 58 40, 64 32, 70 38" fill="none" stroke={SKY} strokeWidth="4" strokeLinecap="round" />
      <path d="M10 38 H 90 L 84 86 H 16 Z" fill="#FFFFFF" stroke={INK} strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M10 38 L 50 60 L 90 38" fill="none" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="50" cy="66" r="9" fill={SKY} stroke={INK} strokeWidth="1.8" />
      <text x="50" y="70" textAnchor="middle" fontFamily="Playfair Display, Georgia, serif" fontWeight="800" fontSize="11" fill={INK}>s.</text>
    </svg>
  )
}

function Bottle({ liquid, cap }: { liquid: string; cap: string }) {
  return (
    <svg viewBox="0 0 40 100" aria-hidden focusable="false">
      <rect x="14" y="4" width="12" height="9" rx="2" fill={cap} stroke={INK} strokeWidth="2" />
      <path d="M15 13 H 25 V 24 C 25 30, 34 32, 34 42 V 90 C 34 94, 31 96, 27 96 H 13 C 9 96, 6 94, 6 90 V 42 C 6 32, 15 30, 15 24 Z" fill="#FFFFFF" fillOpacity="0.55" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M7 50 H 33 V 90 C 33 93, 31 95, 27 95 H 13 C 9 95, 7 93, 7 90 Z" fill={liquid} />
      <rect x="9" y="58" width="22" height="18" rx="3" fill={CREAM} stroke={INK} strokeWidth="1.6" />
      <text x="20" y="71" textAnchor="middle" fontFamily="Playfair Display, Georgia, serif" fontWeight="800" fontSize="10" fill={INK}>s.</text>
      <path d="M11 44 V 86" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
    </svg>
  )
}

const CAST = ['coffee', 'sandwich', 'croissant'] as const
const LOOK_EVERY_MS = 100 // ≤10 looks a second

export function Chiller({ orderHref }: { orderHref: string }) {
  const kitchen = useKitchen('stackd')
  const closed = kitchen.phase === 'closed'
  const closedRef = useRef(closed)
  closedRef.current = closed
  const [open, setOpen] = useState(false)
  const cheered = useRef(false)
  const lastLook = useRef(0)
  const fridgeRef = useViewProgress<HTMLDivElement>({
    start: 0.6,
    end: 0.05,
    onChange: (p) => {
      const nowOpen = p > 0.88
      setOpen((o) => (o === nowOpen ? o : nowOpen))
      if (nowOpen && !cheered.current) {
        cheered.current = true
        // After hours the door-light wakes them: a start, not a cheer.
        if (closedRef.current) emitCrowd({ type: 'react', mood: 'surprised', seconds: 1.6 })
        else emitCrowd({ type: 'cheer' })
      } else if (!nowOpen && p < 0.8) {
        // The door has swung back (a little hysteresis so a reader resting
        // on the threshold doesn't make them cheer on every pixel).
        cheered.current = false
      }
    },
  })

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const now = performance.now()
    if (now - lastLook.current < LOOK_EVERY_MS) return
    lastLook.current = now
    emitCrowd({ type: 'look', x: e.clientX, y: e.clientY })
  }

  return (
    <section className={s.section} aria-labelledby="stackd-chiller">
      <div className={`${ui.wrap} ${s.grid}`}>
        <div className={s.copy}>
          <p className={ui.spec}>The market</p>
          <h2 id="stackd-chiller" className={ui.h2}>Grab it. <em>Go.</em></h2>
          <p className={ui.lede}>
            A chiller folded into the counter, stocked for the walk out: sandwiches
            wrapped to travel, cold drinks, craft mocktails. The pastry case is right beside it.
          </p>
          <ul className={s.chips}>
            <li>sandwiches, wrapped</li>
            <li>craft mocktails</li>
            <li>cold drinks</li>
          </ul>
          <div style={{ marginTop: '1.75rem' }}>
            <Link href={orderHref} className={ui.btn}>
              Order for pickup
              <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
          </div>
        </div>

        <div ref={fridgeRef} className={`${s.fridge} ${open ? s.isOpen : ''}`} aria-hidden onPointerMove={onPointerMove}>
          <div className={s.top}>
            <span className={s.brand}>stackd</span>
            <span className={s.led}>
              <span className={s.ledDot} />
              <span className={s.ledOn}>cold</span>
              <span className={s.ledOff}>lights out</span>
            </span>
          </div>
          <div className={s.cabinet}>
            <div className={s.interior}>
              <div className={s.light} />
              <LazyCrowd
                className={s.crowd}
                cast={[...CAST]}
                excitement={open && !closed ? 0.7 : 0}
                sleepy={closed ? 1 : undefined}
                stageId="stackd-chiller"
                fallback={<CrowdRow kinds={[...CAST]} size={100} pose={closed ? 'sleep' : 'idle'} gap={10} stagger={220} />}
              />
              <div className={s.rail} />
              <div className={s.rowWraps}>
                <Wrapped tilt={-4} />
                <Wrapped tilt={3} />
                <Wrapped tilt={-2} />
              </div>
              <div className={s.rail} />
              <div className={s.rowBottles}>
                <Bottle liquid={PLUM} cap={SKY} />
                <Bottle liquid={SKY} cap={PLUM} />
                <Bottle liquid={CREAM} cap={SKY} />
                <Bottle liquid={PLUM} cap={CREAM} />
                <Bottle liquid={SKY} cap={INK} />
              </div>
              <div className={s.rail} />
              <div className={s.mist}>
                <span />
                <span />
                <span />
              </div>
            </div>

            <div className={s.door}>
              <div className={s.doorFace}>
                <svg className={s.fog} viewBox="0 0 300 400" preserveAspectRatio="none">
                  <defs>
                    <mask id="stackd-fog-writing">
                      <rect width="300" height="400" fill="white" />
                      <g fill="none" stroke="black" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M92 120 V 196 M92 162 C 104 142, 132 142, 132 168 V 196" />
                        <path d="M160 152 V 196" />
                        <circle cx="160" cy="128" r="3" />
                        <path d="M190 190 L 191 192" />
                        <path d="M96 236 C 120 262, 176 262, 202 232" />
                      </g>
                    </mask>
                  </defs>
                  <rect width="300" height="400" fill="#EEF8FA" mask="url(#stackd-fog-writing)" />
                </svg>
                <div className={s.drops} />
                <span className={s.drip} style={{ left: '22%', animationDelay: '0.4s' }} />
                <span className={s.drip} style={{ left: '61%', animationDelay: '2.1s' }} />
                <span className={s.drip} style={{ left: '84%', animationDelay: '3.6s' }} />
                <div className={s.decal}>grab<br />&amp; go</div>
              </div>
              <div className={s.handle} />
              <div className={s.doorBack} />
            </div>
          </div>
          <div className={s.feet}><span /><span /></div>
        </div>
      </div>
    </section>
  )
}
