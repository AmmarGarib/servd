// Decorative sky for the browse header — the day-part orb (sun by day, a
// crescent at night), stars after dark, warm motes by day, and the hand-drawn
// doodles. Purely cosmetic, aria-hidden, never the only way to reach anything.
// The tint itself comes from the world tokens on <html>, so the first paint
// already matches the hour.
import { Motes, Stars } from '../../world/Ambient'
import s from './browse.module.css'

export function Doodles() {
  return (
    <>
      <span aria-hidden className={s.orb} />
      <Stars count={26} seed="browse-sky" className={s.ambient} />
      <Motes count={12} seed="browse-sky" className={s.ambient} />
      <svg aria-hidden className={`${s.doodle} ${s.doodleStar}`} viewBox="0 0 40 40">
        <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleSquiggle}`} viewBox="0 0 80 24">
        <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
      </svg>
      <svg aria-hidden className={`${s.doodle} ${s.doodleDot}`} viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8" />
      </svg>
    </>
  )
}
