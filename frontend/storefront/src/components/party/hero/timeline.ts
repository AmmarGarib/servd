// Act I shot list. p is the pinned scene's scroll progress (0..1).
//
//   0.00-0.10  title card       today's hero, crowd walks on
//   0.10-0.28  push-in          camera dollies in, copy shrinks up, letterbox closes, CTA docks
//   0.28-0.46  roll call        stackd (coffee steps forward)
//   0.46-0.64  roll call        simmer (typographic only; camera drifts to the empty side)
//   0.64-0.82  roll call        Flipd (burger steps forward)
//   0.82-1.00  hand-off         cast looks down, camera pulls back, letterbox opens, act ii slate

import type { CrowdShot } from '../../characters/FoodCrowd'
import { lerp, seg } from '../../../lib/film/motion'

export const BEATS = [0.28, 0.46, 0.64, 0.82]

export const PUSH: [number, number] = [0.1, 0.28]
export const HANDOFF: [number, number] = [0.82, 1]

/** The docked CTA is fully in by here and the CTA row starts to leave; the
 *  two cross over 0.16-0.24 so a CTA is always on screen, and exactly one
 *  of them is focusable (the other is inert). */
export const DOCK_AT = 0.2

/** Each lower third's [in, out] segment. It slides in over the first 25% of
 *  its segment and slides out while the next one slides in. */
export const THIRDS = [
  [0.28, 0.46],
  [0.46, 0.64],
  [0.64, 0.82],
] as const

export const THIRD_IN = 0.045 // 25% of an 0.18 segment

const smooth = (t: number) => t * t * (3 - 2 * t)

/** Which lower third is on air at p (-1 = none: title card or hand-off). */
export function activeThird(p: number): number {
  for (let i = 0; i < THIRDS.length; i++) {
    const r = THIRDS[i]
    if (r && p >= r[0] && p < r[1]) return i
  }
  return -1
}

/** Beat index at p: the number of thresholds passed (same rule as useBeat). */
export function beatAt(p: number): number {
  let n = 0
  for (const t of BEATS) if (p >= t) n++
  return n
}

/** Focus target per beat index (number of thresholds passed). */
export function focusForBeat(beat: number): 'coffee' | 'burger' | null {
  if (beat === 1) return 'coffee'
  if (beat === 3) return 'burger'
  return null
}

/** Camera for a scroll position. `narrow` halves the orbit amplitude (phones). */
export function shotAt(p: number, narrow: boolean): CrowdShot {
  const push = smooth(seg(p, PUSH[0], PUSH[1]))
  const back = smooth(seg(p, HANDOFF[0], HANDOFF[1]))
  const toSimmer = smooth(seg(p, 0.46, 0.58))
  const toFlipd = smooth(seg(p, 0.64, 0.76))

  const dolly = lerp(lerp(0, 0.55, push), 0.2, back)
  const lift = lerp(lerp(0, -0.2, push), -0.08, back)
  let orbit = lerp(lerp(lerp(0, -0.35, toSimmer), 0.2, toFlipd), 0, back)
  if (narrow) orbit *= 0.5
  return { dolly, orbit, lift }
}
