'use client'
// The servd food crowd, mounted only once its box is near the viewport.
// WebGL is one context per canvas, so the stackd page uses at most two (the
// chiller and the sign-off), and neither costs anything until the reader gets
// close. Decorative (aria-hidden); nothing on the page depends on it.
//
// Until the 3D crowd has drawn its first real frame, an instant SVG stand-in
// (`fallback`, usually a CrowdRow of the same cast) holds the spot, then
// fades out underneath it — so the shelf is never empty in a screenshot.

import dynamic from 'next/dynamic'
import { useState, type ReactNode } from 'react'
import type { CharacterKind } from '../../characters/types'
import { useInView } from './hooks'
import s from './ui.module.css'

const FoodCrowd = dynamic(() => import('../../characters/FoodCrowd').then((m) => m.FoodCrowd), { ssr: false })

interface Props {
  cast: CharacterKind[]
  excitement?: number
  className?: string
  /** Manual sleep override, 0..1 (1 = fast asleep). Undefined follows the world. */
  sleepy?: number
  /** Emits crowd `stage` events so the buddy knows this crowd is on screen. */
  stageId?: string
  /** Instant SVG stand-in shown until the first WebGL frame. */
  fallback?: ReactNode
}

export function LazyCrowd({ cast, excitement = 0, className, sleepy, stageId, fallback }: Props) {
  const { ref, inView } = useInView<HTMLDivElement>({ rootMargin: '600px 0px', once: true })
  const [ready, setReady] = useState(false)
  return (
    <div ref={ref} className={className} aria-hidden>
      {fallback && (
        <div className={`${s.crowdStandIn} ${ready ? s.crowdStandInOut : ''}`}>{fallback}</div>
      )}
      {inView && (
        <FoodCrowd
          cast={cast}
          excitement={excitement}
          sleepy={sleepy}
          stageId={stageId}
          onReady={() => setReady(true)}
        />
      )}
    </div>
  )
}
