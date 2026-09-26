'use client'
// HowItWorks — the mid-page "one bag" story, told by a second, smaller food
// crowd (burger, coffee, shake) standing on a butter counter. As each step
// scrolls into view the matching character cheers; hovering the explore CTA
// gets the whole crew excited, clicking it makes them cheer on the way out
// (same beat as the hero's Order now).
//
// This is the page's second and last WebGL crowd. It is aria-hidden
// decoration; every step is plain text.
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type MouseEvent } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
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
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.6 }}
          transition={{ type: 'spring', stiffness: 160, damping: 16 }}
        >
          <p className={s.eyebrow}>How servd works</p>
          <h2 id="how-title" className={s.h2}>
            Three kitchens. <em>One bag.</em>
          </h2>
        </motion.header>
      </div>

      {/* The crew — wide and short so all three stand in a row. */}
      <div className={h.stage} aria-hidden>
        <div className={h.counter} />
        <FoodCrowd cast={CAST} excitement={excited ? 1 : 0} />
      </div>

      <div className={s.wrap}>
        <div className={h.stepsWrap}>
          <ol className={h.steps}>
          {STEPS.map((st, i) => (
            <motion.li
              key={st.n}
              className={h.step}
              initial={{ opacity: 0, y: 60, rotate: st.tilt * 4, scale: 0.9 }}
              whileInView={{ opacity: 1, y: 0, rotate: st.tilt, scale: 1 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 180, damping: 13, delay: i * 0.18 }}
              onViewportEnter={() => {
                if (!reduce) window.setTimeout(() => emitCrowd({ type: 'cheer', kind: st.who }), 250 + i * 380)
              }}
            >
              <span className={h.num} aria-hidden>{st.n}</span>
              <span className={h.icon} aria-hidden><st.Icon size={26} strokeWidth={2.4} /></span>
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
          initial={{ opacity: 0, y: 40, rotate: -3 }}
          whileInView={{ opacity: 1, y: 0, rotate: -1 }}
          viewport={{ once: true, amount: 0.5 }}
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
