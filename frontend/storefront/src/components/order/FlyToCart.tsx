'use client'

// Fly-to-cart. The item you just added leaves the sheet as a small clone (a
// 64px photo disc, or a name sticker when there's no photo) and arcs into the
// cart pill: x eases across, y rises through an apex 140px above the midpoint
// and drops in, shrinking to a third and tipping back as it goes. The promise
// resolves when it lands, so the caller can bump the pill on arrival.
//
//   const { fly, portal } = useFlyToCart()
//   await fly(imageEl, { imageUrl, label: item.name })
//   ...
//   return <>{page}{portal}</>
//
// The landing target is whatever element carries [data-cart-target]. It is
// looked up two frames after the call, so a pill that mounts because of this
// very add is already on screen. Reduced motion: no flight, resolves at once.

import { motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { prefersReducedMotion } from '../../lib/tactile'
import styles from './order.module.css'

export interface FlyOptions {
  imageUrl?: string | null
  label: string
  color?: string
}

interface Point { x: number; y: number }

interface Flight {
  id: number
  from: Point
  to: Point
  opts: FlyOptions
  done: () => void
}

const DURATION = 0.62
const APEX = 140
const X_EASE: [number, number, number, number] = [0.45, 0, 0.2, 1]

function centerOf(r: DOMRect | { left: number; top: number; width: number; height: number }): Point {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

function FlightClone({ flight }: { flight: Flight }) {
  const { from, to, opts } = flight
  const apexY = (from.y + to.y) / 2 - APEX
  return (
    <motion.div
      className={styles.flyAnchor}
      initial={{ x: from.x, y: from.y, scale: 1, rotate: 0, opacity: 1 }}
      animate={{
        x: to.x,
        y: [from.y, apexY, to.y],
        scale: 0.35,
        rotate: -18,
        opacity: [1, 1, 0],
      }}
      transition={{
        x: { duration: DURATION, ease: X_EASE },
        y: { duration: DURATION, times: [0, 0.45, 1], ease: ['easeOut', 'easeIn'] },
        scale: { duration: DURATION, ease: X_EASE },
        rotate: { duration: DURATION, ease: 'easeInOut' },
        opacity: { duration: DURATION, times: [0, 0.88, 1] },
      }}
      onAnimationComplete={flight.done}
    >
      {opts.imageUrl ? (
        <div
          className={styles.flyImg}
          style={{ backgroundImage: `url("${opts.imageUrl.replace(/"/g, '%22')}")` }}
        />
      ) : (
        <div className={styles.flyChip} style={opts.color ? { background: opts.color } : undefined}>
          {opts.label}
        </div>
      )}
    </motion.div>
  )
}

export function useFlyToCart(): {
  fly: (fromEl: Element | DOMRect, opts: FlyOptions) => Promise<void>
  portal: ReactNode
} {
  const [flights, setFlights] = useState<Flight[]>([])
  const nextId = useRef(0)
  const alive = useRef(true)
  const pending = useRef(new Set<() => void>())

  useEffect(() => {
    alive.current = true
    const open = pending.current
    return () => {
      alive.current = false
      // Never leave a caller awaiting a flight that can no longer land.
      open.forEach((finish) => finish())
      open.clear()
    }
  }, [])

  const fly = useCallback((fromEl: Element | DOMRect, opts: FlyOptions) => {
    return new Promise<void>((resolve) => {
      if (typeof window === 'undefined' || prefersReducedMotion()) {
        resolve()
        return
      }
      const fromRect = fromEl instanceof Element ? fromEl.getBoundingClientRect() : fromEl
      const from = centerOf(fromRect)

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (!alive.current) { resolve(); return }
          const target = document.querySelector('[data-cart-target]')
          const t = target?.getBoundingClientRect()
          const to: Point = t && t.width > 0
            ? centerOf(t)
            : { x: window.innerWidth / 2, y: window.innerHeight - 56 }

          const id = ++nextId.current
          let settled = false
          let timer = 0
          const done = () => {
            if (settled) return
            settled = true
            window.clearTimeout(timer)
            pending.current.delete(done)
            if (alive.current) setFlights((list) => list.filter((f) => f.id !== id))
            resolve()
          }
          // Belt and braces: land even if the animation never reports back
          // (tab hidden mid-flight, element torn down).
          timer = window.setTimeout(done, DURATION * 1000 + 400)
          pending.current.add(done)
          setFlights((list) => [...list, { id, from, to, opts, done }])
        })
      })
    })
  }, [])

  const layer = flights.length > 0 && typeof document !== 'undefined'
    ? createPortal(
        <div className={styles.flyLayer} aria-hidden="true">
          {flights.map((f) => <FlightClone key={f.id} flight={f} />)}
        </div>,
        document.body,
      )
    : null

  return { fly, portal: layer }
}

export default useFlyToCart
