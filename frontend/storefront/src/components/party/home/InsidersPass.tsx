'use client'
// InsidersPass — servd's loyalty pitch as a VIP lanyard pass that swings
// in, tilts toward the pointer and catches a holographic shimmer, next to
// three perk "stickers" (one per kitchen, each in its own colours).
//
// Per the loyalty-program skill: simmer (premium) gets quiet recognition —
// no points, no coupony language, no cartoon treatment; stackd + Flipd get
// a clean, generous points mechanic. Copy is verbatim from the previous
// section. WhatsApp is the primary route (dominant channel in PK); the
// email signup and sign-in stay as backups.
//
// On touch there is no pointer to tilt toward, so the pass idles on the
// scroll instead (rotateY ±6deg across the section, sprung), and a tap
// flips it a little and back. The perks are information, not controls, so
// they no longer lift on hover.
import Link from 'next/link'
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import {
  animate,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type Transition,
} from 'framer-motion'
import { ArrowRight, Coffee, Gem, MessageCircle, Trophy } from 'lucide-react'
import { BRAND_LOCATIONS, whatsappLink } from '../../../lib/brandLocations'
import { formatBrandName } from '../../../lib/concept'
import { SPRING } from '../../../lib/tactile'
import s from './home.module.css'
import v from './insiders.module.css'

/** SPRING is typed as a component Transition; animate() on a bare motion
 *  value wants a value transition. Same numbers, narrower type. */
function springOf(t: Transition) {
  const { stiffness, damping, mass } = t as { stiffness?: number; damping?: number; mass?: number }
  return { type: 'spring' as const, stiffness, damping, mass }
}

const PERKS = [
  {
    slug: 'simmer',
    Icon: Gem,
    tag: `${formatBrandName('simmer')} · regulars`,
    head: 'The regulars’ list',
    body: 'Quiet recognition. First word on the next menu drop. A held table when the room is full. Now and then the chef sends out a plate. No card, no points — you’re known here.',
    tilt: -2,
    featured: false,
  },
  {
    slug: 'stackd',
    Icon: Coffee,
    tag: `${formatBrandName('stackd')} · counter club`,
    head: 'Five coffees in, the sixth is on us',
    body: `Buy five drinks at ${formatBrandName('stackd')} and the sixth is on the house. Insiders also get first look at the pastry case before the morning bake goes out to the floor.`,
    tilt: 1.5,
    featured: true,
  },
  {
    slug: 'flipd',
    Icon: Trophy,
    tag: `${formatBrandName('Flipd')} · points`,
    head: 'Points on every box',
    body: `Earn 1 point per Rs. 10 spent at ${formatBrandName('Flipd')}. Free weekday lunch delivery for members. Redeem points for a meal at 2,000.`,
    tilt: -1,
    featured: false,
  },
]

const KITCHENS = ['stackd', 'simmer', 'Flipd'].map(formatBrandName)

/** True on hover-less (touch) devices. Read after mount so SSR matches. */
function useTouchOnly(): boolean {
  const [touch, setTouch] = useState(false)
  useEffect(() => {
    try {
      const mq = window.matchMedia('(hover: none)')
      setTouch(mq.matches)
      const on = (e: MediaQueryListEvent) => setTouch(e.matches)
      mq.addEventListener('change', on)
      return () => mq.removeEventListener('change', on)
    } catch {
      return undefined
    }
  }, [])
  return touch
}

function Pass({ sectionRef }: { sectionRef: RefObject<HTMLElement> }) {
  const reduce = useReducedMotion()
  const touch = useTouchOnly()
  const ref = useRef<HTMLDivElement>(null)
  const px = useMotionValue(0.5)
  const py = useMotionValue(0.5)
  const sx = useSpring(px, { stiffness: 200, damping: 16 })
  const sy = useSpring(py, { stiffness: 200, damping: 16 })
  const pointerY = useTransform(sx, [0, 1], [-16, 16])
  const rotateX = useTransform(sy, [0, 1], [12, -12])
  const shine = useTransform(sx, (x) => `${x * 100}%`)
  const holo = useMotionTemplate`linear-gradient(115deg, transparent 20%, rgba(255,212,71,0.45) calc(${shine} - 12%), rgba(124,242,154,0.35) ${shine}, rgba(58,168,255,0.35) calc(${shine} + 10%), transparent 80%)`

  // Touch idle: the pass turns with the section's scroll progress.
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ['start end', 'end start'] })
  const idleRaw = useTransform(scrollYProgress, [0, 1], [-6, 6])
  const idle = useSpring(idleRaw, { stiffness: 90, damping: 18 })
  const idleGain = useMotionValue(0)
  useEffect(() => {
    idleGain.set(touch && !reduce ? 1 : 0)
  }, [touch, reduce, idleGain])
  // Tap: a small flip and back.
  const flip = useMotionValue(0)
  const rotateY = useTransform(
    [pointerY, idle, idleGain, flip],
    ([p, i, g, f]: number[]) => (p ?? 0) + (i ?? 0) * (g ?? 0) + (f ?? 0),
  )

  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType !== 'mouse') return
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    px.set((e.clientX - r.left) / r.width)
    py.set((e.clientY - r.top) / r.height)
  }
  function onTap(e: PointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType === 'mouse') return
    animate(flip, 12, springOf(SPRING.pop)).then(() => animate(flip, 0, springOf(SPRING.release)))
  }

  return (
    <motion.div
      className={v.lanyard}
      aria-hidden
      initial={{ rotate: -3, y: -24, opacity: 0.001 }}
      whileInView={{ rotate: 0, y: 0, opacity: 1 }}
      viewport={{ once: true, amount: 0.2, margin: '0px 0px -8% 0px' }}
      transition={reduce ? { duration: 0 } : { default: { type: 'spring', stiffness: 120, damping: 6, mass: 1.1 }, opacity: { duration: 0.22 } }}
    >
      <div className={v.swing}>
      <span className={v.strap} />
      <motion.div
        ref={ref}
        className={v.pass}
        onPointerMove={onMove}
        onPointerLeave={() => { px.set(0.5); py.set(0.5) }}
        onPointerUp={onTap}
        style={{ rotateX, rotateY }}
      >
        <span className={v.clip} />
        <div className={v.passTop}>
          <span className={v.passBrand}>servd<span>.</span></span>
          <span className={v.passTier}>insider</span>
        </div>
        <p className={v.passTitle}>All-access<br /><em>pass</em></p>
        <ul className={v.passKitchens}>
          {KITCHENS.map((n) => <li key={n}>{n}</li>)}
        </ul>
        <div className={v.passFoot}>
          <svg viewBox="0 0 120 34" className={v.barcode} preserveAspectRatio="none">
            {[2, 6, 9, 14, 17, 19, 24, 29, 31, 35, 40, 42, 47, 50, 55, 57, 61, 66, 68, 73, 77, 80, 84, 89, 91, 96, 99, 103, 108, 111, 115].map((x, i) => (
              <rect key={x} x={x} y="0" width={i % 3 === 0 ? 2.6 : 1.3} height="34" />
            ))}
          </svg>
          <span>free forever</span>
        </div>
        <motion.span className={v.holo} style={{ background: holo }} />
      </motion.div>
      </div>
    </motion.div>
  )
}

export function InsidersPass() {
  const reduce = useReducedMotion()
  const sectionRef = useRef<HTMLElement>(null)
  return (
    <section ref={sectionRef} className={v.section} aria-labelledby="insiders-title">
      <div className={s.wrap}>
        <div className={v.top}>
          <motion.div
            initial={{ opacity: 0.001, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2, margin: '0px 0px -8% 0px' }}
            transition={reduce ? { duration: 0 } : { default: { type: 'spring', stiffness: 220, damping: 20 }, opacity: { duration: 0.22 } }}
          >
            <p className={s.eyebrow}>Insiders · free to join</p>
            <h2 id="insiders-title" className={s.h2}>
              The best stuff<br />
              <em>doesn&rsquo;t get listed.</em>
            </h2>
            <p className={s.lead}>
              Limited drops. Off-menu plates. Weekday lunch perks. Points on every order. Insiders get first.
            </p>

            <div className={v.ctas}>
              <a
                href={whatsappLink(BRAND_LOCATIONS['simmer']!, 'add me to servd insiders')}
                target="_blank"
                rel="noopener noreferrer"
                className={`${s.btn} ${v.wa}`}
              >
                <MessageCircle aria-hidden size={20} strokeWidth={2.5} />
                Join on WhatsApp
                <ArrowRight aria-hidden size={20} strokeWidth={2.6} />
              </a>
              <Link href="/signup?insider=1" className={s.btn}>
                Or sign up with email
              </Link>
            </div>
            <p className={v.fine}>
              <Link href="/login" className={v.signin}>Already a member? Sign in</Link>
              <span>· free forever · cancel anytime</span>
            </p>
          </motion.div>

          <Pass sectionRef={sectionRef} />
        </div>

        <ul className={v.perks}>
          {PERKS.map((p, i) => (
            <motion.li
              key={p.head}
              className={`${v.perk} ${v[p.slug] ?? ''} ${p.featured ? v.featured : ''}`}
              initial={{ opacity: 0.001, y: 24, rotate: p.tilt * 1.5, scale: 0.96 }}
              whileInView={{ opacity: 1, y: p.featured ? -14 : 0, rotate: p.tilt, scale: 1 }}
              viewport={{ once: true, amount: 0.2, margin: '0px 0px -8% 0px' }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { default: { type: 'spring', stiffness: 260, damping: 16, delay: i * 0.06 }, opacity: { duration: 0.22, delay: i * 0.06 } }
              }
            >
              <span className={v.perkIcon} aria-hidden><p.Icon size={22} strokeWidth={2.2} /></span>
              <p className={v.perkTag}>{p.tag}</p>
              <h3 className={v.perkHead}>{p.head}</h3>
              <p className={v.perkBody}>{p.body}</p>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  )
}
