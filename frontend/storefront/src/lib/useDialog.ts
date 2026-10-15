'use client'
import { useEffect, useRef, type RefObject } from 'react'

// The storefront's one modal behaviour (twin of the admin's hook — a separate
// app and bundle): Escape closes, focus moves in on open, Tab stays inside,
// focus goes back to the opener on close, the page behind does not scroll
// (position kept) and is `inert` (siblings of the dialog's ancestors).
// PopupHost keeps its own copy of the simpler logic and is left as it is.

let lockCount = 0
let lockPrev = ''

function lockScroll() {
  if (lockCount++ === 0) {
    lockPrev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
}
function unlockScroll() {
  if (--lockCount <= 0) {
    lockCount = 0
    document.body.style.overflow = lockPrev
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getClientRects().length > 0,
  )
}

export interface UseDialogOptions {
  open: boolean
  /** The dialog element (focus is kept inside it). */
  ref: RefObject<HTMLElement | null>
  onClose: () => void
  /** Element to focus on open; default the first focusable inside. */
  initialFocus?: () => HTMLElement | null | undefined
  /** Where focus goes on close; default the element focused at open. */
  restoreTo?: () => HTMLElement | null | undefined
}

export function useDialog({ open, ref, onClose, initialFocus, restoreTo }: UseDialogOptions): void {
  // Latest callbacks without re-running the effect on every render.
  const cb = useRef({ onClose, initialFocus, restoreTo })
  cb.current = { onClose, initialFocus, restoreTo }

  useEffect(() => {
    if (!open) return
    const root = ref.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

    lockScroll()

    // Everything outside the dialog's branch of the tree is inert.
    const inerted: HTMLElement[] = []
    if (root) {
      let node: HTMLElement | null = root
      while (node && node !== document.body) {
        const parent: HTMLElement | null = node.parentElement
        if (!parent) break
        for (const sib of Array.from(parent.children)) {
          if (sib === node || !(sib instanceof HTMLElement)) continue
          if (sib.tagName === 'SCRIPT' || sib.tagName === 'STYLE' || sib.hasAttribute('inert')) continue
          sib.setAttribute('inert', '')
          inerted.push(sib)
        }
        node = parent
      }
    }

    const focusIn = () => {
      const target = cb.current.initialFocus?.() ?? (root ? focusables(root)[0] ?? root : null)
      target?.focus({ preventScroll: true })
    }
    // After the dialog has painted its content.
    const raf = requestAnimationFrame(focusIn)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.stopPropagation()
        cb.current.onClose()
        return
      }
      if (e.key !== 'Tab' || !root) return
      const items = focusables(root)
      if (items.length === 0) { e.preventDefault(); root.focus(); return }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey, true)
      inerted.forEach((el) => el.removeAttribute('inert'))
      unlockScroll()
      const back = cb.current.restoreTo?.() ?? opener
      if (back && back.isConnected) back.focus({ preventScroll: true })
    }
  }, [open, ref])
}
