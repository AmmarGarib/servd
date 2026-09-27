'use client'
// The nav's basket: a little SVG basket with a count badge, shown once the
// persisted cart has hydrated and holds something for a kitchen. It links to
// that kitchen's ordering page with ?basket=open, which the ordering page reads
// to open its drawer.
//
// When the count goes up the badge pops (a 380ms jelly) and the basket hops.
// Reduced motion: the count changes with a short opacity cross-fade instead.
//
// Read-only on the cart: this component never calls a cart action.

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { AnimatePresence, motion, useAnimationControls } from 'framer-motion'
import { useCart } from '../../store/cart'
import { useHydrated, usePrefersReducedMotion } from '@/lib/play'
import s from './nav.module.css'

const JELLY = [0.34, 1.56, 0.64, 1] as const

export function NavBasket() {
  const hydrated = useHydrated()
  const reduced = usePrefersReducedMotion()
  const items = useCart((st) => st.items)
  const conceptSlug = useCart((st) => st.conceptSlug)
  const count = items.reduce((n, it) => n + (Number.isFinite(it.quantity) ? it.quantity : 0), 0)
  const visible = hydrated && items.length > 0 && !!conceptSlug

  const badge = useAnimationControls()
  const basket = useAnimationControls()
  const prev = useRef<number | null>(null)

  useEffect(() => {
    if (!visible) { prev.current = null; return }
    const before = prev.current
    prev.current = count
    // The first value after hydration is not an "add"; only react to growth.
    if (before === null || count <= before) return
    if (reduced) {
      void badge.start({ opacity: [0.35, 1], transition: { duration: 0.12 } })
      return
    }
    void badge.start({
      scale: [1, 1.35, 1],
      rotate: [-10, -10, 0],
      transition: { duration: 0.38, ease: JELLY, times: [0, 0.4, 1] },
    })
    void basket.start({
      y: [0, -5, 0],
      transition: { duration: 0.38, ease: JELLY, times: [0, 0.35, 1] },
    })
  }, [count, visible, reduced, badge, basket])

  const label = `basket, ${count} ${count === 1 ? 'item' : 'items'}`

  return (
    <AnimatePresence initial={false}>
      {visible && conceptSlug ? (
        <motion.span
          key="nav-basket"
          className={s.basketWrap}
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
          transition={reduced ? { duration: 0.12 } : { type: 'spring', stiffness: 520, damping: 18 }}
          whileTap={reduced ? undefined : { scale: 0.94 }}
        >
          <Link
            href={`/${encodeURIComponent(conceptSlug)}?basket=open`}
            aria-label={label}
            className={`${s.basket} ${s.hoverPop}`}
          >
            <motion.svg
              animate={basket}
              aria-hidden="true"
              focusable="false"
              viewBox="0 0 28 28"
              width="24"
              height="24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* handle */}
              <path d="M9 11 L12.5 4.5 M19 11 L15.5 4.5" />
              {/* basket body */}
              <path d="M3.5 11 H24.5 L22.4 22.2 A2.4 2.4 0 0 1 20 24.2 H8 A2.4 2.4 0 0 1 5.6 22.2 Z" fill="var(--party-butter, #FFD447)" />
              {/* weave */}
              <path d="M10.5 15 V20.5 M14 15 V20.5 M17.5 15 V20.5" />
            </motion.svg>
            <motion.span className={s.basketCount} animate={badge} aria-hidden="true">
              {count > 99 ? '99+' : count}
            </motion.span>
          </Link>
        </motion.span>
      ) : null}
    </AnimatePresence>
  )
}
