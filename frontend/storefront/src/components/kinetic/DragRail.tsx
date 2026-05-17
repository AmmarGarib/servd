'use client'
import { useRef, useState, useEffect, type ReactNode } from 'react'

/**
 * DragRail — horizontal scroll-snap carousel with desktop drag affordance
 * and "drag" / "swipe" hint that fades after first interaction.
 *
 * Touch users get native flick scrolling. Desktop users get a pointer-grab
 * cursor; click-and-drag pans the rail. The "← drag →" hint appears in
 * the corner until the user has interacted at least once.
 */
export function DragRail({
  children,
  hint = '← Drag →',
  className = '',
}: {
  children: ReactNode
  hint?: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [touched, setTouched] = useState(false)

  // Pointer-based drag-to-scroll. Bind on the rail and translate pointer
  // deltas into scrollLeft adjustments — same UX as Apple/Airbnb rails.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let startX = 0
    let startScroll = 0
    let dragging = false
    function onDown(e: PointerEvent) {
      // Skip mouse middle-click and right-click; touch comes through fine.
      if (e.button !== 0 && e.pointerType === 'mouse') return
      dragging = true
      startX = e.clientX
      startScroll = el!.scrollLeft
      setTouched(true)
    }
    function onMove(e: PointerEvent) {
      if (!dragging) return
      el!.scrollLeft = startScroll - (e.clientX - startX)
    }
    function onUp() { dragging = false }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    el.addEventListener('scroll', () => setTouched(true), { passive: true })
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  return (
    <div className={`relative ${className}`}>
      <div ref={ref} className="drag-rail px-5 md:px-8">
        {children}
      </div>
      {!touched && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-5 -top-9 md:right-8 md:-top-11 text-xs eyebrow eyebrow-accent select-none animate-pulse"
        >
          {hint}
        </div>
      )}
    </div>
  )
}
