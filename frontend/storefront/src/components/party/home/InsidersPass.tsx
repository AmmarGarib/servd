'use client'
// InsidersPass — servd's loyalty pitch as a VIP lanyard pass that swings
// in, tilts toward the pointer and catches a holographic shimmer, next to
// three perk "stickers" (one per kitchen, each in its own colours).
//
// Per the loyalty-program skill: simmer (premium) gets quiet recognition —
// no points, no coupony language, no cartoon treatment; stackd + Flipd get
// a clean, generous points mechanic. WhatsApp is the primary route
// (dominant channel in PK); the email signup and sign-in stay as backups.
//
// Film pass: every entrance is scrubbed by scroll and none starts at
// opacity 0. On touch the pass tilts and shines with the section's scroll
// progress (a twin of the mouse tilt). A signed-in guest sees "your pass",
// their tier if the loyalty endpoint answers, and a link to their points.
import Link from 'next/link'
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform, type MotionValue } from 'framer-motion'
import { ArrowRight, Coffee, Gem, MessageCircle, Trophy } from 'lucide-react'
import { BRAND_LOCATIONS, whatsappLink } from '../../../lib/brandLocations'
import { formatBrandName } from '../../../lib/concept'
import { lerp, seg, useIsCoarsePointer, usePrefersReducedMotion, useScene } from '../../../lib/film/motion'
import { useCustomerAuth } from '../../../store/customerAuth'
import s from './home.module.css'
import v from './insiders.module.css'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

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

/** A signed-in guest's tier, from the loyalty endpoint the account page already uses. Silent on any failure. */
function useTier(token: string | null): string | null {
  const [tier, setTier] = useState<string | null>(null)
  useEffect(() => {
    if (!token) { setTier(null); return }
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), 5000)
    fetch(`${API_URL}/api/v1/loyalty/account`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ tier?: unknown }>) : null))
      .then((d) => { if (d && typeof d.tier === 'string' && d.tier.trim()) setTier(d.tier.trim().toLowerCase()) })
      .catch(() => {})
      .finally(() => window.clearTimeout(timer))
    return () => { ctrl.abort(); window.clearTimeout(timer) }
  }, [token])
  return tier
}

function Pass({ sectionRef, signedIn, tier }: {
  sectionRef: RefObject<HTMLElement>
  signedIn: boolean
  tier: string | null
}) {
  const reduce = usePrefersReducedMotion()
  const coarse = useIsCoarsePointer()
  const ref = useRef<HTMLDivElement>(null)

  // Mouse: tilt toward the pointer (unchanged behaviour).
  const px = useMotionValue(0.5)
  const py = useMotionValue(0.5)
  const sx = useSpring(px, { stiffness: 200, damping: 16 })
  const sy = useSpring(py, { stiffness: 200, damping: 16 })

  // Touch twin: the section's full traversal drives the tilt and the shine.
  const pass = useScene(sectionRef, 'pass')
  const enter = useScene(sectionRef, 'enter')

  const mode = useRef({ coarse, reduce })
  mode.current = { coarse, reduce }

  const rotateY = useTransform([sx, pass], (vals: number[]) => {
    const [x = 0.5, q = 0.5] = vals
    if (mode.current.reduce) return 0
    return mode.current.coarse ? lerp(-12, 12, q) : lerp(-16, 16, x)
  })
  const rotateX = useTransform(sy, (y) => (mode.current.coarse || mode.current.reduce ? 0 : lerp(12, -12, y)))
  const shine = useTransform([sx, pass], (vals: number[]) => {
    const [x = 0.5, q = 0.5] = vals
    // On touch the sweep crosses the card while the section is mid-screen.
    const t = mode.current.coarse ? seg(q, 0.2, 0.8) : x
    return `${(t * 100).toFixed(1)}%`
  })
  const holo = useMotionTemplate`linear-gradient(115deg, transparent 20%, rgba(255,212,71,0.45) calc(${shine} - 12%), rgba(124,242,154,0.35) ${shine}, rgba(58,168,255,0.35) calc(${shine} + 10%), transparent 80%)`

  // The swing-in: scrubbed by the section's entrance, never from opacity 0.
  const swing = useTransform(enter, (e) => (mode.current.reduce ? 0 : lerp(-18, 0, seg(e, 0, 0.9))))
  const drop = useTransform(enter, (e) => (mode.current.reduce ? 0 : lerp(-60, 0, seg(e, 0, 0.9))))

  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (reduce || e.pointerType !== 'mouse') return
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    px.set((e.clientX - r.left) / r.width)
    py.set((e.clientY - r.top) / r.height)
  }

  return (
    <motion.div
      className={v.lanyard}
      aria-hidden
      data-touch={coarse ? '' : undefined}
      style={{ rotate: swing, y: drop }}
    >
      <div className={v.swing}>
        <span className={v.strap} />
        <motion.div
          ref={ref}
          className={v.pass}
          onPointerMove={onMove}
          onPointerLeave={() => { px.set(0.5); py.set(0.5) }}
          style={{ rotateX, rotateY }}
        >
          <span className={v.clip} />
          <div className={v.passTop}>
            <span className={v.passBrand}>servd<span>.</span></span>
            <span className={v.passTier}>{signedIn && tier ? tier : 'insider'}</span>
          </div>
          {signedIn ? (
            <p className={v.passTitle}>your<br /><em>pass</em></p>
          ) : (
            <p className={v.passTitle}>All-access<br /><em>pass</em></p>
          )}
          <ul className={v.passKitchens}>
            <li>{formatBrandName('stackd')}</li>
            <li>{formatBrandName('simmer')}</li>
            <li>{formatBrandName('Flipd')}</li>
          </ul>
          <div className={v.passFoot}>
            <svg viewBox="0 0 120 34" className={v.barcode} preserveAspectRatio="none">
              {[2, 6, 9, 14, 17, 19, 24, 29, 31, 35, 40, 42, 47, 50, 55, 57, 61, 66, 68, 73, 77, 80, 84, 89, 91, 96, 99, 103, 108, 111, 115].map((x, i) => (
                <rect key={x} x={x} y="0" width={i % 3 === 0 ? 2.6 : 1.3} height="34" />
              ))}
            </svg>
            <span>{signedIn ? 'member' : 'free forever'}</span>
          </div>
          <motion.span className={v.holo} style={{ background: holo }} />
        </motion.div>
      </div>
    </motion.div>
  )
}

function Perk({ p, i, progress }: { p: (typeof PERKS)[number]; i: number; progress: MotionValue<number> }) {
  // Deal-in by scroll: position and rotation only, full opacity throughout.
  const t = useTransform(progress, (e) => seg(e, i * 0.12, 0.62 + i * 0.12))
  const y = useTransform(t, (k) => lerp(64, p.featured ? -14 : 0, k))
  const rotate = useTransform(t, (k) => lerp(p.tilt * 5, p.tilt, k))
  return (
    <motion.li
      className={`${v.perk} ${v[p.slug] ?? ''} ${p.featured ? v.featured : ''}`}
      style={{ y, rotate }}
    >
      <span className={v.perkIcon} aria-hidden><p.Icon size={22} strokeWidth={2.2} /></span>
      <p className={v.perkTag}>{p.tag}</p>
      <h3 className={v.perkHead}>{p.head}</h3>
      <p className={v.perkBody}>{p.body}</p>
    </motion.li>
  )
}

export function InsidersPass() {
  const sectionRef = useRef<HTMLElement>(null)
  const perksRef = useRef<HTMLUListElement>(null)
  const copyRef = useRef<HTMLDivElement>(null)

  // The persisted auth store rehydrates on the client only; wait a tick so
  // the first client render matches the server's signed-out markup.
  const token = useCustomerAuth((st) => st.token)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const signedIn = mounted && !!token
  const tier = useTier(signedIn ? token : null)

  const copyIn = useScene(copyRef, 'enter')
  const copyY = useTransform(copyIn, (e) => lerp(28, 0, e))
  const perksIn = useScene(perksRef as RefObject<HTMLElement>, 'enter')

  return (
    <section id="insiders" ref={sectionRef} className={v.section} aria-labelledby="insiders-title">
      <div className={s.wrap}>
        <div className={v.top}>
          <motion.div ref={copyRef} style={{ y: copyY }}>
            <p className={s.eyebrow}>{signedIn ? 'Insiders · you’re in' : 'Insiders · free to join'}</p>
            <h2 id="insiders-title" className={s.h2}>
              The best stuff<br />
              <em>doesn&rsquo;t get listed.</em>
            </h2>
            <p className={s.lead}>
              Limited drops. Off-menu plates. Weekday lunch perks. Points on every order. Insiders get first.
            </p>

            {signedIn ? (
              <div className={v.ctas}>
                <Link href="/account" className={s.btn}>
                  see your points
                  <ArrowRight aria-hidden size={20} strokeWidth={2.6} />
                </Link>
              </div>
            ) : (
              <>
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
              </>
            )}
          </motion.div>

          <Pass sectionRef={sectionRef} signedIn={signedIn} tier={tier} />
        </div>

        <ul ref={perksRef} className={v.perks}>
          {PERKS.map((p, i) => (
            <Perk key={p.head} p={p} i={i} progress={perksIn} />
          ))}
        </ul>
      </div>
    </section>
  )
}
