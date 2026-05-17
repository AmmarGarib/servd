'use client'
import type { ReactNode } from 'react'

/**
 * MarqueeStrip — horizontally scrolling text band used as a kinetic
 * section divider (Buzz Interactive et al). Renders the same content
 * twice so the loop is seamless. Pauses on hover.
 *
 * Usage:
 *   <MarqueeStrip>
 *     <span>Three kitchens.</span><span>·</span><span>One bag.</span>
 *   </MarqueeStrip>
 *
 * Children should be the inline content; the component handles spacing,
 * masking, and duplication.
 */
export function MarqueeStrip({
  children,
  speed = 32,
  accent = false,
  className = '',
}: {
  children: ReactNode
  speed?: number              // seconds per full loop; lower = faster
  accent?: boolean            // use brand-accent background instead of ink
  className?: string
}) {
  const style = {
    background: accent ? 'var(--brand-accent)' : 'var(--servd-black)',
    color:      accent ? 'var(--brand-ink)'    : 'white',
    ['--marquee-speed' as string]: `${speed}s`,
  } as React.CSSProperties

  return (
    <div
      className={`marquee py-5 md:py-6 ${className}`}
      style={style}
      aria-hidden="true"
    >
      <div className="marquee-track">
        {children}
        {children /* second copy keeps the scroll seamless */}
      </div>
    </div>
  )
}

/**
 * Convenience: a marquee that takes a flat list of strings and stamps
 * each one out with a separator dot. Most common use case so worth a
 * shortcut.
 */
export function MarqueeText({
  items, separator = '✦', speed = 32, accent = false,
}: {
  items: string[]
  separator?: string
  speed?: number
  accent?: boolean
}) {
  return (
    <MarqueeStrip speed={speed} accent={accent}>
      <span className="display whitespace-nowrap" style={{ fontSize: 'clamp(1.5rem, 3.5vw, 2.5rem)' }}>
        {items.flatMap((item, i) => [
          <span key={`item-${i}`}>{item}</span>,
          <span key={`sep-${i}`} style={{ opacity: 0.45 }}>{separator}</span>,
        ])}
      </span>
    </MarqueeStrip>
  )
}
