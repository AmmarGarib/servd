'use client'
// ─── TenantField + TenantChip — shared portfolio-aware tenant UI ─────────────
//
// Pattern adopted across every create/edit modal: when the operator is viewing
// All Companies, writes have to declare which company they target. Two pieces
// solve this end-to-end:
//
//   <TenantField value={tenantId} onChange={setTenantId} /> — dropdown that
//   shows itself only when the operator has multiple tenants, defaults to the
//   active one in single-tenant view, requires a pick in portfolio view.
//
//   <TenantChip tenant={…} fallback="No company" /> — indigo pill rendered on
//   list rows so the operator can tell which company each item belongs to.
//
// Combined with the `tenantId` option on api.post/patch/etc., these let pages
// stay in portfolio view the entire time. The header (x-servd-active-tenant)
// is read by backend middleware and overrides req.staffUser.tenantId for that
// one request — no session switching, no nav jiggle.

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useViewAllTenants } from './TenantSwitcher'
import { Select } from '@/components/ui/Select'

export interface TenantLite {
  id: string
  name: string
  slug?: string
  industry?: string | null
  /** 'company' | 'head_office' (D1). Pickers for writes only offer companies. */
  kind?: 'company' | 'head_office'
  /** Set only on a reached (lens) company — never offered by a picker. */
  access?: string
}

/** A trading company the user belongs to: never a head office, never a reached company. */
export function isPickableCompany(t: { kind?: string; access?: string }): boolean {
  return (t.kind ?? 'company') === 'company' && t.access !== 'head_office'
}

/** Hook: fetch the operator's tenant memberships once, cache for 5 minutes. */
export function useMyTenants() {
  return useQuery<TenantLite[]>({
    queryKey: ['my-tenants'],
    queryFn:  () => api.get<TenantLite[]>('/tenants/mine'),
    // Writes bind to a company the user belongs to; reached companies and
    // head offices are never offered.
    select: (rows) => rows.filter(isPickableCompany),
    staleTime: 5 * 60_000,
  })
}

/**
 * Inline company picker. Renders nothing when the operator is single-tenant
 * (one company on file) since there's no decision to make. In portfolio view
 * the field is required and prepends an empty "— pick a company —" option;
 * single-tenant view default-selects the first tenant.
 */
export function TenantField({
  value, onChange, label = 'Company', required, autoDefault = true, className,
}: {
  value: string
  onChange: (id: string) => void
  label?: string
  /** Set true on create forms — controls the required-asterisk + empty option. */
  required?: boolean
  /**
   * When true (default), auto-selects the first tenant once memberships load
   * IF the caller hasn't already set a value AND we're not in portfolio view.
   */
  autoDefault?: boolean
  className?: string
}) {
  const viewAll = useViewAllTenants()
  const { data: tenants = [] } = useMyTenants()

  useEffect(() => {
    if (!autoDefault) return
    if (viewAll) return                              // never auto-pick in portfolio mode
    if (value) return                                // already chosen
    const first = tenants[0]
    if (first) onChange(first.id)
  }, [tenants, viewAll, value, onChange, autoDefault])

  // Single-tenant install (or operator only belongs to one company) — hide
  // the field entirely; there's nothing to pick. The caller still gets a
  // tenantId via autoDefault.
  if (tenants.length <= 1) return null

  const hint = viewAll
    ? 'Required — you\'re viewing all companies.'
    : 'Defaults to your active company; switch if needed.'

  return (
    <label className={`block ${className ?? ''}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-s-muted">
          {label}{required && <span className="text-red-700"> *</span>}
        </span>
        <span className="text-[10px] text-s-muted/70">{hint}</span>
      </div>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none">
        {viewAll && !value && <option value="">— pick a company —</option>}
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </Select>
    </label>
  )
}

/**
 * Indigo brand chip — drop on a list row in portfolio view so the operator
 * sees which company each item belongs to. Falls back to an orange "⚠ No
 * company" badge for orphan rows (tenantId null). Stays hidden in single-
 * tenant view because every row would carry the same name.
 */
export function TenantChip({
  tenant, tenantId, tenants, fallback = '⚠ No company', alwaysShow,
}: {
  /** Hydrated relation (when the API returned `tenant: {...}` inline). */
  tenant?: { id: string; name: string } | null
  /** Bare ID fallback — looked up against the operator's tenant list. */
  tenantId?: string | null
  /** Memberships, typically from useMyTenants — used to resolve `tenantId`. */
  tenants?: TenantLite[]
  /** Custom orphan label. */
  fallback?: string
  /**
   * Force render even in single-tenant view. Default false (chips are noise
   * when every row is the same company).
   */
  alwaysShow?: boolean
}) {
  const viewAll = useViewAllTenants()
  // Resolve display tenant from whichever input the caller supplied.
  const resolved: { name: string } | null =
    tenant ??
    (tenantId && tenants ? tenants.find((t) => t.id === tenantId) ?? null : null)

  // Orphan rows always show a warning — that's a data bug worth surfacing
  // regardless of view mode.
  if (!resolved && !tenantId) {
    return (
      <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
        style={{ background: 'rgba(255,77,79,0.10)', color: '#b42318' }}
        title="No company assigned — edit to fix.">
        {fallback}
      </span>
    )
  }

  // In single-tenant view, every row would show the same brand chip — noise.
  // Skip unless the caller explicitly asks (e.g. a chain rollup page).
  if (!viewAll && !alwaysShow) return null
  if (!resolved) return null

  return (
    <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
      style={{ background: 'rgb(var(--ink-rgb) / 0.15)', color: 'var(--erp-primary-ink)' }}>
      {resolved.name}
    </span>
  )
}
