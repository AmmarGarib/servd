'use client'
// Decorative hand-drawn doodles for the browse header — purely cosmetic,
// aria-hidden, and never the only way to reach anything (see party.md).
// When the filter changes they get a one-shot 400ms wiggle punch, as if the
// page had been nudged.

import { useEffect, useRef, useState } from 'react'
import s from './browse.module.css'

const PUNCH_MS = 400

export function Doodles({ punchKey }: { punchKey?: string | number }) {
  const [punch, setPunch] = useState(false)
  const first = useRef(true)
  const timer = useRef<number | undefined>(undefined)
  const raf = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (first.current) { first.current = false; return }
    // Restart cleanly if a punch is already running: drop the class for a
    // frame so the animation can play again from the top.
    setPunch(false)
    window.clearTimeout(timer.current)
    if (raf.current) cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      setPunch(true)
      timer.current = window.setTimeout(() => setPunch(false), PUNCH_MS)
    })
  }, [punchKey])

  useEffect(() => () => {
    window.clearTimeout(timer.current)
    if (raf.current) cancelAnimationFrame(raf.current)
  }, [])

  return (
    <div aria-hidden className={`${s.doodles} ${punch ? s.doodlesPunch : ''}`}>
      <svg aria-hidden className={`${s.doodle} ${s.doodleStar}`} viewBox="0 0 40 40">
        <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleSquiggle}`} viewBox="0 0 80 24">
        <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleDot}`} viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8" />
      </svg>
    </div>
  )
}
