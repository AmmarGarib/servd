// servd's universal spinner (storefront) — a small member of the cast.
//
// One CrowdCameo idles while a loading line rotates under it. Which character
// is on shift follows the hour: coffee at breakfast, burger at lunch, shake in
// the afternoon lull, fries at dinner, the sandwich late and the croissant in
// the small hours (asleep). All six are server-rendered and CSS on the
// server-stamped html[data-daypart] shows the right one, so there is no
// hydration flash. simmer never gets a character: SIMMER_CELLS (or
// brand="simmer") renders a single slow orange dot instead.
//
// API is backwards compatible with the old 9-cell ripple: `size` was the
// cell size (footprint ≈ 3×size); the cameo's height is scaled from it, so
// the default 44 gives the standard 56px cameo. `colors` is still accepted;
// the palettes are kept for existing imports.

import type { CSSProperties } from 'react'
import type { CharacterKind } from '../characters/types'
import type { DayPart } from '../../lib/world/clock'
import type { VoiceBrand } from '../../lib/world/voice'
import { CrowdCameo, type CameoPose } from '../world/cast/CrowdCameo'
import { DayLines, PartyLoader } from '../party/loader/PartyLoader'
import s from '../party/loader/loader.module.css'

// servd obsidian-plum gradient (the storefront brand). Simmer = single orange
// signal (their rules ban gradients); Stackd = navy-grey (legacy palette).
export const SERVD_CELLS = ['#2D1E2F', '#3D2540', '#4E2A4F', '#623A63', '#774B78', '#8C5E8E', '#A375A4', '#BE96BE', '#D9BFD9']
export const SIMMER_CELLS = Array<string>(9).fill('#E94E1B')
export const STACKD_CELLS = ['#142834', '#1E3340', '#293B47', '#384A56', '#45505C', '#5C6470', '#737A85', '#8D8F97', '#B0B2B8']

/** Who minds the spinner at each hour. */
const ON_SHIFT: { kind: CharacterKind; parts: DayPart[]; pose: CameoPose }[] = [
  { kind: 'coffee', parts: ['morning'], pose: 'sip' },
  { kind: 'burger', parts: ['lunch'], pose: 'idle' },
  { kind: 'shake', parts: ['afternoon'], pose: 'idle' },
  { kind: 'fries', parts: ['dinner'], pose: 'idle' },
  { kind: 'sandwich', parts: ['late'], pose: 'idle' },
  { kind: 'croissant', parts: ['night'], pose: 'sleep' },
]

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

function isSimmer(colors: string[] | undefined, brand: VoiceBrand | undefined): boolean {
  if (brand === 'simmer') return true
  return !!colors && colors.length > 0 && colors.every((c) => c.toUpperCase() === '#E94E1B')
}

export function Loader({
  size = 44,
  colors,
  className = '',
  label,
  brand,
  showLine,
}: {
  /** Legacy cell size; the cameo is ~1.27× this tall (44 → 56px). */
  size?: number
  /** Legacy palette. SIMMER_CELLS switches to simmer's character-free dot. */
  colors?: string[]
  className?: string
  /** Screen-reader label (and the fixed line, when given). Default "Loading". */
  label?: string
  /** Voice for the rotating line. Default servd. */
  brand?: VoiceBrand
  /** Show the rotating line. Default: on when the cameo is 40px or taller. */
  showLine?: boolean
}) {
  const h = Math.max(20, Math.min(120, Math.round(size * 1.27)))
  const line = showLine ?? h >= 40
  const simmer = isSimmer(colors, brand)
  const voice: VoiceBrand = brand ?? (simmer ? 'simmer' : 'servd')
  const style: CSSProperties = { minWidth: h }

  return (
    <div className={cx(s.mini, className)} role="status" aria-live="polite" style={style}>
      <span className="sr-only">{label ?? 'Loading'}</span>
      <span className={s.miniStage} aria-hidden="true">
        {simmer ? (
          <span className={s.miniDot} />
        ) : (
          ON_SHIFT.map((c, i) => (
            <span key={c.kind} className={s.miniCameo} data-dp={c.parts.join(' ')}>
              <CrowdCameo kind={c.kind} size={h} pose={c.pose} delay={i * 170} />
            </span>
          ))
        )}
      </span>
      {line && (
        <span aria-hidden="true" style={{ display: 'contents' }}>
          {label ? <span className={s.status}><span className={s.fixed}>{label}</span></span> : <DayLines brand={voice} />}
        </span>
      )}
    </div>
  )
}

// Inline page-level loading state. With no `colors`, it shows the compact
// servd food-crowd loader (the characters doing their wave) — the hub look.
// Passing `colors` keeps a single brand-appropriate cameo (or simmer's dot).
export function LoadingScreen({
  label,
  size = 34,
  colors,
  minHeight = '60dvh',
}: {
  label?: string
  size?: number
  colors?: string[]
  minHeight?: string | number
}) {
  if (!colors) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight }}>
        <PartyLoader variant="inline" label={label} />
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight, padding: '2rem' }}>
      <Loader size={Math.max(size, 40)} colors={colors} label={label} />
    </div>
  )
}

export default Loader
