// Browser side of block scroll effects (block.motion). No React: used by
// MotionRuntime (live pages) and the editor frame (preview slider).
//
// 1. Reach guard — every browser. A preset whose range end the page can never
//    scroll to (a pin-reveal near the bottom) would stay part-way forever, so
//    its wrapper gets data-sv-motion-off and motion.css drops the animation:
//    natural, fully visible content.
// 2. Fallback engine — only where CSS scroll-driven animations are missing.
//    It drives the SAME @keyframes: marks a wrapper data-sv-motion-ready (which
//    applies a paused 1000 ms animation) and sets currentTime = progress·1000,
//    progress computed with lib/motion.ts rangeProgress (the JS mirror of the
//    CSS ranges). Before the mark nothing animates, so no-JS = full content.
// Neither runs under prefers-reduced-motion (motion.css shows everything
// natural there); both follow the media query live.

import { MOTION_SPECS, normalizeMotion, rangeProgress, rangeSpan, type MotionSpec, type NormalizedMotion } from '../../lib/motion'

const WRAPPER = '.sv-motion[data-sv-motion]'
const READY = 'data-sv-motion-ready'
const OFF = 'data-sv-motion-off'
const SCRUB = 'data-sv-m-scrub'

/** CSS scroll-driven animations (view timelines) are available. */
export function supportsScrollTimeline(): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timeline: view()')
  } catch {
    return false
  }
}

function specOf(w: Element): { m: NormalizedMotion; spec: MotionSpec } | null {
  const el = w as HTMLElement
  const m = normalizeMotion({ preset: el.dataset['svMotion'], intensity: el.dataset['svIntensity'] })
  return m ? { m, spec: MOTION_SPECS[m.preset] } : null
}

/** The element that moves: `.sv-motion > .sv-motion-target`, or the target
 *  inside the pin. Never a nested block's target. */
export function targetOf(w: Element): HTMLElement | null {
  for (const c of Array.from(w.children)) {
    if (c.classList.contains('sv-motion-target')) return c as HTMLElement
    if (c.classList.contains('sv-motion-pin')) {
      const t = Array.from(c.children).find((x) => x.classList.contains('sv-motion-target'))
      if (t) return t as HTMLElement
    }
  }
  return null
}

function motionAnimation(target: Element): Animation | null {
  if (typeof (target as HTMLElement).getAnimations !== 'function') return null
  return target.getAnimations().find((a) => {
    const name = (a as CSSAnimation).animationName
    return typeof name === 'string' && name.startsWith('sv-m-')
  }) ?? null
}

const clamp01 = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p)

// ── Engine ─────────────────────────────────────────────────────────────────

let refs = 0
let enabled = false
let fallback = false
let reduceMql: MediaQueryList | null = null
let io: IntersectionObserver | null = null
let mo: MutationObserver | null = null
let ro: ResizeObserver | null = null
const observed = new Set<HTMLElement>()
const active = new Set<HTMLElement>()
let scanFrame = 0
let updateFrame = 0

const reduced = () => !!reduceMql?.matches

/** Ref-counted: every MotionRuntime on the page starts it once. */
export function startMotionEngine(): void {
  if (typeof window === 'undefined') return
  refs += 1
  if (refs > 1) return
  reduceMql = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  reduceMql?.addEventListener?.('change', onPreference)
  if (!reduced()) enable()
}

export function stopMotionEngine(): void {
  if (refs === 0) return
  refs -= 1
  if (refs > 0) return
  disable()
  reduceMql?.removeEventListener?.('change', onPreference)
  reduceMql = null
}

/** Recompute progress on the next frame (e.g. after a preview ends). */
export function requestMotionUpdate(): void {
  if (!enabled || updateFrame) return
  updateFrame = requestAnimationFrame(runUpdate)
}

function onPreference() {
  if (reduced()) disable()
  else enable()
}

function enable() {
  if (enabled || typeof document === 'undefined' || !document.body) return
  enabled = true
  fallback = !supportsScrollTimeline()
  if (fallback && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(onIntersect, { rootMargin: '50% 0px' })
  }
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(scheduleScan)
    mo.observe(document.body, { childList: true, subtree: true })
  }
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(scheduleScan)
    ro.observe(document.body)
  }
  window.addEventListener('resize', scheduleScan, { passive: true })
  if (fallback) window.addEventListener('scroll', requestMotionUpdate, { passive: true })
  scan()
}

function disable() {
  if (!enabled) return
  enabled = false
  io?.disconnect(); io = null
  mo?.disconnect(); mo = null
  ro?.disconnect(); ro = null
  window.removeEventListener('resize', scheduleScan)
  window.removeEventListener('scroll', requestMotionUpdate)
  if (scanFrame) cancelAnimationFrame(scanFrame)
  if (updateFrame) cancelAnimationFrame(updateFrame)
  scanFrame = 0
  updateFrame = 0
  for (const w of observed) {
    w.removeAttribute(READY)
    w.removeAttribute(OFF)
  }
  observed.clear()
  active.clear()
}

function scheduleScan() {
  if (!enabled || scanFrame) return
  scanFrame = requestAnimationFrame(() => {
    scanFrame = 0
    scan()
  })
}

function scan() {
  if (!enabled) return
  const seen = new Set<HTMLElement>()
  document.querySelectorAll<HTMLElement>(WRAPPER).forEach((w) => {
    seen.add(w)
    if (!observed.has(w)) {
      observed.add(w)
      io?.observe(w)
    }
  })
  for (const w of observed) {
    if (!seen.has(w)) {
      io?.unobserve(w)
      observed.delete(w)
      active.delete(w)
    }
  }
  guard()
  if (fallback) {
    // Without an IntersectionObserver every wrapper counts as active.
    if (!io) for (const w of observed) active.add(w)
    requestMotionUpdate()
  }
}

function onIntersect(entries: IntersectionObserverEntry[]) {
  const leaving: HTMLElement[] = []
  for (const e of entries) {
    const w = e.target as HTMLElement
    if (e.isIntersecting) active.add(w)
    else if (active.delete(w)) leaving.push(w)
  }
  // A wrapper leaving gets one last update so it isn't left mid-way.
  if (leaving.length) apply(leaving)
  requestMotionUpdate()
}

function runUpdate() {
  updateFrame = 0
  if (!enabled || !fallback) return
  apply(Array.from(active))
}

/** Reads every rect first, then writes, so a long page doesn't thrash layout. */
function apply(list: HTMLElement[]) {
  const V = window.innerHeight
  const plan: Array<{ w: HTMLElement; target: HTMLElement; p: number }> = []
  for (const w of list) {
    if (!w.isConnected || w.hasAttribute(SCRUB) || w.hasAttribute(OFF)) continue
    const s = specOf(w)
    const range = s?.spec.keyframes ? s.spec.range?.[s.m.intensity] : null
    const target = range ? targetOf(w) : null
    if (!range || !target) continue
    const r = w.getBoundingClientRect()
    plan.push({ w, target, p: rangeProgress(range, r.top, r.height, V) })
  }
  for (const { w, target, p } of plan) {
    if (!w.hasAttribute(READY)) w.setAttribute(READY, '')
    const a = motionAnimation(target)
    if (a) a.currentTime = p * 1000
  }
}

/** Switch off presets whose range end this page can never scroll to. */
function guard() {
  const V = window.innerHeight
  const sy = window.scrollY
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - V)
  const plan: Array<{ w: HTMLElement; off: boolean }> = []
  for (const w of observed) {
    const s = specOf(w)
    const range = s?.spec.reachEnd ? s.spec.range?.[s.m.intensity] : null
    if (!range) { plan.push({ w, off: false }); continue }
    const r = w.getBoundingClientRect()
    const docTop = r.top + sy
    const sMax = V - (docTop - maxScroll)
    const [, s1] = rangeSpan(range, r.height, V)
    plan.push({ w, off: sMax < s1 - 1 })
  }
  for (const { w, off } of plan) {
    if (off && !w.hasAttribute(OFF)) w.setAttribute(OFF, '')
    else if (!off && w.hasAttribute(OFF)) w.removeAttribute(OFF)
  }
}

// ── Editor preview (only inside /editor-frame) ─────────────────────────────

/** Show the effect at `p` (0 = start state, 1 = end state) on this wrapper,
 *  whatever the scroll position. false when there is nothing to scrub. */
export function setScrubProgress(wrapper: HTMLElement, p: number): boolean {
  if (!wrapper.hasAttribute(SCRUB)) wrapper.setAttribute(SCRUB, '')
  const target = targetOf(wrapper)
  // getAnimations() after the attribute: it recalculates style, so the scrub
  // rule's paused animation is the one returned.
  const a = target ? motionAnimation(target) : null
  if (!a) return false
  a.currentTime = clamp01(p) * 1000
  return true
}

/** Back to the scroll-driven state. */
export function clearScrub(wrapper: HTMLElement): void {
  wrapper.removeAttribute(SCRUB)
  requestMotionUpdate()
}

/** sticky-stack: scroll the page so its stack is `p` of the way through —
 *  0 = the first card has reached its sticky top, 1 = the stack releases. */
export function scrollStackTo(wrapper: HTMLElement, p: number): boolean {
  const group = wrapper.closest('.sv-stack')
  if (!group) return false
  const first = (group.querySelector('.sv-stack-card[data-sv-stack-first]') ?? group.querySelector('.sv-stack-card')) as HTMLElement | null
  if (!first) return false
  const g = group.getBoundingClientRect()
  const stickyTop = parseFloat(getComputedStyle(first).top) || 0
  const start = g.top + window.scrollY - stickyTop
  const end = start + Math.max(0, g.height - first.getBoundingClientRect().height)
  window.scrollTo({ top: start + clamp01(p) * (end - start), behavior: 'instant' })
  return true
}
