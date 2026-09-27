'use client'

// MiniCrowd: three tiny food characters perched on the basket pill's top edge.
// They cheer every time something lands (the toss emits a crowd cheer).
//
// Rules:
//   - stackd and Flipd only. NEVER simmer (no cartoon characters there).
//   - Mounted lazily, after the first add of the session, so a customer who
//     only browses never pays for the WebGL context.
//   - 170 x 72, transparent. Only the canvas takes pointer events, so the
//     box around the characters never blocks a tap on the menu behind it.
//   - keyboardPoke is off: the pill itself is the keyboard target here.
//   - Hidden (not unmounted) while the drawer is open, and never mounted on
//     viewports narrower than 360px, where it would crowd the tin and the
//     feedback dot.

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import type { CharacterKind } from '@/components/characters/types'
import styles from './toss.module.css'

const FoodCrowd = dynamic(() => import('@/components/characters/FoodCrowd').then((m) => m.FoodCrowd), { ssr: false })

const CASTS: Record<string, CharacterKind[]> = {
  stackd: ['coffee', 'croissant', 'sandwich'],
  flipd: ['burger', 'fries', 'shake'],
}

/** The cast for a brand, or null when the brand gets no mini crowd. */
export function miniCrowdCast(slug: string | null | undefined): CharacterKind[] | null {
  const key = (slug ?? '').toLowerCase()
  if (key === 'simmer') return null
  return CASTS[key] ?? null
}

function useWideEnough(): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    let mq: MediaQueryList
    try {
      mq = window.matchMedia('(min-width: 360px)')
    } catch {
      return
    }
    const sync = () => setOk(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return ok
}

export function MiniCrowd({ slug, hidden }: { slug: string; hidden: boolean }) {
  const cast = miniCrowdCast(slug)
  const wide = useWideEnough()
  if (!cast || !wide) return null
  return (
    <div
      className={styles.mini}
      data-hidden={hidden ? 'true' : 'false'}
      aria-hidden="true"
    >
      <FoodCrowd cast={cast} excitement={0.55} keyboardPoke={false} />
    </div>
  )
}

export default MiniCrowd
