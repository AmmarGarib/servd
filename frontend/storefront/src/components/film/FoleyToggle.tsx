'use client'

/**
 * FoleyToggle — the "sound" pill for the nav. Sound is off by default; the
 * click that turns it on is the user gesture that creates the AudioContext,
 * and it plays a chime so the change is heard. The equaliser bars only move
 * while sound is on (and never under reduced motion).
 */
import { useEffect, useState } from 'react'
import { isSoundOn, onSoundChange, setSoundOn, sfx } from '@/lib/film/sfx'
import { haptic } from '@/lib/haptics'
import styles from './foley.module.css'

export function FoleyToggle({ tone = 'light' }: { tone?: 'light' | 'dark' }): JSX.Element {
  // Off on the server and the first client render; synced from storage after.
  const [on, setOn] = useState(false)

  useEffect(() => {
    setOn(isSoundOn())
    return onSoundChange(setOn)
  }, [])

  const toggle = () => {
    const next = !on
    setSoundOn(next)
    setOn(next)
    haptic(8)
    if (next) sfx('chime')
  }

  const label = on ? 'sound on' : 'sound off'
  return (
    <button
      type="button"
      className={`${styles.pill} ${tone === 'dark' ? styles.dark : styles.light}`}
      aria-pressed={on}
      data-on={on ? 'true' : 'false'}
      onClick={toggle}
      title={on ? 'turn sound off' : 'turn sound on'}
    >
      <svg className={styles.eq} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <rect className={styles.bar} x="2" y="3" width="3" height="11" rx="1.5" />
        <rect className={styles.bar} x="6.5" y="3" width="3" height="11" rx="1.5" />
        <rect className={styles.bar} x="11" y="3" width="3" height="11" rx="1.5" />
      </svg>
      <span className={styles.label}>{label}</span>
    </button>
  )
}

export default FoleyToggle
