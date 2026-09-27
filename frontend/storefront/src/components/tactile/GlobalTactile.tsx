'use client'
// GlobalTactile — one document-level listener that gives every pressable thing
// on the storefront a light haptic tick on touch, so individual components do
// not each have to remember. Renders nothing.
//
// Opt a subtree out with data-no-haptic. tick() itself is throttled (50ms), so
// a component that also ticks on its own press never double-buzzes.

import { useEffect } from 'react'
import { tick } from '../../lib/tactile'

const PRESSABLE = 'button, [role="button"], .servd-btn-primary, .servd-btn-secondary, .servd-btn-dark, .t-squish, .t-rubber'

export function GlobalTactile() {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      const target = e.target
      if (!(target instanceof Element)) return
      const hit = target.closest(PRESSABLE)
      if (!hit) return
      if (hit.closest('[data-no-haptic]')) return
      if (hit.matches(':disabled, [aria-disabled="true"]')) return
      tick('light')
    }
    // iOS Safari only applies :active to elements when a touchstart listener
    // exists somewhere up the tree. A passive no-op on document switches it on
    // for the whole page, so every CSS press (.servd-btn-*, .t-rubber,
    // .t-squish, the brand pills) squashes under a thumb too.
    const noop = () => {}
    const opts: AddEventListenerOptions = { capture: true, passive: true }
    document.addEventListener('pointerdown', onPointerDown, opts)
    document.addEventListener('touchstart', noop, { passive: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, opts)
      document.removeEventListener('touchstart', noop)
    }
  }, [])
  return null
}

export default GlobalTactile
