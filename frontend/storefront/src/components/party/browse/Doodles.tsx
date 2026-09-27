'use client'
// Hand-drawn doodles for the browse header. Purely cosmetic: aria-hidden,
// never focusable, never the only way to reach anything. Poke one and it
// takes a multi-spin flick — arcs away from your finger, fades, then pops
// back in somewhere new along the header's top band. The lever next to the
// search box is this page's keyboard toy.

import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { buzz, emitPlay, sfx, usePrefersReducedMotion } from '@/lib/play'
import s from './browse.module.css'

type Kind = 'star' | 'squiggle' | 'dot'

// Where a doodle may land after a pop: the empty band above the eyebrow, or
// (on screens wide enough to have one) the gutter right of the content
// column. Never over the search, the lever or the chips.
const CONTENT_MAX = 1180

function nextSpot(header: DOMRect): { left: string; top: string } {
  const gutter = (header.width - CONTENT_MAX) / 2
  if (gutter >= 90 && Math.random() < 0.4) {
    const left = header.width - gutter + 16 + Math.random() * (gutter - 70)
    return { left: `${Math.round(left)}px`, top: `${Math.round(18 + Math.random() * 60)}%` }
  }
  // The header's top padding is 3.5rem–5.5rem; stay inside it.
  const bandPx = Math.max(24, Math.min(header.height * 0.1, 60))
  const topPx = 6 + Math.random() * (bandPx - 20)
  return { left: `${Math.round(4 + Math.random() * 86)}%`, top: `${Math.round(topPx)}px` }
}

export function Doodles() {
  const reduce = usePrefersReducedMotion()
  const busy = useRef(new WeakSet<Element>())

  function pop(e: ReactPointerEvent<HTMLSpanElement>, kind: Kind) {
    const host = e.currentTarget
    const art = host.firstElementChild as SVGElement | null
    const header = host.parentElement
    if (!art || !header || busy.current.has(host)) return
    busy.current.add(host)

    const r = host.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    sfx('pop')
    buzz(8)
    emitPlay({ type: 'poke', source: `browse-doodle:${kind}`, x: cx, y: cy })

    const respawn = () => {
      const spot = nextSpot(header.getBoundingClientRect())
      host.style.left = spot.left
      host.style.top = spot.top
      host.style.right = 'auto'
      host.style.bottom = 'auto'
      const back = reduce
        ? art.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'linear' })
        : art.animate(
            [
              { opacity: 0, transform: 'scale(0) rotate(-90deg)' },
              { opacity: 1, transform: 'scale(1.25) rotate(8deg)', offset: 0.6 },
              { opacity: 1, transform: 'scale(1) rotate(0deg)' },
            ],
            { duration: 380, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
          )
      back.onfinish = () => busy.current.delete(host)
      back.oncancel = () => busy.current.delete(host)
    }

    if (reduce) {
      const out = art.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'linear', fill: 'forwards' })
      out.onfinish = () => { respawn(); out.cancel() }
      return
    }

    // Flick away from the pointer: sideways, up, then falling as it fades.
    const away = e.clientX <= cx ? 1 : -1
    const dx = away * (90 + Math.random() * 90)
    const spin = away * (720 + Math.round(Math.random() * 2) * 180)
    const out = art.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.55}px, -70px) rotate(${spin * 0.55}deg) scale(1.15)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${dx}px, 40px) rotate(${spin}deg) scale(0.4)`, opacity: 0 },
      ],
      { duration: 620, easing: 'cubic-bezier(0.22, 0.8, 0.36, 1)', fill: 'forwards' },
    )
    out.onfinish = () => { respawn(); out.cancel() }
  }

  return (
    <>
      <span aria-hidden data-toy="poke" className={`${s.doodle} ${s.doodleStar}`} onPointerDown={(e) => pop(e, 'star')}>
        <svg viewBox="0 0 40 40" focusable="false">
          <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
        </svg>
      </span>
      <span aria-hidden data-toy="poke" className={`${s.doodle} ${s.doodleSquiggle}`} onPointerDown={(e) => pop(e, 'squiggle')}>
        <svg viewBox="0 0 80 24" focusable="false">
          <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
        </svg>
      </span>
      <span aria-hidden data-toy="poke" className={`${s.doodle} ${s.doodleDot}`} onPointerDown={(e) => pop(e, 'dot')}>
        <svg viewBox="0 0 20 20" focusable="false">
          <circle cx="10" cy="10" r="8" />
        </svg>
      </span>
    </>
  )
}
