'use client'
// useSquish — the rubber press for any motion.* element.
//
//   const squish = useSquish()
//   <motion.button {...squish}>Order</motion.button>
//
// Down squashes wide and short and sinks 2px; up springs back past rest and
// settles (SPRING.release). Under reduced motion the press becomes a brief
// opacity dip — calmer, never dead.

import { useReducedMotion, type TargetAndTransition, type Transition } from 'framer-motion'
import { useCallback, useMemo } from 'react'
import { SPRING, tick } from '../../lib/tactile'

export interface SquishOptions {
  /** 1 = the standard press. 1.4 or so for a primary commit, 0.5 for chips. */
  strength?: number
  /** Lift on hover. Off for elements that already move on hover. */
  hover?: boolean
  /** Fire a light haptic tick on press. */
  haptic?: boolean
}

export interface SquishProps {
  whileHover?: TargetAndTransition
  whileTap: TargetAndTransition
  transition: Transition
  onTapStart: () => void
}

export function useSquish({ strength = 1, hover = true, haptic = true }: SquishOptions = {}): SquishProps {
  const reduced = useReducedMotion()
  const s = strength

  const onTapStart = useCallback(() => {
    if (haptic) tick('light')
  }, [haptic])

  return useMemo<SquishProps>(() => {
    if (reduced) {
      return {
        whileTap: { opacity: 0.82 },
        transition: { duration: 0.12 },
        onTapStart,
      }
    }
    return {
      whileTap: {
        scaleX: 1 + 0.04 * s,
        scaleY: 1 - 0.08 * s,
        y: 2 * s,
        transition: SPRING.press,
      },
      ...(hover ? { whileHover: { y: -2 * s, scale: 1 + 0.015 * s } } : {}),
      transition: SPRING.release,
      onTapStart,
    }
  }, [reduced, s, hover, onTapStart])
}

export default useSquish
