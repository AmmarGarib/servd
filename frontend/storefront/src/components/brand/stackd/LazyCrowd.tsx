'use client'
// The servd food crowd, booted only once its box is near the viewport.
// WebGL is one context per canvas, so the stackd page uses at most two, and
// neither costs anything until the reader gets close. Until then the flat SVG
// poster holds the spot (FoodCrowd paints the same poster first, then
// cross-fades into 3D), so the crowd is never an empty box. Decorative
// (aria-hidden); nothing on the page depends on it.

import { CrowdPoster } from '../../characters/CrowdPoster'
import { FoodCrowd } from '../../characters/FoodCrowd'
import type { CharacterKind } from '../../characters/types'
import { useInView } from './hooks'

export function LazyCrowd({ cast, excitement = 0, className }: { cast: CharacterKind[]; excitement?: number; className?: string }) {
  const { ref, inView } = useInView<HTMLDivElement>({ rootMargin: '600px 0px', once: true })
  return (
    <div ref={ref} className={className} aria-hidden>
      {inView ? <FoodCrowd cast={cast} excitement={excitement} /> : <CrowdPoster cast={cast} mode="waking" />}
    </div>
  )
}
