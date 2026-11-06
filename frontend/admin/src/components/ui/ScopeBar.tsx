'use client'
// The scope bar (owner, 2026-11-06: "This account switcher should be implemented across servd … company first. And
// for companies that have multiple brands/branches they can have a separate switcher once u move into that company";
// "Replace the old one but keep all view … And kill the role view option"). It REPLACED the ∞ switcher module
// (bottom-left button + panel), the "Portfolio view" banner and the CEO's "view as role" — ONE place, at the top of
// every page, to pick what the page shows:
//
//   Row 1 — Company: each company the person belongs to, companies reached through a head office (the lens), and
//           "All companies" for someone in more than one. Shown only when there is a choice.
//   Row 2 — Brand:   "All brands" + each brand of the companies in view (in All companies: every brand the person
//           can open). Shown only when there are two or more.
//   Row 3 — Branch:  "All branches" + each outlet of the companies in view (only the picked brand's when a brand is
//           picked). Shown only when there are two or more.
//
// The choices are the same ones the old switcher made, so every page keeps working unchanged: the company is the
// server's active company (POST /tenants/switch), All companies is the portfolio header, a reached company is the
// lens, and brand / branch are the read filters (`x-servd-brand` / `x-servd-location`, store/brandFilter.ts and
// store/branchFilter.ts). A row says "not filtered on this page" when the page's figures ignore the pick.

import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter, usePathname } from 'next/navigation'
import { api, ApiError } from '../../lib/api'
import { useBrandOptions } from './BrandPicker'
import { useBranchFilter } from '../../store/branchFilter'
import { TestChip, useSwitchCompany, useViewAllTenants, writeViewAll } from './TenantSwitcher'
import { useHeadOfficeMe } from '../../hooks/useWorkspaces'
import { useLens, writeLens } from '../../hooks/useLens'
import { formatBrandName } from '../../lib/brandName'

interface Tenant { id: string; name: string; isActive?: boolean; isTest?: boolean }
interface Branch {
  id: string; name: string; slug?: string; isActive?: boolean; deletedAt?: string | null
  concepts?: Array<{ concept?: { id: string } | null; conceptId?: string }>
}

type Tone = 'company' | 'filter'

function Tab({ on, onClick, children, tone, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; tone: Tone; disabled?: boolean }) {
  // Company = identity (purple, as on the CEO home); brand / branch = a selected filter (green chip, the green rule).
  // The picked tab is kept in view when its row scrolls sideways (a phone).
  const ref = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [on])
  const onStyle: React.CSSProperties = tone === 'company'
    ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
    : { background: 'rgb(var(--erp-accent-rgb) / 0.22)', color: 'var(--erp-primary-ink)', boxShadow: 'inset 0 0 0 1px rgb(var(--erp-accent-rgb) / 0.6)' }
  return (
    <button ref={ref} type="button" role="tab" aria-selected={on} onClick={onClick} disabled={disabled}
      className={`shrink-0 whitespace-nowrap rounded-lg px-3 ${tone === 'company' ? 'py-1.5 text-sm' : 'py-1 text-xs'} font-bold transition-colors disabled:opacity-60 inline-flex items-center gap-1.5`}
      style={on ? onStyle : { color: 'rgb(var(--ink-rgb) / 0.62)' }}>
      {children}
    </button>
  )
}

function Row({ label, children, note }: { label: string; children: React.ReactNode; note?: string | null }) {
  return (
    // The note wraps under the tabs rather than squeezing them (a phone).
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
      <span className="sr-only">{label}</span>
      <div role="tablist" aria-label={label}
        className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto rounded-xl p-1 [scrollbar-width:none]"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        {children}
      </div>
      {note && <span className="shrink-0 text-[11px] font-semibold" style={{ color: 'var(--erp-warning)' }}>{note}</span>}
    </div>
  )
}

export function ScopeBar() {
  const qc = useQueryClient()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const viewAll = useViewAllTenants()
  const { reach } = useHeadOfficeMe()
  const { lensId, setLens } = useLens()
  // Always mounted, so a brand / branch from another company is dropped even when its row is hidden.
  const brand = useBrandOptions()
  const { locationId, setLocation, seen: branchSeen, applied: branchApplied } = useBranchFilter()

  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<Tenant[]>('/tenants/mine'),
    staleTime: 30_000,
  })
  const { data: locations } = useQuery<Branch[]>({
    queryKey: ['locations', 'scope-bar'],
    queryFn: () => api.get<Branch[]>('/locations'),
    staleTime: 60_000,
    meta: { background: true },
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 1,
  })
  const switchTo = useSwitchCompany()

  const active = tenants.find((t) => t.isActive) ?? tenants[0]
  const current = lensId ? `lens:${lensId}` : viewAll ? 'all' : (active?.id ?? '')

  // Trading outlets only: never a switched-off one or the "General — to be assigned" holding place.
  const branches = (locations ?? []).filter((l) => !l.deletedAt && l.isActive !== false && !(l.slug ?? '').startsWith('general-'))
    .filter((l) => !brand.brandId || (l.concepts ?? []).some((c) => (c.concept?.id ?? c.conceptId) === brand.brandId))
  useEffect(() => {
    if (locationId && locations && !branches.some((b) => b.id === locationId)) { setLocation(null); void qc.invalidateQueries() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId, locations, brand.brandId])

  const pickAll = () => {
    if (current === 'all') return
    writeLens(null)
    writeViewAll(true)
    void qc.invalidateQueries()
    router.refresh()
  }
  const pickCompany = (id: string) => {
    if (current === id) return
    switchTo.mutate(id)
  }
  const pickLens = (id: string) => {
    if (current === `lens:${id}`) return
    writeViewAll(false)
    setLens(id)
    router.refresh()
  }
  const pickBranch = (id: string | null) => {
    if (id === locationId) return
    setLocation(id)
    void qc.invalidateQueries()
  }

  const companyCount = tenants.length + reach.length
  const showCompanies = companyCount > 1
  const concepts = brand.concepts ?? []
  const showBrands = concepts.length > 1
  const showBranches = branches.length > 1
  if (!showCompanies && !showBrands && !showBranches) return null

  const branchNotHere = !!locationId && !!branchSeen[pathname] && !branchApplied[pathname]
  const switching = switchTo.isPending ? switchTo.variables : null

  return (
    <nav aria-label="What this page shows" className="px-4 sm:px-7 pb-3 pt-1 flex flex-col gap-1.5 max-w-full">
      {showCompanies && (
        <Row label="Company">
          {tenants.map((t) => (
            <Tab key={t.id} tone="company" on={current === t.id} onClick={() => pickCompany(t.id)} disabled={!!switching}>
              {t.name}{t.isTest && <TestChip />}{switching === t.id && <span className="text-[10px] font-semibold opacity-70">…</span>}
            </Tab>
          ))}
          {reach.map((c) => (
            <Tab key={`lens:${c.companyId}`} tone="company" on={current === `lens:${c.companyId}`} onClick={() => pickLens(c.companyId)}>
              {c.name}<span className="text-[10px] font-semibold opacity-70">via head office</span>
            </Tab>
          ))}
          {tenants.length > 1 && <Tab tone="company" on={current === 'all'} onClick={pickAll}>All companies</Tab>}
        </Row>
      )}
      {showBrands && (
        <Row label="Brand" note={brand.notHere ? 'Brand not filtered on this page' : null}>
          <Tab tone="filter" on={!brand.brandId} onClick={() => brand.pick(null)}>All brands</Tab>
          {concepts.map((c) => (
            <Tab key={c.id} tone="filter" on={brand.brandId === c.id} onClick={() => brand.pick(c.id)}>{formatBrandName(c.name)}</Tab>
          ))}
        </Row>
      )}
      {showBranches && (
        <Row label="Branch" note={branchNotHere ? 'Branch not filtered on this page' : null}>
          <Tab tone="filter" on={!locationId} onClick={() => pickBranch(null)}>All branches</Tab>
          {branches.map((b) => (
            <Tab key={b.id} tone="filter" on={locationId === b.id} onClick={() => pickBranch(b.id)}>{b.name}</Tab>
          ))}
        </Row>
      )}
    </nav>
  )
}
