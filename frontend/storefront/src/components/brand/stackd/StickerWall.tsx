'use client'
// What we do — the highlights, as die-cut seals slapped onto the wall as they
// scroll in. Each seal carries a small moving drawing in the brand's ink:
// a pan that steams, a sandwich that stacks itself, a glass being poured,
// a bag swinging on its way out. Loops run only while the wall is on screen.

import { useEffect, useState, type CSSProperties } from 'react'
import { Die } from './Die'
import { useInView } from './hooks'
import s from './stickers.module.css'
import ui from './ui.module.css'

type Kind = 'cook' | 'stack' | 'pour' | 'bag' | 'seal'

function kindFor(label: string): Kind {
  const l = label.toLowerCase()
  if (/mocktail|drink|pour|coffee/.test(l)) return 'pour'
  if (/grab|market|to go|take/.test(l)) return 'bag'
  if (/sandwich|pastr|bake/.test(l)) return 'stack'
  if (/scratch|cook|kitchen/.test(l)) return 'cook'
  return 'seal'
}

function Vignette({ kind }: { kind: Kind }) {
  switch (kind) {
    case 'cook':
      return (
        <svg viewBox="0 0 120 96" className={`${s.vig} ${s.cook}`} aria-hidden focusable="false">
          <g className={s.steamG}>
            <path d="M44 34 C 38 26, 50 20, 44 10" />
            <path d="M60 32 C 54 22, 66 16, 60 4" />
            <path d="M76 34 C 70 26, 82 20, 76 10" />
          </g>
          <g className={s.pan}>
            <path className={s.ink} d="M22 50 H 98 C 98 70, 86 80, 60 80 C 34 80, 22 70, 22 50 Z" fill="#7C2946" />
            <path className={s.ink} d="M98 56 L 116 50" />
            <ellipse cx="60" cy="50" rx="38" ry="6" fill="#FCE8CE" className={s.ink} />
            <circle className={s.egg} cx="56" cy="49" r="5" />
          </g>
          <path className={s.flame} d="M44 90 C 46 84, 50 86, 50 82 C 54 86, 56 84, 58 88 C 60 84, 64 86, 64 82 C 68 86, 70 84, 74 90" />
        </svg>
      )
    case 'stack':
      return (
        <svg viewBox="0 0 120 96" className={`${s.vig} ${s.stack}`} aria-hidden focusable="false">
          <g className={s.layer} style={{ '--d': 0 } as CSSProperties}>
            <path className={s.ink} d="M22 82 C 22 74, 30 72, 60 72 C 90 72, 98 74, 98 82 C 98 88, 90 88, 60 88 C 30 88, 22 88, 22 82 Z" fill="#FCE8CE" />
          </g>
          <g className={s.layer} style={{ '--d': 1 } as CSSProperties}>
            <path className={s.ink} d="M18 68 C 26 62, 32 72, 40 66 C 48 60, 54 70, 62 64 C 70 58, 76 70, 84 64 C 92 58, 98 66, 102 66 L 98 72 L 22 72 Z" fill="#9BD3DD" />
          </g>
          <g className={s.layer} style={{ '--d': 2 } as CSSProperties}>
            <rect className={s.ink} x="24" y="54" width="72" height="10" rx="5" fill="#7C2946" />
          </g>
          <g className={s.layer} style={{ '--d': 3 } as CSSProperties}>
            <path className={s.ink} d="M20 50 C 20 26, 40 18, 60 18 C 80 18, 100 26, 100 50 C 100 54, 96 55, 60 55 C 24 55, 20 54, 20 50 Z" fill="#FCE8CE" />
            <path className={s.inkThin} d="M40 34 l 4 -3 M58 28 l 4 -3 M76 34 l 4 -3 M50 42 l 3 -2 M68 42 l 3 -2" />
          </g>
        </svg>
      )
    case 'pour':
      return (
        <svg viewBox="0 0 120 96" className={`${s.vig} ${s.pour}`} aria-hidden focusable="false">
          <defs>
            <clipPath id="stackd-glass-clip">
              <path d="M38 36 L 44 90 H 76 L 82 36 Z" />
            </clipPath>
          </defs>
          <g className={s.bottle}>
            <path className={s.ink} d="M78 2 H 92 V 12 C 100 16, 104 22, 104 30 V 40 H 70 V 30 C 70 22, 72 16, 78 12 Z" fill="#FCE8CE" transform="rotate(-38 88 24)" />
          </g>
          <path className={s.stream} d="M66 30 C 62 44, 60 58, 60 90" />
          <g clipPath="url(#stackd-glass-clip)">
            <rect className={s.liquid} x="30" y="36" width="60" height="56" fill="#9BD3DD" />
            <rect className={s.ice} x="48" y="60" width="11" height="11" rx="2" />
            <rect className={s.ice2} x="61" y="66" width="10" height="10" rx="2" />
          </g>
          <path className={s.ink} d="M38 36 L 44 90 H 76 L 82 36" fill="none" />
          <path className={s.inkThin} d="M72 20 L 66 48" />
          <circle className={s.garnish} cx="82" cy="38" r="7" />
        </svg>
      )
    case 'bag':
      return (
        <svg viewBox="0 0 120 96" className={`${s.vig} ${s.bag}`} aria-hidden focusable="false">
          <g className={s.bagSwing}>
            <path className={s.ink} d="M48 30 C 48 14, 72 14, 72 30" fill="none" />
            <path className={s.baguette} d="M70 36 L 88 6 C 92 2, 98 6, 94 10 L 80 38 Z" />
            <path className={s.ink} d="M30 30 H 90 L 94 90 H 26 Z" fill="#FCE8CE" />
            <path className={s.inkThin} d="M30 38 H 90" />
            <circle cx="60" cy="62" r="13" fill="#9BD3DD" className={s.inkThin} />
            <text x="60" y="66" textAnchor="middle" className={s.bagText}>s.</text>
          </g>
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 120 96" className={s.vig} aria-hidden focusable="false">
          <path className={s.ink} d="M60 10 L 68 38 L 96 44 L 70 56 L 74 86 L 60 66 L 46 86 L 50 56 L 24 44 L 52 38 Z" fill="#9BD3DD" />
        </svg>
      )
  }
}

export function StickerWall({ highlights }: { highlights: string[] }) {
  // Seen once -> the slap plays. On screen now -> the loops run.
  const { ref, inView } = useInView<HTMLElement>({ rootMargin: '0px 0px -15% 0px' })
  const [seen, setSeen] = useState(false)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    // Only hide-until-seen once JS is here, so no-JS readers see the wall.
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setArmed(true)
  }, [])
  useEffect(() => { if (inView) setSeen(true) }, [inView])

  const cls = [s.wall, armed ? s.armed : '', seen ? s.seen : '', inView ? s.live : ''].filter(Boolean).join(' ')

  return (
    <section ref={ref} className={cls} aria-labelledby="stackd-what">
      <div className={ui.wrap}>
        <div className={s.head}>
          <p className={ui.spec}>What we do</p>
          <h2 id="stackd-what" className={ui.h2}>Made here, <em>not assembled.</em></h2>
        </div>
        <ul className={s.grid}>
          {highlights.map((h, i) => (
            <li key={h} className={s.sticker} style={{ '--i': i } as CSSProperties}>
              <Die className={s.die} face={i % 2 ? '#FFFFFF' : '#FCE8CE'} />
              <div className={s.inner}>
                <Vignette kind={kindFor(h)} />
                <span className={s.num}>{String(i + 1).padStart(2, '0')}</span>
                <p className={s.label}>{h}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
