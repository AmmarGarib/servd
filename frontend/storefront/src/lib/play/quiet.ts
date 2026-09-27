// Quiet routes: simmer is the calm kitchen. On a quiet route there is no tin,
// no confetti, no toasts and no toy hints; finds made there are queued and
// shown on the next non-quiet page.

import { usePathname } from 'next/navigation'
import { useBrandSlug } from '../host'
import { resolveBrandSlug } from '../brandDomains'

export function isQuietRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  const path = (pathname.split(/[?#]/)[0] ?? '').toLowerCase().replace(/\/+$/, '')
  return (
    path === '/simmer' ||
    path.startsWith('/simmer/') ||
    path === '/brand/simmer' ||
    path.startsWith('/brand/simmer/')
  )
}

/** Non-hook check against the live location (path or simmer brand host). */
export function isQuietNow(): boolean {
  if (typeof window === 'undefined') return false
  if (isQuietRoute(window.location.pathname)) return true
  try {
    return resolveBrandSlug(window.location.host) === 'simmer'
  } catch {
    return false
  }
}

export function useQuiet(): boolean {
  const pathname = usePathname()
  const slug = useBrandSlug()
  return isQuietRoute(pathname) || slug === 'simmer'
}
