// HopDots — the storefront's one pending indicator. Three dots that hop and
// squash on landing, pure CSS so it costs nothing to leave running. Under
// reduced motion the dots pulse opacity instead of travelling.
//
// Decorative by default (aria-hidden). Pass `label` when the dots are the only
// thing telling a screen-reader user that something is happening.

import type { CSSProperties } from 'react'
import s from './tactile.module.css'

export interface HopDotsProps {
  size?: number
  gap?: number
  color?: string
  label?: string
  className?: string
  style?: CSSProperties
}

const STAGGER_MS = 110

export function HopDots({ size = 7, gap = 5, color = 'currentColor', label, className, style }: HopDotsProps) {
  const rootStyle = { gap, ['--hop-size' as string]: `${size}px`, ...style } as CSSProperties
  return (
    <span
      className={className ? `${s.hopDots} ${className}` : s.hopDots}
      style={rootStyle}
      {...(label ? { role: 'status' as const } : { 'aria-hidden': true })}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className={s.hopDot}
          style={{
            width: size,
            height: size,
            background: color,
            ['--hop-delay' as string]: `${i * STAGGER_MS}ms`,
          } as CSSProperties}
        />
      ))}
      {label ? <span className={s.srOnly}>{label}</span> : null}
    </span>
  )
}

export default HopDots
