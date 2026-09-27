'use client'
// Root template — the page "set down".
//
// Next remounts a template on every navigation into a new top-level segment,
// so this is where a page gets placed on the table: it lands 10px low, a hair
// small and transparent, and settles in 300ms. It is CSS only, and the
// animation runs on the wrapper's CHILDREN rather than the wrapper, for two
// reasons:
//   - A child is re-inserted when a route loader hands over to its page, and
//     CSS replays the entrance on insertion. So both the loader appearing and
//     the page replacing it are set down, with no JS listening for either.
//   - `animation-fill-mode: backwards` means nothing is held once it ends: no
//     transform, no will-change. A transformed ancestor would otherwise turn
//     every position: fixed descendant (the cart pill, sheets, the nav) into
//     one positioned against the page, and break sticky headers.
//
// The loader hands over on purpose: while a route loader is mounted the
// wrapper wears the loader's ground colour (see `data-route-loader` in
// template.module.css), and when the page replaces it that ground dissolves
// under the page as the page fades in. The cut reads as the page being set
// down onto the loader, not as a flash of white.
//
// Brand microsites run their own intros, so on /brand/* and the three brand
// ordering routes the entrance is opacity only: nothing double-animates.

import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { BRAND_REWRITE_PATHS, resolveBrandSlug } from '../lib/brandDomains'
import s from './template.module.css'

// First path segments whose pages carry their own entrance.
const OWN_INTRO = new Set(['brand', 'simmer', 'stackd', 'stax', 'flipd'])
// simmer surfaces: the 404 and error boundaries render inside this wrapper,
// so they read `data-surface` and drop the servd crowd and butter for simmer's
// own ground (the brand bible bans characters there).
function surfaceOf(segments: string[]): 'simmer' | undefined {
  const [a, b] = segments
  if (a === 'simmer' || (a === 'brand' && b === 'simmer')) return 'simmer'
  return undefined
}

// On simmer.pk the middleware rewrites `/`, `/menu`… onto /brand/simmer, but
// the browser path stays `/`, so usePathname() cannot see it. Error and 404
// boundaries render client-side anyway, so reading the host after mount is
// enough to keep the crowd off simmer's own domain.
function useSimmerHost(pathname: string): boolean {
  const [simmerHost, setSimmerHost] = useState(false)
  useEffect(() => {
    try {
      setSimmerHost(
        BRAND_REWRITE_PATHS.has(pathname) && resolveBrandSlug(window.location.hostname) === 'simmer',
      )
    } catch {
      setSimmerHost(false)
    }
  }, [pathname])
  return simmerHost
}

export default function RootTemplate({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/'
  const segments = pathname.toLowerCase().split('/').filter(Boolean)
  const simmerHost = useSimmerHost(pathname)
  // Brand-host microsites are already calm via `.brand-shell` in the CSS;
  // flipping data-setdown after mount would restart the entrance.
  const calm = OWN_INTRO.has(segments[0] ?? '')
  const surface = simmerHost ? 'simmer' : surfaceOf(segments)
  return (
    <div className={s.root} data-setdown={calm ? 'calm' : 'full'} data-surface={surface}>
      {children}
    </div>
  )
}
