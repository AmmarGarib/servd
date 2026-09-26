'use client'
// The servd food crowd, mounted only once its box is near the viewport.
// WebGL is one context per canvas, so the stackd page uses at most two, and
// neither costs anything until the reader gets close. Decorative (aria-hidden
// inside FoodCrowd); nothing on the page depends on it.

import dynamic from 'next/dynamic'
import type { CharacterKind } from '../../characters/types'
import { useInView } from './hooks'

const FoodCrowd = dynamic(() => import('../../characters/FoodCrowd').then((m) => m.FoodCrowd), { ssr: false })

export function LazyCrowd({ cast, excitement = 0, className }: { cast: CharacterKind[]; excitement?: number; className?: string }) {
  const { ref, inView } = useInView<HTMLDivElement>({ rootMargin: '600px 0px', once: true })
  return (
    <div ref={ref} className={className} aria-hidden>
      {inView && <FoodCrowd cast={cast} excitement={excitement} />}
    </div>
  )
}
