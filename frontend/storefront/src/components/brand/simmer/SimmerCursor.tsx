'use client'
// A soft bone ring that trails the pointer and shows only while it is over
// something you can press on a simmer page. The native cursor stays — this
// is a halo around it, not a replacement. Flat 1px ring, no fill, no glow.
//
// Fine pointers only (no touch), off under reduced motion, and scoped to the
// nearest `.simmer-page` so it never leaks onto other surfaces. On bone
// grounds (`data-ground="bone"`) it switches to tiber so it stays visible.

import { useEffect, useRef } from 'react'
import s from './simmer.module.css'

const INTERACTIVE = 'a[href], button, [role="button"], summary, label[for]'

export function SimmerCursor() {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !window.matchMedia) return
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let x = -100, y = -100, tx = -100, ty = -100
    let scale = 0.4, tScale = 0.4
    let raf = 0
    let on = false
    // Pressing closes the ring to .75 through the same lerp (so it eases in
    // and out with weight, no snap and no bounce); letting go opens it.
    let pressed = false
    const target = () => (on ? (pressed ? 0.75 : 1) : 0.4)

    const tick = () => {
      x += (tx - x) * 0.2
      y += (ty - y) * 0.2
      scale += (tScale - scale) * 0.18
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`
      const settled = Math.abs(tx - x) < 0.2 && Math.abs(ty - y) < 0.2 && Math.abs(tScale - scale) < 0.002
      raf = settled ? 0 : requestAnimationFrame(tick)
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick) }

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      tx = e.clientX; ty = e.clientY
      const t = e.target as Element | null
      const page = t?.closest?.('.simmer-page')
      const hit = page ? t?.closest?.(INTERACTIVE) : null
      const next = !!hit
      if (next !== on) {
        on = next
        el.dataset.on = String(on)
        tScale = target()
      }
      if (hit) {
        const ground = hit.closest('[data-ground]')?.getAttribute('data-ground') ?? 'tiber'
        if (el.dataset.ground !== ground) el.dataset.ground = ground
      }
      if (!on) { x = tx; y = ty }   // no trailing while hidden
      kick()
    }
    const onLeave = () => { on = false; pressed = false; el.dataset.on = 'false'; tScale = 0.4; kick() }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      pressed = true
      tScale = target()
      kick()
    }
    const onUp = () => {
      if (!pressed) return
      pressed = false
      tScale = target()
      kick()
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onDown, { passive: true })
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onUp, { passive: true })
    window.addEventListener('blur', onUp)
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
  return <div ref={ref} aria-hidden="true" className={s.cursor} data-on="false" data-ground="tiber" />
}
