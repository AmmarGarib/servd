'use client'

// CartPill — the floating basket button, made of rubber. It is the landing
// target for fly-to-cart ([data-cart-target]); when an item lands the parent
// bumps it and it jellies, ticks, and pops an "added · {item}" speech-bubble
// sticker for 1.6s. The count and subtotal roll digit by digit.
//
// Mount it inside <AnimatePresence>: it pops in (.t-pop-in) when the basket
// goes from empty to one, and scales down on the way out.
//
// Per material: simmer gets a weighted 1px settle (no bounce), Flipd a hard
// clack, stackd and the servd hub the jelly. Reduced motion: no movement, the
// pill flashes tomato for 150ms instead.

import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { EASE_OUT, JELLY, SPRING, tick } from '../../lib/tactile'
import type { OrderBrand } from './BottomSheet'
import { RollingNumber } from './RollingNumber'
import styles from './order.module.css'

export interface CartPillProps {
  count: number
  subtotalLabel: string
  onOpen: () => void
  /** Increment to celebrate a landing. */
  bump: number
  /** Item name for the "added · …" bubble shown on the next bump. */
  note?: string
  brand?: OrderBrand
  label?: string
}

const NOTE_MS = 1600

export function CartPill({
  count, subtotalLabel, onOpen, bump, note, brand = 'hub', label = 'View basket',
}: CartPillProps) {
  const reduced = useReducedMotion()
  const controls = useAnimationControls()
  const [flash, setFlash] = useState(false)
  const [bubble, setBubble] = useState<{ id: number; text: string } | null>(null)
  const lastBump = useRef(bump)
  const flashTimer = useRef(0)
  const noteTimer = useRef(0)

  useEffect(() => {
    if (bump === lastBump.current) return
    lastBump.current = bump
    tick('light')

    if (reduced) {
      setFlash(true)
      window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlash(false), 150)
    } else if (brand === 'simmer') {
      void controls.start({ y: [0, 1, 0], transition: { duration: 0.34, ease: EASE_OUT } })
    } else if (brand === 'flipd') {
      void controls.start({
        y: [0, 4, 0],
        scaleY: [1, 0.93, 1],
        transition: { duration: 0.2, times: [0, 0.25, 1], ease: 'easeOut' },
      })
    } else {
      void controls.start({ ...JELLY, transition: { duration: 0.5, ease: 'easeOut' } })
    }

    if (note) {
      setBubble({ id: bump, text: note })
      window.clearTimeout(noteTimer.current)
      noteTimer.current = window.setTimeout(() => setBubble(null), NOTE_MS)
    }
  }, [bump, note, reduced, brand, controls])

  useEffect(() => () => {
    window.clearTimeout(flashTimer.current)
    window.clearTimeout(noteTimer.current)
  }, [])

  const pop = brand === 'simmer' ? { duration: 0.22, ease: EASE_OUT } : SPRING.pop

  return (
    <motion.div
      className={styles.pillDock}
      // The servd/stackd/Flipd entrance is the CSS .t-pop-in on the inner
      // wrapper; simmer and reduced motion just fade in.
      initial={brand === 'simmer' || reduced ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      exit={reduced ? { opacity: 0, transition: { duration: 0.15 } } : { scale: 0.55, opacity: 0, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
    >
      <span className={styles.srOnly} aria-live="polite">
        {bubble ? `Added ${bubble.text} to your basket` : ''}
      </span>
      <div className={`${styles.pillPop} ${brand === 'simmer' ? '' : 't-pop-in'}`}>
        <div className={styles.bubbleDock} aria-hidden="true">
          <AnimatePresence>
            {bubble && (
              <motion.div
                key={bubble.id}
                className={styles.bubbleWrap}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4, y: 10 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7, y: 6, transition: { duration: 0.16 } }}
                transition={reduced ? { duration: 0.15 } : pop}
                style={{ transformOrigin: '50% 100%' }}
              >
                <div className={styles.bubble}>added · {bubble.text}</div>
                <span className={styles.bubbleTail} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <motion.button
          type="button"
          data-cart-target=""
          className={`${styles.pill} ${flash ? styles.pillFlash : ''}`}
          onClick={onOpen}
          animate={controls}
          whileTap={reduced ? { opacity: 0.85 } : brand === 'simmer' ? { y: 1 } : { scaleX: 1.04, scaleY: 0.92, y: 3, transition: SPRING.press }}
          transition={brand === 'simmer' ? { duration: 0.2, ease: EASE_OUT } : SPRING.release}
          onTapStart={() => tick('light')}
          aria-label={`${label}: ${count} item${count === 1 ? '' : 's'}, ${subtotalLabel}`}
        >
          <span className={styles.pillCount}><RollingNumber value={count} decorative /></span>
          <span className={styles.pillLabel}>{label}</span>
          <span className={styles.pillSub}><RollingNumber value={subtotalLabel} decorative /></span>
        </motion.button>
      </div>
    </motion.div>
  )
}

export default CartPill
