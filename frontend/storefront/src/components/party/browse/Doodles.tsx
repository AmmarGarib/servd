// Decorative hand-drawn doodles for the browse header — purely cosmetic,
// aria-hidden, and never the only way to reach anything (see party.md).
//
// They ride the header's 'pass' scroll progress: the star drifts up-left, the
// squiggle stretches 1→1.3 on X. The scroll transform lives on a wrapper so
// each doodle's own idle loop (spin / wiggle / bob, in CSS) keeps running.
// Without a progress value (or under reduced motion, where useScene holds at
// 1) they sit still in place.
'use client'
import { motion, useTransform, type MotionValue } from 'framer-motion'
import s from './browse.module.css'

export function Doodles({ progress }: { progress?: MotionValue<number> }) {
  return progress ? <DriftingDoodles progress={progress} /> : <DoodleArt />
}

function DriftingDoodles({ progress }: { progress: MotionValue<number> }) {
  const starX = useTransform(progress, [0, 1], [0, -56])
  const starY = useTransform(progress, [0, 1], [0, -72])
  const squiggleScale = useTransform(progress, [0, 1], [1, 1.3])
  return <DoodleArt starStyle={{ x: starX, y: starY }} squiggleStyle={{ scaleX: squiggleScale }} />
}

function DoodleArt({
  starStyle, squiggleStyle,
}: {
  starStyle?: { x: MotionValue<number>; y: MotionValue<number> }
  squiggleStyle?: { scaleX: MotionValue<number> }
}) {
  return (
    <>
      <motion.span aria-hidden className={`${s.doodle} ${s.doodleStar}`} style={starStyle}>
        <svg className={s.doodleSvg} viewBox="0 0 40 40">
          <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
        </svg>
      </motion.span>
      <motion.span aria-hidden className={`${s.doodle} ${s.doodleSquiggle}`} style={squiggleStyle}>
        <svg className={s.doodleSvg} viewBox="0 0 80 24">
          <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
        </svg>
      </motion.span>
      <span aria-hidden className={`${s.doodle} ${s.doodleDot}`}>
        <svg className={s.doodleSvg} viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" />
        </svg>
      </span>
    </>
  )
}
