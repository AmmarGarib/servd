'use client'

// Portfolio-write guard.
//
// When the user is viewing data in "Portfolio" mode (aggregated across all
// their companies), writes are ambiguous — which company should the new
// brand / promo / menu item land in? This hook lets a button intercept its
// own click, prompt the user to pick a tenant, switch the session to that
// tenant, and only THEN run the action.
//
// Usage:
//   const ensureTenant = useEnsureTenant()
//
//   const create = useMutation({ mutationFn: () => api.post(...) })
//
//   <button onClick={() => ensureTenant(() => create.mutate())}>
//
// If portfolio mode is OFF, the callback runs synchronously. If portfolio
// mode is ON, the global PortfolioWriteGuardModal opens and the callback
// fires once the user picks a target tenant + the session switches.
//
// Implementation note: we use a tiny event-bus + a global modal mounted in
// AppShell. No React context needed — works from any page even if the
// component tree changes between mount and resolve.

import { useViewAllTenants } from '../components/ui/TenantSwitcher'

const GUARD_REQUEST_EVENT  = 'servd:portfolio-write-request'
const GUARD_RESOLVE_EVENT  = 'servd:portfolio-write-resolve'

interface RequestDetail {
  // Optional context for the modal copy ("Add this brand to…", "Run this campaign as…")
  intent?: string
}
interface ResolveDetail {
  // 'switched' = user picked a tenant + session switched. Action proceeds.
  // 'cancelled' = user dismissed the modal. Action aborts.
  result: 'switched' | 'cancelled'
}

export function useEnsureTenant() {
  const inPortfolio = useViewAllTenants()

  return function ensureTenant(action: () => void, intent?: string): void {
    if (!inPortfolio) {
      // Single-tenant mode — run immediately, no prompt.
      action()
      return
    }
    // Portfolio mode — ask the global modal to open + wait for the user
    // to pick a tenant. One-shot listener: fires once and detaches itself.
    const onResolve = (e: Event) => {
      window.removeEventListener(GUARD_RESOLVE_EVENT, onResolve)
      const detail = (e as CustomEvent<ResolveDetail>).detail
      if (detail.result === 'switched') action()
      // 'cancelled' → silently abort
    }
    window.addEventListener(GUARD_RESOLVE_EVENT, onResolve)

    window.dispatchEvent(new CustomEvent<RequestDetail>(GUARD_REQUEST_EVENT, {
      detail: { intent },
    }))
  }
}

// Used by the modal to subscribe to "show yourself" requests.
export function onPortfolioWriteRequest(handler: (intent?: string) => void): () => void {
  const wrapped = (e: Event) => {
    const detail = (e as CustomEvent<RequestDetail>).detail
    handler(detail?.intent)
  }
  window.addEventListener(GUARD_REQUEST_EVENT, wrapped)
  return () => window.removeEventListener(GUARD_REQUEST_EVENT, wrapped)
}

// Used by the modal to publish the user's decision.
export function resolvePortfolioWrite(result: 'switched' | 'cancelled'): void {
  window.dispatchEvent(new CustomEvent<ResolveDetail>(GUARD_RESOLVE_EVENT, {
    detail: { result },
  }))
}
