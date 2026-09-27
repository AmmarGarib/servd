'use client'
// HowItWorks: the mid-page "one bag" story, told by a second, smaller food
// crowd (burger, coffee, shake) standing on a butter counter.
//
// The crew paints instantly as SVG (CrowdStage) and cross-fades to 3D when
// WebGL is ready. Each step card has its own small cast member acting it
// out: the sandwich points at "pick your kitchens", the shake holds out the
// bag, the fries wave the rider off. They all doze at night through the same
// CSS rule as the hero. When a step settles into view, the matching 3D
// character cheers. Hovering or focusing the explore CTA gets the crew
// excited, and clicking it makes them cheer on the way out.
//
// The crowd is aria-hidden decoration, and every step is plain text.
// Reveal hygiene: SSR is final. Blocks below the fold are armed at opacity .4
// and settle in ≤ 450 ms. The arrows draw in 400 ms.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { emitCrowd } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
import type { CameoPose } from '../../world/cast/CrowdCameo'
import { CrowdStage, DozyCameo } from '../PartyHero'
import { useReveal } from './Divider'
import s from './home.module.css'
import h from './how.module.css'

const CAST: CharacterKind[] = ['burger', 'coffee', 'shake']

type Step = {
  n: string
  title: string
  body: string
  /** 3D crowd member that cheers when this step lands. */
  who: CharacterKind
  /** SVG cast member acting the step out on the card. */
  actor: CharacterKind
  pose: CameoPose
  tilt: number
}

const STEPS: Step[] = [
  {
    n: '1',
    title: 'Pick your kitchens',
    body: 'stackd, simmer and Flipd side by side. Add from one, or from all three.',
    who: 'coffee',
    actor: 'sandwich',
    pose: 'point',
    tilt: -2,
  },
  {
    n: '2',
    title: 'One bag, one checkout',
    body: 'Everything lands in a single cart. You pay once, whatever the mix.',
    who: 'shake',
    actor: 'shake',
    pose: 'catch',
    tilt: 1.5,
  },
  {
    n: '3',
    title: 'Delivered together',
    body: 'Our own riders bring the whole order in one trip. Hot stays hot, cold stays cold.',
    who: 'burger',
    actor: 'fries',
    pose: 'wave',
    tilt: -1,
  },
]

// A small kraft servd bag for the shake to hold out.
function Bag() {
  return (
    <svg className={h.bag} viewBox="0 0 32 34" aria-hidden>
      <path d="M11 9 C 11 3, 21 3, 21 9" className={h.bagHandle} />
      <path d="M5 9 H27 L25.5 31 H6.5 Z" className={h.bagBody} />
      <path d="M12.5 18.5 C 12.5 16, 19.5 16, 19.5 18.5 C 19.5 21, 12.5 20.5, 12.5 23 C 12.5 25.5, 19.5 25.5, 19.5 23" className={h.bagMark} />
    </svg>
  )
}

function StepCard({ st, index, last }: { st: Step; index: number; last: boolean }) {
  const [ref, reveal] = useReveal<HTMLLIElement>()

  useEffect(() => {
    if (reveal !== 'shown') return
    const t = window.setTimeout(() => emitCrowd({ type: 'cheer', kind: st.who }), 220 + index * 260)
    return () => window.clearTimeout(t)
  }, [reveal, st.who, index])

  return (
    <li
      ref={ref}
      className={`${h.stepSlot} ${s.rv}`}
      data-reveal={reveal}
      style={{ '--ri': Math.min(index, 2), '--tilt': `${st.tilt}deg` } as CSSProperties}
    >
      <div className={h.step} tabIndex={-1}>
        <span className={h.num} aria-hidden>{st.n}</span>
        <span className={h.actor} aria-hidden>
          <DozyCameo kind={st.actor} pose={st.pose} size={70} delay={index * 300} />
          {st.pose === 'catch' && <Bag />}
        </span>
        <h3 className={h.stepTitle}>
          <span className={s.srOnly}>Step {st.n}: </span>
          {st.title}
        </h3>
        <p className={h.stepBody}>{st.body}</p>
      </div>
      {!last && (
        <svg aria-hidden className={h.arrow} viewBox="0 0 64 40">
          <path className={h.arrowPath} d="M4 24 C 18 4, 38 4, 54 20" pathLength={1} />
          <path className={h.arrowHead} d="M44 20 L55 21 L53 10" pathLength={1} />
        </svg>
      )}
    </li>
  )
}

export function HowItWorks() {
  const router = useRouter()
  const [excited, setExcited] = useState(false)
  const [headRef, headReveal] = useReveal<HTMLElement>()
  const [ticketRef, ticketReveal] = useReveal<HTMLDivElement>()

  function onExplore(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    emitCrowd({ type: 'cheer' })
    window.setTimeout(() => router.push('/browse'), 520)
  }

  return (
    <section className={h.section} aria-labelledby="how-title">
      <svg aria-hidden className={`${h.doodle} ${h.doodleSquiggle}`} viewBox="0 0 80 24">
        <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
      </svg>
      <svg aria-hidden className={`${h.doodle} ${h.doodleStar}`} viewBox="0 0 40 40">
        <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
      </svg>

      <div className={s.wrap}>
        <header ref={headRef} className={`${h.head} ${s.rv}`} data-reveal={headReveal}>
          <p className={s.eyebrow}>How servd works</p>
          <h2 id="how-title" className={s.h2}>
            Three kitchens. <em>One bag.</em>
          </h2>
        </header>
      </div>

      {/* The crew: wide and short, so all three stand in a row. */}
      <div className={h.stage} aria-hidden>
        <div className={h.counter} />
        <CrowdStage cast={CAST} excited={excited} variant="how" />
      </div>

      <div className={s.wrap}>
        <div className={h.stepsWrap}>
          <ol className={h.steps}>
            {STEPS.map((st, i) => (
              <StepCard key={st.n} st={st} index={i} last={i === STEPS.length - 1} />
            ))}
          </ol>
        </div>

        {/* Explore invitation: the old plum band, now a torn ticket. */}
        <div ref={ticketRef} className={`${h.ticketSlot} ${s.rv}`} data-reveal={ticketReveal}>
          <div className={h.ticket}>
            <p className={h.ticketCopy}>
              <strong>Every kitchen, one order.</strong>
              <span>Explore the brands and check out once.</span>
            </p>
            <Link
              href="/browse"
              className={s.btn}
              onClick={onExplore}
              onMouseEnter={() => setExcited(true)}
              onMouseLeave={() => setExcited(false)}
              onFocus={() => setExcited(true)}
              onBlur={() => setExcited(false)}
            >
              Explore the brands
              <ArrowRight aria-hidden size={20} strokeWidth={2.6} />
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
