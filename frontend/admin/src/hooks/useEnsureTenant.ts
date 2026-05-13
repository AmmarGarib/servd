'use client'

// Portfolio-write guard — bridge between api.ts and the global picker modal.
//
// As of 2026-05-13 the picker NO LONGER switches sessions. It stashes the
// chosen tenant ID on a module-level ref; api.ts reads it back and attaches
// `x-servd-active-tenant: <id>` to the next request. The operator stays in
// portfolio view; only the single write lands in the picked company.
//
// Pages that want fully inline pickers (preferred) should use the reusable
// <TenantField> component + the `tenantId` option on api.post/patch/delete
// directly. This hook + modal stays as a safety net for legacy create paths
// that haven't been swept yet.

import { useViewAllTenants } from '../components/ui/TenantSwitcher'

const GUARD_REQUEST_EVENT  = 'servd:portfolio-write-request'
const GUARD_RESOLVE_EVENT  = 'servd:portfolio-write-resolve'

interface RequestDetail {
  // Optional context for the modal copy ("Add this brand to…", "Run this campaign as…")
  intent?: string
}
interface ResolveDetail {
  // 'picked' = user picked a tenant; pickedTenantId() returns the chosen id.
  // 'cancelled' = user dismissed; pickedTenantId() returns null.
  result: 'picked' | 'cancelled'
}

// Module-level slot holding the most recent picked-tenant. api.ts consumes
// (and clears) this on the next request. Mutated only by the global modal.
let _pickedTenantId: string | null = null
export function setPickedTenantId(id: string | null): void {
  _pickedTenantId = id
}
export function consumePickedTenantId(): string | null {
  const v = _pickedTenantId
  _pickedTenantId = null
  return v
}

export function useEnsureTenant() {
  const inPortfolio = useViewAllTenants()

  return function ensureTenant(action: () => void, intent?: string): void {
    if (!inPortfolio) {
      action()
      return
    }
    const onResolve = (e: Event) => {
      window.removeEventListener(GUARD_RESOLVE_EVENT, onResolve)
      const detail = (e as CustomEvent<ResolveDetail>).detail
      if (detail.result === 'picked') action()
    }
    window.addEventListener(GUARD_RESOLVE_EVENT, onResolve)

    window.dispatchEvent(new CustomEvent<RequestDetail>(GUARD_REQUEST_EVENT, {
      detail: { intent },
    }))
  }
}

export function onPortfolioWriteRequest(handler: (intent?: string) => void): () => void {
  const wrapped = (e: Event) => {
    const detail = (e as CustomEvent<RequestDetail>).detail
    handler(detail?.intent)
  }
  window.addEventListener(GUARD_REQUEST_EVENT, wrapped)
  return () => window.removeEventListener(GUARD_REQUEST_EVENT, wrapped)
}

export function resolvePortfolioWrite(result: 'picked' | 'cancelled'): void {
  window.dispatchEvent(new CustomEvent<ResolveDetail>(GUARD_RESOLVE_EVENT, {
    detail: { result },
  }))
}
