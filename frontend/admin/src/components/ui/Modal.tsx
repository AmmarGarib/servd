'use client'
// Modal + useDialog — the admin's ONE dialog behaviour (UX audit ERP-SHELL-12,
// CODE-FIELDS-6). Portal to <body>, role=dialog, Escape, a Tab trap, initial
// focus, focus handed back to the opener, and a ref-counted scroll lock on the
// body AND on the shell's scroller (main#main). Page-local modals are thin
// wrappers over <Modal> (same props they always had) — never another copy.
//
// `useDialog` is exported for the few overlays that must keep their own markup
// (a drawer, the till's settle screen): it gives them the same
// keyboard / focus / scroll-lock behaviour without the chrome.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useConfirm } from './ConfirmDialog'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert],[hidden]') && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0,
  )
}

// ── Scroll lock (ref-counted so stacked dialogs restore correctly) ──────────
let lockCount = 0
let savedOverflow: Array<[HTMLElement, string]> = []
function lockScroll() {
  if (typeof document === 'undefined') return
  if (lockCount++ > 0) return
  const targets = [document.body, document.getElementById('main')].filter((el): el is HTMLElement => !!el)
  savedOverflow = targets.map((el) => [el, el.style.overflow])
  targets.forEach((el) => { el.style.overflow = 'hidden' })
}
function unlockScroll() {
  if (lockCount === 0) return
  if (--lockCount > 0) return
  savedOverflow.forEach(([el, v]) => { el.style.overflow = v })
  savedOverflow = []
}

// Only the top-most dialog answers the keyboard (a confirm over a modal).
const stack: object[] = []

export interface UseDialogOptions {
  onClose: () => void
  /** false = Escape does nothing (a payment in flight, a forced choice). */
  dismissible?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
}

export function useDialog(panelRef: RefObject<HTMLElement | null>, opts: UseDialogOptions) {
  const { dismissible = true } = opts
  const optsRef = useRef(opts)
  optsRef.current = opts
  // The opener, captured at first render — before a child's autoFocus moves focus.
  const [opener] = useState<Element | null>(() => (typeof document === 'undefined' ? null : document.activeElement))

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    lockScroll()
    if (!panel.hasAttribute('tabindex')) panel.tabIndex = -1
    if (!panel.contains(document.activeElement) || document.activeElement === document.body) {
      const target =
        optsRef.current.initialFocusRef?.current ??
        panel.querySelector<HTMLElement>('[autofocus]') ??
        focusablesIn(panel).find((el) => !el.hasAttribute('data-dialog-close')) ??
        focusablesIn(panel)[0] ??
        panel
      target.focus({ preventScroll: true })
    }
    return () => {
      unlockScroll()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const token = {}
    stack.push(token)
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return
      const panel = panelRef.current
      if (!panel) return
      if (e.key === 'Escape') {
        if (e.defaultPrevented || !dismissible) return
        e.preventDefault()
        optsRef.current.onClose()
      } else if (e.key === 'Tab') {
        const items = focusablesIn(panel)
        if (items.length === 0) { e.preventDefault(); panel.focus(); return }
        const first = items[0]!
        const last = items[items.length - 1]!
        const active = document.activeElement as HTMLElement | null
        const inside = !!active && panel.contains(active)
        if (!inside) {
          // Focus is in a portalled child (a Select list handles its own Tab) or lost.
          if (e.defaultPrevented) return
          e.preventDefault(); first.focus()
        } else if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = stack.indexOf(token)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [panelRef, dismissible])
}

export interface ModalProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  wide?: boolean
  /** Unsaved edits: closing (backdrop, Escape, X) asks "Discard changes?" first. */
  dirty?: boolean
  dismissible?: boolean
  /** Sticky bottom bar (buttons). */
  footer?: ReactNode
  /** aria-labelledby of your own heading, when `title` is not the visible heading. */
  labelledBy?: string
  zIndex?: number
  initialFocusRef?: RefObject<HTMLElement | null>
}

export function Modal({
  title, onClose, children, wide, dirty, dismissible = true, footer, labelledBy, zIndex = 50, initialFocusRef,
}: ModalProps) {
  const confirm = useConfirm()
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const downOnBackdrop = useRef(false)
  const asking = useRef(false)

  const requestClose = async () => {
    if (!dismissible) return
    if (dirty) {
      if (asking.current) return
      asking.current = true
      const ok = await confirm({ title: 'Discard changes?', body: 'What you typed here has not been saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true })
      asking.current = false
      if (!ok) return
    }
    onClose()
  }

  useDialog(panelRef, { onClose: requestClose, dismissible, initialFocusRef })

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center bg-secondary/40 p-4" style={{ zIndex }}
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget }}
      onMouseUp={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) void requestClose(); downOnBackdrop.current = false }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? titleId}
        className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'} max-h-[90dvh] flex flex-col rounded-2xl overflow-hidden outline-none`}
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', overscrollBehavior: 'contain' }}>
        <div className="flex items-center justify-between border-b border-white/[0.05] pl-5 pr-1 py-1 shrink-0">
          <h2 id={titleId} className="font-black text-white/90">{title}</h2>
          {dismissible && (
            <button type="button" data-dialog-close onClick={() => void requestClose()} aria-label="Close"
              className="flex h-11 w-11 items-center justify-center text-white/40 hover:text-white/80 text-xl">✕</button>
          )}
        </div>
        <div className="p-5 space-y-3 overflow-y-auto min-h-0 flex-1" style={{ overscrollBehavior: 'contain' }}>{children}</div>
        {footer && (
          <div className="sticky bottom-0 shrink-0 border-t border-white/[0.05] px-5 py-3" style={{ background: 'var(--surface)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

export default Modal
