'use client'
// TactileButton — a native <button> with the rubber press and finished
// pending / success / error states. It has no look of its own: the caller's
// className and style decide everything visual, this only adds behaviour.
//
//   <TactileButton className="servd-btn-primary" state={placing ? 'loading' : 'idle'}
//                  loadingLabel="Placing order" successLabel="Placed">
//     Place order
//   </TactileButton>
//
// loading  → aria-busy + aria-disabled, clicks ignored (never native disabled,
//            which drops focus), full colour, width locked to what it was just
//            before, label lifts away and HopDots hop in.
// success  → dots collapse, a check draws in (+ successLabel), one jelly wobble
//            and a success haptic.
// error    → a short shake and an error haptic, then the label is back.
//
// Children always stay in the DOM so assistive tech keeps the button's name.
// The current state is mirrored on data-state for callers who want to paint it.

import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
  type HTMLMotionProps,
} from 'framer-motion'
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ForwardedRef,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { JELLY, tick } from '../../lib/tactile'
import { HopDots } from './HopDots'
import { useSquish } from './useSquish'
import s from './tactile.module.css'

export type TactileState = 'idle' | 'loading' | 'success' | 'error'

// framer-motion redefines these handlers with its own signatures, so the
// native versions cannot be passed straight through to motion.button.
type ConflictingHandlers =
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'

export interface TactileButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, ConflictingHandlers> {
  state?: TactileState
  /** Announced (visually hidden) while loading. Defaults to "Working". */
  loadingLabel?: string
  /** Shown beside the check on success. */
  successLabel?: string
  /** Press strength; 1 is the standard squash. */
  squish?: number
  children?: ReactNode
}

// Measure layout before paint on the client, quietly no-op on the server.
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

export const TactileButton = forwardRef<HTMLButtonElement, TactileButtonProps>(function TactileButton(
  {
    state = 'idle',
    loadingLabel = 'Working',
    successLabel,
    squish = 1,
    children,
    onClick,
    style,
    ...rest
  },
  ref,
) {
  const reduced = useReducedMotion()
  const squishProps = useSquish({ strength: squish })
  const controls = useAnimationControls()

  const nodeRef = useRef<HTMLButtonElement | null>(null)
  const setNode = useCallback(
    (node: HTMLButtonElement | null) => {
      nodeRef.current = node
      assignRef(ref, node)
    },
    [ref],
  )

  // Width lock: remember the width while idle so the pending state can hold it.
  const idleWidth = useRef<number | undefined>(undefined)
  const [lockedWidth, setLockedWidth] = useState<number | undefined>(undefined)

  useIsoLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return
    if (state === 'idle' || state === 'error') {
      idleWidth.current = node.getBoundingClientRect().width
    }
  })

  useIsoLayoutEffect(() => {
    if (state === 'loading') setLockedWidth(idleWidth.current)
    else if (state === 'idle') setLockedWidth(undefined)
  }, [state])

  // State side effects: haptics plus the one-shot body moves.
  const prevState = useRef<TactileState>(state)
  useEffect(() => {
    const prev = prevState.current
    prevState.current = state
    if (prev === state) return
    if (state === 'success') {
      tick('success')
      if (!reduced) {
        void controls.start({
          scaleX: JELLY.scaleX,
          scaleY: JELLY.scaleY,
          transition: { duration: 0.5, ease: 'easeOut' },
        })
      }
    } else if (state === 'error') {
      tick('error')
      if (!reduced) {
        void controls.start({
          x: [0, -7, 7, -5, 5, -2, 0],
          transition: { duration: 0.38, ease: 'easeOut' },
        })
      }
    }
  }, [state, reduced, controls])

  const busy = state === 'loading'
  const showLabel = state === 'idle' || state === 'error'

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      if (busy) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      onClick?.(e)
    },
    [busy, onClick],
  )

  const fade = { duration: 0.14, ease: 'easeOut' as const }

  const mergedStyle: CSSProperties = {
    ...style,
    ...(lockedWidth ? { minWidth: lockedWidth } : null),
  }

  return (
    <motion.button
      {...(rest as HTMLMotionProps<'button'>)}
      ref={setNode}
      style={mergedStyle as HTMLMotionProps<'button'>['style']}
      onClick={handleClick}
      aria-busy={busy || undefined}
      aria-disabled={busy || rest['aria-disabled'] || undefined}
      data-state={state}
      animate={controls}
      whileHover={busy ? undefined : squishProps.whileHover}
      whileTap={busy ? undefined : squishProps.whileTap}
      transition={squishProps.transition}
      onTapStart={busy ? undefined : squishProps.onTapStart}
    >
      <span className={s.stack}>
        <motion.span
          className={s.label}
          initial={false}
          animate={showLabel ? { opacity: 1, y: 0 } : { opacity: 0, y: reduced ? 0 : -6 }}
          transition={fade}
        >
          {children}
        </motion.span>

        <AnimatePresence initial={false}>
          {state === 'loading' ? (
            <motion.span
              key="loading"
              className={s.overlay}
              initial={{ opacity: 0, y: reduced ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: reduced ? 1 : 0.4 }}
              transition={fade}
            >
              <HopDots label={loadingLabel} />
            </motion.span>
          ) : null}

          {state === 'success' ? (
            <motion.span
              key="success"
              className={s.overlay}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fade}
              role="status"
            >
              <svg className={s.check} viewBox="0 0 24 24" fill="none" aria-hidden>
                <motion.path
                  d="M4.5 12.5l5 5L19.5 7"
                  stroke="currentColor"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: reduced ? 1 : 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: reduced ? 0 : 0.26, ease: 'easeOut', delay: reduced ? 0 : 0.06 }}
                />
              </svg>
              {successLabel ? <span>{successLabel}</span> : <span className={s.srOnly}>Done</span>}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
    </motion.button>
  )
})

export default TactileButton
