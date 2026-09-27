'use client'

// The ordering page's opening frame: the brand photo under a duotone in the
// brand's own two colours (simmer: a flat tiber scrim at 0.6, no gradient),
// drifting down 0→15% as the hero scrolls away, with the brand name on a
// title plate. Links are plain <Link>s, so the site's cut grows from them.

import { useRef } from 'react'
import Link from 'next/link'
import { motion, useScroll, useTransform } from 'framer-motion'
import { usePrefersReducedMotion } from '@/lib/film/motion'
import type { OrderingTheme } from './theme'
import o from './ordering.module.css'

export function OrderingHero({
  slug, name, description, imageUrl, theme,
}: {
  slug: string
  /** Already passed through formatBrandName. */
  name: string
  description: string | null
  imageUrl: string
  theme: OrderingTheme
}) {
  const ref = useRef<HTMLElement>(null)
  const reduce = usePrefersReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], ['0%', '15%'])
  const simmer = theme.brand === 'simmer'

  return (
    <section ref={ref} className={`${o.hero} ${simmer ? '' : o.duo}`}>
      <div className={o.heroPhoto} aria-hidden>
        <motion.img
          src={imageUrl}
          alt=""
          className={o.heroImg}
          decoding="async"
          style={reduce ? undefined : { y }}
        />
        {simmer ? (
          <span className={o.scrim} />
        ) : (
          <>
            <span className={o.duoLight} />
            <span className={o.duoDark} />
          </>
        )}
      </div>

      <div className={`${o.wrap} ${o.heroInner}`}>
        <div className={o.heroLinks}>
          <Link href={`/brand/${slug}`} className={o.heroLink}>
            <span aria-hidden>←</span> {name}
          </Link>
          <Link href="/browse" className={o.heroLink}>
            other kitchens <span aria-hidden>→</span>
          </Link>
        </div>
        <h1 className={o.plate}>{name}</h1>
        {description && <p className={o.heroDesc}>{description}</p>}
      </div>
    </section>
  )
}
