'use client'

/**
 * FoodCrowd — a row of procedural 3D food characters (three.js) whose eyes
 * follow the cursor anywhere on the page, and a toy: poke them (combos), grab
 * and throw them (mouse / pen), double-tap to launch one (touch). Pokes and
 * tosses feed the sticker tin (`@/lib/play`).
 *
 * The component fills its parent box; the parent sets the size. The canvas
 * is transparent, so the stage colour behind it shows through. The canvas
 * host is aria-hidden; the keyboard "poke the food crowd" button is not. When
 * a caller wraps the crowd in its own aria-hidden box, the button is portalled
 * next to that box so it never sits focusable inside a hidden subtree.
 *
 * three.js is imported lazily inside an effect: nothing touches window or
 * WebGL during SSR, and without WebGL the component quietly renders nothing.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type * as React from 'react'
import { createPortal } from 'react-dom'
import { buzz, celebrate, collect, emitPlay, sfx, usePlay } from '@/lib/play'
import { emitCrowd, onCrowd } from './crowdBus'
import { isCharacterKind, type CharacterKind } from './types'
import type { CrowdEngine } from './engine'

export type { CharacterKind } from './types'

export interface FoodCrowdHandle {
  /** One character (or all when omitted) does a happy jump + squash. `big` = higher, spinning, neighbours join. */
  cheer(kind?: CharacterKind, big?: boolean): void
  /** The whole crowd throws a party. */
  party(): void
}

export interface FoodCrowdProps {
  /** Left→right order. Default ['fries','burger','coffee','sandwich','shake','croissant']. */
  cast?: CharacterKind[]
  /** 0..1 — lean toward the cursor harder, bounce faster, eyes widen. */
  excitement?: number
  className?: string
  /** The component fills its parent box (width/height 100%); the parent sizes it. */
  style?: React.CSSProperties
  /** Fired once the cast is on stage (first populated frame). */
  onReady?: () => void
  /** Poke, grab/throw and the keyboard poke. Default true. */
  interactive?: boolean
  /** Render the visually hidden, focusable "poke the food crowd" button. Default true. */
  keyboardPoke?: boolean
  /** A character was poked; `combo` counts pokes less than 1.2s apart (resets after 8). */
  onPoke?: (kind: CharacterKind, combo: number) => void
}

const DEFAULT_CAST: CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']

/** Motion vocabulary: "jelly" overshoot. */
const JELLY = 'cubic-bezier(0.34,1.56,0.64,1)'

const HOST_STYLE: React.CSSProperties = { position: 'absolute', inset: 0 }

const CHIP_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  zIndex: 2,
  pointerEvents: 'none',
  opacity: 0,
  padding: '4px 11px 5px',
  borderRadius: 999,
  background: 'var(--party-butter, #FFD447)',
  color: 'var(--party-ink, #2A1A2B)',
  border: '2px solid var(--party-ink, #2A1A2B)',
  boxShadow: '2px 3px 0 var(--party-ink, #2A1A2B)',
  fontFamily: 'var(--font-display, "Bricolage Grotesque", system-ui, sans-serif)',
  fontWeight: 800,
  fontSize: 18,
  lineHeight: 1,
  letterSpacing: '-0.01em',
  whiteSpace: 'nowrap',
  transform: 'translate(-50%, -140%)',
  willChange: 'transform, opacity',
}

const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
}

const POKE_PILL: React.CSSProperties = {
  position: 'absolute',
  zIndex: 6,
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  padding: '0 16px',
  margin: 0,
  borderRadius: 999,
  background: 'var(--party-butter, #FFD447)',
  color: 'var(--party-ink, #2A1A2B)',
  border: '2px solid var(--party-ink, #2A1A2B)',
  boxShadow: '2px 3px 0 var(--party-ink, #2A1A2B)',
  fontFamily: 'var(--font-display, "Bricolage Grotesque", system-ui, sans-serif)',
  fontWeight: 700,
  fontSize: 15,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  outline: '3px solid var(--party-plum, #4E2A4F)',
  outlineOffset: 2,
}

function prefersReduced(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

/** The outermost aria-hidden ancestor of `el`, if any. */
function hiddenAncestor(el: HTMLElement): HTMLElement | null {
  let top: HTMLElement | null = null
  let cur = el.parentElement?.closest<HTMLElement>('[aria-hidden="true"]') ?? null
  while (cur) {
    top = cur
    cur = cur.parentElement?.closest<HTMLElement>('[aria-hidden="true"]') ?? null
  }
  return top
}

const play = (fn: () => void) => {
  try {
    fn()
  } catch {
    /* the sticker economy is decorative; never break the crowd */
  }
}

export const FoodCrowd = forwardRef<FoodCrowdHandle, FoodCrowdProps>(function FoodCrowd(
  { cast, excitement = 0, className, style, onReady, interactive = true, keyboardPoke = true, onPoke },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLSpanElement>(null)
  const chipAnim = useRef<Animation | null>(null)
  const chipTimer = useRef(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const liveRef = useRef<HTMLSpanElement>(null)
  const fromKey = useRef(false)
  const engineRef = useRef<CrowdEngine | null>(null)
  /** Engine is up (WebGL present) — only then is there anything to poke. */
  const [armed, setArmed] = useState(false)
  /** Where the keyboard button lives when the crowd sits inside a caller's aria-hidden box. */
  const [portalTo, setPortalTo] = useState<HTMLElement | null>(null)
  const [focused, setFocused] = useState(false)
  const [pillAt, setPillAt] = useState<{ left: number; top: number }>({ left: 10, top: 10 })

  const castKey = (cast && cast.length ? cast : DEFAULT_CAST).filter(isCharacterKind).join(',')
  const latest = useRef({ castKey, excitement, onReady, onPoke })
  latest.current = { castKey, excitement, onReady, onPoke }
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive

  /* ---------------- combo chip (imperative: no re-render per poke) ---------------- */
  const showChip = useCallback((n: number, clientX: number, clientY: number) => {
    const chip = chipRef.current
    const wrap = wrapRef.current
    if (!chip || !wrap || n < 2) return
    const r = wrap.getBoundingClientRect()
    const x = Math.min(Math.max(clientX - r.left, 28), Math.max(28, r.width - 28))
    const y = Math.min(Math.max(clientY - r.top, 44), Math.max(44, r.height))
    chip.textContent = `x${n}`
    chip.style.left = `${x}px`
    chip.style.top = `${y}px`
    chipAnim.current?.cancel()
    window.clearTimeout(chipTimer.current)
    const rot = (Math.random() * 2 - 1) * 9
    if (typeof chip.animate !== 'function') {
      chip.style.opacity = '1'
      chipTimer.current = window.setTimeout(() => {
        chip.style.opacity = '0'
      }, 600)
      return
    }
    const at = `translate(-50%, -140%) rotate(${rot.toFixed(1)}deg)`
    chipAnim.current = prefersReduced()
      ? // still: a quick cross-fade in and out, no movement
        chip.animate(
          [
            { opacity: 0, transform: at },
            { opacity: 1, transform: at, offset: 0.15 },
            { opacity: 1, transform: at, offset: 0.85 },
            { opacity: 0, transform: at },
          ],
          { duration: 700, fill: 'forwards' },
        )
      : // pop over 380ms on the jelly curve, hold, float off
        chip.animate(
          [
            { opacity: 0, transform: `translate(-50%, -100%) rotate(${rot.toFixed(1)}deg) scale(0.3)`, easing: JELLY },
            { opacity: 1, transform: `${at} scale(1)`, offset: 0.54 },
            { opacity: 1, transform: `${at} scale(1)`, offset: 0.74, easing: 'ease-in' },
            { opacity: 0, transform: `translate(-50%, -175%) rotate(${rot.toFixed(1)}deg) scale(0.92)` },
          ],
          { duration: 700, fill: 'forwards' },
        )
  }, [])

  /* ---------------- engine callbacks → sticker economy ---------------- */
  const handlePoke = useCallback(
    (kind: CharacterKind, combo: number, x: number, y: number) => {
      play(() => {
        usePlay.getState().bumpPokes()
      })
      play(() => {
        collect('crowd-poke', { x, y })
      })
      play(() => buzz(10))
      play(() => sfx('pop'))
      play(() => emitPlay({ type: 'poke', source: 'crowd', x, y }))
      play(() => showChip(combo, x, y))
      if (fromKey.current && liveRef.current) liveRef.current.textContent = combo >= 2 ? `combo ${combo}` : ''
      if (combo >= 8) {
        emitCrowd({ type: 'party' })
        play(() => {
          void celebrate({ x, y, power: 'small' }).catch(() => {})
        })
      }
      play(() => latest.current.onPoke?.(kind, combo))
    },
    [showChip],
  )

  const handleToss = useCallback((x: number, y: number) => {
    play(() => {
      collect('crowd-toss', { x, y })
    })
    play(() => sfx('whoosh'))
  }, [])

  // Mount the engine once; three.js is code-split and loaded client-side only.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    import('./engine')
      .then(({ createCrowdEngine }) => {
        if (cancelled) return
        try {
          engineRef.current = createCrowdEngine(host, {
            cast: latest.current.castKey.split(',').filter(isCharacterKind),
            excitement: latest.current.excitement,
            interactive: interactiveRef.current,
            onFirstFrame: () => latest.current.onReady?.(),
            onPoke: handlePoke,
            onToss: handleToss,
          })
        } catch {
          engineRef.current = null
        }
        if (engineRef.current && !cancelled) setArmed(true)
      })
      .catch(() => {
        /* chunk failed to load — stay decorative-empty */
      })
    return () => {
      cancelled = true
      try {
        engineRef.current?.dispose()
      } catch {
        /* ignore */
      }
      engineRef.current = null
      chipAnim.current?.cancel()
      window.clearTimeout(chipTimer.current)
    }
  }, [handlePoke, handleToss])

  useEffect(() => {
    engineRef.current?.setCast(castKey.split(',').filter(isCharacterKind))
  }, [castKey])

  useEffect(() => {
    engineRef.current?.setExcitement(excitement)
  }, [excitement])

  useEffect(() => {
    engineRef.current?.setInteractive(interactive)
  }, [interactive, armed])

  // Page-wide bus: add-to-cart, sticker finds etc. can make the crowd react.
  useEffect(
    () =>
      onCrowd((e) => {
        const engine = engineRef.current
        if (!engine) return
        if (e.type === 'cheer') engine.cheer(e.kind, e.big === true)
        else if (e.type === 'party') engine.party()
        else if (e.type === 'look' && Number.isFinite(e.x) && Number.isFinite(e.y)) engine.look(e.x, e.y)
      }),
    [],
  )

  useImperativeHandle(
    ref,
    () => ({
      cheer: (kind?: CharacterKind, big?: boolean) => engineRef.current?.cheer(kind, big === true),
      party: () => engineRef.current?.party(),
    }),
    [],
  )

  /* ---------------- keyboard poke ---------------- */
  const showKey = armed && interactive && keyboardPoke

  // A caller that wraps the crowd in aria-hidden would hide a focusable
  // button; move it just outside that box instead.
  useEffect(() => {
    if (!showKey) return
    const wrap = wrapRef.current
    if (!wrap) return
    const hidden = hiddenAncestor(wrap)
    setPortalTo(hidden?.parentElement ?? null)
  }, [showKey])

  /** Pin the pill to the crowd box's top-left, whichever box it lives in. */
  const placePill = useCallback(() => {
    const btn = btnRef.current
    const wrap = wrapRef.current
    if (!btn || !wrap) return
    const op = btn.offsetParent as HTMLElement | null
    const wr = wrap.getBoundingClientRect()
    let left = 10
    let top = 10
    if (op && op !== wrap) {
      if (op === document.body || op === document.documentElement) {
        left = wr.left + window.scrollX + 10
        top = wr.top + window.scrollY + 10
      } else {
        const or = op.getBoundingClientRect()
        left = wr.left - or.left - op.clientLeft + op.scrollLeft + 10
        top = wr.top - or.top - op.clientTop + op.scrollTop + 10
      }
    }
    setPillAt((p) => (Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top }))
  }, [])

  useEffect(() => {
    if (!showKey || !portalTo) return
    placePill()
    window.addEventListener('resize', placePill)
    return () => window.removeEventListener('resize', placePill)
  }, [showKey, portalTo, placePill])

  const onKeyClick = useCallback(() => {
    const engine = engineRef.current
    const btn = btnRef.current
    if (!engine || !btn) return
    const r = btn.getBoundingClientRect()
    fromKey.current = true
    try {
      engine.keyPoke(r.left + r.width / 2, r.top + r.height / 2)
    } finally {
      fromKey.current = false
    }
  }, [])

  const keyButton = showKey ? (
    <>
      <button
        ref={btnRef}
        type="button"
        className="sr-only-focusable"
        aria-label="poke the food crowd"
        title="press twice quickly to launch one"
        onClick={onKeyClick}
        onKeyDown={(e) => {
          // a held Enter would machine-gun pokes; one per press
          if (e.repeat && e.key === 'Enter') e.preventDefault()
        }}
        onFocus={() => {
          placePill()
          setFocused(true)
        }}
        onBlur={() => setFocused(false)}
        style={focused ? { ...POKE_PILL, left: pillAt.left, top: pillAt.top } : { ...SR_ONLY, left: pillAt.left, top: pillAt.top }}
      >
        poke the food crowd
      </button>
      <span ref={liveRef} role="status" aria-live="polite" style={SR_ONLY} />
    </>
  ) : null

  return (
    <div ref={wrapRef} className={className} style={{ position: 'relative', width: '100%', height: '100%', ...style }}>
      <div ref={hostRef} aria-hidden="true" style={HOST_STYLE} />
      <span ref={chipRef} aria-hidden="true" style={CHIP_STYLE} />
      {keyButton && (portalTo ? createPortal(keyButton, portalTo) : keyButton)}
    </div>
  )
})

FoodCrowd.displayName = 'FoodCrowd'

export default FoodCrowd
