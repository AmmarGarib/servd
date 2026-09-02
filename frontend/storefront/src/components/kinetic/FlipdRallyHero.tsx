'use client'
// FlipdRallyHero — the Flipd microsite hero as a scroll-driven rally.
//
// A padel court seen from the baseline: bone sky, court-blue back wall,
// turf floor in perspective. As the user scrolls, the optic ball drops
// in and bounces across the court — squashing on every contact, its
// shadow tightening under it — and each bounce stamps a word onto the
// sky: GAME → SET → SMASH. The rally ends with the smash: the burger
// lands center-court on a serving circle with the order CTAs.
//
// All scroll-scrubbed (framer useScroll/useTransform), fully reversible.
// Reduced-motion users get the static composition with the same CTAs.

import Link from 'next/link'
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionValue,
} from 'framer-motion'
import { useRef } from 'react'

interface Props {
  img: string          // the burger photograph for the final beat
  orderHref: string
  menuHref: string
}

// Bounce choreography on the 0..1 runway. Contacts stamp the words.
const CONTACTS = [0.2, 0.42, 0.62] as const
const FINALE = 0.74

export function FlipdRallyHero({ img, orderHref, menuHref }: Props) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ['start start', 'end end'] })

  // Ball flight — x sweeps left→right; y is a chain of decaying arcs
  // (0 = resting on the baseline of the floor band).
  const ballX = useTransform(p,
    [0.02, FINALE, 0.9],
    ['-36vw', '30vw', '12vw'])
  const ballY = useTransform(p,
    [0.02, CONTACTS[0], 0.31, CONTACTS[1], 0.52, CONTACTS[2], 0.68, FINALE, 0.9],
    ['-70vh', '0vh', '-30vh', '0vh', '-19vh', '0vh', '-11vh', '0vh', '0vh'])
  const ballSquash = useTransform(p,
    [0.02, CONTACTS[0] - 0.015, CONTACTS[0], CONTACTS[0] + 0.02,
     CONTACTS[1] - 0.015, CONTACTS[1], CONTACTS[1] + 0.02,
     CONTACTS[2] - 0.015, CONTACTS[2], CONTACTS[2] + 0.02, 1],
    [1, 1, 0.68, 1, 1, 0.74, 1, 1, 0.8, 1, 1])
  const ballRotate = useTransform(p, [0, 1], [0, 640])

  // Shadow hugs the floor under the ball — tight and dark at contact,
  // wide and faint at the top of each arc.
  const shadowScale = useTransform(p,
    [0.02, CONTACTS[0], 0.31, CONTACTS[1], 0.52, CONTACTS[2], 0.68, FINALE],
    [1.6, 0.72, 1.35, 0.78, 1.2, 0.84, 1.05, 0.8])
  const shadowOpacity = useTransform(p,
    [0.02, CONTACTS[0], 0.31, CONTACTS[1], 0.52, CONTACTS[2], 0.68, FINALE],
    [0.12, 0.4, 0.16, 0.38, 0.18, 0.36, 0.22, 0.38])

  // Finale — the smash lands.
  const dishY       = useTransform(p, [FINALE, FINALE + 0.1], ['-90vh', '0vh'])
  const dishOpacity = useTransform(p, [FINALE - 0.02, FINALE + 0.04], [0, 1])
  const dishScale   = useTransform(p, [FINALE, FINALE + 0.1, 0.97], [1.2, 1, 1.03])
  const ctaOpacity  = useTransform(p, [FINALE + 0.08, FINALE + 0.16], [0, 1])
  const ctaY        = useTransform(p, [FINALE + 0.08, FINALE + 0.16], [26, 0])
  const cueOpacity  = useTransform(p, [0, 0.06], [1, 0])

  // Motion streaks — visible mid-flight, gone at contacts and at rest.
  const streakOpacity = useTransform(p,
    [0.02, 0.1, CONTACTS[0], 0.31, CONTACTS[1], 0.52, CONTACTS[2], FINALE],
    [0, 0.55, 0, 0.5, 0, 0.45, 0, 0])

  if (reduce) {
    return (
      <section className="flipd-page" style={{
        minHeight: '86vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        gap: '1.4rem', padding: '6rem 1.5rem 4rem', background: 'var(--flipd-cream)',
      }}>
        <span className="flipd-marquee" style={{ fontSize: 'clamp(2.4rem, 7vw, 4.6rem)', color: 'var(--flipd-ink)' }}>
          GAME · SET · SMASH
        </span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img} alt="A Flipd smash burger" style={{ width: 'min(26rem, 78vw)', borderRadius: '50%', aspectRatio: '1', objectFit: 'cover', border: '4px solid var(--flipd-ink)' }} />
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <Link href={orderHref} className="flipd-btn">Order now</Link>
          <Link href={menuHref} className="flipd-btn flipd-btn-ghost">See the menu</Link>
        </div>
      </section>
    )
  }

  return (
    <div ref={ref} style={{ height: '420vh', position: 'relative' }}>
      <section
        aria-label="Flipd — game, set, smash"
        style={{
          position: 'sticky', top: 0, height: '100vh', overflow: 'hidden',
          background: 'var(--flipd-cream)',
        }}
      >
        {/* ── COURT ──────────────────────────────────────────────────── */}
        {/* back wall — court blue band with a bone service line */}
        <div aria-hidden style={{
          position: 'absolute', left: 0, right: 0, bottom: '30%', height: '13%',
          background: 'var(--flipd-sky)',
          borderTop: '3px solid var(--flipd-ink)',
          borderBottom: '4px solid var(--flipd-cream)',
          boxShadow: 'inset 0 -10px 24px rgba(9,13,23,0.25)',
        }}>
          <div style={{
            position: 'absolute', top: '46%', left: 0, right: 0, height: 3,
            background: 'rgba(237,230,211,0.55)',
          }} />
        </div>
        {/* floor — turf in perspective with bone court lines */}
        <div aria-hidden style={{
          position: 'absolute', left: '-14%', right: '-14%', bottom: 0, height: '30%',
          transformOrigin: 'top center',
          transform: 'perspective(760px) rotateX(38deg)',
          background: `
            linear-gradient(180deg, #55a53c 0%, var(--flipd-green-deep) 100%)
          `,
          borderTop: '4px solid var(--flipd-cream)',
        }}>
          {/* court lines */}
          <div style={{ position: 'absolute', inset: 0, background: `
            linear-gradient(90deg, transparent calc(50% - 2px), rgba(237,230,211,0.75) calc(50% - 2px), rgba(237,230,211,0.75) calc(50% + 2px), transparent calc(50% + 2px)),
            linear-gradient(0deg, transparent 54%, rgba(237,230,211,0.7) 54%, rgba(237,230,211,0.7) 55.2%, transparent 55.2%),
            repeating-linear-gradient(90deg, rgba(9,13,23,0.05) 0 90px, transparent 90px 180px)
          ` }} />
        </div>

        {/* ── WORD STAMPS — GAME · SET · SMASH ───────────────────────── */}
        <div aria-hidden style={{
          position: 'absolute', top: 'clamp(4.5rem, 13vh, 8rem)', left: 0, right: 0,
          display: 'flex', justifyContent: 'center', alignItems: 'baseline',
          gap: 'clamp(0.9rem, 3vw, 2.2rem)', padding: '0 1rem',
          flexWrap: 'wrap',
        }}>
          {(['GAME', 'SET', 'SMASH'] as const).map((word, i) => (
            <WordStamp key={word} p={p} at={CONTACTS[i]!} word={word} final={i === 2} />
          ))}
        </div>

        {/* ── SCOREBOARD — ticks with the rally ──────────────────────── */}
        <div aria-hidden style={{
          position: 'absolute', top: 'clamp(1rem, 3vh, 2rem)', right: 'clamp(1rem, 3vw, 2.2rem)',
          background: 'var(--flipd-ink)', color: 'var(--flipd-cream)',
          border: '2px solid var(--flipd-ink)',
          borderRadius: '0.55rem',
          boxShadow: '0 4px 0 var(--flipd-green-deep), 0 10px 26px rgba(9,13,23,0.25)',
          padding: '0.55rem 0.9rem',
          display: 'flex', alignItems: 'baseline', gap: '0.7rem',
        }}>
          <span className="flipd-type" style={{ fontSize: '0.62rem', letterSpacing: '0.26em', textTransform: 'uppercase', opacity: 0.65 }}>
            flipd · serving
          </span>
          <span style={{ position: 'relative', display: 'inline-block', minWidth: '6ch', textAlign: 'right' }}>
            {(['LOVE', '15', '30', 'SMASH'] as const).map((v, i) => (
              <ScoreValue key={v} p={p} value={v} index={i} />
            ))}
          </span>
        </div>

        {/* ── BALL + SHADOW ──────────────────────────────────────────── */}
        <motion.div aria-hidden style={{
          x: ballX, scaleX: shadowScale, opacity: shadowOpacity,
          position: 'absolute', bottom: '26.5%', left: '50%',
          width: 'clamp(7rem, 11vw, 10rem)', height: '1.6rem',
          marginLeft: 'clamp(-3.5rem, -5.5vw, -5rem)',
          borderRadius: '50%', background: '#0a1a10',
          filter: 'blur(6px)',
        }} />
        <motion.div aria-hidden style={{
          x: ballX, y: ballY,
          position: 'absolute', bottom: '26%', left: '50%',
          width: 'clamp(8rem, 13vw, 12rem)',
          marginLeft: 'clamp(-4rem, -6.5vw, -6rem)',
        }}>
          {/* speed streaks trailing the flight */}
          <motion.div style={{
            opacity: streakOpacity,
            position: 'absolute', top: '38%', right: '92%',
            display: 'flex', flexDirection: 'column', gap: '0.5rem',
            transform: 'rotate(-14deg)',
          }}>
            <span style={{ display: 'block', width: '4.2rem', height: 4, borderRadius: 999, background: 'var(--flipd-optic)' }} />
            <span style={{ display: 'block', width: '2.8rem', height: 4, borderRadius: 999, background: 'var(--flipd-optic)', opacity: 0.65, marginLeft: '1rem' }} />
            <span style={{ display: 'block', width: '1.8rem', height: 4, borderRadius: 999, background: 'var(--flipd-optic)', opacity: 0.4, marginLeft: '0.4rem' }} />
          </motion.div>
          <motion.div style={{ scaleY: ballSquash, rotate: ballRotate, transformOrigin: '50% 100%' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/flipd/ball.png" alt="" style={{ width: '100%', height: 'auto', display: 'block' }} />
          </motion.div>
        </motion.div>

        {/* ── FINALE — the smash lands center court ──────────────────── */}
        <motion.div style={{
          y: dishY, opacity: dishOpacity, scale: dishScale,
          position: 'absolute', left: 0, right: 0, bottom: '16%',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.1rem',
          pointerEvents: 'none',
        }}>
          {/* confetti burst radiating from the landing */}
          <div aria-hidden style={{ position: 'absolute', top: '38%', left: '50%', width: 0, height: 0 }}>
            {CONFETTI.map((c, i) => (
              <ConfettiPiece key={i} p={p} {...c} />
            ))}
          </div>
          <div style={{
            width: 'min(34vh, 64vw)', height: 'min(34vh, 64vw)',
            borderRadius: '50%', overflow: 'hidden',
            border: '5px solid var(--flipd-ink)',
            boxShadow: '0 10px 0 var(--flipd-ink), 0 34px 70px rgba(9,13,23,0.4)',
            background: 'var(--flipd-pale)',
          }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt="A Flipd smash burger, served court-side" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <motion.div style={{
            opacity: ctaOpacity, y: ctaY,
            display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center',
            pointerEvents: 'auto',
          }} className="flipd-page">
            <Link href={orderHref} className="flipd-btn">Order now</Link>
            <Link href={menuHref} className="flipd-btn flipd-btn-ghost">See the menu</Link>
          </motion.div>
        </motion.div>

        {/* ── SCROLL CUE ─────────────────────────────────────────────── */}
        <motion.div style={{
          opacity: cueOpacity,
          position: 'absolute', bottom: '2rem', left: 0, right: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.45rem',
          pointerEvents: 'none',
        }}>
          <span className="flipd-eyebrow" style={{ color: 'var(--flipd-ink)' }}>scroll — serve's up</span>
          <span className="kp-chevron" aria-hidden style={{ borderColor: 'var(--flipd-ink)' }} />
        </motion.div>
      </section>
    </div>
  )
}

// One scoreboard value — visible only during its stretch of the rally.
function ScoreValue({ p, value, index }: {
  p: MotionValue<number>; value: string; index: number
}) {
  const edges = [0, ...CONTACTS, 1.01]
  const a = edges[index]!
  const b = edges[index + 1]!
  const opacity = useTransform(p, [a, a + 0.008, b, b + 0.008], [index === 0 ? 1 : 0, 1, 1, 0])
  const y = useTransform(p, [a, a + 0.02], [index === 0 ? 0 : 8, 0])
  return (
    <motion.span className="flipd-marquee" style={{
      opacity, y,
      position: index === 0 ? 'relative' : 'absolute',
      right: 0, top: 0,
      fontSize: '1.05rem', lineHeight: 1,
      color: value === 'SMASH' ? 'var(--flipd-optic)' : 'var(--flipd-cream)',
      whiteSpace: 'nowrap',
    }}>
      {value}
    </motion.span>
  )
}

// Confetti geometry — angle (deg), distance (px), size, color, spin.
const CONFETTI = [
  { angle: -80, dist: 300, w: 14, h: 22, color: 'var(--flipd-optic)', spin: 260 },
  { angle: -55, dist: 360, w: 12, h: 12, color: 'var(--flipd-sky)', spin: -200 },
  { angle: -30, dist: 320, w: 16, h: 10, color: 'var(--flipd-cream)', spin: 320 },
  { angle: -10, dist: 380, w: 10, h: 18, color: 'var(--flipd-green)', spin: -280 },
  { angle: -100, dist: 340, w: 10, h: 16, color: 'var(--flipd-sky)', spin: 240 },
  { angle: -125, dist: 330, w: 14, h: 10, color: 'var(--flipd-green)', spin: -300 },
  { angle: -150, dist: 360, w: 12, h: 20, color: 'var(--flipd-optic)', spin: 210 },
  { angle: -170, dist: 300, w: 12, h: 12, color: 'var(--flipd-cream)', spin: -240 },
  { angle: -65, dist: 210, w: 8, h: 14, color: 'var(--flipd-green)', spin: 180 },
  { angle: -115, dist: 220, w: 9, h: 9, color: 'var(--flipd-optic)', spin: -160 },
  { angle: -20, dist: 220, w: 8, h: 12, color: 'var(--flipd-sky)', spin: 200 },
  { angle: -160, dist: 215, w: 9, h: 13, color: 'var(--flipd-sky)', spin: -190 },
] as const

function ConfettiPiece({ p, angle, dist, w, h, color, spin }: {
  p: MotionValue<number>
  angle: number; dist: number; w: number; h: number; color: string; spin: number
}) {
  const rad = (angle * Math.PI) / 180
  const window: [number, number] = [FINALE + 0.02, FINALE + 0.16]
  const x = useTransform(p, window, [0, Math.cos(rad) * dist])
  // Rise on the burst, then gravity pulls the tail of the flight down.
  const y = useTransform(p, [window[0], (window[0] + window[1]) / 2, window[1]],
    [0, Math.sin(rad) * dist, Math.sin(rad) * dist + 90])
  const opacity = useTransform(p, [window[0], window[0] + 0.02, window[1] - 0.02, window[1]], [0, 1, 1, 0])
  const rotate = useTransform(p, window, [0, spin])
  return (
    <motion.span style={{
      x, y, opacity, rotate,
      position: 'absolute',
      width: w, height: h,
      borderRadius: 2,
      background: color,
      border: '1.5px solid var(--flipd-ink)',
      display: 'block',
    }} />
  )
}

// One stamped word — slams in (big → resting) at its bounce contact.
function WordStamp({ p, at, word, final }: {
  p: MotionValue<number>; at: number; word: string; final?: boolean
}) {
  const opacity = useTransform(p, [at - 0.005, at + 0.02], [0, 1])
  const scale   = useTransform(p, [at - 0.005, at + 0.035], [2.6, 1])
  const rotate  = useTransform(p, [at - 0.005, at + 0.035], [final ? 5 : -4, final ? -2 : 1.5])
  return (
    <motion.span className="flipd-marquee" style={{
      opacity, scale, rotate,
      display: 'inline-block',
      fontSize: final ? 'clamp(3.4rem, 10.5vw, 7.5rem)' : 'clamp(2.6rem, 8vw, 5.8rem)',
      lineHeight: 0.95,
      color: final ? 'var(--flipd-cream)' : 'var(--flipd-ink)',
      background: final ? 'var(--flipd-ink)' : 'transparent',
      padding: final ? '0.1em 0.32em' : 0,
      borderRadius: final ? '0.12em' : 0,
      boxShadow: final ? '0 6px 0 var(--flipd-green-deep), 0 18px 44px rgba(9,13,23,0.3)' : 'none',
      textShadow: final ? 'none' : '0 4px 0 rgba(9,13,23,0.14)',
    }}>
      {word}
    </motion.span>
  )
}
