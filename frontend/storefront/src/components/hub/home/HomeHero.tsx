'use client'
import Link from 'next/link'
import type { CSSProperties } from 'react'
import { ArrowRight, ChevronDown } from 'lucide-react'
import type { HeroConfig } from '../../../lib/heroConfig'
import { Parallax } from '../motion'
import type { HomeBrand } from './types'
import s from './home.module.css'

// Hero — headline + overview stay operator-editable (Admin → Marketing →
// Landing Hero). The media fields on that block drove the old scroll-expansion
// hero; the hub hero leads with the three kitchens' own photography instead.

interface Props {
  config: HeroConfig
  brands: HomeBrand[]
}

// The hub display type sets the emotional half of a headline in italic lilac.
// The title is free text from the CMS, so we only split on a trailing clause
// ("Every kitchen, one place") and otherwise render it untouched.
function splitTitle(title: string): { lead: string; tail: string | null } {
  const i = title.lastIndexOf(',')
  if (i <= 0 || i >= title.length - 2) return { lead: title, tail: null }
  return { lead: title.slice(0, i + 1), tail: title.slice(i + 1).trim() }
}

// Back → front. Each layer drifts at its own rate so the stack reads as depth.
const STACK_SPEEDS = [0.22, 0.12, 0.04]

export function HomeHero({ config, brands }: Props) {
  const { lead, tail } = splitTitle(config.title)
  // Front card is the first brand in the grid order; paint back-to-front.
  const stack = brands.slice(0, 3).reverse()

  return (
    <section className={`hub-grain ${s.hero}`} aria-labelledby="home-hero-title">
      <div aria-hidden className="hub-glow" style={{ width: '44rem', height: '44rem', top: '-18rem', left: '-14rem', background: 'var(--hub-plum)', opacity: 0.75 }} />
      <div aria-hidden className="hub-glow" style={{ width: '30rem', height: '30rem', bottom: '-12rem', right: '-8rem', background: 'var(--hub-ember)', opacity: 0.16 }} />

      <div className={`hub-container ${s.heroGrid}`}>
        {/* Above the fold: CSS entrances (.hub-enter), so the headline paints
            with the HTML instead of waiting for hydration. */}
        <div>
          <p className="hub-eyebrow hub-eyebrow--accent hub-enter" style={{ margin: 0 }}>servd · karachi</p>
          <h1 id="home-hero-title" className={`hub-display hub-enter ${s.heroTitle}`} style={enterDelay(80)}>
            {lead}
            {tail && <>{' '}<em>{tail}</em></>}
          </h1>
          {config.overview && (
            <p className={`hub-lead hub-enter ${s.heroLead}`} style={enterDelay(160)}>{config.overview}</p>
          )}
          <div className={`hub-enter ${s.heroCtas}`} style={enterDelay(240)}>
            <Link href="/browse" className="hub-btn">
              Order now <ArrowRight aria-hidden />
            </Link>
            <a href="#kitchens" className="hub-btn-ghost">
              Meet the kitchens <ChevronDown aria-hidden />
            </a>
          </div>
          {config.conclusion && (
            <p className={`hub-meta hub-enter ${s.heroNote}`} style={enterDelay(320)}>{config.conclusion}</p>
          )}
        </div>

        {/* Decorative: the same kitchens are named and linked in the bento
            below, so the stack stays out of the accessibility tree. */}
        <div className="hub-enter" style={enterDelay(200)}>
          <div className={s.stack} aria-hidden>
            {stack.map((b, i) => (
              <Parallax key={b.id} speed={STACK_SPEEDS[i]} className={s.stackSlot}>
                <div className={`hub-media ${s.stackCard}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={b.img}
                    alt=""
                    width={600}
                    height={750}
                    loading="eager"
                    decoding="async"
                  />
                  <span className={s.stackLabel} style={{ '--accent': b.accent } as CSSProperties}>
                    <span className={s.dot} />
                    {b.name}
                  </span>
                </div>
              </Parallax>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function enterDelay(ms: number): CSSProperties {
  return { '--hub-delay': `${ms}ms` } as CSSProperties
}
