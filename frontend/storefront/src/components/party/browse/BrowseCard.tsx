// A single brand card on /browse — a cream sticker card with an ink border,
// offset shadow, and a slight alternating tilt (see browse.module.css
// .cardWrap:nth-child). Links to /brand/<slug>, tracks concept_switched,
// and falls back to the brand's editorial one-liner when the concept has no
// custom description.
//
// Open/closed comes from the world's one rule set (lib/world/kitchens), and
// the status sticker speaks in the kitchen's own voice. A cast member peeks
// over the top edge — a coffee for stackd, a burger for Flipd, nobody for
// simmer — and waves on hover, focus or tap; it sleeps when the kitchen is
// closed.
'use client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Concept } from '../../../lib/concept'
import { typeLabel, conceptHeroImage, brandStory, formatBrandName } from '../../../lib/concept'
import { track } from '../../../lib/analytics'
import { useKitchens } from '../../../lib/world/kitchens'
import { useWorld } from '../../../lib/world/useWorld'
import { asKitchenSlug } from '../../../lib/world/kitchenCore'
import { kitchenLine } from '../../../lib/world/voice'
import type { CharacterKind } from '../../characters/types'
import { CrowdCameo, type CameoPose } from '../../world/cast/CrowdCameo'
import s from './browse.module.css'

const PEEKER: Record<string, CharacterKind> = { stackd: 'coffee', flipd: 'burger' }

export function BrowseCard({ concept, index = 0 }: { concept: Concept; index?: number }) {
  const { bySlug } = useKitchens()
  const world = useWorld()
  const slug = asKitchenSlug(concept.slug)
  const k = slug ? bySlug[slug] : null
  const story = brandStory(concept.slug)
  const name = formatBrandName(concept.name)
  const open = k ? k.open : true
  const kind = PEEKER[concept.slug] ?? null

  const [active, setActive] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Touch mirrors hover: a tap lifts the card and wakes the cameo for a beat.
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return
    setActive(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setActive(false), 1600)
  }, [])

  const pose: CameoPose = k && !k.open ? (active ? 'wave' : 'sleep') : active ? 'wave' : 'idle'
  const statusLine = k ? kitchenLine(k, world.dayPart) : null

  return (
    <div className={s.cardShell} data-active={active ? '1' : undefined}>
      {kind && (
        <span className={s.cardCameo} aria-hidden>
          <CrowdCameo kind={kind} pose={pose} size={76} look="down" delay={index * 370} />
        </span>
      )}
      <Link
        href={`/brand/${concept.slug}`}
        aria-label={`Visit ${name}${k ? ` — ${k.label}` : ''}`}
        className={s.card}
        onClick={() => track('concept_switched', { slug: concept.slug })}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setActive(true) }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(false) }}
        onPointerDown={onPointerDown}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
      >
        <div className={`${s.photoWrap} ${open ? '' : s.photoClosed}`}>
          <img
            src={conceptHeroImage(concept)}
            alt=""
            loading="lazy"
            decoding="async"
            className={s.photo}
          />
          <span aria-hidden className={s.photoShade} />
          <span className={s.badge}>{typeLabel(concept.type)}</span>
          {k && statusLine && (
            <span className={s.statusSticker} data-phase={k.phase} data-brand={k.slug}>
              <span aria-hidden className={s.statusDot} />
              {statusLine}
            </span>
          )}
        </div>
        <div className={s.cardBody}>
          <h3 className={s.cardName} data-brand={slug ?? undefined}>{name}</h3>
          <p className={s.cardDesc}>{concept.description || story.oneLiner}</p>
          <div className={s.cardFooter}>
            <span className={s.orderPill}>Order <span aria-hidden>→</span></span>
            <span className={s.seeMore}>See brand <span aria-hidden>→</span></span>
          </div>
        </div>
      </Link>
    </div>
  )
}
