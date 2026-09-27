// Act I roll call — TV-style lower thirds, one per kitchen, each in that
// brand's own language:
//   stackd  cream die-cut sticker, plum swatch, Playfair lowercase (café + market, never burgers)
//   simmer  flat tiber bar, bone Amarante lowercase, one orange dot, no character/gradient/white
//   Flipd   mustard diner bar, blue slab type, checker edge
// Presentational only: the hero positions and scrubs them. Links are plain
// internal links, so the site-wide scene cut picks them up.

import Link from 'next/link'
import { formatBrandName } from '../../../lib/concept'
import h from './hero.module.css'

export type ThirdKey = 'stackd' | 'simmer' | 'flipd'

export const THIRD_ORDER: ThirdKey[] = ['stackd', 'simmer', 'flipd']

interface ThirdCopy {
  name: string
  sub: string
  order: string
  more: string
  moreLabel: string
  moreAria: string
  skin: string | undefined
}

function copyFor(key: ThirdKey): ThirdCopy {
  switch (key) {
    case 'stackd': {
      const name = formatBrandName('stackd')
      return {
        name,
        sub: 'café + market · sandwiches, pastries, mocktails',
        order: '/stackd',
        more: '/brand/stackd',
        moreLabel: 'the café',
        moreAria: `the café at ${name}`,
        skin: h.ltStackd,
      }
    }
    case 'simmer': {
      const name = formatBrandName('simmer')
      return {
        name,
        sub: 'simmer down.',
        order: '/simmer',
        more: '/brand/simmer',
        moreLabel: 'the room',
        moreAria: `the room at ${name}`,
        skin: h.ltSimmer,
      }
    }
    case 'flipd': {
      const name = formatBrandName('Flipd')
      return {
        name,
        sub: 'same burger, every time.',
        order: '/flipd',
        more: '/brand/flipd',
        moreLabel: 'the diner',
        moreAria: `the diner at ${name}`,
        skin: h.ltFlipd,
      }
    }
  }
}

export function LowerThird({ brand, index }: { brand: ThirdKey; index: number }) {
  const c = copyFor(brand)
  return (
    <div className={`${h.lt} ${c.skin ?? ''}`} role="group" aria-label={`starring ${c.name}`}>
      {brand === 'stackd' && <span aria-hidden className={h.swatch} />}
      <div className={h.ltText}>
        <p className={h.ltKicker}>
          starring · 0{index + 1}
        </p>
        <p className={h.ltName}>
          {c.name}
          {brand === 'simmer' && <span aria-hidden className={h.signal} />}
        </p>
        <p className={h.ltSub}>{c.sub}</p>
      </div>
      <div className={h.ltLinks}>
        <Link href={c.order} className={h.ltLink} aria-label={`order from ${c.name}`}>
          order <span aria-hidden>→</span>
        </Link>
        <Link href={c.more} className={`${h.ltLink} ${h.ltLinkQuiet}`} aria-label={c.moreAria}>
          {c.moreLabel} <span aria-hidden>→</span>
        </Link>
      </div>
    </div>
  )
}

/** Reduced motion: the roll call as a small static "starring" list below the hero. */
export function Starring() {
  return (
    <div className={h.starring}>
      <p className={h.starringLabel}>starring</p>
      <ul className={h.starringList}>
        {THIRD_ORDER.map((b, i) => (
          <li key={b}>
            <LowerThird brand={b} index={i} />
          </li>
        ))}
      </ul>
    </div>
  )
}
