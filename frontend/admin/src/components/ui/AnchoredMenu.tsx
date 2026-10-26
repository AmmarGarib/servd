'use client'
// THE floating panel for every dropdown / menu / pop-over in the admin (owner,
// 2026-10-26: the Export menu on P&L opened half off the phone screen and under
// the tabs). A panel anchored to a button must never be cut off or covered:
// it is rendered in a portal on <body> (no parent's overflow, transform or
// z-index can clip it), positioned `fixed` from the anchor's rectangle, kept
// at least 8px inside the viewport on every side, opened upwards when there is
// no room below, and capped in height with its own scroll. It closes on an
// outside tap, Escape, or once its anchor scrolls off screen (it follows the
// anchor while the page scrolls or resizes).
//
//   const btn = useRef<HTMLButtonElement>(null)
//   <button ref={btn} onClick={() => setOpen(o => !o)}>Export</button>
//   <AnchoredMenu anchor={btn} open={open} onClose={() => setOpen(false)} align="end">…</AnchoredMenu>
//
// Never build a dropdown as `absolute right-0` inside the page again — see
// docs/UI_CHECKLIST.md.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const GUTTER = 8
const GAP = 4

export function AnchoredMenu({
  anchor, open, onClose, children, align = 'start', minWidth = 160, matchWidth = false, className = '', role = 'menu', maxHeight = 360,
}: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: ReactNode
  /** Line the panel up with the anchor's left (start) or right (end) edge; it is moved inside the screen either way. */
  align?: 'start' | 'end'
  minWidth?: number
  /** Panel at least as wide as the anchor (selects, pickers). */
  matchWidth?: boolean
  className?: string
  role?: string
  maxHeight?: number
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width?: number; maxHeight: number } | null>(null)

  const place = useCallback(() => {
    const a = anchor.current, p = panel.current
    if (!a || !p) return
    const r = a.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    const width = Math.min(Math.max(p.offsetWidth, matchWidth ? r.width : 0, minWidth), vw - GUTTER * 2)
    let left = align === 'end' ? r.right - width : r.left
    left = Math.max(GUTTER, Math.min(left, vw - GUTTER - width))
    const below = vh - r.bottom - GAP - GUTTER, above = r.top - GAP - GUTTER
    const natural = Math.min(p.scrollHeight, maxHeight)
    const up = natural > below && above > below
    const room = Math.max(120, up ? above : below)
    const h = Math.min(natural, room)
    const top = up ? r.top - GAP - h : r.bottom + GAP
    setPos({ top, left, width: matchWidth ? Math.max(width, r.width) : undefined, maxHeight: room })
  }, [anchor, align, minWidth, matchWidth, maxHeight])

  useLayoutEffect(() => { if (open) place(); else setPos(null) }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); anchor.current?.focus() } }
    // Scrolling inside the panel is fine. When the page moves (incl. the phone keyboard opening under a
    // search box) the panel follows its anchor; it closes only once the anchor has left the screen.
    const onScroll = (e: Event) => {
      if (panel.current?.contains(e.target as Node)) return
      const r = anchor.current?.getBoundingClientRect()
      if (!r || r.bottom < 0 || r.top > window.innerHeight) onClose(); else place()
    }
    const onResize = () => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, onClose, place, anchor])

  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div ref={panel} role={role}
      style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: pos?.width, minWidth, maxWidth: `calc(100vw - ${GUTTER * 2}px)`, maxHeight: pos?.maxHeight ?? maxHeight, visibility: pos ? 'visible' : 'hidden' }}
      className={`z-[80] overflow-auto rounded-lg border border-s-border bg-s-surface py-1 shadow-lg ${className}`}>
      {children}
    </div>,
    document.body,
  )
}
