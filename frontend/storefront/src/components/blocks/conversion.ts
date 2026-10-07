'use client'
import { createContext, useContext } from 'react'

// The content-module conversion beacon, exposed to blocks. TrackedLayout
// (pages) and PopupFrame (pop-ups) normally count the first click / submit
// inside them as the conversion. A block whose real conversion comes later
// (the waitlist form: "Send code" is not a sign-up, the verified join is)
// marks its root with MANUAL_CONVERT_ATTR so those clicks are ignored, and
// calls useConversion()() itself. Outside a page or pop-up it is a no-op.

export const ConversionContext = createContext<(() => void) | null>(null)

export const MANUAL_CONVERT_ATTR = 'data-sv-manual-convert'

/** True when the event target sits inside a block that fires its own conversion. */
export function isManualConvertTarget(target: EventTarget | null): boolean {
  const el = target as Element | null
  return !!el?.closest?.(`[${MANUAL_CONVERT_ATTR}]`)
}

export function useConversion(): () => void {
  return useContext(ConversionContext) ?? noop
}

function noop() { /* not inside a tracked page or pop-up */ }
