'use client'

// OrderEmptyState — what /[concept] shows when the menu can't be loaded
// (the brand hasn't published to online ordering, or the menu API is down).
// A finished state, not a white error page: a rubber sticker card, the
// brand's own ground, a retry that goes loading → success or error, and two
// ways forward (the printed menu, a table).
//
// Per brand:
//   flipd  — the burger and fries shrug on a butter ground.
//   stackd — the hand-drawn mascot swaying on plum, a cream card, lowercase.
//   simmer — no characters. Forest ground, bone type, Amarante, lowercase,
//            the retry is the single orange signal.
//   other  — fries and coffee shrug on butter.

import { motion, useReducedMotion } from 'framer-motion'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { formatBrandName } from '../../lib/concept'
import { EASE_OUT, SPRING } from '../../lib/tactile'
import { CrowdPoster } from '../characters/CrowdPoster'
import { TactileButton, type TactileState } from '../tactile/TactileButton'
import { orderBrand } from './BottomSheet'
import styles from './order.module.css'

export interface OrderEmptyStateProps {
  slug: string
  brandName: string
  /** Re-runs the page's menu fetch. Rejects when the menu is still offline. */
  onRetry: () => Promise<void>
}

export function OrderEmptyState({ slug, brandName, onRetry }: OrderEmptyStateProps) {
  const brand = orderBrand(slug)
  const reduced = useReducedMotion()
  const [state, setState] = useState<TactileState>('idle')
  const [status, setStatus] = useState('')
  const timer = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(timer.current)
    }
  }, [])

  async function retry() {
    if (state === 'loading') return
    window.clearTimeout(timer.current)
    setState('loading')
    setStatus('')
    try {
      await onRetry()
      if (!mounted.current) return
      setState('success')
      setStatus('The menu is up. Opening it now.')
    } catch {
      if (!mounted.current) return
      setState('error')
      setStatus('Still not online. Give it a minute and try again.')
      timer.current = window.setTimeout(() => {
        if (mounted.current) setState('idle')
      }, 1600)
    }
  }

  const name = formatBrandName(brandName)
  const calm = brand === 'simmer'
  const enter = reduced
    ? { duration: 0.15 }
    : calm ? { duration: 0.5, ease: EASE_OUT } : SPRING.pop
  const from = reduced ? { opacity: 0.3 } : calm ? { opacity: 0.3, y: 10 } : { opacity: 0.25, y: 28, scale: 0.94 }
  const to = reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }

  return (
    <section className={styles.empty} data-obrand={brand} aria-labelledby="order-empty-title">
      <motion.div className={styles.emptyCard} initial={from} animate={to} transition={enter}>
        {brand === 'flipd' && (
          <div className={styles.emptyPoster}>
            <CrowdPoster cast={['burger', 'fries']} mode="shrug" />
          </div>
        )}
        {brand === 'hub' && (
          <div className={styles.emptyPoster}>
            <CrowdPoster cast={['fries', 'coffee']} mode="shrug" />
          </div>
        )}
        {brand === 'stackd' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src="/brand/stackd-mascot.png"
            alt=""
            aria-hidden="true"
            className={styles.emptyMascot}
            height={170}
            decoding="async"
          />
        )}

        <span className={styles.emptyEyebrow}>Online ordering</span>
        <motion.h1
          id="order-empty-title"
          className={styles.emptyTitle}
          initial={reduced ? false : { opacity: 0.3, y: calm ? 6 : 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduced ? { duration: 0 } : calm ? { duration: 0.5, ease: EASE_OUT, delay: 0.08 } : { ...SPRING.pop, delay: 0.08 }}
        >
          {name}&rsquo;s menu isn&rsquo;t online yet.
        </motion.h1>
        <p className={styles.emptyBody}>
          The kitchen hasn&rsquo;t published its menu to online ordering. You can see the printed menu or
          book a table while they get set up.
        </p>

        <div className={styles.emptyActions}>
          <TactileButton
            type="button"
            className={styles.emptyRetry}
            state={state}
            loadingLabel="Checking the kitchen"
            successLabel="Menu is up"
            squish={calm ? 0.3 : 1.2}
            onClick={() => { void retry() }}
          >
            Try again
          </TactileButton>
          <Link href={`/brand/${slug}/menu`} className={`servd-btn-secondary ${styles.emptySecondary}`}>
            See the menu
          </Link>
          <Link href={`/reserve/${slug}`} className={`servd-btn-secondary ${styles.emptySecondary}`}>
            Reserve a table
          </Link>
        </div>

        <p className={styles.emptyStatus} role="status" aria-live="polite">{status}</p>
        <Link href="/browse" className={styles.emptyMore}>Browse the other kitchens</Link>
      </motion.div>
    </section>
  )
}

export default OrderEmptyState
