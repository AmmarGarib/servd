// Menu skeleton, tinted with the brand surface (never white on simmer, and a
// soft opacity pulse instead of a gradient shimmer). Mirrors the loaded
// layout — hero, category chips, a grid of cards — so hydrating the real menu
// doesn't shift the page.

import type { CSSProperties } from 'react'
import { orderingTheme, themeVars } from './theme'
import o from './ordering.module.css'

export function OrderingSkeleton({ slug }: { slug: string }) {
  const theme = orderingTheme(slug)
  return (
    <div role="status" aria-label="Loading menu" className={`${o.skeleton} ${o[theme.brand]}`} style={themeVars(theme)}>
      <div className={o.skHero} />
      <div className={o.skChips}>
        {Array.from({ length: 5 }).map((_, i) => <span key={i} className={o.skChip} />)}
      </div>
      <div className={o.skGrid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={o.skCard} style={{ ['--i' as string]: i } as CSSProperties} />
        ))}
      </div>
      <span className={o.srOnly}>Loading menu…</span>
    </div>
  )
}
