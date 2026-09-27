'use client'
// The footer's scalloped top edge: the ground of the section above dipping
// onto the plum. It is jelly now.
//
// - Scroll: the wave's extra amplitude follows the page's scroll velocity
//   through a spring (k 120, d 10, up to 14px), so a hard flick sloshes it and
//   it settles when the page stops. The phase travels with the scroll.
// - Desktop drag: grabbing the scallop pulls the nearest control points toward
//   the cursor (max 40px) and they spring back on release. No touch drag, so a
//   phone never loses its vertical scroll here.
// - The rAF loop only runs while the footer edge is in view.
// - Reduced motion: the original static path, nothing moves.
//
// Decorative only (aria-hidden).

import { useEffect, useRef, useState } from 'react'
import { getScrollVelocity, usePrefersReducedMotion } from '@/lib/play'
import s from './footer.module.css'

const VB_W = 1440
const STEP = 30 // control-point spacing, viewBox units
const N = VB_W / STEP + 1
const PERIOD = 360 // resting scallop period (matches the original path)
const MAX_AMP = 14 // px of extra slosh
const MAX_PULL = 40 // px a drag may pull a point
const K = 120
const D = 10

// The original static edge, used for SSR and reduced motion. Filled ABOVE the
// wave so the section above reads as dipping onto the plum.
const STATIC_D =
  'M0,0 L0,30 C120,60 240,0 360,30 C480,60 600,0 720,30 C840,60 960,0 1080,30 C1200,60 1320,0 1440,30 L1440,0 Z'

function clamp(n: number, lo: number, hi: number) {
  return n < lo ? lo : n > hi ? hi : n
}

/** Catmull-Rom through the points, as cubic Beziers, closed over the top. */
function buildPath(xs: Float32Array, ys: Float32Array): string {
  let d = `M0,0 L0,${ys[0]!.toFixed(1)}`
  for (let i = 0; i < N - 1; i++) {
    const x0 = xs[Math.max(0, i - 1)]!, y0 = ys[Math.max(0, i - 1)]!
    const x1 = xs[i]!, y1 = ys[i]!
    const x2 = xs[i + 1]!, y2 = ys[i + 1]!
    const x3 = xs[Math.min(N - 1, i + 2)]!, y3 = ys[Math.min(N - 1, i + 2)]!
    const c1x = x1 + (x2 - x0) / 6, c1y = y1 + (y2 - y0) / 6
    const c2x = x2 - (x3 - x1) / 6, c2y = y2 - (y3 - y1) / 6
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
  }
  return `${d} L${VB_W},0 Z`
}

export function FooterWave() {
  const reduced = usePrefersReducedMotion()
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const pathRef = useRef<SVGPathElement>(null)
  // The live SVG is taller than the resting edge so a pull has room to hang.
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (reduced) { setLive(false); return }
    setLive(true)
  }, [reduced])

  useEffect(() => {
    if (!live) return
    const wrap = wrapRef.current
    const svg = svgRef.current
    const path = pathRef.current
    if (!wrap || !svg || !path) return

    const xs = new Float32Array(N)
    for (let i = 0; i < N; i++) xs[i] = i * STEP
    const ys = new Float32Array(N)
    const off = new Float32Array(N) // drag offsets, px
    const offV = new Float32Array(N)
    const pull = new Float32Array(N) // drag targets, px

    // Geometry in CSS px: the viewBox height is the element's height so one
    // vertical unit is one pixel.
    let vbH = 100
    let restY = 20 // resting centre line of the scallop
    let baseAmp = 5.8
    const measure = () => {
      const r = svg.getBoundingClientRect()
      vbH = Math.max(40, Math.round(r.height))
      // The resting edge occupies the top "edge" height (clamp 28-48px), as
      // the original 60-unit path did: centre at half, amplitude ~0.144 of it.
      const edgeH = clamp(window.innerWidth * 0.05, 28, 48)
      restY = edgeH / 2
      baseAmp = edgeH * 0.144
      svg.setAttribute('viewBox', `0 0 ${VB_W} ${vbH}`)
      for (let i = 0; i < N; i++) ys[i] = restY + baseAmp * Math.sin((2 * Math.PI * xs[i]!) / PERIOD)
      path.setAttribute('d', buildPath(xs, ys))
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(svg)

    let amp = 0
    let ampV = 0
    let phase = 0
    let dragging = false
    let settledDrawn = false
    let raf = 0
    let last = 0
    let inView = false

    const frame = (now: number) => {
      raf = 0
      const dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60)
      last = now

      const v = getScrollVelocity()
      const target = clamp(v * (MAX_AMP / 2200), -MAX_AMP, MAX_AMP)
      ampV += (K * (target - amp) - D * ampV) * dt
      amp += ampV * dt
      amp = clamp(amp, -MAX_AMP * 1.4, MAX_AMP * 1.4)
      phase += dt * (1.2 + Math.abs(v) / 500)

      let moving = Math.abs(amp) > 0.05 || Math.abs(ampV) > 0.05 || dragging
      for (let i = 0; i < N; i++) {
        const t = dragging ? pull[i]! : 0
        offV[i] = offV[i]! + (260 * (t - off[i]!) - 14 * offV[i]!) * dt
        off[i] = off[i]! + offV[i]! * dt
        if (Math.abs(off[i]!) > 0.05 || Math.abs(offV[i]!) > 0.05) moving = true
      }

      if (moving || !settledDrawn) {
        const floor = vbH - 2
        for (let i = 0; i < N; i++) {
          const x = xs[i]!
          const y =
            restY +
            baseAmp * Math.sin((2 * Math.PI * x) / PERIOD) +
            amp * Math.sin((2 * Math.PI * x) / (PERIOD * 2) + phase) +
            off[i]!
          ys[i] = clamp(y, 1, floor)
        }
        path.setAttribute('d', buildPath(xs, ys))
        settledDrawn = !moving
      }
      if (inView) raf = requestAnimationFrame(frame)
    }
    const start = () => {
      if (!raf && inView) { last = 0; raf = requestAnimationFrame(frame) }
    }

    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          inView = entries.some((e) => e.isIntersecting)
          if (inView) start()
          else if (raf) { cancelAnimationFrame(raf); raf = 0 }
        })
      : null
    if (io) io.observe(wrap)
    else { inView = true; start() }

    // ── Desktop drag ──────────────────────────────────────────────────────
    const toLocal = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect()
      return {
        x: ((e.clientX - r.left) / Math.max(1, r.width)) * VB_W,
        y: e.clientY - r.top,
        unitsPerPx: VB_W / Math.max(1, r.width),
      }
    }
    const setPull = (e: PointerEvent) => {
      const p = toLocal(e)
      const sigma = 110 * p.unitsPerPx
      for (let i = 0; i < N; i++) {
        const x = xs[i]!
        const rest = restY + baseAmp * Math.sin((2 * Math.PI * x) / PERIOD)
        const w = Math.exp(-(((x - p.x) / sigma) ** 2))
        pull[i] = clamp(p.y - rest, -MAX_PULL, MAX_PULL) * w
      }
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.button !== 0) return
      dragging = true
      setPull(e)
      try { path.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      wrap.dataset['dragging'] = 'true'
      e.preventDefault()
      start()
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging) return
      setPull(e)
    }
    const onUp = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      pull.fill(0)
      try { path.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
      delete wrap.dataset['dragging']
      start()
    }
    path.addEventListener('pointerdown', onDown)
    path.addEventListener('pointermove', onMove)
    path.addEventListener('pointerup', onUp)
    path.addEventListener('pointercancel', onUp)
    path.addEventListener('lostpointercapture', onUp)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      io?.disconnect()
      ro?.disconnect()
      path.removeEventListener('pointerdown', onDown)
      path.removeEventListener('pointermove', onMove)
      path.removeEventListener('pointerup', onUp)
      path.removeEventListener('pointercancel', onUp)
      path.removeEventListener('lostpointercapture', onUp)
    }
  }, [live])

  if (!live) {
    return (
      <div className={s.waveWrap} aria-hidden="true">
        <svg className={s.wave} viewBox="0 0 1440 60" preserveAspectRatio="none" focusable="false">
          <path d={STATIC_D} />
        </svg>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className={`${s.waveWrap} ${s.waveLive}`} aria-hidden="true">
      <svg ref={svgRef} className={s.wave} viewBox={`0 0 ${VB_W} 100`} preserveAspectRatio="none" focusable="false">
        <path ref={pathRef} d={STATIC_D} className={s.wavePath} />
      </svg>
    </div>
  )
}
