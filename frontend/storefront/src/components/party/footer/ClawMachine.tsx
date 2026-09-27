'use client'
// The footer claw machine. Every page ends with one.
//
// A plum-glass cabinet with a cream frame: a rail, a carriage, a three-prong
// claw, five capsules on the floor and a prize chute on the right. Move the
// claw (drag the carriage on desktop, hold the chevron buttons anywhere, or
// arrow keys while the cabinet is focused), then drop it (the drop button, or
// Space/Enter). A claw within 22px of a capsule's centre grabs it; the third
// drop in a row always wins. A carried capsule rides to the chute, drops in
// and pops open.
//
// Rewards are cosmetic only. The first win earns the 'claw-prize' sticker;
// after that the prize is a fortune line. Never a code, a discount or money.
//
// Hidden on quiet routes (simmer). Rendered lazily when the footer is within
// 400px of the viewport. Reduced motion: no drift, no bob, no jostle, and the
// drop sequence is a set of 150ms position swaps.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { buzz, celebrate, collect, onScrollFlick, sfx, usePrefersReducedMotion, useQuiet } from '@/lib/play'
import { emitCrowd } from '../../characters/crowdBus'
import c from './claw.module.css'

// ── Tuning ────────────────────────────────────────────────────────────────
const SPEED = 230 // px/s while a move control is held
const HIT = 22 // px either side of a capsule centre
const PITY = 3 // the third drop in a row always wins
const T = { descend: 600, close: 200, rise: 700, carry: 500, release: 320, wobble: 520 }
const T_REDUCED = 150

const CABLE_TOP = 17
const REST_L = 10
const CLAW_W = 40
const CHUTE_W = 58
const INSET = 8

// Coloured top half + a cream bottom half (the cream one gets a sky bottom so
// its two halves still read).
const CAPSULES = [
  { key: 'butter', top: '#FFD447', bottom: '#FFF4D6' },
  { key: 'tomato', top: '#FF5A3C', bottom: '#FFF4D6' },
  { key: 'cream', top: '#FFF4D6', bottom: '#9BD3DD' },
  { key: 'sky', top: '#9BD3DD', bottom: '#FFF4D6' },
  { key: 'mustard', top: '#D9A21B', bottom: '#FFF4D6' },
] as const

const FORTUNES = [
  'you won: bragging rights.',
  'you won: a warm feeling.',
  'you won: a small round of applause.',
  'you won: the respect of the claw.',
  'you won: a very good mood.',
  'you won: a story for later.',
  'you won: first dibs on nothing in particular.',
]

const MISSES = [
  'missed. the claw slipped.',
  'so close. the claw needs a word with itself.',
  'nothing. the claw is pretending that was a warm-up.',
]

type Phase = 'idle' | 'descend' | 'close' | 'rise' | 'carry' | 'release' | 'wobble'
type Mode = 'floor' | 'held' | 'falling' | 'gone' | 'spawning'

interface Slot {
  x: number
  y: number
  mode: Mode
  since: number
}

function clamp(n: number, lo: number, hi: number) {
  return n < lo ? lo : n > hi ? hi : n
}
function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}
function easeIn(t: number) {
  return t * t
}

/** Public component: quiet-route gate + lazy render near the viewport. */
export function ClawMachine() {
  const quiet = useQuiet()
  const holderRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    if (quiet || near) return
    const el = holderRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [quiet, near])

  if (quiet) return null
  return (
    <div ref={holderRef} className={c.holder}>
      {near ? <Cabinet /> : null}
    </div>
  )
}

function Cabinet() {
  const reduced = usePrefersReducedMotion()
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced

  const cabinetRef = useRef<HTMLDivElement>(null)
  const glassRef = useRef<HTMLDivElement>(null)
  const carriageRef = useRef<HTMLDivElement>(null)
  const cableRef = useRef<HTMLDivElement>(null)
  const clawRef = useRef<HTMLDivElement>(null)
  const prongLRef = useRef<SVGGElement>(null)
  const prongRRef = useRef<SVGGElement>(null)
  const capRefs = useRef<Array<HTMLDivElement | null>>([])
  const capInnerRefs = useRef<Array<HTMLDivElement | null>>([])

  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [pop, setPop] = useState<{ n: number; top: string; bottom: string } | null>(null)

  // Mutable simulation state (never drives React renders per frame).
  const sim = useRef({
    W: 0,
    H: 0,
    D: 30,
    x: 0,
    dir: 0 as -1 | 0 | 1,
    interacted: false,
    dragging: false,
    phase: 'idle' as Phase,
    t0: 0,
    fromX: 0,
    toX: 0,
    grip: 0, // 0 open, 1 closed
    cableL: REST_L,
    wobble: 0,
    held: -1,
    misses: 0,
    wins: 0,
    slots: [] as Slot[],
    ready: false,
    inView: false,
  })

  // ── Geometry helpers ────────────────────────────────────────────────────
  const geo = useCallback(() => {
    const s = sim.current
    const floorY = s.H - 12
    const capY = floorY - s.D / 2
    const chuteX = s.W - INSET - CHUTE_W / 2
    return {
      floorY,
      capY,
      chuteX,
      xMin: 26,
      xMax: chuteX,
      floorMin: 20 + s.D / 2,
      floorMax: s.W - INSET - CHUTE_W - 12 - s.D / 2,
      downL: Math.max(REST_L + 20, capY - 24 - CABLE_TOP),
      chuteFloorY: s.H - 10 - s.D / 2,
    }
  }, [])

  const freeFloorX = useCallback((except: number) => {
    const s = sim.current
    const g = geo()
    for (let tries = 0; tries < 24; tries++) {
      const x = g.floorMin + Math.random() * Math.max(1, g.floorMax - g.floorMin)
      const clash = s.slots.some((o, i) => i !== except && o.mode !== 'gone' && Math.abs(o.x - x) < s.D + 4)
      if (!clash) return x
    }
    return g.floorMin + Math.random() * Math.max(1, g.floorMax - g.floorMin)
  }, [geo])

  // ── Paint the current sim state into the DOM ───────────────────────────
  const paint = useCallback(() => {
    const s = sim.current
    const carriage = carriageRef.current
    const cable = cableRef.current
    const claw = clawRef.current
    if (!carriage || !cable || !claw) return
    carriage.style.transform = `translate3d(${(s.x - 18).toFixed(1)}px,0,0)`
    cable.style.transform = `translate3d(${(s.x - 1).toFixed(1)}px,0,0) scaleY(${(s.cableL / 100).toFixed(3)})`
    claw.style.transform = `translate3d(${(s.x - CLAW_W / 2).toFixed(1)}px,${(CABLE_TOP + s.cableL).toFixed(1)}px,0) rotate(${s.wobble.toFixed(2)}deg)`
    const open = 24 - s.grip * 30 // degrees: 24 open, -6 closed
    prongLRef.current?.setAttribute('transform', `rotate(${open.toFixed(1)} 17 10)`)
    prongRRef.current?.setAttribute('transform', `rotate(${(-open).toFixed(1)} 23 10)`)
    s.slots.forEach((slot, i) => {
      const el = capRefs.current[i]
      if (!el) return
      el.style.transform = `translate3d(${(slot.x - s.D / 2).toFixed(1)}px,${(slot.y - s.D / 2).toFixed(1)}px,0)`
      el.style.opacity = slot.mode === 'gone' ? '0' : '1'
      if (el.dataset['mode'] !== slot.mode) el.dataset['mode'] = slot.mode
    })
  }, [])

  // ── Layout: measure the glass and lay the capsules out ─────────────────
  useEffect(() => {
    const glass = glassRef.current
    if (!glass) return
    const measure = () => {
      const s = sim.current
      const r = glass.getBoundingClientRect()
      if (r.width < 10) return
      const firstLayout = !s.ready
      const prevW = s.W
      s.W = r.width
      s.H = r.height
      s.D = r.height >= 140 ? 30 : 26
      const g = geo()
      if (firstLayout) {
        const span = g.floorMax - g.floorMin
        s.slots = CAPSULES.map((_, i) => ({
          x: g.floorMin + (span * (i + 0.5)) / CAPSULES.length + (Math.random() - 0.5) * 8,
          y: g.capY,
          mode: 'floor' as Mode,
          since: 0,
        }))
        s.x = (g.xMin + g.floorMax) / 2
        s.ready = true
      } else if (prevW > 0) {
        const k = s.W / prevW
        s.slots.forEach((slot) => {
          if (slot.mode === 'floor' || slot.mode === 'spawning') {
            slot.x = clamp(slot.x * k, g.floorMin, g.floorMax)
            slot.y = g.capY
          }
        })
        s.x = clamp(s.x * k, g.xMin, g.xMax)
      }
      paint()
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(glass)
    return () => ro?.disconnect()
  }, [geo, paint])

  // ── Outcome handlers ───────────────────────────────────────────────────
  const onWin = useCallback(() => {
    const s = sim.current
    const glass = glassRef.current
    const g = geo()
    s.misses = 0
    s.wins += 1
    let at = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    if (glass) {
      const r = glass.getBoundingClientRect()
      at = { x: r.left + g.chuteX, y: r.top + g.chuteFloorY }
    }
    const fresh = collect('claw-prize', at)
    void celebrate({ x: at.x, y: at.y, power: 'small' })
    sfx('ding')
    buzz(20)
    emitCrowd({ type: 'cheer' })
    const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)] ?? FORTUNES[0]!
    setStatus(fresh ? 'you won: the claw champ sticker. it flew into your tin.' : fortune)
  }, [geo])

  const onMiss = useCallback(() => {
    const s = sim.current
    s.misses += 1
    sfx('thunk')
    const line = MISSES[(s.misses - 1) % MISSES.length] ?? MISSES[0]!
    setStatus(s.misses >= PITY - 1 ? `${line} the next drop feels lucky.` : line)
  }, [])

  // ── The loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    const s = sim.current
    let raf = 0
    let last = 0
    let driftT0 = 0

    const dur = (ms: number) => (reducedRef.current ? T_REDUCED : ms)
    // Reduced motion: a step at the end of each phase instead of a tween.
    const prog = (now: number, ms: number) => {
      const p = clamp((now - s.t0) / dur(ms), 0, 1)
      return reducedRef.current ? (p < 1 ? 0 : 1) : p
    }
    const enter = (phase: Phase, now: number) => {
      s.phase = phase
      s.t0 = now
    }

    const step = (now: number) => {
      raf = 0
      if (!s.ready) { schedule(); return }
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60)
      last = now
      const g = geo()
      const R = reducedRef.current

      switch (s.phase) {
        case 'idle': {
          if (s.dir !== 0) {
            s.x = clamp(s.x + s.dir * SPEED * dt, g.xMin, g.xMax)
          } else if (!s.interacted && !R) {
            if (!driftT0) driftT0 = now
            const mid = (g.xMin + g.floorMax) / 2
            const amp = (g.floorMax - g.xMin) * 0.32
            s.x = mid + amp * Math.sin(((now - driftT0) / 6000) * Math.PI * 2)
          }
          s.cableL = REST_L
          s.wobble = 0
          break
        }
        case 'descend': {
          const p = prog(now, T.descend)
          const e = R ? p : easeInOut(p)
          s.cableL = REST_L + (g.downL - REST_L) * e
          if (s.toX !== s.fromX) s.x = s.fromX + (s.toX - s.fromX) * e
          if ((now - s.t0) >= dur(T.descend)) {
            enter('close', now)
            sfx('clack')
          }
          break
        }
        case 'close': {
          const p = prog(now, T.close)
          s.grip = p
          if ((now - s.t0) >= dur(T.close)) {
            // Hit test: nearest floor capsule within ±HIT px of the claw.
            let best = -1
            let bestD = Infinity
            s.slots.forEach((slot, i) => {
              if (slot.mode !== 'floor') return
              const d = Math.abs(slot.x - s.x)
              if (d < bestD) { bestD = d; best = i }
            })
            s.held = best >= 0 && bestD <= HIT ? best : -1
            if (s.held >= 0) {
              const slot = s.slots[s.held]!
              slot.mode = 'held'
              slot.since = now
            }
            enter('rise', now)
          }
          break
        }
        case 'rise': {
          const p = prog(now, T.rise)
          const e = R ? p : easeInOut(p)
          s.cableL = g.downL + (REST_L - g.downL) * e
          if (s.held < 0 && !R) s.grip = 1 - 0.6 * p // a limp claw lets go
          if ((now - s.t0) >= dur(T.rise)) {
            if (s.held >= 0) {
              s.fromX = s.x
              s.toX = g.chuteX
              enter('carry', now)
            } else {
              s.grip = 0
              enter('wobble', now)
              onMiss()
            }
          }
          break
        }
        case 'carry': {
          const p = prog(now, T.carry)
          const e = R ? p : easeInOut(p)
          s.x = s.fromX + (s.toX - s.fromX) * e
          if ((now - s.t0) >= dur(T.carry)) {
            const slot = s.slots[s.held]
            if (slot) { slot.mode = 'falling'; slot.since = now }
            enter('release', now)
          }
          break
        }
        case 'release': {
          const p = prog(now, T.release)
          s.grip = 1 - clamp(p * 2, 0, 1)
          const slot = s.slots[s.held]
          if (slot) {
            const fromY = CABLE_TOP + REST_L + 24
            slot.x = g.chuteX
            slot.y = fromY + (g.chuteFloorY - fromY) * (R ? p : easeIn(p))
          }
          if ((now - s.t0) >= dur(T.release)) {
            if (slot) { slot.mode = 'gone'; slot.since = now }
            const won = CAPSULES[s.held] ?? CAPSULES[0]
            setPop((prev) => ({ n: (prev?.n ?? 0) + 1, top: won.top, bottom: won.bottom }))
            s.held = -1
            s.grip = 0
            enter('idle', now)
            setBusy(false)
            onWin()
          }
          break
        }
        case 'wobble': {
          const t = (now - s.t0) / 1000
          s.wobble = R ? 0 : 9 * Math.sin(t * 26) * Math.exp(-t * 6)
          if ((now - s.t0) >= dur(T.wobble)) {
            s.wobble = 0
            enter('idle', now)
            setBusy(false)
          }
          break
        }
      }

      // Carried capsule rides between the prongs.
      if (s.held >= 0 && (s.phase === 'rise' || s.phase === 'carry')) {
        const slot = s.slots[s.held]
        if (slot) {
          slot.x = s.x
          slot.y = CABLE_TOP + s.cableL + 24
        }
      }

      // Respawn: a won capsule comes back to the floor after a beat.
      s.slots.forEach((slot, i) => {
        if (slot.mode === 'gone' && now - slot.since > 1400) {
          slot.x = freeFloorX(i)
          slot.y = g.capY - (R ? 0 : 40)
          slot.mode = 'spawning'
          slot.since = now
        } else if (slot.mode === 'spawning') {
          const p = clamp((now - slot.since) / (R ? 120 : 380), 0, 1)
          slot.y = g.capY - (R ? 0 : 40 * (1 - easeIn(p)))
          if (p >= 1) { slot.y = g.capY; slot.mode = 'floor' }
        }
      })

      paint()
      schedule()
    }

    const schedule = () => {
      if (!raf && s.inView && !document.hidden) raf = requestAnimationFrame(step)
    }
    const kick = () => { last = 0; schedule() }

    const cab = cabinetRef.current
    const io = cab && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          s.inView = entries.some((e) => e.isIntersecting)
          if (s.inView) kick()
          else if (raf) { cancelAnimationFrame(raf); raf = 0 }
        })
      : null
    if (io && cab) io.observe(cab)
    else { s.inView = true; kick() }

    const onVis = () => { if (!document.hidden) kick() }
    document.addEventListener('visibilitychange', onVis)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      io?.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [geo, paint, freeFloorX, onWin, onMiss])

  // ── Jostle the floor on a hard scroll flick ────────────────────────────
  useEffect(() => {
    return onScrollFlick((v) => {
      const s = sim.current
      if (reducedRef.current || !s.inView) return
      const force = clamp(Math.abs(v) / 2200, 1, 2.2)
      s.slots.forEach((slot, i) => {
        if (slot.mode !== 'floor') return
        const el = capInnerRefs.current[i]
        if (!el || typeof el.animate !== 'function') return
        const dx = (Math.random() - 0.5) * 10 * force
        const dy = (4 + Math.random() * 6) * force
        const r = (Math.random() - 0.5) * 40 * force
        el.animate(
          [
            { transform: 'translate(0,0) rotate(0deg)' },
            { transform: `translate(${dx.toFixed(1)}px,${(-dy).toFixed(1)}px) rotate(${r.toFixed(1)}deg)` },
            { transform: 'translate(0,0) rotate(0deg)' },
          ],
          { duration: 520, easing: 'cubic-bezier(0.34,1.56,0.64,1)', delay: i * 30 },
        )
      })
    })
  }, [])

  // ── Controls ────────────────────────────────────────────────────────────
  const touch = () => {
    sim.current.interacted = true
  }

  const drop = useCallback(() => {
    const s = sim.current
    if (!s.ready || s.phase !== 'idle') return
    s.interacted = true
    s.dir = 0
    s.fromX = s.x
    s.toX = s.x
    // Pity: after two misses in a row, the claw's swing finds the nearest
    // capsule on the way down.
    if (s.misses >= PITY - 1) {
      let best = -1
      let bestD = Infinity
      s.slots.forEach((slot, i) => {
        if (slot.mode !== 'floor') return
        const d = Math.abs(slot.x - s.x)
        if (d < bestD) { bestD = d; best = i }
      })
      if (best >= 0) s.toX = s.slots[best]!.x
    }
    s.phase = 'descend'
    s.t0 = performance.now()
    s.grip = 0
    setBusy(true)
    setStatus('')
    sfx('whoosh')
  }, [])

  const nudge = (dir: -1 | 1, px: number) => {
    const s = sim.current
    if (!s.ready || s.phase !== 'idle') return
    touch()
    const g = geo()
    s.x = clamp(s.x + dir * px, g.xMin, g.xMax)
    paint()
  }

  const holdStart = (dir: -1 | 1) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    touch()
    sim.current.dir = dir
    nudge(dir, 4)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const holdEnd = () => {
    sim.current.dir = 0
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const s = sim.current
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      touch()
      if (s.phase === 'idle') s.dir = e.key === 'ArrowLeft' ? -1 : 1
      return
    }
    // Space/Enter on a focused button inside is that button's own click.
    if ((e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) {
      e.preventDefault()
      drop()
    }
  }
  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') sim.current.dir = 0
  }

  // Desktop (and small-target touch) drag of the carriage along the rail.
  const onCarriageDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sim.current
    if (s.phase !== 'idle' || (e.pointerType === 'mouse' && e.button !== 0)) return
    touch()
    s.dragging = true
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    e.preventDefault()
  }
  const onCarriageMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = sim.current
    const glass = glassRef.current
    if (!s.dragging || !glass || s.phase !== 'idle') return
    const r = glass.getBoundingClientRect()
    const g = geo()
    s.x = clamp(e.clientX - r.left, g.xMin, g.xMax)
    paint()
  }
  const onCarriageUp = () => {
    sim.current.dragging = false
  }

  return (
    <div
      ref={cabinetRef}
      className={c.cabinet}
      role="group"
      tabIndex={0}
      aria-label="claw machine. arrow keys move the claw, space or enter drops it."
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={holdEnd}
    >
      <div className={c.glassFrame}>
        <span className={c.marquee} aria-hidden="true">grab a prize</span>
        <div ref={glassRef} className={c.glass} aria-hidden="true">
          <span className={c.shine} />
          <span className={c.rail} />
          <div
            ref={carriageRef}
            className={c.carriage}
            data-toy="drag"
            onPointerDown={onCarriageDown}
            onPointerMove={onCarriageMove}
            onPointerUp={onCarriageUp}
            onPointerCancel={onCarriageUp}
            onLostPointerCapture={onCarriageUp}
          >
            <span className={c.carriageBody} />
          </div>
          <div ref={cableRef} className={c.cable} />
          <div ref={clawRef} className={c.claw}>
            <svg viewBox="0 0 40 38" width="40" height="38" focusable="false">
              <g ref={prongLRef}>
                <path className={c.prong} d="M17 10 C9 15 6 23 10 33 L13.5 32 C11 25 12.5 18 19 13.5 Z" />
              </g>
              <g ref={prongRRef}>
                <path className={c.prong} d="M23 10 C31 15 34 23 30 33 L26.5 32 C29 25 27.5 18 21 13.5 Z" />
              </g>
              <path className={c.prong} d="M18.4 12 H21.6 V30 L20 32.5 L18.4 30 Z" />
              <rect className={c.clawHead} x="11" y="0.5" width="18" height="10" rx="3.5" />
              <circle className={c.clawHub} cx="20" cy="5.5" r="2" />
            </svg>
          </div>

          {CAPSULES.map((cap, i) => (
            <div
              key={cap.key}
              ref={(el) => { capRefs.current[i] = el }}
              className={c.capsule}
              data-mode="floor"
            >
              <div
                ref={(el) => { capInnerRefs.current[i] = el }}
                className={c.capInner}
                style={{ ['--cap-top' as string]: cap.top, ['--cap-bottom' as string]: cap.bottom, animationDelay: `${(i * -0.47).toFixed(2)}s` }}
              >
                <span className={c.capShine} />
              </div>
            </div>
          ))}

          <div className={c.chute}>
            <span className={c.chuteLabel}>prize</span>
            {pop ? (
              <span key={pop.n} className={c.pop} style={{ ['--cap-top' as string]: pop.top, ['--cap-bottom' as string]: pop.bottom }}>
                <span className={c.popTop} />
                <span className={c.popBottom} />
                <svg className={c.popStar} viewBox="0 0 40 40" focusable="false">
                  <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
                </svg>
              </span>
            ) : null}
          </div>
          <span className={c.floor} />
        </div>
      </div>

      <div className={c.controls}>
        <div className={c.pad}>
          <button
            type="button"
            className={c.move}
            aria-label="move claw left"
            onPointerDown={holdStart(-1)}
            onPointerUp={holdEnd}
            onPointerCancel={holdEnd}
            onLostPointerCapture={holdEnd}
            onClick={(e) => { if (e.detail === 0) nudge(-1, 24) }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 5 L8 12 L15 19" />
            </svg>
          </button>
          <button
            type="button"
            className={c.move}
            aria-label="move claw right"
            onPointerDown={holdStart(1)}
            onPointerUp={holdEnd}
            onPointerCancel={holdEnd}
            onLostPointerCapture={holdEnd}
            onClick={(e) => { if (e.detail === 0) nudge(1, 24) }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 5 L16 12 L9 19" />
            </svg>
          </button>
          <button
            type="button"
            className={c.drop}
            aria-label="drop the claw"
            aria-disabled={busy || undefined}
            data-busy={busy ? 'true' : undefined}
            onClick={drop}
          >
            drop
          </button>
        </div>
        <p className={c.status}>
          {/* Only outcomes are announced; the idle hint sits outside the
              live region so each new drop does not re-read it. */}
          <span aria-live="polite" aria-atomic="true">{status}</span>
          {status ? null : <span className={c.hint}>move the claw, then drop it.</span>}
        </p>
      </div>
    </div>
  )
}
