'use client'
// SimmerMenu — the menu for /brand/simmer/menu, while the kitchen's own menu
// is still unpublished.
//
// It reads as a printed card laid on a dark table: the card comes down onto
// the tiber ground at a slight angle and settles, casting a hard flat shadow
// (no blur, no gradient). Bone paper, tiber ink, Amarante for dish names and
// course numerals, Times for everything else. Each course is revealed as you
// reach it — the rule draws across, then the dishes set one by one.
//
// One orange at a time: the numeral of the course you are reading. While the
// masthead is on screen none is lit.
//
// When the operator publishes a real menu (`/api/v1/storefront/<slug>/menu`
// returns items), the menu page renders the live categories through the
// generic layout instead of this placeholder.

import Link from 'next/link'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { formatBrandName } from '../../../lib/concept'
import { SimmerCursor } from '../simmer/SimmerCursor'
import { Reveal, Line } from '../simmer/reveal'
import { useService } from '../simmer/serviceClock'
import s from '../simmer/simmer.module.css'

interface PlaceholderItem {
  name: string
  body: string
  pricePkr: number
}
interface PlaceholderCourse {
  rubric: string
  title: string
  items: PlaceholderItem[]
}

// Placeholder courses — operator can replace any item via the API.
// Copy intentionally dry: ingredient list, no banned words, no exclamation
// marks.
const PLACEHOLDER_MENU: PlaceholderCourse[] = [
  {
    rubric: 'I.',
    title: 'small plates',
    items: [
      { name: 'Burrata',         body: 'blistered tomato · olive oil cracker · basil',  pricePkr: 1400 },
      { name: 'Charred octopus', body: 'smoked aioli · pickled chilli · lemon',         pricePkr: 1650 },
      { name: 'Beef tartare',    body: 'capers · cured yolk · sourdough crisp',         pricePkr: 1750 },
    ],
  },
  {
    rubric: 'II.',
    title: 'large plates',
    items: [
      { name: 'Lamb shoulder',         body: 'soft polenta · jus · gremolata',           pricePkr: 2800 },
      { name: 'Hand-cut tagliatelle',  body: 'brown butter · sage · aged parmesan',      pricePkr: 2200 },
      { name: 'Seared duck breast',    body: 'charred plum · turnip · five-spice jus',   pricePkr: 2950 },
    ],
  },
  {
    rubric: 'III.',
    title: 'desserts',
    items: [
      { name: 'Olive oil chocolate cake', body: 'maldon flake · whipped crème fraîche',  pricePkr:  950 },
      { name: 'Cardamom panna cotta',     body: 'roasted apricot · honeycomb shard',     pricePkr:  900 },
      { name: 'Bone marrow caramel',      body: 'salted caramel · burnt-butter ice',     pricePkr: 1050 },
    ],
  },
  {
    rubric: 'IV.',
    title: 'mocktails',
    items: [
      { name: 'Garden Spritz',         body: 'basil · lime · cucumber · house soda',       pricePkr:  850 },
      { name: 'Negroni, sin',          body: 'non-alc bitters · blood orange · oleo',      pricePkr:  950 },
      { name: 'Smoked Old Fashioned',  body: 'smoked cherry · char · sugar · non-alc',     pricePkr:  950 },
    ],
  },
]

const i = (n: number) => ({ ['--i' as string]: n } as CSSProperties)
const fmt = (pkr: number) => `Rs ${pkr.toLocaleString('en-PK')}`

/**
 * Which course is being read: the last one whose top has passed the reading
 * line (40% down the viewport). None while the masthead is still on screen.
 */
function useActiveCourse(count: number) {
  const mastRef = useRef<HTMLDivElement | null>(null)
  const courseRefs = useRef<Array<HTMLElement | null>>([])
  const [active, setActive] = useState(-1)
  useEffect(() => {
    let raf = 0
    const update = () => {
      raf = 0
      const vh = window.innerHeight
      const mast = mastRef.current?.getBoundingClientRect()
      if (mast && mast.bottom > 0) { setActive(-1); return }
      let idx = -1
      courseRefs.current.forEach((el, n) => {
        if (el && el.getBoundingClientRect().top < vh * 0.4) idx = n
      })
      setActive(idx)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [count])
  return { mastRef, courseRefs, active }
}

export function SimmerMenu({ slug, conceptName }: { slug: string, conceptName: string }) {
  const { stamp } = useService()
  const { mastRef, courseRefs, active } = useActiveCourse(PLACEHOLDER_MENU.length)
  // Through the shared helper (simmer is a lowercase brand), then lowercased
  // again because this whole surface is set in the bible's lowercase voice.
  const brand = (formatBrandName(conceptName) || 'simmer').toLowerCase()

  return (
    <div className={`simmer-page ${s.root}`} style={{ minHeight: '100dvh' }}>
      <SimmerCursor />
      {/* The page's h1. The masthead is set as wordmark + utility type, not a
          heading, so this carries the title for screen readers and search. */}
      <h1 className={s.srOnly}>the {brand} menu</h1>

      <div className={s.table}>
        <p className={s.utility} style={{ textAlign: 'center', margin: '0 0 1.6rem', color: 'rgba(237,230,211,0.8)' }}>
          set for tonight
        </p>

        {/* ── THE CARD ─────────────────────────────────────────────────── */}
        <article data-ground="bone" className={s.card} aria-labelledby="simmer-menu-title">
          <span aria-hidden="true" className={s.fold} />

          {/* Masthead */}
          <div ref={mastRef}>
            <div className={`${s.eyebrow}`} style={{ borderBottomColor: 'rgba(6,57,47,0.22)' }}>
              <span className={s.utility}>tonight&apos;s service</span>
              <span className={s.utility} suppressHydrationWarning>{stamp}</span>
            </div>
            <div style={{ textAlign: 'center', padding: '2.6rem 0 0.8rem' }}>
              <p id="simmer-menu-title" className={s.amarante} style={{ fontSize: 'clamp(3.4rem, 12vw, 5.6rem)', lineHeight: 0.95, margin: 0 }}>
                {brand}
              </p>
              <p className={s.amarante} style={{ fontSize: 'clamp(1.15rem, 3vw, 1.5rem)', margin: '0.7rem 0 0' }}>
                simmer down.
              </p>
              <p className={s.utility} style={{ margin: '1.8rem 0 0' }}>the menu</p>
              <p className={s.utility} style={{ margin: '0.5rem 0 0', fontSize: '0.72rem', color: 'rgba(6,57,47,0.8)' }}>
                draft — pending kitchen
              </p>
            </div>
          </div>

          {/* Courses */}
          {PLACEHOLDER_MENU.map((course, ci) => (
            <Reveal
              as="section"
              key={course.title}
              aria-labelledby={`simmer-course-${ci}`}
              rootMargin="0px 0px -18% 0px"
              style={{ paddingTop: '2.4rem' }}
            >
              <div ref={(el: HTMLDivElement | null) => { courseRefs.current[ci] = el }}>
                <span aria-hidden="true" className={s.rule} style={{ opacity: 0.3 }} />
                {/* Course header — numeral + lowercase rubric, one heading. */}
                <h2 id={`simmer-course-${ci}`} style={{
                  display: 'flex', alignItems: 'baseline', gap: '0.9rem',
                  margin: '1.6rem 0 1.5rem', fontWeight: 400, letterSpacing: 0,
                }}>
                  <span className={`${s.numeral} ${active === ci ? s.numeralLit : ''}`}>
                    <Line>{course.rubric}</Line>
                  </span>
                  {' '}
                  <span className={`${s.utility} ${s.rise}`} style={i(1)}>{course.title}</span>
                </h2>

                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '1.35rem' }}>
                  {course.items.map((item, n) => (
                    <li key={item.name} className={s.rise} style={i(n + 2)}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem' }}>
                        <p className={s.amarante} style={{ fontSize: 'clamp(1.1rem, 2.6vw, 1.3rem)', lineHeight: 1.2, margin: 0 }}>
                          {item.name}
                        </p>
                        <span aria-hidden="true" className={s.leader} />
                        <p className={s.amarante} style={{ fontSize: '1.02rem', letterSpacing: '0.04em', whiteSpace: 'nowrap', margin: 0 }}>
                          {fmt(item.pricePkr)}
                        </p>
                      </div>
                      <p style={{
                        fontFamily: 'var(--simmer-body)', fontSize: '0.92rem', lineHeight: 1.5,
                        letterSpacing: '0.02em', margin: '0.3rem 0 0', color: 'rgba(6,57,47,0.85)',
                      }}>
                        {item.body}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}

          <Reveal style={{ paddingTop: '2.6rem', textAlign: 'center' }}>
            <span aria-hidden="true" className={s.rule} style={{ opacity: 0.3 }} />
            <p className={`${s.utility} ${s.rise}`} style={{ margin: '1.6rem 0 0', fontSize: '0.72rem', color: 'rgba(6,57,47,0.8)' }}>
              menu changes when the kitchen changes
            </p>
          </Reveal>
        </article>

        {/* ── OFF THE CARD ─────────────────────────────────────────────
            Tableside ordering isn't live yet — the live /<slug> route needs
            the kitchen's API to publish real items first. Until then: flag a
            server, or book. Swap in an order link once the menu is live. */}
        <Reveal style={{ maxWidth: '32rem', margin: 'clamp(3.5rem, 9vh, 5.5rem) auto 0', textAlign: 'center' }}>
          <p className={s.amarante} style={{ fontSize: 'clamp(1.6rem, 4.4vw, 2.3rem)', lineHeight: 1.2, margin: 0 }}>
            <Line>ready when you are.</Line>
          </p>
          <p className={s.rise} style={{ ...i(1), fontSize: '1rem', lineHeight: 1.7, letterSpacing: '0.02em', margin: '0.9rem 0 0' }}>
            Flag your server — they&apos;ll take the order. Tableside ordering opens once the kitchen publishes.
          </p>
          <div className={s.rise} style={{ ...i(2), marginTop: '2rem', display: 'flex', gap: '0.8rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href={`/reserve/${slug}`} className={s.btnSolid}>reserve a table</Link>
            <Link href={`/brand/${slug}`} className={s.btn}>{brand} home</Link>
          </div>
        </Reveal>
      </div>
    </div>
  )
}
