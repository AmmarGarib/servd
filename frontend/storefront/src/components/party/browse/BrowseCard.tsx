// A single brand card on /browse — a cream sticker card with an ink border,
// offset shadow, and a slight alternating tilt (see browse.module.css
// .cardWrap:nth-child). Preserves the original card's behavior: links to
// /brand/<slug>, tracks concept_switched, shows open/closed + service type,
// and falls back to the brand's editorial one-liner when the concept has no
// custom description.
'use client'
import Link from 'next/link'
import type { Concept } from '../../../lib/concept'
import { typeLabel, conceptHeroImage, brandStory, formatBrandName } from '../../../lib/concept'
import { isOpenNow } from '../../../lib/hours'
import { track } from '../../../lib/analytics'
import s from './browse.module.css'

export function BrowseCard({ concept }: { concept: Concept }) {
  const story = brandStory(concept.slug)
  const status = isOpenNow(concept.type)
  const name = formatBrandName(concept.name)

  return (
    <Link
      href={`/brand/${concept.slug}`}
      aria-label={`Visit ${name}${status.open ? ' — open now' : ' — closed'}`}
      className={s.card}
      onClick={() => track('concept_switched', { slug: concept.slug })}
    >
      <div className={`${s.photoWrap} ${status.open ? '' : s.photoClosed}`}>
        <img
          src={conceptHeroImage(concept)}
          alt=""
          loading="lazy"
          decoding="async"
          className={s.photo}
        />
        <span aria-hidden className={s.photoShade} />
        <span className={s.badge}>{typeLabel(concept.type)}</span>
        <span className={`${s.statusPill} ${status.open ? s.statusOpen : s.statusClosed}`}>
          <span aria-hidden className={s.statusDot} />
          {status.open ? 'Open now' : 'Closed'}
        </span>
      </div>
      <div className={s.cardBody}>
        <h3 className={s.cardName}>{name}</h3>
        <p className={s.cardDesc}>{concept.description || story.oneLiner}</p>
        <div className={s.cardFooter}>
          <span className={s.orderPill}>Order <span aria-hidden>→</span></span>
          <span className={s.seeMore}>See brand <span aria-hidden>→</span></span>
        </div>
      </div>
    </Link>
  )
}
