'use client'

// BottomSheet — the one sheet the ordering flow uses for the item detail and
// the basket.
//
// Phone: rises from the bottom on SPRING.settle over a 200ms backdrop fade.
// It can be dragged down from the grab handle, or from anything wrapped in
// <SheetDragZone> (the item photo, the basket header). The scroll body never
// starts a drag, so scrolled content never fights the sheet. Let go past
// 120px, or flick faster than 600px/s, and it leaves with the fling's
// momentum; anything less springs back.
//
// 768px and up: a centred card that settles in from scale .96.
//
// Escape closes it, focus moves in on open and back to the opener on close,
// Tab is trapped inside, and the page behind is scroll-locked. The scroll
// body is <SheetBody> (data-lenis-prevent). Render it inside the page's
// .scope element so it paints in the brand's material.

import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
  type PanInfo,
  type Variants,
} from 'framer-motion'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { SPRING } from '../../lib/tactile'
import styles from './order.module.css'

export type OrderBrand = 'hub' | 'simmer' | 'stackd' | 'flipd'

export function orderBrand(slug: string | null | undefined): OrderBrand {
  if (slug === 'simmer' || slug === 'stackd' || slug === 'flipd') return slug
  return 'hub'
}

// ── Desktop breakpoint ──────────────────────────────────────────────────────

const DESKTOP_Q = '(min-width: 768px)'
function subscribeDesktop(cb: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia(DESKTOP_Q)
  mq.addEventListener?.('change', cb)
  return () => mq.removeEventListener?.('change', cb)
}
function isDesktopNow() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DESKTOP_Q).matches
}
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, isDesktopNow, () => false)
}

// ── Drag context ────────────────────────────────────────────────────────────

interface SheetCtx {
  startDrag: (e: ReactPointerEvent) => void
  draggable: boolean
}
const SheetContext = createContext<SheetCtx>({ startDrag: () => {}, draggable: false })

const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"]'

/** Anything inside can start a sheet drag on phones (photo, header). */
export function SheetDragZone({
  children, className, innerRef,
}: { children: ReactNode; className?: string; innerRef?: Ref<HTMLDivElement> }) {
  const { startDrag, draggable } = useContext(SheetContext)
  return (
    <div
      ref={innerRef}
      className={[className, draggable ? styles.dragZone : ''].filter(Boolean).join(' ')}
      onPointerDown={draggable ? startDrag : undefined}
    >
      {children}
    </div>
  )
}

/** The scrolling part of the sheet. Never starts a drag. */
export function SheetBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={[styles.sheetBody, className].filter(Boolean).join(' ')} data-lenis-prevent="">
      {children}
    </div>
  )
}

// ── Motion ──────────────────────────────────────────────────────────────────

interface Mode { desktop: boolean; reduced: boolean; fling: number; calm: boolean }

const sheetVariants: Variants = {
  hidden: (m: Mode) =>
    m.reduced ? { opacity: 0 }
    : m.desktop ? { opacity: 0, scale: 0.96, y: 14 }
    : { y: '100%' },
  shown: (m: Mode) =>
    m.reduced ? { opacity: 1, transition: { duration: 0.15 } }
    : m.desktop ? { opacity: 1, scale: 1, y: 0, transition: m.calm ? SPRING.heavy : SPRING.settle }
    : { y: 0, transition: m.calm ? SPRING.heavy : SPRING.settle },
  exit: (m: Mode) =>
    m.reduced ? { opacity: 0, transition: { duration: 0.15 } }
    : m.desktop ? { opacity: 0, scale: 0.96, y: 14, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }
    : {
        y: typeof window !== 'undefined' ? window.innerHeight : 900,
        transition: { type: 'spring', stiffness: 320, damping: 36, velocity: Math.max(m.fling, 0) },
      },
}

const DISMISS_OFFSET = 120
const DISMISS_VELOCITY = 600

// ── Sheet ───────────────────────────────────────────────────────────────────

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  /** Accessible name of the dialog. */
  label: string
  brand?: OrderBrand
  className?: string
  children: ReactNode
}

export function BottomSheet({ open, onClose, label, brand = 'hub', className, children }: BottomSheetProps) {
  const reduced = !!useReducedMotion()
  const desktop = useIsDesktop()
  const dragControls = useDragControls()
  const sheetRef = useRef<HTMLDivElement>(null)
  const fling = useRef(0)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [, force] = useState(0)

  const draggable = !desktop && !reduced

  const startDrag = useCallback((e: ReactPointerEvent) => {
    if (!draggable) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target as Element | null
    if (target?.closest(INTERACTIVE)) return
    dragControls.start(e)
  }, [draggable, dragControls])

  // Reset the fling each time the sheet opens so a button close exits calmly.
  useEffect(() => {
    if (open) {
      fling.current = 0
      force((n) => n + 1)
    }
  }, [open])

  // Escape, focus in/out and the body scroll lock.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    const opener = document.activeElement as HTMLElement | null
    const body = document.body
    const prevOverflow = body.style.overflow
    body.style.overflow = 'hidden'

    const raf = window.requestAnimationFrame(() => {
      sheetRef.current?.focus({ preventScroll: true })
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey)
      body.style.overflow = prevOverflow
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [open])

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !sheetRef.current) return
    const nodes = Array.from(
      sheetRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((n) => n.offsetParent !== null || n === document.activeElement)
    if (nodes.length === 0) { e.preventDefault(); return }
    const first = nodes[0]!
    const last = nodes[nodes.length - 1]!
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === sheetRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) {
      fling.current = info.velocity.y
      force((n) => n + 1)
      onCloseRef.current()
    }
  }

  const mode: Mode = { desktop, reduced, fling: fling.current, calm: brand === 'simmer' }

  return (
    <AnimatePresence custom={mode}>
      {open && (
        <motion.div
          key="backdrop"
          className={styles.backdrop}
          onClick={() => onCloseRef.current()}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.2 } }}
          exit={{ opacity: 0, transition: { duration: 0.2 } }}
          data-lenis-prevent=""
          aria-hidden="true"
        />
      )}
      {open && (
        <div key="frame" className={styles.sheetFrame} data-lenis-prevent="">
          <motion.div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            className={[styles.sheet, className].filter(Boolean).join(' ')}
            custom={mode}
            variants={sheetVariants}
            initial="hidden"
            animate="shown"
            exit="exit"
            drag={draggable ? 'y' : false}
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.08, bottom: 0.6 }}
            dragMomentum={false}
            onDragEnd={onDragEnd}
            onKeyDown={trapTab}
          >
            {draggable && (
              <div className={styles.handleZone} onPointerDown={startDrag} aria-hidden="true">
                <span className={styles.handle} />
              </div>
            )}
            <SheetContext.Provider value={{ startDrag, draggable }}>
              {children}
            </SheetContext.Provider>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

export default BottomSheet
