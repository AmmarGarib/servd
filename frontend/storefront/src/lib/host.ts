'use client'
import { useEffect, useState } from 'react'
import { resolveBrandSlug } from './brandDomains'

// Canonical servd host URL (no trailing slash). Used when navigating from a
// brand-domain cart into the servd checkout. Set to e.g. https://servd.app in
// prod, http://localhost:3002 in dev. Empty when unset → callers fall back to
// same-host navigation (the brand and servd code paths are otherwise identical
// while running on a single host).
export function getServdHost(): string {
  return (process.env['NEXT_PUBLIC_SERVD_HOST'] ?? '').replace(/\/$/, '')
}

// Resolve the current browser's brand slug, or null if we're on the servd
// canonical host. Server-rendered: returns null on first render, then the
// real value after mount. Components that want to switch behaviour based on
// host should treat null as "still loading / on servd".
export function useBrandSlug(): string | null {
  const [slug, setSlug] = useState<string | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    setSlug(resolveBrandSlug(window.location.host))
  }, [])
  return slug
}
