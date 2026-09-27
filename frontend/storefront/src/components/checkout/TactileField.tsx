'use client'

import { forwardRef, useEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import styles from './checkout.module.css'

/* TactileField — the checkout's text inputs, with the focus state carried by
   a class instead of inline style mutation.

   - Focus: the ring grows via box-shadow (200ms --ease-out), the border
     colour transitions, and the field lifts to scale(1.01). The scale is
     dropped under reduced motion and on simmer (see checkout.module.css).
   - Invalid: pass `invalid`. The field gets aria-invalid and shakes once
     each time it flips from valid to invalid (`.t-shake` from the tactile
     kit, with a module-local keyframe as the source of truth).

   Everything else is a plain <input>/<textarea>: same props, same values,
   same change handlers. The inline background stays on the element so the
   brand skins in globals.css (which match `[style*="background: #fff"]`)
   keep repainting it. */

type Extra = {
  /** Marks the field invalid (aria-invalid) and shakes it once on the flip. */
  invalid?: boolean
}

function useShakeOnInvalid(invalid: boolean | undefined) {
  const [shaking, setShaking] = useState(false)
  const prev = useRef(Boolean(invalid))
  useEffect(() => {
    const now = Boolean(invalid)
    if (now && !prev.current) setShaking(true)
    prev.current = now
  }, [invalid])
  return { shaking, stop: () => setShaking(false) }
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

export const TactileInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & Extra>(
  function TactileInput({ invalid, className, onAnimationEnd, ...rest }, ref) {
    const { shaking, stop } = useShakeOnInvalid(invalid)
    return (
      <input
        ref={ref}
        {...rest}
        aria-invalid={invalid ? true : rest['aria-invalid']}
        className={cx(styles.field, shaking && styles.fieldShake, shaking && 't-shake', className)}
        onAnimationEnd={(e) => {
          if (shaking) stop()
          onAnimationEnd?.(e)
        }}
      />
    )
  },
)

export const TactileTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & Extra>(
  function TactileTextarea({ invalid, className, onAnimationEnd, ...rest }, ref) {
    const { shaking, stop } = useShakeOnInvalid(invalid)
    return (
      <textarea
        ref={ref}
        {...rest}
        aria-invalid={invalid ? true : rest['aria-invalid']}
        className={cx(styles.field, shaking && styles.fieldShake, shaking && 't-shake', className)}
        onAnimationEnd={(e) => {
          if (shaking) stop()
          onAnimationEnd?.(e)
        }}
      />
    )
  },
)
