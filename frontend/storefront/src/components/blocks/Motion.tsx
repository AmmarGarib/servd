// The wrapper a block gets when it has a scroll effect (block.motion). Plain
// markup with inline custom properties — no hooks, so it renders on the
// server (PageRenderer) and needs no JS: in browsers with scroll-driven
// animations motion.css does everything; elsewhere MotionRuntime's small
// engine drives the same @keyframes. The values come from lib/motion.ts.
//
// The view-timeline subject is always the untransformed .sv-motion wrapper;
// the element that moves is .sv-motion-target. No wrapper gets a layout style
// (position, overflow…) — only pin-reveal's sticky child and its static track.

import type { CSSProperties, ReactNode } from 'react'
import { MOTION_SPECS, motionVars, type NormalizedMotion } from '../../lib/motion'
import './motion.css'

export function MotionWrap({ motion, stackIndex = 0, children }: {
  motion: NormalizedMotion
  /** sticky-stack: this block's position in its run of stack blocks. */
  stackIndex?: number
  children: ReactNode
}) {
  const spec = MOTION_SPECS[motion.preset]
  const vars = motionVars(motion)
  const common = { 'data-sv-motion': motion.preset, 'data-sv-intensity': motion.intensity }

  if (spec.structure === 'stack') {
    const style = { '--sv-stack-i': String(stackIndex), ...vars } as CSSProperties
    return (
      <div className="sv-motion sv-stack-card" {...common} {...(stackIndex === 0 && { 'data-sv-stack-first': '' })} style={style}>
        {children}
      </div>
    )
  }
  if (spec.structure === 'pin') {
    return (
      <div className="sv-motion" {...common} style={vars as CSSProperties}>
        <div className="sv-motion-pin"><div className="sv-motion-target">{children}</div></div>
        <div className="sv-motion-track" aria-hidden="true" />
      </div>
    )
  }
  return (
    <div className="sv-motion" {...common} style={vars as CSSProperties}>
      <div className="sv-motion-target">{children}</div>
    </div>
  )
}
