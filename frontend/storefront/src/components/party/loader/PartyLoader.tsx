// PartyLoader — the servd hub route loader in the "food crowd" direction.
//
// The six characters come from the shared SVG cast (world/cast/CrowdCameo),
// so they paint from the very first byte of HTML (no JS, no WebGL, no network
// assets). They stand on a floor under the hour's sky and run a stadium wave:
// each one crouches, springs up with its arms in the air and lands with a
// squash, a sparkle popping over its head. The servd. wordmark ripples as the
// wave passes and a status line cycles through the hour's loading lines.
//
// The sky, the sun or moon and the night crowd are pure CSS on the server-
// stamped html[data-daypart] / html[data-world-dark], so the first paint is
// already right at 2am: the crowd dozes and the night cook holds a lantern.
// The status lines for every day-part are rendered and CSS shows the one that
// matches, so the copy is right before hydration too.
//
// Reduced motion shows the crowd standing still with the first status line.

import type { CSSProperties } from 'react'
import type { CharacterKind } from '../../characters/types'
import { DAYPARTS, type DayPart } from '../../../lib/world/clock'
import { loadingLines, type VoiceBrand } from '../../../lib/world/voice'
import { Stars } from '../../world/Ambient'
import { CrowdCameo, type CameoNightPose } from '../../world/cast/CrowdCameo'
import { LoaderSignal } from './LoaderSignal'
import s from './loader.module.css'

type V = CSSProperties & Record<`--${string}`, string | number>

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/** The hub's ground: the hour's sky (lunch = the classic butter). */
export const HUB_GROUND = 'var(--world-sky-b, #FFD447)'

/* ── Day-part lines: every day-part's set is rendered, CSS picks one ──── */

/** Rotating loader copy for `brand`, correct at first paint for any hour.
 *  Identical sets are merged, so a brand with one voice renders once. */
export function DayLines({ brand, className }: { brand: VoiceBrand | null; className?: string }) {
  const groups: { parts: DayPart[]; lines: string[] }[] = []
  for (const dp of DAYPARTS) {
    const lines = loadingLines(brand, dp).slice(0, 4)
    const key = lines.join('|')
    const hit = groups.find((g) => g.lines.join('|') === key)
    if (hit) hit.parts.push(dp)
    else groups.push({ parts: [dp], lines })
  }
  return (
    <>
      {groups.map((g) => (
        <p key={g.parts.join(' ')} className={cx(s.status, s.dayLines, className)} data-dp={g.parts.join(' ')}>
          {g.lines.map((t, i) => (
            <span key={`${i}-${t}`} style={{ '--n': i } as V}>{t}</span>
          ))}
        </p>
      ))}
    </>
  )
}

/* ── The crowd ─────────────────────────────────────────────────────────── */

const CAST: { kind: CharacterKind; night: CameoNightPose }[] = [
  { kind: 'croissant', night: 'sleep' },
  { kind: 'fries', night: 'sleep' },
  { kind: 'burger', night: 'sleep' },
  { kind: 'shake', night: 'sleep' },
  // The night cook: stays up with a lantern while the others doze.
  { kind: 'coffee', night: 'point' },
  { kind: 'sandwich', night: 'sleep' },
]

const STAR = 'M0 -12L3 -3L12 0L3 3L0 12L-3 3L-12 0L-3 -3Z'

function Crowd() {
  return (
    <div className={s.crowd} aria-hidden="true">
      <span className={s.floor} />
      {CAST.map(({ kind, night }, i) => (
        <span key={kind} className={cx(s.member, (i === 0 || i === CAST.length - 1) && s.edge, night === 'point' && s.lamp)} style={{ '--i': i } as V}>
          <svg className={s.spark} viewBox="-13 -13 26 26" focusable="false">
            <path d={STAR} fill={i % 2 ? '#FF5A3C' : '#4E2A4F'} />
          </svg>
          <CrowdCameo
            kind={kind}
            size={176}
            pose="idle"
            delay={i * 350}
            nightPose={night}
            lantern={night === 'point'}
            className={s.cameo}
          />
        </span>
      ))}
    </div>
  )
}

/** The loader. `screen` = full-viewport sky stage (route loading).
 *  `inline` = compact crowd on whatever surface it sits on. Passing `label`
 *  shows that line instead of the cycling status lines. */
export function PartyLoader({ variant = 'screen', label }: { variant?: 'screen' | 'inline'; label?: string }) {
  const screen = variant === 'screen'
  return (
    <div className={screen ? s.screen : s.inline} role="status" aria-live="polite">
      <LoaderSignal ground={HUB_GROUND} />
      <span className="sr-only">{label ?? 'Loading…'}</span>
      {screen && (
        <>
          <span className={s.glow} aria-hidden="true" />
          <span className={s.orb} aria-hidden="true" />
          <Stars count={30} seed="party-loader" />
          <svg className={`${s.doodle} ${s.dStar}`} aria-hidden="true" viewBox="-13 -13 26 26"><path d={STAR} /></svg>
          <svg className={`${s.doodle} ${s.dDot}`} aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" /></svg>
          <svg className={`${s.doodle} ${s.dSquig}`} aria-hidden="true" viewBox="0 0 80 24"><path d="M2 12C12 2 22 22 32 12S52 2 62 12S76 20 78 12" /></svg>
          <div className={s.burst} aria-hidden="true" />
        </>
      )}
      <div className={s.stage}><Crowd /></div>
      <div className={s.brand} aria-hidden="true">
        <p className={s.wordmark}>
          {'servd'.split('').map((ch, i) => (
            <span key={i} style={{ '--l': i } as V}>{ch}</span>
          ))}
          <span className={s.dot} style={{ '--l': 5 } as V} />
        </p>
        {label ? (
          <p className={s.status}><span className={s.fixed}>{label}</span></p>
        ) : (
          <DayLines brand="servd" />
        )}
      </div>
    </div>
  )
}

export default PartyLoader
