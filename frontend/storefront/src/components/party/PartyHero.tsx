'use client'
// PartyHero — the home hero for the playful "food crowd" direction.
//
// A warm butter-yellow stage with the 3D food crowd standing on its floor.
// The crowd watches the cursor everywhere on the page; hovering the main
// CTA gets them excited (they lean in and bounce), clicking it makes them
// cheer before navigating. Headline + overview stay operator-editable
// (Admin → Marketing → Landing Hero); the headline splits on its comma so
// "Every kitchen, one place" lands as two beats.
//
// FoodCrowd is WebGL and client-only, so it loads via next/dynamic with
// ssr:false; the page is fully usable (and readable) before it arrives
// and if WebGL is unavailable.

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type CSSProperties } from 'react'
import type { HeroConfig } from '../../lib/heroConfig'
import { emitCrowd } from '../characters/crowdBus'
import s from './party.module.css'

const FoodCrowd = dynamic(
  () => import('../characters/FoodCrowd').then((m) => m.FoodCrowd),
  { ssr: false },
)

function splitTitle(title: string): [string, string | null] {
  const i = title.indexOf(',')
  if (i <= 0 || i >= title.length - 2) return [title, null]
  return [title.slice(0, i + 1), title.slice(i + 1).trim()]
}

// Each word drops in on its own beat; --i drives the stagger in CSS.
function BouncyWords({ text, offset = 0 }: { text: string; offset?: number }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <span key={`${w}-${i}`} className={s.word} style={{ '--i': i + offset } as CSSProperties}>
          {w}
        </span>
      ))}
    </>
  )
}

export function PartyHero({ config }: { config: HeroConfig }) {
  const router = useRouter()
  const [excited, setExcited] = useState(false)
  const [lead, tail] = splitTitle(config.title)
  const leadCount = lead.split(' ').length

  function onOrder(e: React.MouseEvent<HTMLAnchorElement>) {
    // Let modified clicks (new tab, etc.) behave natively.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    emitCrowd({ type: 'cheer' })
    window.setTimeout(() => router.push('/browse'), 520)
  }

  return (
    <section className={s.hero} aria-labelledby="party-hero-title">
      {/* Floating doodles — decoration only. */}
      <svg aria-hidden className={`${s.doodle} ${s.doodleStar}`} viewBox="0 0 40 40">
        <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleSquiggle}`} viewBox="0 0 80 24">
        <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleDot}`} viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8" />
      </svg>

      <div className={s.copy}>
        <p className={s.eyebrow}>servd · karachi · three kitchens</p>
        <h1 id="party-hero-title" className={s.title}>
          <BouncyWords text={lead} />
          {tail && (
            <span className={s.tail}>
              <BouncyWords text={tail} offset={leadCount} />
              <svg aria-hidden className={s.underline} viewBox="0 0 300 20" preserveAspectRatio="none">
                <path d="M4 14 C 60 4, 120 18, 180 9 S 280 6, 296 12" />
              </svg>
            </span>
          )}
        </h1>
        {config.overview && <p className={s.lead}>{config.overview}</p>}
        <div className={s.ctas}>
          <Link
            href="/browse"
            className={s.cta}
            onClick={onOrder}
            onMouseEnter={() => setExcited(true)}
            onMouseLeave={() => setExcited(false)}
            onFocus={() => setExcited(true)}
            onBlur={() => setExcited(false)}
          >
            Order now
            <svg aria-hidden viewBox="0 0 24 24" width="20" height="20"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </Link>
          <a href="#brands" className={s.ctaGhost}>Meet the kitchens</a>
        </div>
      </div>

      <div className={s.stage} aria-hidden>
        <div className={s.floor} />
        <FoodCrowd excitement={excited ? 1 : 0} />
      </div>
    </section>
  )
}
