'use client'
// Scene 2 of the simmer take: the title card after the door.
//
// "gs foods presents", the wordmark surfacing letter by letter, the tagline
// set below it, a hairline, then five credit lines. It used to play once on a
// timer after an IntersectionObserver fired, which left a dead tiber screen
// between the walk-in and tonight's service whenever a frame was caught
// before it fired. Now it is scrubbed by scroll: every letter and line is a
// function of how far its block has entered the viewport ('enter' progress),
// revealed by clip + translate and never below 0.35 opacity. So any scroll
// offset shows a composed, readable card, and scrolling back runs it in
// reverse. Bone only: no orange in this scene.
//
// Reduced motion: useScene pins progress at 1, the final set card.

import { useRef, type CSSProperties, type ReactNode } from 'react'
import { motion, useTransform, type MotionValue } from 'framer-motion'
import { lerp, seg, useScene } from '../../../lib/film/motion'
import s from './simmer.module.css'

const pad = 'clamp(1.25rem, 5vw, 3rem)'

/** 0..1 for item `i` of `n` inside the block's progress, staggered. */
function stagger(p: number, i: number, n: number, span = 0.5) {
  const step = n > 1 ? (1 - span) / (n - 1) : 0
  return seg(p, i * step, i * step + span)
}

function ScrubLetter({ ch, i, n, p }: { ch: string; i: number; n: number; p: MotionValue<number> }) {
  const t = useTransform(p, (v) => stagger(v, i, n, 0.55))
  const opacity = useTransform(t, (v) => lerp(0.35, 1, v))
  const y = useTransform(t, (v) => `${lerp(0.22, 0, v)}em`)
  // Surfaces from the baseline up: the top of the letter is clipped away
  // first, as if it were rising out of the dark.
  const clipPath = useTransform(t, (v) => `inset(${lerp(38, 0, v).toFixed(2)}% -10% -20% -10%)`)
  return (
    <motion.span className={s.scrubLetter} style={{ opacity, y, clipPath }}>
      {ch === ' ' ? ' ' : ch}
    </motion.span>
  )
}

function ScrubLine({ i, n, p, children }: { i: number; n: number; p: MotionValue<number>; children: ReactNode }) {
  const t = useTransform(p, (v) => stagger(v, i, n, 0.45))
  const opacity = useTransform(t, (v) => lerp(0.35, 1, v))
  const y = useTransform(t, (v) => `${lerp(48, 0, v)}%`)
  return (
    <span className={s.line}>
      <motion.span style={{ opacity, y }}>{children}</motion.span>
    </span>
  )
}

function ScrubRise({ p, at, children, style, className }: {
  p: MotionValue<number>
  at: [number, number]
  children: ReactNode
  style?: CSSProperties
  className?: string
}) {
  const t = useTransform(p, (v) => seg(v, at[0], at[1]))
  const opacity = useTransform(t, (v) => lerp(0.35, 1, v))
  const y = useTransform(t, (v) => lerp(16, 0, v))
  return (
    <motion.p className={className} style={{ ...style, opacity, y }}>
      {children}
    </motion.p>
  )
}

const CREDITS = [
  'small plates, to share.',
  'mocktails, stirred slow.',
  'a dark room below stackd.',
  'tuesday to sunday,',
  'seven till late.',
]

export function TitleCard() {
  const markRef = useRef<HTMLDivElement>(null)
  const creditsRef = useRef<HTMLParagraphElement>(null)
  const pMark = useScene(markRef, 'enter')
  const pCredits = useScene(creditsRef, 'enter')
  const rule = useTransform(pMark, (v) => seg(v, 0.7, 1))
  const word = 'simmer'
  const letters = Array.from(word)

  return (
    <section
      aria-label="simmer, the room"
      style={{ padding: `clamp(4rem, 11vh, 7rem) ${pad} clamp(4rem, 11vh, 7rem)`, textAlign: 'center' }}
    >
      <div ref={markRef} style={{ maxWidth: '60rem', margin: '0 auto' }}>
        <ScrubRise p={pMark} at={[0, 0.3]} className={s.utility} style={{ margin: 0 }}>
          gs foods presents
        </ScrubRise>
        <p className={s.amarante} style={{ fontSize: 'clamp(5.2rem, 21vw, 13rem)', lineHeight: 0.9, margin: '1.6rem 0 0' }}>
          <span style={{ whiteSpace: 'nowrap' }}>
            <span className={s.srOnly}>{word}</span>
            <span aria-hidden="true">
              {letters.map((ch, i) => (
                <ScrubLetter key={i} ch={ch} i={i} n={letters.length} p={pMark} />
              ))}
            </span>
          </span>
        </p>
        {/* Tagline always below the wordmark, never above. */}
        <ScrubRise
          p={pMark}
          at={[0.45, 0.85]}
          className={s.amarante}
          style={{ fontSize: 'clamp(1.5rem, 3.6vw, 2.3rem)', margin: '1.2rem 0 0' }}
        >
          simmer down.
        </ScrubRise>
        <motion.span
          aria-hidden="true"
          className={s.rule}
          style={{ width: 'min(14rem, 50%)', margin: '3rem auto 2.6rem', opacity: 0.35, scaleX: rule, transformOrigin: 'center' }}
        />
      </div>
      <p
        ref={creditsRef}
        className={s.amarante}
        style={{ fontSize: 'clamp(1.7rem, 4.6vw, 3.2rem)', lineHeight: 1.18, margin: '0 auto', maxWidth: '48rem' }}
      >
        {CREDITS.map((line, i) => (
          <ScrubLine key={line} i={i} n={CREDITS.length} p={pCredits}>{line}</ScrubLine>
        ))}
      </p>
    </section>
  )
}
