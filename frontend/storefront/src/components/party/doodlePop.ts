// doodlePop — the shared "pop" for the home doodles (hero + ticker tape).
//
// Every pop bumps a per-session counter, throws a little burst of dots at
// the press point, clicks + buzzes, and has the crowd glance at it. The 5th
// pop of the session earns the 'doodle-pop' sticker. Purely cosmetic: the
// burst is a throwaway fixed-position node that removes itself.
import { buzz, collect, emitPlay, sfx } from '@/lib/play'
import { emitCrowd } from '../characters/crowdBus'

const STORE_KEY = 'servd-doodle-pops'
/** The sticker lands on exactly this pop, once per session. */
export const DOODLE_POP_GOAL = 5

let memoryCount = 0

function readCount(): number {
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY)
    const n = raw ? Number.parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n >= 0) return Math.max(n, memoryCount)
  } catch {
    /* private mode / blocked storage — fall through to memory */
  }
  return memoryCount
}

function writeCount(n: number): void {
  memoryCount = n
  try {
    window.sessionStorage.setItem(STORE_KEY, String(n))
  } catch {
    /* memory copy is enough */
  }
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function burst(at: { x: number; y: number }, color: string): void {
  const root = document.createElement('div')
  root.setAttribute('aria-hidden', 'true')
  root.style.cssText =
    `position:fixed;left:${at.x}px;top:${at.y}px;width:0;height:0;` +
    'pointer-events:none;z-index:70;contain:layout style;'
  document.body.appendChild(root)
  const done = () => root.remove()

  if (reducedMotion()) {
    // Hand-authored calm state: one static ring that simply fades.
    const ring = document.createElement('span')
    ring.style.cssText =
      'position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:999px;' +
      `border:3px solid ${color};box-sizing:border-box;`
    root.appendChild(ring)
    if (typeof ring.animate === 'function') {
      ring.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'linear', fill: 'forwards' }).onfinish = done
    } else {
      window.setTimeout(done, 150)
    }
    return
  }

  const DOTS = 6
  const start = Math.random() * Math.PI * 2
  for (let i = 0; i < DOTS; i++) {
    const dot = document.createElement('span')
    const size = 6 + (i % 3) * 2
    dot.style.cssText =
      `position:absolute;left:${-size / 2}px;top:${-size / 2}px;width:${size}px;height:${size}px;` +
      `border-radius:999px;background:${color};box-shadow:0 0 0 1.5px rgba(42,26,43,0.85);`
    root.appendChild(dot)
    const angle = start + (i / DOTS) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
    const dist = 28 + Math.random() * 16
    const dx = Math.cos(angle) * dist
    const dy = Math.sin(angle) * dist
    if (typeof dot.animate === 'function') {
      dot.animate(
        [
          { transform: 'translate(0,0) scale(0.6)', opacity: 1 },
          { transform: `translate(${dx * 0.8}px,${dy * 0.8}px) scale(1.1)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${dx}px,${dy}px) scale(0.4)`, opacity: 0 },
        ],
        { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
      )
    }
  }
  // One timer cleans up every dot (and covers browsers without WAAPI).
  window.setTimeout(done, 400)
}

/**
 * Pop a doodle at a viewport point (CSS px, same space as clientX/Y).
 * Returns the session pop count after this pop.
 */
export function popDoodle(at: { x: number; y: number }, color: string): number {
  if (typeof window === 'undefined') return 0
  const count = readCount() + 1
  writeCount(count)

  try {
    burst(at, color)
  } catch {
    /* decoration must never break the caller */
  }
  sfx('pop')
  buzz(8)
  emitPlay({ type: 'poke', source: 'doodle', x: at.x, y: at.y })
  emitCrowd({ type: 'look', x: at.x, y: at.y })

  if (count === DOODLE_POP_GOAL) collect('doodle-pop', at)
  return count
}

/** Centre of an element's box in viewport px. */
export function centreOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}
