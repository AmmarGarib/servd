'use client'
import type { CSSProperties } from 'react'

/**
 * KineticShape — atmospheric decorative element used to give pages the
 * "modern agency" feel of floating 3D motifs without shipping actual 3D
 * renders. The shape variants cover the three patterns the design wants:
 *
 *   blob   — soft glowing radial blur, the default atmosphere
 *   crisp  — solid coloured shape, no blur (mimics a 3D decal)
 *   ring   — outlined circle, useful for layering over photography
 *   emoji  — render an emoji as a giant 3D-ish motif (food orbs etc.)
 *
 * Position via the standard `style.top/left/right/bottom`. Size in `size`
 * (px). Colour falls back to whatever --brand-accent is on the parent.
 */

type Variant = 'blob' | 'crisp' | 'ring' | 'emoji'

interface Props {
  variant?: Variant
  size?: number
  color?: string                  // CSS colour; defaults to current --brand-accent
  emoji?: string                  // only used when variant='emoji'
  spin?: boolean                  // slow infinite rotation
  style?: CSSProperties
  className?: string
  ariaHidden?: boolean
}

export function KineticShape({
  variant = 'blob',
  size = 220,
  color,
  emoji,
  spin = false,
  style,
  className = '',
  ariaHidden = true,
}: Props) {
  const baseStyle: CSSProperties = {
    width: size,
    height: size,
    ['--shape-color' as string]: color ?? 'var(--brand-accent)',
    ...style,
  }

  if (variant === 'emoji') {
    // Emoji motifs are absolutely positioned + scaled so they read as
    // floating decals. Drop shadow gives the food/object the illusion of
    // sitting in 3D space without needing real 3D assets.
    return (
      <span
        aria-hidden={ariaHidden}
        className={`pointer-events-none absolute select-none ${spin ? 'spin-slow' : ''} ${className}`}
        style={{
          fontSize: size,
          lineHeight: 1,
          filter: 'drop-shadow(0 22px 28px rgba(0,0,0,0.25))',
          opacity: 0.95,
          ...style,
        }}
      >
        {emoji ?? '✨'}
      </span>
    )
  }

  const variantClass =
    variant === 'crisp' ? 'kinetic-shape shape-crisp' :
    variant === 'ring'  ? 'kinetic-shape shape-ring' :
                          'kinetic-shape'

  return (
    <span
      aria-hidden={ariaHidden}
      className={`${variantClass} ${spin ? 'spin-slow' : ''} ${className}`}
      style={baseStyle}
    />
  )
}
