// Scroll effects for blocks (`block.motion`, D4 stage 1) — the ONE table of
// what each preset does. Isomorphic on purpose (no 'use client', no server-only
// imports): the server wrapper (components/blocks/Motion.tsx), the client
// fallback engine (components/blocks/motionClient.ts) and the editor frame all
// read it. The @keyframes it names live in components/blocks/motion.css.
//
// Every preset's NON-animated state is the natural, fully visible element, so
// whenever the animation is not applied (reduced motion, an unknown preset, a
// browser without scroll timelines and no JS) the block looks exactly like a
// block without motion. Presets that start hidden (fade, grow, side-pan,
// text-reveal) reach their natural state by `entry 100%`, which every block
// can reach (its bottom meets the viewport bottom at the latest at max scroll).

import {
  MOTION_INTENSITIES, MOTION_PRESETS,
  type Block, type MotionIntensity, type MotionPreset,
} from './blocks'

export type RangeName = 'cover' | 'entry' | 'exit' | 'contain' | 'entry-crossing' | 'exit-crossing'
export type RangeEdge = { name: RangeName; pct: number } | { name: RangeName; vh: number }

export interface MotionSpec {
  /** @keyframes name in motion.css; null = no animation (sticky-stack). */
  keyframes: string | null
  structure: 'plain' | 'pin' | 'stack'
  /** Editor preview: play the effect on the element, or scroll the page. */
  scrub: 'in-place' | 'scroll'
  range: Record<MotionIntensity, [RangeEdge, RangeEdge]> | null
  /** Inline custom properties per strength. */
  vars: Record<MotionIntensity, Record<string, string>>
  /** The end of the range must be reachable or the effect is switched off
   *  (the content would otherwise stay part-way, e.g. inset-clipped). False
   *  for parallax: it is a continuous drift whose rest state is mid-range. */
  reachEnd: boolean
}

export type NormalizedMotion = { preset: MotionPreset; intensity: MotionIntensity }

const all = <T,>(v: T): Record<MotionIntensity, T> => ({ subtle: v, medium: v, strong: v })
const pct = (name: RangeName, p: number): RangeEdge => ({ name, pct: p })
const vh = (name: RangeName, v: number): RangeEdge => ({ name, vh: v })

export const MOTION_SPECS: Record<MotionPreset, MotionSpec> = {
  parallax: {
    keyframes: 'sv-m-parallax', structure: 'plain', scrub: 'in-place', reachEnd: false,
    range: all([pct('cover', 0), pct('cover', 100)]),
    vars: { subtle: { '--sv-m-y': '24px' }, medium: { '--sv-m-y': '56px' }, strong: { '--sv-m-y': '112px' } },
  },
  fade: {
    keyframes: 'sv-m-fade', structure: 'plain', scrub: 'in-place', reachEnd: true,
    range: {
      subtle: [pct('entry', 0), pct('entry', 60)],
      medium: [pct('entry', 0), pct('entry', 100)],
      strong: [pct('entry', 0), pct('entry', 100)],
    },
    vars: { subtle: { '--sv-m-o0': '0.45' }, medium: { '--sv-m-o0': '0.15' }, strong: { '--sv-m-o0': '0' } },
  },
  grow: {
    keyframes: 'sv-m-grow', structure: 'plain', scrub: 'in-place', reachEnd: true,
    range: all([pct('entry', 0), pct('entry', 100)]),
    vars: { subtle: { '--sv-m-s0': '0.94' }, medium: { '--sv-m-s0': '0.86' }, strong: { '--sv-m-s0': '0.72' } },
  },
  'pin-reveal': {
    keyframes: 'sv-m-reveal', structure: 'pin', scrub: 'in-place', reachEnd: true,
    range: {
      subtle: [pct('exit-crossing', 0), vh('exit-crossing', 40)],
      medium: [pct('exit-crossing', 0), vh('exit-crossing', 70)],
      strong: [pct('exit-crossing', 0), vh('exit-crossing', 110)],
    },
    vars: {
      subtle: { '--sv-m-track': '40vh', '--sv-m-inset': '5% 3%', '--sv-m-radius': '16px' },
      medium: { '--sv-m-track': '70vh', '--sv-m-inset': '10% 7%', '--sv-m-radius': '28px' },
      strong: { '--sv-m-track': '110vh', '--sv-m-inset': '18% 12%', '--sv-m-radius': '40px' },
    },
  },
  'sticky-stack': {
    keyframes: null, structure: 'stack', scrub: 'scroll', reachEnd: false,
    range: null,
    vars: { subtle: { '--sv-stack-step': '8px' }, medium: { '--sv-stack-step': '16px' }, strong: { '--sv-stack-step': '28px' } },
  },
  'side-pan': {
    keyframes: 'sv-m-pan', structure: 'plain', scrub: 'in-place', reachEnd: true,
    range: all([pct('entry', 0), pct('entry', 100)]),
    vars: { subtle: { '--sv-m-x': '6vw' }, medium: { '--sv-m-x': '14vw' }, strong: { '--sv-m-x': '26vw' } },
  },
  'text-reveal': {
    keyframes: 'sv-m-text', structure: 'plain', scrub: 'in-place', reachEnd: true,
    range: all([pct('entry', 0), pct('entry', 100)]),
    vars: { subtle: { '--sv-m-floor': '0.45' }, medium: { '--sv-m-floor': '0.2' }, strong: { '--sv-m-floor': '0.06' } },
  },
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A block's motion as the renderer may use it, or null for "no effect". The
 * editor frame renders posted, unvalidated JSON, so every renderer goes
 * through this: null unless `v` is a plain object whose `preset` is a known
 * preset; an intensity outside the list reads as 'medium'.
 */
export function normalizeMotion(v: unknown): NormalizedMotion | null {
  if (!isPlainObject(v)) return null
  const preset = v['preset']
  if (typeof preset !== 'string' || !(MOTION_PRESETS as readonly string[]).includes(preset)) return null
  const raw = v['intensity']
  const intensity: MotionIntensity = typeof raw === 'string' && (MOTION_INTENSITIES as readonly string[]).includes(raw)
    ? raw as MotionIntensity
    : 'medium'
  return { preset: preset as MotionPreset, intensity }
}

const edgeCss = (e: RangeEdge): string => ('pct' in e ? `${e.name} ${e.pct}%` : `${e.name} ${e.vh}vh`)

/** 'entry 0% cover 50%', 'exit-crossing 0% exit-crossing 70vh'. */
export function rangeCss(r: [RangeEdge, RangeEdge]): string {
  return `${edgeCss(r[0])} ${edgeCss(r[1])}`
}

/** The inline custom properties a wrapper carries: the preset's vars for this
 *  strength, plus --sv-m-name (when it animates) and --sv-m-range. */
export function motionVars(m: NormalizedMotion): Record<string, string> {
  const spec = MOTION_SPECS[m.preset]
  const range = spec.range?.[m.intensity]
  return {
    ...(spec.keyframes && { '--sv-m-name': spec.keyframes }),
    ...(range && { '--sv-m-range': rangeCss(range) }),
    ...spec.vars[m.intensity],
  }
}

/**
 * A named range in "distance travelled" units. s = V − top: how far the
 * subject's top has moved up since it touched the viewport bottom. H = the
 * subject's height, V = the viewport height. Mirrors CSS view timelines.
 */
function namedSpan(name: RangeName, H: number, V: number): [number, number] {
  switch (name) {
    case 'cover':          return [0, V + H]
    case 'entry':          return [0, Math.min(H, V)]
    case 'exit':           return [Math.max(H, V), V + H]
    case 'contain':        return [Math.min(H, V), Math.max(H, V)]
    case 'entry-crossing': return [0, H]
    case 'exit-crossing':  return [V, V + H]
  }
}

function edgeAt(e: RangeEdge, H: number, V: number): number {
  const [start, end] = namedSpan(e.name, H, V)
  return 'pct' in e ? start + (e.pct / 100) * (end - start) : start + (e.vh / 100) * V
}

/** [s0, s1]: where the range starts and ends, in the same units as s. */
export function rangeSpan(r: [RangeEdge, RangeEdge], H: number, V: number): [number, number] {
  return [edgeAt(r[0], H, V), edgeAt(r[1], H, V)]
}

/** Progress 0..1 through the range for a subject whose viewport top is `top`
 *  (JS mirror of animation-range, used by the fallback engine). */
export function rangeProgress(r: [RangeEdge, RangeEdge], top: number, H: number, V: number): number {
  const s = V - top
  const [s0, s1] = rangeSpan(r, H, V)
  if (!(s1 > s0)) return s >= s1 ? 1 : 0
  const p = (s - s0) / (s1 - s0)
  return p <= 0 ? 0 : p >= 1 ? 1 : p
}

/** True when any block (top level or inside columns) has a valid motion. */
export function hasMotion(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false
  return blocks.some((b: unknown) => {
    if (!isPlainObject(b)) return false
    if (normalizeMotion(b['motion'])) return true
    const cols = b['type'] === 'columns' ? b['columns'] : null
    return Array.isArray(cols) && cols.some((c) => hasMotion(c))
  })
}

/** Narrowing helper for renderers holding a typed Block. */
export function blockMotion(b: Block): NormalizedMotion | null {
  return normalizeMotion((b as { motion?: unknown }).motion)
}
