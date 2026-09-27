'use client'
// InsidersPass: servd's loyalty pitch as a VIP lanyard pass that sways on
// its strap, tilts toward the pointer and catches a holographic shimmer.
// Tapping it gives the same flash, and the crowd cheers. Next to it are three
// perk "stickers", one per kitchen, each in its own colours.
//
// Per the loyalty-program skill: simmer (premium) gets quiet recognition,
// with no points, no coupony language and no cartoon treatment. Its sticker
// stays typographic. stackd and Flipd get a clean, generous points mechanic,
// fronted by their own cast faces (coffee, burger), which doze at night.
// WhatsApp is the primary route (the dominant channel in PK); the email
// signup and sign-in stay as backups.
//
// Reveal hygiene: SSR is final. Blocks below the fold are armed at opacity .4
// and settle in ≤ 450 ms.
import Link from 'next/link'
import { useRef, type CSSProperties, type PointerEvent } from 'react'
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import { ArrowRight, MessageCircle } from 'lucide-react'
import { BRAND_LOCATIONS, whatsappLink } from '../../../lib/brandLocations'
import { emitCrowd } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
import { Motes } from '../../world/Ambient'
import { DozyCameo } from '../PartyHero'
import { useReveal } from './Divider'
import s from './home.module.css'
import v from './insiders.module.css'

const PERKS = [
  {
    slug: 'simmer',
    face: undefined as CharacterKind | undefined,
    tag: 'simmer · regulars',
    head: 'The regulars’ list',
    body: 'Quiet recognition. First word on the next menu drop. A held table when the room is full. Now and then the chef sends out a plate. No card, no points — you’re known here.',
    tilt: -2,
    featured: false,
  },
  {
    slug: 'stackd',
    face: 'coffee' as CharacterKind | undefined,
    tag: 'stackd · counter club',
    head: 'Five coffees in, the sixth is on us',
    body: 'Buy five drinks at stackd and the sixth is on the house. Insiders also get first look at the pastry case before the morning bake goes out to the floor.',
    tilt: 1.5,
    featured: true,
  },
  {
    slug: 'flipd',
    face: 'burger' as CharacterKind | undefined,
    tag: 'Flipd · points',
    head: 'Points on every box',
    body: 'Earn 1 point per Rs. 10 spent at Flipd. Free weekday lunch delivery for members. Redeem points for a meal at 2,000.',
    tilt: -1,
    featured: false,
  },
]

function Pass() {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const [slotRef, reveal] = useReveal<HTMLDivElement>()
  const flashTimer = useRef<number | undefined>(undefined)
  const px = useMotionValue(0.5)
  const py = useMotionValue(0.5)
  const sx = useSpring(px, { stiffness: 200, damping: 16 })
  const sy = useSpring(py, { stiffness: 200, damping: 16 })
  const rotateY = useTransform(sx, [0, 1], [-16, 16])
  const rotateX = useTransform(sy, [0, 1], [12, -12])
  const shine = useTransform(sx, (x) => `${x * 100}%`)
  const holo = useMotionTemplate`linear-gradient(115deg, transparent 20%, rgba(255,212,71,0.45) calc(${shine} - 12%), rgba(124,242,154,0.35) ${shine}, rgba(58,168,255,0.35) calc(${shine} + 10%), transparent 80%)`

  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType !== 'mouse') return
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    px.set((e.clientX - r.left) / r.width)
    py.set((e.clientY - r.top) / r.height)
  }

  // Tap (or click): the holo flashes across the pass, the same as a hover
  // sweep, and the whole crowd cheers.
  function onDown() {
    const el = slotRef.current
    if (el) {
      el.setAttribute('data-flash', '1')
      window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => {
        el.removeAttribute('data-flash')
        px.set(0.5)
        py.set(0.5)
      }, 750)
    }
    if (!reduce) {
      px.jump(0.05)
      px.set(0.95)
      py.set(0.35)
    }
    emitCrowd({ type: 'cheer' })
  }

  return (
    <div ref={slotRef} className={`${v.lanyard} ${s.rv}`} data-reveal={reveal} aria-hidden>
      <div className={v.swing}>
        <span className={v.strap} />
        <motion.div
          ref={ref}
          className={v.pass}
          onPointerMove={onMove}
          onPointerLeave={() => { px.set(0.5); py.set(0.5) }}
          onPointerDown={onDown}
          style={{ rotateX, rotateY }}
        >
          <span className={v.clip} />
          <div className={v.passTop}>
            <span className={v.passBrand}>servd<span>.</span></span>
            <span className={v.passTier}>insider</span>
          </div>
          <p className={v.passTitle}>All-access<br /><em>pass</em></p>
          <ul className={v.passKitchens}>
            <li>stackd</li>
            <li>simmer</li>
            <li>Flipd</li>
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
    </div>
  )
}

type Perk = (typeof PERKS)[number]

function PerkCard({ p, index }: { p: Perk; index: number }) {
  const [ref, reveal] = useReveal<HTMLLIElement>()
  return (
    <li
      ref={ref}
      className={`${v.perkSlot} ${s.rv} ${p.featured ? v.featured : ''}`}
      data-reveal={reveal}
      style={{ '--ri': Math.min(index, 2), '--tilt': `${p.tilt}deg` } as CSSProperties}
    >
      <div className={`${v.perk} ${v[p.slug] ?? ''}`} tabIndex={-1}>
        {p.face ? (
          <span className={v.perkFace} aria-hidden>
            <DozyCameo kind={p.face} pose="idle" size={58} delay={index * 350} />
          </span>
        ) : (
          <span className={v.perkRule} aria-hidden />
        )}
        <p className={v.perkTag}>{p.tag}</p>
        <h3 className={v.perkHead}>{p.head}</h3>
        <p className={v.perkBody}>{p.body}</p>
      </div>
    </li>
  )
}

export function InsidersPass() {
  const [copyRef, copyReveal] = useReveal<HTMLDivElement>()
  return (
    <section className={v.section} aria-labelledby="insiders-title">
      <Motes className={s.motes} count={7} seed={42} color="rgba(78, 42, 79, 0.26)" />
      <div className={s.wrap}>
        <div className={v.top}>
          <div ref={copyRef} className={s.rv} data-reveal={copyReveal}>
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
          </div>

          <Pass />
        </div>

        <ul className={v.perks}>
          {PERKS.map((p, i) => <PerkCard key={p.head} p={p} index={i} />)}
        </ul>
      </div>
    </section>
  )
}
