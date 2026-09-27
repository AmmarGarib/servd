// flyToBag: the physical half of add-to-cart.
//
// A 44px round token (the dish's photo, or a disc in the brand colour) lifts
// off the add button and flies a quadratic arc into the basket FAB
// ([data-cart-fab]), shrinking to 0.6 as it lands; the FAB bumps to 1.15 to
// catch it. The arc is sampled into WAAPI keyframes and the whole flight runs
// on EASE_CUT, so it is compositor-only (transform + opacity) and needs no
// React state.
//
// Callers capture the origin rect BEFORE whatever holds the button unmounts
// (the item modal closes on add). The FAB may not exist yet on the very first
// add (it mounts with the first item), so the target is looked up on the next
// frames and the token falls back to the bottom centre of the viewport.
//
// Skipped entirely under prefers-reduced-motion.

import { EASE_CUT } from '@/lib/film/motion'

const SIZE = 44
const DURATION = 560
const STEPS = 24

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function waitFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = (left: number) => {
      if (left <= 0) { resolve(); return }
      requestAnimationFrame(() => tick(left - 1))
    }
    tick(n)
  })
}

function findFab(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-cart-fab]')
}

function bumpFab(fab: HTMLElement | null) {
  if (!fab || typeof fab.animate !== 'function') return
  try {
    // `scale` (the individual transform property) composes with the FAB's own
    // translateX(-50%) centring instead of overwriting it.
    fab.animate(
      [{ scale: '1' }, { scale: '1.15', offset: 0.4 }, { scale: '1' }],
      { duration: 360, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
    )
  } catch {
    /* decorative */
  }
}

export function flyToBag(fromRect: DOMRect, opts: { color: string; imageUrl?: string | null }): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (reducedMotion()) return

  void (async () => {
    try {
      // Let the modal close and the FAB mount before measuring the target.
      await waitFrames(2)
      let fab = findFab()
      if (!fab) { await waitFrames(3); fab = findFab() }

      const vw = window.innerWidth
      const vh = window.innerHeight
      const target = fab?.getBoundingClientRect()
      const x0 = fromRect.left + fromRect.width / 2 - SIZE / 2
      const y0 = fromRect.top + fromRect.height / 2 - SIZE / 2
      const x2 = (target ? target.left + target.width / 2 : vw / 2) - SIZE / 2
      const y2 = (target ? target.top + target.height / 2 : vh - 48) - SIZE / 2
      // Control point: above both ends, pulled toward the target so the token
      // arcs up and drops into the bag.
      const cx = x0 + (x2 - x0) * 0.6
      const cy = Math.max(24, Math.min(y0, y2) - Math.min(220, Math.max(120, Math.abs(x2 - x0) * 0.5 + 80)))

      const token = document.createElement('div')
      token.setAttribute('aria-hidden', 'true')
      const s = token.style
      s.position = 'fixed'
      s.left = '0'
      s.top = '0'
      s.width = `${SIZE}px`
      s.height = `${SIZE}px`
      s.borderRadius = '999px'
      s.zIndex = '999'
      s.pointerEvents = 'none'
      s.border = '2px solid rgba(0,0,0,0.18)'
      s.boxShadow = '0 10px 24px rgba(0,0,0,0.22)'
      s.backgroundColor = opts.color
      s.willChange = 'transform, opacity'
      if (opts.imageUrl) {
        s.backgroundImage = `url("${opts.imageUrl.replace(/"/g, '%22')}")`
        s.backgroundSize = 'cover'
        s.backgroundPosition = 'center'
      }
      s.transform = `translate3d(${x0}px, ${y0}px, 0)`
      document.body.appendChild(token)

      const frames: Keyframe[] = []
      for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS
        const u = 1 - t
        const x = u * u * x0 + 2 * u * t * cx + t * t * x2
        const y = u * u * y0 + 2 * u * t * cy + t * t * y2
        // Pops up a touch on take-off, then shrinks to 0.6 in the bag.
        const scale = t < 0.2 ? 1 + t * 0.6 : 1.12 - (t - 0.2) * 0.65
        frames.push({
          transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(3)}) rotate(${(t * 220).toFixed(0)}deg)`,
          opacity: t > 0.92 ? 1 - (t - 0.92) * 6 : 1,
        })
      }

      const anim = token.animate(frames, {
        duration: DURATION,
        easing: `cubic-bezier(${EASE_CUT.join(',')})`,
        fill: 'forwards',
      })
      const done = () => {
        token.remove()
        bumpFab(findFab() ?? fab)
      }
      anim.onfinish = done
      anim.oncancel = () => token.remove()
      // Belt and braces: never leave a token behind.
      window.setTimeout(() => { if (token.isConnected) token.remove() }, DURATION + 400)
    } catch {
      /* a decorative flight must never break the add */
    }
  })()
}
