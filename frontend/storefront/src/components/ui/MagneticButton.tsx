'use client'
import * as React from 'react'
import { useEffect, useState, useCallback } from 'react'
import { motion, useAnimation } from 'framer-motion'

// "Magnetize" hover effect, colour-preserving. Drop-in for any prominent
// button: swap  <button …>label</button>  →  <MagneticButton …>label</MagneticButton>.
// All button props (className, style, onClick, type, disabled, aria-*) pass
// straight through, so the call site's existing palette is untouched — we only
// add the particle layer. Particles use `currentColor`, so they automatically
// tint to whatever text colour the button already has.
//
// Implementation notes:
//  - The button keeps `overflow: visible` so existing box-shadows aren't
//    clipped; the particle layer clips itself (borderRadius: inherit).
//  - Particles are invisible at rest (opacity 0) and only fly in on hover/touch,
//    so a page full of these stays calm until you interact.
//  - Disabled buttons skip the effect; caller mouse handlers are preserved.

interface MagneticButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  particleCount?: number
}
interface Particle { id: number; x: number; y: number }

export function MagneticButton({
  particleCount = 10,
  className,
  children,
  style,
  disabled,
  onMouseEnter,
  onMouseLeave,
  onTouchStart,
  onTouchEnd,
  ...props
}: MagneticButtonProps) {
  const [particles, setParticles] = useState<Particle[]>([])
  const controls = useAnimation()

  useEffect(() => {
    setParticles(
      Array.from({ length: particleCount }, (_, i) => ({
        id: i,
        x: Math.random() * 140 - 70,
        y: Math.random() * 90 - 45,
      })),
    )
  }, [particleCount])

  const attract = useCallback(async () => {
    if (disabled) return
    await controls.start({ x: 0, y: 0, opacity: 0.85, transition: { type: 'spring', stiffness: 50, damping: 10 } })
  }, [controls, disabled])

  const release = useCallback(async () => {
    await controls.start((i: number) => ({
      x: particles[i]?.x ?? 0,
      y: particles[i]?.y ?? 0,
      opacity: 0,
      transition: { type: 'spring', stiffness: 100, damping: 15 },
    }))
  }, [controls, particles])

  return (
    <button
      className={className}
      disabled={disabled}
      style={{ position: 'relative', ...style }}
      onMouseEnter={(e) => { void attract(); onMouseEnter?.(e) }}
      onMouseLeave={(e) => { void release(); onMouseLeave?.(e) }}
      onTouchStart={(e) => { void attract(); onTouchStart?.(e) }}
      onTouchEnd={(e) => { void release(); onTouchEnd?.(e) }}
      {...props}
    >
      {/* Particle layer — clips to the button's own radius, inherits its colour. */}
      <span
        aria-hidden
        style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 'inherit', pointerEvents: 'none' }}
      >
        <span style={{ position: 'absolute', top: '50%', left: '50%' }}>
          {particles.map((p, i) => (
            <motion.span
              key={p.id}
              custom={i}
              initial={{ x: p.x, y: p.y, opacity: 0 }}
              animate={controls}
              style={{ position: 'absolute', width: 5, height: 5, borderRadius: 9999, background: 'currentColor' }}
            />
          ))}
        </span>
      </span>
      {/* Content sits above the particles. */}
      <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', width: '100%', height: '100%' }}>
        {children}
      </span>
    </button>
  )
}

export default MagneticButton
