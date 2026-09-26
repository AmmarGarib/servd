'use client'
import Link from 'next/link'
import type { CSSProperties } from 'react'
import { ArrowRight, Package, Sparkles } from 'lucide-react'
import { Reveal } from '../motion'
import type { HomeBrand } from './types'
import s from './home.module.css'

// The kitchens — asymmetric bento. One tall tile + two stacked on desktop,
// a single column on mobile, then a row of small value/CTA tiles.
//
// Each brand tile carries two navigation intents: the tile body goes to the
// brand microsite (/brand/<slug>), the "Order from X" button goes straight
// into ordering (/<slug>). The tile link is a stretched, empty anchor under
// the content and the button sits on a higher layer — never nested anchors.

const BRAND_AREAS = [s.areaBig, s.areaS1, s.areaS2]

// Per-tile reveals, not a RevealGroup: stacked on mobile the grid is ~2500px
// tall, and a group waits for 15% of that before revealing anything.
const stagger = (i: number) => (i % 3) * 0.08

export function KitchensBento({ brands }: { brands: HomeBrand[] }) {
  return (
    <section id="kitchens" className="hub-section" aria-labelledby="kitchens-title" style={{ scrollMarginTop: '1rem' }}>
      <div className="hub-container">
        <Reveal className={s.sectionHead}>
          <div>
            <p className="hub-eyebrow hub-eyebrow--accent" style={{ margin: 0 }}>The kitchens</p>
            <h2 id="kitchens-title" className={`hub-display ${s.h2}`}>
              Pick one. Pick two. <em>Pick all of them.</em>
            </h2>
          </div>
          <p className="hub-lead" style={{ margin: 0 }}>
            Three kitchens, one checkout. Open a kitchen for its story, or go straight to its menu.
          </p>
        </Reveal>

        <div className={s.bento}>
          {brands.slice(0, 3).map((b, i) => (
            <Reveal key={b.id} delay={stagger(i)} className={`${s.cell} ${BRAND_AREAS[i] ?? ''}`}>
              <BrandTile brand={b} big={i === 0} />
            </Reveal>
          ))}

          <Reveal delay={stagger(0)} className={`${s.cell} ${s.areaV1}`}>
            <div className={`hub-card ${s.valueCard}`}>
              <span className={s.iconBadge}><Package aria-hidden /></span>
              <h3 className={s.valueTitle}>One bag, one delivery.</h3>
              <p className={s.valueBody}>
                We hold the slowest dish so the salad stays cold and the burger stays hot.
              </p>
            </div>
          </Reveal>

          <Reveal delay={stagger(1)} className={`${s.cell} ${s.areaV2}`}>
            <a href="#insiders" className={`hub-card hub-card--interactive ${s.valueCard}`}>
              <span className={s.iconBadge}><Sparkles aria-hidden /></span>
              <span className={s.valueTitle}>Insiders get first dibs.</span>
              <span className={s.valueBody}>
                Limited drops, off-menu plates and points on every order.
              </span>
              <span className={s.valueMore}>See the perks <ArrowRight aria-hidden /></span>
            </a>
          </Reveal>

          <Reveal delay={stagger(2)} className={`${s.cell} ${s.areaCta}`}>
            <div className={`hub-card ${s.valueCard} ${s.ctaCard}`}>
              <h3 className={s.valueTitle} style={{ marginTop: 0 }}>Every kitchen, one order.</h3>
              <p className={s.valueBody}>Explore the brands and check out once.</p>
              <Link href="/browse" className={`hub-btn ${s.ctaBtn}`}>
                Explore the brands <ArrowRight aria-hidden />
              </Link>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

function BrandTile({ brand: b, big }: { brand: HomeBrand; big: boolean }) {
  return (
    <article
      className={`hub-media ${s.tile} ${big ? s.tileBig : ''}`}
      style={{ '--accent': b.accent } as CSSProperties}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={b.img} alt="" loading="lazy" decoding="async" width={1200} height={1500} />
      <div aria-hidden className={s.tileScrim} />
      <div aria-hidden className={s.tileHairline} />
      <Link href={`/brand/${b.slug}`} aria-label={`Visit ${b.name}'s landing page`} className={s.stretched} />
      <div className={s.tileBody}>
        <p className={`hub-eyebrow ${s.tileEyebrow}`} style={{ margin: 0 }}>
          <span aria-hidden className={s.dot} />
          /{b.slug}
        </p>
        <h3 className={`hub-display ${s.tileName}`}>{b.name}</h3>
        <p className={s.tileTagline}>{b.story.tagline}</p>
        <Link href={`/${b.slug}`} className={`hub-btn ${s.tileBtn}`}>
          Order from {b.name} <ArrowRight aria-hidden />
        </Link>
      </div>
    </article>
  )
}
