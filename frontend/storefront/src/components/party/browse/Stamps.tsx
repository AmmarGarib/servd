'use client'
// Kitchen stamps for the /browse header — a tiny passport. One round ink
// stamp per kitchen, filled once you've opened that kitchen (usePlay
// kitchens, fed by markKitchen). Empty stamps are dashed outlines.
//
// A stamp that fills since the last time this viewer saw the header "thuds"
// in (scale 1.4 → 0.9 → 1 plus an ink-blot reveal). What was already shown is
// remembered per tab in sessionStorage, purely as a convenience.
//
// These are servd hub UI, not brand surfaces, so each kitchen's initial is
// set in that kitchen's colour (simmer's green included).

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { usePlay, useHydrated } from '@/lib/play'
import { formatBrandName } from '../../../lib/concept'
import s from './browse.module.css'

const KITCHENS = [
  { slug: 'stackd', name: 'stackd', color: '#7C2946' },
  { slug: 'simmer', name: 'simmer', color: '#06392F' },
  { slug: 'flipd',  name: 'Flipd',  color: '#294375' },
] as const

const SEEN_KEY = 'servd-browse-stamps-seen'

function readSeen(): string[] | null {
  try {
    const raw = window.sessionStorage.getItem(SEEN_KEY)
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

function writeSeen(slugs: string[]) {
  try { window.sessionStorage.setItem(SEEN_KEY, JSON.stringify(slugs)) } catch { /* private mode */ }
}

export function Stamps() {
  const hydrated = useHydrated()
  const kitchens = usePlay((st) => st.kitchens)
  const visited = useMemo(
    () => new Set(hydrated ? kitchens.map((k) => k.toLowerCase()) : []),
    [hydrated, kitchens],
  )

  // Which filled stamps should thud in on this render.
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!hydrated) return
    const now = KITCHENS.filter((k) => visited.has(k.slug)).map((k) => k.slug)
    const seen = readSeen()
    // First visit this tab: stamps you earned earlier just sit there quietly.
    const baseline = seen ?? now
    const added = now.filter((slug) => !baseline.includes(slug))
    if (added.length) setFresh(new Set(added))
    writeSeen(now)
  }, [hydrated, visited])

  const count = KITCHENS.filter((k) => visited.has(k.slug)).length
  const names = KITCHENS.filter((k) => visited.has(k.slug)).map((k) => formatBrandName(k.name))
  const label = `kitchens visited: ${count} of ${KITCHENS.length}${names.length ? ` (${names.join(', ')})` : ''}`

  return (
    <div className={s.stamps} role="img" aria-label={label}>
      <span className={s.stampsCap} aria-hidden>
        stamps <b>{count}/{KITCHENS.length}</b>
      </span>
      <span className={s.stampRow} aria-hidden>
        {KITCHENS.map((k, i) => {
          const filled = visited.has(k.slug)
          const initial = formatBrandName(k.name).charAt(0)
          return (
            <span
              key={k.slug}
              className={`${s.stamp} ${filled ? s.stampFilled : ''} ${filled && fresh.has(k.slug) ? s.stampFresh : ''}`}
              style={{ '--stamp': k.color, '--i': i } as CSSProperties}
            >
              {filled && <span className={s.stampBlot} />}
              <span className={s.stampInk}>{initial}</span>
            </span>
          )
        })}
      </span>
    </div>
  )
}
