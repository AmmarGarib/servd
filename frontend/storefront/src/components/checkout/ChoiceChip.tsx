'use client'

import { motion, useReducedMotion } from 'framer-motion'
import type { CSSProperties, ReactNode } from 'react'
import { useSquish } from '../tactile/useSquish'
import { SPRING } from '../../lib/tactile'
import styles from './checkout.module.css'

/* ChoiceChip — the one selectable used across checkout: the fulfilment
   chooser, the rider-tip chips and the payment options.

   - Press: an asymmetric squash from the shared tactile kit (useSquish at
     strength .6), so every choice on the page presses like the same rubber.
   - Select: the chip settles with a small spring hop, the border / fill
     transition over 160ms, and (when `dot` is on) the radio dot pops from
     0 to 1 on SPRING.pop.
   - Semantics are the caller's: `aria="pressed"` renders a toggle button
     with aria-pressed; `aria="radio"` renders role="radio" + aria-checked
     (wrap the group in role="radiogroup"). onClick is passed through as is.

   Colours stay the caller's — `selectedStyle` / `idleStyle` are the exact
   inline styles the page used before, so the brand skins that repaint them
   keep working. */

const SETTLE_EASE: [number, number, number, number] = [0.34, 1.56, 0.64, 1]

export function ChoiceChip({
  selected,
  onClick,
  aria = 'pressed',
  className,
  selectedStyle,
  idleStyle,
  dot = false,
  dotSelectedStyle,
  dotIdleStyle,
  children,
  label,
  calm = false,
}: {
  selected: boolean
  onClick: () => void
  aria?: 'pressed' | 'radio'
  className?: string
  selectedStyle: CSSProperties
  idleStyle: CSSProperties
  /** Render a trailing radio dot that pops on select. */
  dot?: boolean
  dotSelectedStyle?: CSSProperties
  dotIdleStyle?: CSSProperties
  children: ReactNode
  /** Optional accessible name when the visible content is not enough. */
  label?: string
  /** simmer's linen: a weighted, near-flat press and no settle hop. */
  calm?: boolean
}) {
  const reduce = useReducedMotion()
  const squish = useSquish({ strength: calm ? 0.2 : 0.6, hover: !calm })
  const hop = !reduce && !calm
  const semantic = aria === 'radio'
    ? { role: 'radio' as const, 'aria-checked': selected }
    : { 'aria-pressed': selected }

  return (
    <motion.button
      type="button"
      {...squish}
      {...semantic}
      aria-label={label}
      onClick={onClick}
      className={`${styles.chip}${className ? ' ' + className : ''}`}
      style={selected ? selectedStyle : idleStyle}
      initial={false}
      animate={hop && selected ? { y: [0, 2, -1.5, 0] } : { y: 0 }}
      transition={{
        ...(squish.transition ?? {}),
        // Selecting: a short keyframed settle. Otherwise y returns from the
        // press on the kit's release spring (or its 120ms fade when reduced).
        y: hop && selected
          ? { duration: 0.42, times: [0, 0.2, 0.6, 1], ease: SETTLE_EASE }
          : squish.transition,
      }}
    >
      {children}
      {dot && (
        <span className={styles.chipDot} style={selected ? dotSelectedStyle : dotIdleStyle} aria-hidden="true">
          <motion.span
            className={styles.chipDotInner}
            initial={false}
            animate={reduce ? { opacity: selected ? 1 : 0 } : { scale: selected ? 1 : 0, opacity: selected ? 1 : 0 }}
            transition={reduce ? { duration: 0.12 } : { scale: calm ? SPRING.settle : SPRING.pop, opacity: { duration: 0.1 } }}
          />
        </span>
      )}
    </motion.button>
  )
}
