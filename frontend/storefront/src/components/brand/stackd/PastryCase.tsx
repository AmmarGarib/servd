'use client'
// The pastry case — this morning's bake on lit shelves behind glass. Hover a
// pastry and it lifts off the shelf as if picked up with tongs, its tag
// swinging; left alone, one of them hops now and then. The glass glint slides
// as you scroll past.
//
// The line-up is illustrative — the menu API does not yet expose per-brand
// items, so this is the case's character, not a price list. The CTA goes to
// the real menu.

import Link from 'next/link'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useInView, useViewProgress, prefersReducedMotion } from './hooks'
import s from './case.module.css'
import ui from './ui.module.css'

const INK = '#3D1122'
const CREAM = '#FCE8CE'
const PLUM = '#7C2946'
const SKY = '#9BD3DD'
const inkProps = { stroke: INK, strokeWidth: 2.6, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const }

function Croissant() {
  const lobes: Array<[number, number, number, number, number]> = [
    [20, 74, 7, 8, -58], [120, 74, 7, 8, 58],
    [32, 64, 11, 13, -42], [108, 64, 11, 13, 42],
    [50, 56, 15, 18, -20], [90, 56, 15, 18, 20],
    [70, 52, 18, 23, 0],
  ]
  return (
    <svg viewBox="0 0 140 100" aria-hidden focusable="false">
      {lobes.map(([cx, cy, rx, ry, r], i) => (
        <g key={i} transform={`rotate(${r} ${cx} ${cy})`}>
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={CREAM} {...inkProps} />
          <path d={`M${cx - rx * 0.45} ${cy - ry * 0.55} Q ${cx} ${cy - ry * 0.8} ${cx + rx * 0.45} ${cy - ry * 0.55}`} fill="none" stroke={INK} strokeWidth={1.6} strokeLinecap="round" />
        </g>
      ))}
    </svg>
  )
}

function Sourdough() {
  // The mascot's own loaf — the brand's drawing, not a new one.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/stackd/bread.png" alt="" width={197} height={167} loading="lazy" decoding="async" />
}

function CinnamonRoll() {
  return (
    <svg viewBox="0 0 140 100" aria-hidden focusable="false">
      <ellipse cx="70" cy="82" rx="40" ry="8" fill={PLUM} opacity="0.18" />
      <path d="M30 60 C 30 36, 50 24, 70 24 C 92 24, 110 36, 110 60 C 110 78, 92 86, 70 86 C 48 86, 30 78, 30 60 Z" fill={CREAM} {...inkProps} />
      <path d="M70 56 C 74 52, 80 56, 78 62 C 76 70, 64 70, 61 62 C 57 52, 66 44, 76 45 C 90 46, 94 60, 90 69 C 84 80, 64 82, 54 74 C 42 64, 46 44, 58 38 C 72 31, 92 36, 100 50" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
      <path d="M44 40 C 52 44, 50 50, 58 50 M84 34 C 86 42, 94 40, 96 46 M40 64 C 46 60, 50 68, 56 64" fill="none" stroke="#FFFFFF" strokeWidth={3.4} strokeLinecap="round" />
    </svg>
  )
}

function Cookie() {
  const chips: Array<[number, number, number]> = [[56, 44, 4], [80, 40, 3.4], [88, 60, 4.2], [62, 66, 3.6], [48, 58, 3], [74, 54, 2.8]]
  return (
    <svg viewBox="0 0 140 100" aria-hidden focusable="false">
      <path d="M70 20 C 84 19, 98 26, 102 40 C 107 54, 101 70, 90 78 C 78 86, 60 86, 49 79 C 37 71, 33 56, 37 43 C 41 29, 55 21, 70 20 Z" fill={CREAM} {...inkProps} />
      <path d="M52 36 L 58 40 L 56 46 M86 70 L 80 68 L 78 74 M92 42 L 88 46" fill="none" stroke={INK} strokeWidth={1.6} strokeLinecap="round" />
      {chips.map(([cx, cy, r], i) => (
        <path key={i} d={`M${cx - r} ${cy} C ${cx - r} ${cy - r * 1.2}, ${cx + r} ${cy - r * 1.3}, ${cx + r} ${cy} C ${cx + r * 0.8} ${cy + r}, ${cx - r * 0.7} ${cy + r * 1.1}, ${cx - r} ${cy} Z`} fill={INK} />
      ))}
    </svg>
  )
}

function BananaBread() {
  return (
    <svg viewBox="0 0 140 100" aria-hidden focusable="false">
      <path d="M34 88 L 34 46 C 34 28, 52 18, 70 18 C 88 18, 106 28, 106 46 L 106 88 Z" fill={PLUM} {...inkProps} />
      <path d="M41 84 L 41 47 C 41 33, 55 25, 70 25 C 85 25, 99 33, 99 47 L 99 84 Z" fill={CREAM} stroke={INK} strokeWidth={1.6} />
      {[[54, 44], [72, 38], [86, 50], [60, 62], [80, 68], [52, 76], [90, 78], [68, 52]].map(([x, y], i) => (
        <ellipse key={i} cx={x} cy={y} rx="2.4" ry="1.6" fill={INK} transform={`rotate(${i * 37} ${x} ${y})`} />
      ))}
      <path d="M58 22 C 64 14, 78 14, 84 22" fill="none" stroke={INK} strokeWidth={2} strokeLinecap="round" />
    </svg>
  )
}

function Focaccia() {
  return (
    <svg viewBox="0 0 140 100" aria-hidden focusable="false">
      <path d="M18 62 C 18 72, 24 78, 34 78 H 106 C 116 78, 122 72, 122 62 V 56 H 18 Z" fill={PLUM} {...inkProps} />
      <path d="M18 56 C 18 40, 26 32, 40 32 H 100 C 114 32, 122 40, 122 56 C 122 64, 116 66, 106 66 H 34 C 24 66, 18 64, 18 56 Z" fill={CREAM} {...inkProps} />
      {[[38, 46], [56, 42], [74, 46], [92, 42], [106, 50], [46, 56], [66, 56], [86, 56]].map(([x, y], i) => (
        <ellipse key={i} cx={x} cy={y} rx="3.6" ry="2.2" fill="none" stroke={INK} strokeWidth={1.6} />
      ))}
      <path d="M60 36 l 4 6 M64 36 l -1 7 M100 46 l 4 5 M104 45 l -1 7 M30 50 l 4 5" stroke={SKY} strokeWidth={3} strokeLinecap="round" />
    </svg>
  )
}

interface Item {
  name: string
  art: ReactNode
  fresh?: boolean
}

const TOP: Item[] = [
  { name: 'croissant', art: <Croissant /> },
  { name: 'sourdough', art: <Sourdough /> },
  { name: 'cinnamon roll', art: <CinnamonRoll />, fresh: true },
]
const BOTTOM: Item[] = [
  { name: 'cookie', art: <Cookie /> },
  { name: 'banana bread', art: <BananaBread /> },
  { name: 'focaccia', art: <Focaccia /> },
]

function Shelf({ items, offset, hop }: { items: Item[]; offset: number; hop: number }) {
  return (
    <>
      <ul className={s.row}>
        {items.map((it, i) => {
          const n = offset + i
          return (
            <li key={it.name} className={s.item} data-hop={hop === n ? 'true' : undefined} style={{ '--n': n } as CSSProperties}>
              <div className={s.lift}>
                {it.fresh && (
                  <svg className={s.steam} viewBox="0 0 60 40" aria-hidden focusable="false">
                    <path d="M16 38 C 10 28, 22 20, 16 8" />
                    <path d="M32 38 C 26 26, 38 18, 32 2" />
                    <path d="M46 38 C 40 28, 52 20, 46 8" />
                  </svg>
                )}
                <div className={s.art}>{it.art}</div>
              </div>
              <span className={s.shadow} aria-hidden />
              <span className={s.tag}>{it.name}</span>
            </li>
          )
        })}
      </ul>
      <div className={s.plank} aria-hidden />
    </>
  )
}

export function PastryCase({ menuHref }: { menuHref: string }) {
  const glassRef = useViewProgress<HTMLDivElement>({ start: 1, end: 0 })
  const { ref, inView } = useInView<HTMLElement>()
  const [hop, setHop] = useState(-1)
  const [settled, setSettled] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  // Items drop onto the shelves the first time the case is seen.
  useEffect(() => { if (inView) setSettled(true) }, [inView])

  // Idle life: while the case is on screen, a random pastry hops.
  useEffect(() => {
    if (!inView || prefersReducedMotion()) return
    let last = -1
    const id = window.setInterval(() => {
      let n = Math.floor(Math.random() * 6)
      if (n === last) n = (n + 1) % 6
      last = n
      setHop(n)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setHop(-1), 900)
    }, 2600)
    return () => { window.clearInterval(id); window.clearTimeout(timer.current) }
  }, [inView])

  return (
    <section ref={ref} className={`${s.section} ${settled ? s.settled : ''}`} aria-labelledby="stackd-case">
      <div className={`${ui.wrap} ${s.grid}`}>
        <div className={s.copy}>
          <p className={ui.spec}>The pastry case</p>
          <h2 id="stackd-case" className={ui.h2}>This morning&rsquo;s <em>bake.</em></h2>
          <p className={ui.lede}>
            Baked here in the morning, then into the case, then into a bag.
            What&rsquo;s on the shelves changes with the day &mdash; the menu has today&rsquo;s.
          </p>
          <div style={{ marginTop: '1.75rem' }}>
            <Link href={menuHref} className={ui.btn}>
              See the menu
              <svg viewBox="0 0 24 24" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
          </div>
        </div>

        <div className={s.case}>
          <div className={s.crown} aria-hidden>
            <span>fresh</span>
            <span className={s.bulb} />
            <span>daily</span>
          </div>
          <div ref={glassRef} className={s.window}>
            <div className={s.lamp} aria-hidden />
            <Shelf items={TOP} offset={0} hop={hop} />
            <Shelf items={BOTTOM} offset={3} hop={hop} />
            <div className={s.glass} aria-hidden />
          </div>
          <div className={s.base} aria-hidden>
            <span>baked here</span>
            <span>·</span>
            <span>stackd</span>
          </div>
        </div>
      </div>
    </section>
  )
}
