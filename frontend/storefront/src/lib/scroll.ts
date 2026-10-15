// Smooth, reduced-motion-aware scrolling helpers for the storefront.

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Scroll an element into view, smoothly unless the visitor asked for less
 *  motion. The global [id] scroll-margin keeps it clear of the sticky header. */
export function smoothScrollTo(
  el: Element | null | undefined,
  opts: { block?: ScrollLogicalPosition; inline?: ScrollLogicalPosition } = {},
): void {
  if (!el) return
  el.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: opts.block ?? 'start',
    inline: opts.inline ?? 'nearest',
  })
}
