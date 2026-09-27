'use client'
// HowItWorks — the mid-page "one bag" story, told by a second, smaller food
// crowd (burger, coffee, shake) standing on a butter counter. As each step
// scrolls into view the matching character cheers; hovering the explore CTA
// gets the whole crew excited, clicking it makes them cheer on the way out
// (same beat as the hero's Order now).
//
// This is the page's second and last WebGL crowd. It is aria-hidden
// decoration; every step is plain text. Each step's icon is a real button
// ("cheer the coffee") so the crowd can be poked from the keyboard too.
//
// Until the crowd draws its first frame (or forever, without WebGL) the
// stage shows three hand-drawn stand-ins on a butter floor shadow, so the
// band never reads as an empty yellow void.
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { animate, motion, useMotionValue, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bike, ShoppingBag, Store } from 'lucide-react'
import { emitCrowd } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
import s from './home.module.css'
import h from './how.module.css'

const FoodCrowd = dynamic(
  () => import('../../characters/FoodCrowd').then((m) => m.FoodCrowd),
  { ssr: false },
)

const CAST: CharacterKind[] = ['burger', 'coffee', 'shake']

/** The shared "pop" spring for presses and catches. */
const POP = { type: 'spring', stiffness: 520, damping: 18 } as const

type StepIconType = typeof Store

function StepIcon({ who, Icon }: { who: CharacterKind; Icon: StepIconType }) {
  const reduce = useReducedMotion()
  const scale = useMotionValue(1)
  const [lit, setLit] = useState(false)
  const litTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(litTimer.current), [])

  function cheer() {
    emitCrowd({ type: 'cheer', kind: who })
    if (reduce) {
      // Static state: the tile flips to plum for a beat, no bounce.
      setLit(true)
      window.clearTimeout(litTimer.current)
      litTimer.current = window.setTimeout(() => setLit(false), 450)
      return
    }
    scale.stop()
    void animate(scale, 1.3, { duration: 0.08, ease: 'easeOut' }).then(() => {
      animate(scale, 1, POP)
    })
  }

  return (
    <button
      type="button"
      className={h.icon}
      aria-label={`cheer the ${who}`}
      data-toy="poke"
      data-lit={lit || undefined}
      onClick={cheer}
    >
      <motion.span className={h.iconFace} style={{ scale }} aria-hidden>
        <Icon size={26} strokeWidth={2.4} />
      </motion.span>
    </button>
  )
}

/** Hand-drawn stand-ins for the crowd: a shopfront, a bag, a rider's bike. */
function StandIns() {
  return (
    <div className={h.standIns}>
      <svg viewBox="0 0 96 96" className={h.standIn} focusable="false">
        <ellipse cx="48" cy="88" rx="34" ry="6" className={h.standShadow} />
        <path d="M18 40 V80 H78 V40" />
        <path d="M40 80 V58 H56 V80" />
        <path d="M12 40 L20 18 H76 L84 40" className={h.standFill} />
        <path d="M12 40 q9 10 18 0 q9 10 18 0 q9 10 18 0 q9 10 18 0" />
      </svg>
      <svg viewBox="0 0 96 96" className={h.standIn} focusable="false">
        <ellipse cx="48" cy="88" rx="30" ry="6" className={h.standShadow} />
        <path d="M22 34 H74 L70 82 H26 Z" className={h.standFill} />
        <path d="M36 34 C36 14, 60 14, 60 34" />
        <path d="M40 52 q8 8 16 0" />
      </svg>
      <svg viewBox="0 0 96 96" className={h.standIn} focusable="false">
        <ellipse cx="48" cy="88" rx="38" ry="6" className={h.standShadow} />
        <circle cx="24" cy="66" r="13" />
        <circle cx="72" cy="66" r="13" />
        <path d="M24 66 L40 40 H58 L72 66 M40 40 L36 30 H26 M58 40 L64 26 H74" />
        <path d="M44 22 H62 V36 H44 Z" className={h.standFill} />
      </svg>
    </div>
  )
}

const STEPS: Array<{ n: string; title: string; body: string; Icon: typeof Store; who: CharacterKind; tilt: number }> = [
  {
    n: '1',
    title: 'Pick your kitchens',
    body: 'stackd, simmer and Flipd side by side. Add from one, or from all three.',
    Icon: Store,
    who: 'coffee',
    tilt: -2,
  },
  {
    n: '2',
    title: 'One bag, one checkout',
    body: 'Everything lands in a single cart. You pay once, whatever the mix.',
    Icon: ShoppingBag,
    who: 'shake',
    tilt: 1.5,
  },
  {
    n: '3',
    title: 'Delivered together',
    body: 'Our own riders bring the whole order in one trip. Hot stays hot, cold stays cold.',
    Icon: Bike,
    who: 'burger',
    tilt: -1,
  },
]

export function HowItWorks() {
  const reduce = useReducedMotion()
  const router = useRouter()
  const [excited, setExcited] = useState(false)
  const [crowdReady, setCrowdReady] = useState(false)

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
        <motion.header
          className={h.head}
          initial={reduce ? false : { opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 200, damping: 18 }}
        >
          <p className={s.eyebrow}>How servd works</p>
          <h2 id="how-title" className={s.h2}>
            Three kitchens. <em>One bag.</em>
          </h2>
        </motion.header>
      </div>

      {/* The crew — wide and short so all three stand in a row. */}
      <div className={h.stage} aria-hidden data-ready={crowdReady || undefined}>
        <div className={h.counter} />
        <StandIns />
        {/* keyboardPoke off: this stage is aria-hidden, and the step icons
            below are the keyboard way to cheer this crew. */}
        <FoodCrowd
          cast={CAST}
          excitement={excited ? 1 : 0}
          keyboardPoke={false}
          onReady={() => setCrowdReady(true)}
        />
      </div>

      <div className={s.wrap}>
        <div className={h.stepsWrap}>
          <ol className={h.steps}>
          {STEPS.map((st, i) => (
            <motion.li
              key={st.n}
              className={h.step}
              initial={reduce ? false : { opacity: 0, y: 44, rotate: st.tilt * 4, scale: 0.94 }}
              whileInView={{ opacity: 1, y: 0, rotate: st.tilt, scale: 1 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 200, damping: 15, delay: i * 0.12 }}
              onViewportEnter={() => {
                if (!reduce) window.setTimeout(() => emitCrowd({ type: 'cheer', kind: st.who }), 250 + i * 380)
              }}
            >
              <span className={h.num} aria-hidden>{st.n}</span>
              <StepIcon who={st.who} Icon={st.Icon} />
              <h3 className={h.stepTitle}>
                <span className={s.srOnly}>Step {st.n}: </span>
                {st.title}
              </h3>
              <p className={h.stepBody}>{st.body}</p>
              {i < STEPS.length - 1 && (
                <svg aria-hidden className={h.arrow} viewBox="0 0 64 40">
                  <motion.path
                    d="M4 24 C 18 4, 38 4, 54 20"
                    initial={{ pathLength: 0 }}
                    whileInView={{ pathLength: 1 }}
                    viewport={{ once: true, amount: 1 }}
                    transition={reduce ? { duration: 0 } : { duration: 0.6, ease: 'easeOut', delay: 0.5 + i * 0.3 }}
                  />
                  <path d="M44 20 L55 21 L53 10" />
                </svg>
              )}
            </motion.li>
          ))}
          </ol>
        </div>

        {/* Explore invitation — the old plum band, now a torn ticket. */}
        <motion.div
          className={h.ticket}
          initial={reduce ? false : { opacity: 0, y: 40, rotate: -3 }}
          whileInView={{ opacity: 1, y: 0, rotate: -1 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 170, damping: 14 }}
        >
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
        </motion.div>
      </div>
    </section>
  )
}
