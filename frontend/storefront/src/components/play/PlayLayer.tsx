'use client'
// PlayLayer: the one global host for the sticker hunt. Mounted once in the
// root layout, after the feedback widget. Client-only; renders nothing until
// hydrated, so the server HTML never contains any of it.
//
// It owns:
//  (a) the sticker tin (bottom-left), its streak flame, the gold 12/12 state
//      and the one-time "psst" bubble
//  (b) the collect flight: a found sticker pops, arcs into the tin and lands
//      with a wobble, a ding, a small confetti puff and a crowd cheer, then a
//      "found: …" toast
//  (c) a polite live region announcing each find
//  (d) quiet-route queueing (simmer, and the pages where the tin hides)
//  (e) the sticker book dialog
//  (f) the toy hint that trails the cursor over [data-toy]
//  (g) the first-session toy shimmer (html.play-hint for 5s)
//  (h) the daily streak touch
//
// Bus events handled here: 'collect' (flights, pops) and 'celebrate' (turned
// into celebrate() calls). 'poke' events are informational; pokes are counted
// by whoever calls usePlay().bumpPokes().

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { usePathname } from 'next/navigation'
import { StickerTin, type TinToast } from './StickerTin'
import { StickerBook } from './StickerBook'
import { StickerArt } from './StickerArt'
import { ToyHint } from './ToyHint'
import { getSticker, STICKER_COUNT, type StickerId } from '../../lib/play/stickers'
import { usePlay, PLAY_STORAGE_KEY, rehydratePlayFromStorage } from '../../lib/play/store'
import { useHydrated } from '../../lib/play/hydrated'
import { onPlay, OPEN_BOOK_EVENT, emitCrowdSignal } from '../../lib/play/bus'
import { celebrate } from '../../lib/play/celebrate'
import { buzz, sfx, armAudio } from '../../lib/play/feedback'
import { useQuiet } from '../../lib/play/quiet'
import { usePrefersReducedMotion, prefersReducedMotion } from '../../lib/play/motion'
import s from './play.module.css'

const SESSION_FLAG = 'servd-play-session'
const TOAST_MS = 2600
const INTRO_MS = 4500
const POP_MS = 140
const ARC_MS = 620

/** Pages where the tin stands down (money and auth flows). */
function isTinHiddenPath(pathname: string | null): boolean {
  if (!pathname) return false
  const p = pathname.toLowerCase()
  return /^\/[^/]+\/checkout(\/|$)/.test(p) || /^\/(login|signup|auth)(\/|$)/.test(p)
}

interface Flight {
  key: number
  id: StickerId
  x: number
  y: number
}

interface Pop {
  key: number
  x: number
  y: number
}

let seq = 0
const nextKey = () => ++seq

export function PlayLayer() {
  const hydrated = useHydrated()
  if (!hydrated) return null
  return <PlayLayerInner />
}

function PlayLayerInner() {
  const pathname = usePathname()
  const quiet = useQuiet()
  const reduced = usePrefersReducedMotion()
  const suppressed = quiet || isTinHiddenPath(pathname)

  const count = usePlay((st) => Object.keys(st.stickers).length)
  const streak = usePlay((st) => st.streak.count)
  const introSeen = usePlay((st) => st.introSeen)
  const partied = usePlay((st) => st.partied)

  const tinRef = useRef<HTMLButtonElement | null>(null)
  const [flights, setFlights] = useState<Flight[]>([])
  const [pending, setPending] = useState<StickerId[]>([])
  const [pops, setPops] = useState<Pop[]>([])
  const [toasts, setToasts] = useState<TinToast[]>([])
  const [announce, setAnnounce] = useState('')
  const [wobbleKey, setWobbleKey] = useState(0)
  const [bookOpen, setBookOpen] = useState(false)
  const [intro, setIntro] = useState(false)

  // Refs mirror the bits event handlers need without re-subscribing.
  const suppressedRef = useRef(suppressed)
  suppressedRef.current = suppressed
  const inFlight = useRef(0)
  const queued = useRef(0)
  queued.current = pending.length
  inFlight.current = flights.length

  // The badge counts stickers that have landed, not ones still in the air.
  const shown = Math.max(0, count - flights.length - pending.length)
  const gold = shown >= STICKER_COUNT

  // (h) streak, audio arming, cross-tab sync
  useEffect(() => {
    usePlay.getState().touchStreak()
    armAudio()
    const onStorage = (e: StorageEvent) => {
      if (e.key === PLAY_STORAGE_KEY) rehydratePlayFromStorage()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const launch = useCallback((id: StickerId, x?: number, y?: number) => {
    const px = x ?? window.innerWidth / 2
    const py = y ?? window.innerHeight / 2
    setFlights((f) => [...f, { key: nextKey(), id, x: px, y: py }])
  }, [])

  // (b)(d) collect events
  useEffect(() => {
    return onPlay((e) => {
      if (e.type === 'collect') {
        if (e.fresh) {
          if (suppressedRef.current) setPending((q) => [...q, e.id])
          else launch(e.id, e.x, e.y)
        } else if (!suppressedRef.current && e.x != null && e.y != null && !prefersReducedMotion()) {
          const key = nextKey()
          setPops((p) => [...p, { key, x: e.x as number, y: e.y as number }])
          window.setTimeout(() => setPops((p) => p.filter((q) => q.key !== key)), 400)
        }
      } else if (e.type === 'celebrate') {
        void celebrate({ x: e.x, y: e.y, palette: e.palette, power: e.power })
      }
    })
  }, [launch])

  // (d) flush finds queued on a quiet page once we are somewhere loud again.
  useEffect(() => {
    if (suppressed || pending.length === 0) return
    // Each queued find stays counted as pending until its own flight leaves,
    // so the badge never jumps ahead of the stickers still to land.
    const timers = pending.map((id, i) =>
      window.setTimeout(() => {
        setPending((q) => {
          const at = q.indexOf(id)
          return at === -1 ? q : [...q.slice(0, at), ...q.slice(at + 1)]
        })
        launch(id)
      }, 500 + i * 320),
    )
    return () => timers.forEach((t) => window.clearTimeout(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suppressed])

  const land = useCallback((f: Flight) => {
    setFlights((list) => list.filter((q) => q.key !== f.key))
    setWobbleKey((k) => k + 1)
    buzz(15)
    sfx('ding')
    const r = tinRef.current?.getBoundingClientRect()
    void celebrate({
      x: r ? r.left + r.width / 2 : 40,
      y: r ? r.top + r.height / 2 : window.innerHeight - 40,
      palette: 'servd',
      power: 'small',
    })
    emitCrowdSignal({ type: 'cheer' })
    const total = Object.keys(usePlay.getState().stickers).length
    const n = Math.max(1, total - (inFlight.current - 1) - queued.current)
    // Two landings in one frame: the second must not count the first as airborne.
    inFlight.current = Math.max(0, inFlight.current - 1)
    const name = getSticker(f.id).name
    setToasts((t) => [...t, { key: nextKey(), id: f.id, text: `found: ${name} · ${n}/${STICKER_COUNT}` }])
    setAnnounce(`sticker found: ${name}. ${n} of ${STICKER_COUNT}.`)
  }, [])

  // Toasts show one at a time.
  const toast = toasts[0] ?? null
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToasts((q) => q.slice(1)), TOAST_MS)
    return () => window.clearTimeout(t)
  }, [toast])

  // (a) 12/12: gold tin, the whole crowd parties. Once, ever.
  useEffect(() => {
    if (!gold || partied || suppressed) return
    usePlay.getState().markPartied()
    emitCrowdSignal({ type: 'party' })
    void celebrate({ power: 'big' })
    setAnnounce(`all ${STICKER_COUNT} stickers found. the tin is gold.`)
  }, [gold, partied, suppressed])

  // (a) the one-time "psst" bubble
  useEffect(() => {
    if (introSeen || suppressed) return
    const show = window.setTimeout(() => {
      usePlay.getState().markIntroSeen()
      setIntro(true)
    }, 900)
    return () => window.clearTimeout(show)
  }, [introSeen, suppressed])
  useEffect(() => {
    if (!intro) return
    const t = window.setTimeout(() => setIntro(false), INTRO_MS)
    return () => window.clearTimeout(t)
  }, [intro])

  // (e) book: open from anywhere, close on navigation or when the tin hides.
  useEffect(() => {
    const open = () => {
      if (suppressedRef.current) return
      setIntro(false)
      setBookOpen(true)
    }
    window.addEventListener(OPEN_BOOK_EVENT, open)
    return () => window.removeEventListener(OPEN_BOOK_EVENT, open)
  }, [])
  useEffect(() => {
    setBookOpen(false)
  }, [pathname])
  useEffect(() => {
    if (suppressed) {
      setBookOpen(false)
      setIntro(false)
    }
  }, [suppressed])

  // (g) first-session toy shimmer, on the first page of the first session.
  useEffect(() => {
    let first = false
    try {
      first = window.sessionStorage.getItem(SESSION_FLAG) == null
      window.sessionStorage.setItem(SESSION_FLAG, '1')
    } catch {
      first = false
    }
    if (!first || prefersReducedMotion() || suppressedRef.current) return
    const html = document.documentElement
    html.classList.add('play-hint')
    const t = window.setTimeout(() => html.classList.remove('play-hint'), 5000)
    return () => {
      window.clearTimeout(t)
      html.classList.remove('play-hint')
    }
  }, [])

  return (
    <div className={s.root}>
      {!suppressed && (
        <StickerTin
          buttonRef={tinRef}
          count={shown}
          total={STICKER_COUNT}
          streak={streak}
          gold={gold}
          wobbleKey={wobbleKey}
          reduced={reduced}
          toast={toast}
          intro={intro}
          onDismissIntro={() => setIntro(false)}
          onOpen={() => {
            setIntro(false)
            setBookOpen(true)
          }}
        />
      )}

      {flights.map((f) => (
        <FlyingSticker key={f.key} flight={f} tinRef={tinRef} reduced={reduced} onLand={land} />
      ))}

      {pops.map((p) => (
        <span key={p.key} className={s.pop} style={{ left: p.x, top: p.y }} aria-hidden="true" />
      ))}

      <StickerBook
        open={bookOpen && !suppressed}
        onClose={() => setBookOpen(false)}
        reduced={reduced}
        returnFocusRef={tinRef}
      />

      {!quiet && <ToyHint reduced={reduced} />}

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
    </div>
  )
}

// ── the flight ─────────────────────────────────────────────────────────────

function tf(x: number, y: number, rot: number, scale: number): string {
  return `translate(${(x - 32).toFixed(1)}px, ${(y - 32).toFixed(1)}px) rotate(${rot.toFixed(1)}deg) scale(${scale.toFixed(3)})`
}

function FlyingSticker({
  flight,
  tinRef,
  reduced,
  onLand,
}: {
  flight: Flight
  tinRef: RefObject<HTMLButtonElement>
  reduced: boolean
  onLand: (f: Flight) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const landed = useRef(false)

  useEffect(() => {
    const el = ref.current
    const finish = () => {
      if (landed.current) return
      landed.current = true
      onLand(flight)
    }
    const r = tinRef.current?.getBoundingClientRect()
    if (!el || !r || typeof el.animate !== 'function') {
      finish()
      return
    }
    const x1 = r.left + r.width / 2
    const y1 = r.top + r.height / 2
    let anim: Animation

    if (reduced) {
      // Calm: the sticker simply appears at the tin and fades into it.
      anim = el.animate(
        [
          { transform: tf(x1, y1 - r.height, 0, 0.6), opacity: 0 },
          { transform: tf(x1, y1 - r.height, 0, 0.6), opacity: 1, offset: 0.25 },
          { transform: tf(x1, y1 - r.height, 0, 0.6), opacity: 1, offset: 0.75 },
          { transform: tf(x1, y1 - r.height, 0, 0.6), opacity: 0 },
        ],
        { duration: 480, easing: 'linear', fill: 'forwards' },
      )
    } else {
      const { x: x0, y: y0 } = flight
      const total = POP_MS + ARC_MS
      const dist = Math.hypot(x1 - x0, y1 - y0)
      const lift = Math.min(220, Math.max(80, dist * 0.3))
      const yc = Math.min(y0, y1) - lift
      const frames: Keyframe[] = [
        { transform: tf(x0, y0, 0, 1), offset: 0 },
        { transform: tf(x0, y0, 0, 1.25), offset: POP_MS / total, easing: 'linear' },
      ]
      const N = 18
      for (let i = 1; i <= N; i++) {
        const t = i / N
        const x = x0 + (x1 - x0) * (1 - (1 - t) * (1 - t)) // linear-out
        const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * yc + t * t * y1 // gravity arc
        const scale = 1.25 + (0.42 - 1.25) * t
        frames.push({ transform: tf(x, y, 360 * t, scale), offset: (POP_MS + ARC_MS * t) / total })
      }
      anim = el.animate(frames, { duration: total, easing: 'linear', fill: 'forwards' })
    }
    anim.onfinish = finish
    // Safety net: a background tab can stall WAAPI; never lose a toast.
    const guard = window.setTimeout(finish, 1500)
    return () => {
      // No finish() here: under StrictMode the effect re-runs and simply
      // starts the flight again. A flight only unmounts by landing.
      window.clearTimeout(guard)
      anim.onfinish = null
      anim.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={ref}
      className={s.flight}
      style={{ transform: tf(flight.x, flight.y, 0, 1), opacity: reduced ? 0 : 1 }}
      aria-hidden="true"
    >
      <StickerArt id={flight.id} size={64} />
    </div>
  )
}

export default PlayLayer
