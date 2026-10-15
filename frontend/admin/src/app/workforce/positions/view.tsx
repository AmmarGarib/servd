'use client'
// ─── Budgeted positions ──────────────────────────────────────────────────────
// What we PLAN to pay for, vs the people page (which lists who's actually
// employed). Edit a salary or headcount here and:
//   - /finance/opex Payroll budget reflects it on next load
//   - /finance/projections labour line on every ProForma reflects it
// No manual sync. The backend's /opex/payroll-snapshot and
// /financePlanning/projections/:id read straight from this table.
//
// Group hierarchy on the page (matches how the CEO thinks about it):
//   Tenant
//     └── Concept (or "Head Office / Tenant-wide")
//           └── Department
//                 └── Shift band
//                       └── Position rows
//
// Lives in view.tsx (not page.tsx) so Next.js App Router doesn't reject the
// PositionsView named export — App Router pages only allow specific named
// exports (metadata, generateMetadata, etc.). page.tsx re-uses this default.

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { fmtPkrWhole } from '../../../lib/money'
import { usePermissions } from '../../../hooks/useCan'
import { useHeadOfficeMe } from '../../../hooks/useWorkspaces'
import { useManagerRoles } from '../../../lib/roles'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { NumberField } from '@/components/ui/NumberField'
import { useConfirm } from '@/components/ui/ConfirmDialog'

// Who may change what on this page — the same rules the API enforces
// (backend/src/modules/positions/routes.ts + contributions.ts), so no one is
// shown a button that answers 403:
//   - managers (the API's MANAGERS): everything, exactly as before;
//   - hr holding 'staff_directory' (POSITION_EDITORS + its module gate): add,
//     edit and archive seats; reads the inter-company contributions;
//   - finance (staff_directory or capital): reads the budget, changes nothing.
// Contributions are a planning figure (what one company bears for another,
// netted into the budget) — they post nothing to either company's books; the
// ledger side is an inter-company transfer (Accounting → Inter-company). They
// still speak for two companies, so only managers who belong to both record
// or change one. Until /permissions/me answers, nothing is writable.
function usePositionAccess(): { isManager: boolean; canEditSeats: boolean } {
  const { data: me } = usePermissions()
  const managerRoles = useManagerRoles()
  if (!me) return { isManager: false, canEditSeats: false }
  const isManager = managerRoles.has(me.role)
  const hrEditor = me.role === 'hr' && (me.modules ?? []).includes('staff_directory')
  return { isManager, canEditSeats: isManager || hrEditor }
}

interface Department {
  id: string
  name: string
  emoji: string | null
  isHeadOffice: boolean
  order: number
}
interface ShiftBand {
  id: string
  name: string
  startTime: string
  endTime: string
  order: number
}
interface Position {
  id: string
  tenantId: string
  conceptId: string | null
  departmentId: string | null
  shiftBandId: string | null
  title: string
  monthlySalaryCents: number
  tenantCostShareCents: number
  costShareNote: string | null
  headcount: number
  filledByUserId: string | null
  status: 'open' | 'filled' | 'frozen' | 'archived'
  notes: string | null
  concept: { id: string; name: string; slug: string } | null
  department: { id: string; name: string; emoji: string | null; isHeadOffice: boolean } | null
  shiftBand: { id: string; name: string; startTime: string; endTime: string } | null
  filledBy: { id: string; name: string; email: string | null } | null
}
interface ContributionSummary {
  id: string
  label: string
  category: 'head_office' | 'commissary' | 'shared_services' | 'other'
  monthlyCents: number
  /** Set by the server on a retired head-office row; never inferred from the category. */
  ended?: boolean
  sourceTenant:      { id: string; name: string }
  destinationTenant: { id: string; name: string }
  direction: 'incoming' | 'outgoing'
  internalSplit: Array<{ label: string; cents: number }> | null
  description?: string | null
}
interface HeadOfficeChargeLine {
  headOfficeId: string
  name: string
  companyTenantId: string
  companyName: string
  shareBps: number
  monthlyCents: number
}
interface Summary {
  totalPositions: number
  totalHeadcount: number
  totalGrossMonthlyCents: number
  totalTenantShareMonthlyCents: number
  netMonthlyCents: number
  incomingContributionMonthlyCents: number
  outgoingContributionMonthlyCents: number
  annualisedTenantShareCents: number
  annualisedNetCents: number
  byConcept: Array<{ id: string | null; name: string; grossCents: number; shareCents: number; count: number }>
  byDepartment: Array<{ id: string; name: string; emoji: string | null; isHeadOffice: boolean; grossCents: number; shareCents: number; count: number }>
  byStatus: { open: number; filled: number; frozen: number }
  contributions: ContributionSummary[]
  headOfficeCharges?: HeadOfficeChargeLine[]
  headOfficeChargesMonthlyCents?: number
  // A head office in scope: what it recharges out to its companies (plan).
  // Already folded into netMonthlyCents by the server.
  rechargedOutMonthlyCents?: number
  labels?: { headOfficeCharges?: string; rechargedOut?: string }
}

const STATUS_META: Record<Position['status'], { label: string; color: string; bg: string }> = {
  open:     { label: 'Open',     color: 'var(--erp-warning)', bg: 'rgba(245,158,11,0.10)' },
  filled:   { label: 'Filled',   color: 'var(--erp-success)', bg: 'rgb(var(--erp-accent-rgb) / 0.18)' },
  frozen:   { label: 'Frozen',   color: 'var(--muted)', bg: 'rgb(var(--fg-rgb) / 0.06)' },
  archived: { label: 'Archived', color: 'var(--muted)', bg: 'rgb(var(--fg-rgb) / 0.04)' },
}

// embedded=true hides:
//   - the outer min-h-screen wrapper + bg (host page provides chrome)
//   - the breadcrumb + h1 + page-title block (host page already has a title)
//   - the "+ New position" button in the header (host renders own actions if it wants)
// embedded=false renders everything (standalone mode at /workforce/positions).
export function PositionsView({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient()
  const { isManager, canEditSeats } = usePositionAccess()
  // After the CEO's head-office setup the old head-office cost-share UI is retired.
  const { headOfficeSetupApplied } = useHeadOfficeMe()
  const { data: positions = [], isLoading } = useQuery<Position[]>({
    queryKey: ['positions'],
    queryFn:  () => api.get('/positions'),
  })
  const { data: summary } = useQuery<Summary>({
    queryKey: ['positions', 'summary'],
    queryFn:  () => api.get('/positions/summary'),
  })
  const { data: departments = [] } = useQuery<Department[]>({
    queryKey: ['departments'],
    queryFn:  () => api.get('/positions/departments'),
  })
  const { data: shiftBands = [] } = useQuery<ShiftBand[]>({
    queryKey: ['shift-bands'],
    queryFn:  () => api.get('/positions/shift-bands'),
  })
  // A seat's title is an HR designation (HR → Org setup owns the list), and
  // departments are written there too — this page only reads them.
  const { data: org } = useQuery<{ units: Array<{ id: string; kind: string; name: string; isActive: boolean }> }>({
    queryKey: ['hr-org', null],
    queryFn:  () => api.get('/hr/org'),
    staleTime: 60_000,
  })
  const designations = (org?.units ?? []).filter((u) => u.kind === 'designation' && u.isActive)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [contribModal, setContribModal] = useState<ContributionSummary | 'new' | null>(null)

  // Tenants the operator is a member of. Used to populate source/destination
  // pickers on the contribution modal. The backend guardrail requires at
  // least one side of the contribution to be a tenant we belong to.
  const { data: tenants = [] } = useQuery<Array<{ id: string; name: string; slug: string; isActive?: boolean; isJointVenture?: boolean; jvPartners?: Array<{ label: string; pct: number }> | null }>>({
    queryKey: ['my-tenants'],
    queryFn:  () => api.get('/tenants/mine'),
    staleTime: 5 * 60_000,
  })
  // Active tenant's JV config. Drives the partner-split chips on the
  // Net P&L stat card so the operator sees "Viva 60% / GS 40%" of every
  // total without doing the math.
  const activeTenant = tenants.find((t) => t.isActive) ?? tenants[0]
  const jvPartners = activeTenant?.isJointVenture ? (activeTenant.jvPartners ?? []) : []

  const grouped = useMemo(() => {
    type GroupedDept = {
      key: string
      title: string
      emoji: string | null
      isHeadOffice: boolean
      shiftGroups: Array<{ shiftBandLabel: string; positions: Position[] }>
      gross: number
      share: number
      headcount: number
    }
    type GroupedConcept = {
      key: string
      title: string
      slug: string | null
      depts: GroupedDept[]
      gross: number
      share: number
      headcount: number
    }

    const concepts = new Map<string, GroupedConcept>()

    for (const p of positions) {
      const cKey = p.concept?.id ?? 'tenant'
      const cTitle = p.concept?.name ?? 'Tenant-wide / Head Office'
      const concept = concepts.get(cKey) ?? {
        key: cKey, title: cTitle, slug: p.concept?.slug ?? null,
        depts: [], gross: 0, share: 0, headcount: 0,
      }
      concepts.set(cKey, concept)

      const dKey = p.department?.id ?? 'no-dept'
      let dept = concept.depts.find((d) => d.key === dKey)
      if (!dept) {
        dept = {
          key: dKey,
          title: p.department?.name ?? 'No department',
          emoji: p.department?.emoji ?? null,
          isHeadOffice: p.department?.isHeadOffice ?? false,
          shiftGroups: [],
          gross: 0, share: 0, headcount: 0,
        }
        concept.depts.push(dept)
      }

      const shiftLabel = p.shiftBand?.name ?? 'Any shift'
      let group = dept.shiftGroups.find((g) => g.shiftBandLabel === shiftLabel)
      if (!group) {
        group = { shiftBandLabel: shiftLabel, positions: [] }
        dept.shiftGroups.push(group)
      }
      group.positions.push(p)

      const grossDelta = p.monthlySalaryCents * p.headcount
      const shareDelta = p.tenantCostShareCents * p.headcount
      dept.gross += grossDelta
      dept.share += shareDelta
      dept.headcount += p.headcount
      concept.gross += grossDelta
      concept.share += shareDelta
      concept.headcount += p.headcount
    }

    return Array.from(concepts.values())
  }, [positions])

  return (
    <div className={embedded ? '' : 'min-h-screen bg-s-bg text-s-text'}>
      {!embedded && (
      <div className="border-b border-s-border bg-s-surface">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs text-s-muted mb-1">
                <Link href="/workforce" className="hover:text-s-text">Workforce</Link>
                <span>/</span>
                <span className="text-s-text">Budgeted positions</span>
              </div>
              <h1 className="text-2xl font-black">Budgeted positions</h1>
              <p className="text-sm text-s-muted mt-1 max-w-2xl">
                Every seat the org pays for, filled or not. Edits here update the
                Payroll line in <Link href="/finance/opex" className="text-primary-ink hover:underline">OpEx</Link> and
                the labour cost on every <Link href="/finance/projections" className="text-primary-ink hover:underline">projection</Link> on
                next load — no manual sync.
              </p>
            </div>
            {canEditSeats && (
              <div className="flex items-center gap-2">
                <button onClick={() => setShowAdd(true)}
                  className="rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90">
                  + New position
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {embedded && canEditSeats && (
        <div className="max-w-6xl mx-auto px-6 pt-4 flex justify-end">
          <button onClick={() => setShowAdd(true)}
            className="rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90">
            + New position
          </button>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-6 pt-5">
        {activeTenant?.isJointVenture && jvPartners.length > 0 && (() => {
          const jvSplit = (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-wider rounded px-1.5 py-0.5"
                style={{ background: 'rgb(var(--erp-primary-rgb) / 0.14)', color: 'var(--erp-primary-ink)' }}>
                Joint venture
              </span>
              <span className="text-sm text-s-text font-bold">{activeTenant.name}</span>
              <span className="text-xs text-s-muted">- partner split:</span>
              {jvPartners.map((p, i) => (
                <span key={i} className="text-[11px] font-bold rounded px-2 py-0.5"
                  style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)', color: 'var(--erp-primary-ink)' }}>
                  {p.label} {p.pct}%
                </span>
              ))}
            </div>
          )
          const jvStyle = { background: 'rgb(var(--erp-primary-rgb) / 0.04)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.2)' }
          // The JV config is company setup (tenant PATCH is admin-only); HR and
          // finance see the split here but get no edit link.
          return isManager ? (
            <Link href="/settings"
              className="block mb-4 rounded-2xl px-4 py-3 hover:bg-white/[0.03] transition-colors"
              style={jvStyle}>
              <div className="flex items-center justify-between flex-wrap gap-2">
                {jvSplit}
                <span className="text-[11px] text-s-muted hover:underline">Edit JV config →</span>
              </div>
            </Link>
          ) : (
            <div className="mb-4 rounded-2xl px-4 py-3" style={jvStyle}>{jvSplit}</div>
          )
        })()}

        {summary && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                label="Net monthly P&L"
                value={fmtPkrWhole(summary.netMonthlyCents)}
                hint={
                  summary.incomingContributionMonthlyCents > 0 || summary.outgoingContributionMonthlyCents > 0
                    ? `gross ${fmtPkrWhole(summary.totalTenantShareMonthlyCents)} +/- JV transfers`
                    : `equals gross (no contributions)`
                }
                accent="var(--erp-primary-ink)"
                jvPartners={jvPartners}
                valueCents={summary.netMonthlyCents}
              />
              <StatCard
                label="Annualised net"
                value={fmtPkrWhole(summary.annualisedNetCents)}
                hint="net x 12 months"
                accent="var(--erp-secondary)"
                jvPartners={jvPartners}
                valueCents={summary.annualisedNetCents}
              />
              <StatCard
                label="Headcount"
                value={summary.totalHeadcount.toString()}
                hint={`${summary.totalPositions} positions`}
                accent="var(--erp-warning)"
              />
              <StatCard
                label="Open seats"
                value={summary.byStatus.open.toString()}
                hint={`${summary.byStatus.filled} filled, ${summary.byStatus.frozen} frozen`}
                accent={summary.byStatus.open > 0 ? 'var(--erp-warning)' : 'var(--erp-success)'}
              />
            </div>

            {((summary.headOfficeCharges ?? []).length > 0 || (summary.rechargedOutMonthlyCents ?? 0) > 0) && (
              <div className="mt-4 rounded-xl border border-s-border bg-s-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-s-border">
                  <p className="text-sm font-bold">{summary.labels?.headOfficeCharges ?? 'Head office charges (plan)'}</p>
                  <p className="text-[11px] text-s-muted">Each company&apos;s planned share of its head office&apos;s cost</p>
                </div>
                <div className="px-4 py-3 grid gap-2">
                  {(summary.headOfficeCharges ?? []).map((h) => (
                    <div key={`${h.headOfficeId}:${h.companyTenantId}`} className="flex justify-between text-xs font-mono items-baseline">
                      <span className="text-s-muted">
                        {h.name} &rarr; {h.companyName}
                        <span className="text-[10px] text-s-muted/70"> ({Number((h.shareBps / 100).toFixed(2))}%)</span>
                      </span>
                      <span className="font-bold" style={{ color: 'var(--erp-warning)' }}>+ {fmtPkrWhole(h.monthlyCents)}</span>
                    </div>
                  ))}
                  {(summary.headOfficeCharges ?? []).length > 0 && (
                    <div className="border-t border-s-border mt-1 pt-2 flex justify-between text-xs font-mono">
                      <span className="font-bold">Total</span>
                      <span className="font-black">{fmtPkrWhole(summary.headOfficeChargesMonthlyCents ?? 0)}</span>
                    </div>
                  )}
                  {(summary.rechargedOutMonthlyCents ?? 0) > 0 && (
                    <div className="flex justify-between text-xs font-mono items-baseline">
                      <span className="text-s-muted">{summary.labels?.rechargedOut ?? 'Recharged to companies (plan)'}</span>
                      <span className="font-bold" style={{ color: 'var(--erp-success)' }}>- {fmtPkrWhole(summary.rechargedOutMonthlyCents ?? 0)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="mt-4 rounded-xl border border-s-border bg-s-surface overflow-hidden">
              <div className="px-4 py-3 border-b border-s-border flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold">JV / inter-tenant contributions</p>
                  <p className="text-[11px] text-s-muted">
                    Subtracts incoming, adds outgoing &rarr; gives net P&L
                  </p>
                </div>
                {isManager && (
                  <button onClick={() => setContribModal('new')}
                    className="rounded-lg px-3 py-1.5 text-xs font-bold border border-s-border text-s-text hover:border-primary/40 hover:text-primary-ink transition-colors">
                    + Add contribution
                  </button>
                )}
              </div>
              {summary.contributions.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs text-s-muted">
                    No inter-tenant contributions yet. Use this for JV chargebacks
                    (e.g. one tenant contributes a lump sum to another for shared
                    head-office or commissary services).
                  </p>
                </div>
              ) : (
                <div className="px-4 py-3 grid gap-2">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-s-muted">Position gross ({summary.totalPositions} seats)</span>
                    <span className="font-bold">{fmtPkrWhole(summary.totalTenantShareMonthlyCents)}</span>
                  </div>
                  {summary.contributions.map((c) => {
                    // Server flag only: a contribution that still counts toward Net is never 'ended'.
                    const ended = c.ended === true
                    const line = (<>
                      <div className="flex justify-between text-xs font-mono items-baseline">
                        <span className="text-s-muted flex items-center gap-1.5">
                          <span style={{ color: c.direction === 'incoming' ? 'var(--erp-success)' : 'var(--erp-warning)' }}>
                            {c.direction === 'incoming' ? '<--' : '-->'}
                          </span>
                          {c.label}
                          <span className="text-[10px] text-s-muted/70">
                            ({c.direction === 'incoming' ? 'from' : 'to'}{' '}
                            {c.direction === 'incoming' ? c.sourceTenant.name : c.destinationTenant.name})
                          </span>
                        </span>
                        <span className="font-bold"
                          style={ended ? undefined : { color: c.direction === 'incoming' ? 'var(--erp-success)' : 'var(--erp-warning)' }}>
                          {ended ? '' : (c.direction === 'incoming' ? '- ' : '+ ')}{fmtPkrWhole(c.monthlyCents)}
                        </span>
                      </div>
                      {c.internalSplit && c.internalSplit.length > 0 && (
                        <div className="pl-5 pt-1 flex gap-3 flex-wrap text-[10px] text-s-muted font-mono">
                          {c.internalSplit.map((s, i) => (
                            <span key={i}>
                              {s.label}: {fmtPkrWhole(s.cents)}
                            </span>
                          ))}
                        </div>
                      )}
                    </>)
                    // After the setup, old head-office contributions are ended:
                    // shown read-only. Only managers may change any other one.
                    if (ended) {
                      return (
                        <div key={c.id} className="rounded-md px-1 py-1 -mx-1 opacity-60">
                          {line}
                          <p className="pl-5 text-[10px] uppercase tracking-wider font-bold text-s-muted">ended</p>
                        </div>
                      )
                    }
                    return isManager ? (
                      <button key={c.id} type="button" onClick={() => setContribModal(c)}
                        className="text-left rounded-md px-1 py-1 -mx-1 hover:bg-s-bg/40 transition-colors">
                        {line}
                      </button>
                    ) : (
                      <div key={c.id} className="rounded-md px-1 py-1 -mx-1">{line}</div>
                    )
                  })}
                  {(summary.headOfficeChargesMonthlyCents ?? 0) > 0 && (
                    <div className="flex justify-between text-xs font-mono items-baseline">
                      <span className="text-s-muted">{summary.labels?.headOfficeCharges ?? 'Head office charges (plan)'}</span>
                      <span className="font-bold" style={{ color: 'var(--erp-warning)' }}>+ {fmtPkrWhole(summary.headOfficeChargesMonthlyCents ?? 0)}</span>
                    </div>
                  )}
                  {(summary.rechargedOutMonthlyCents ?? 0) > 0 && (
                    <div className="flex justify-between text-xs font-mono items-baseline">
                      <span className="text-s-muted">{summary.labels?.rechargedOut ?? 'Recharged to companies (plan)'}</span>
                      <span className="font-bold" style={{ color: 'var(--erp-success)' }}>- {fmtPkrWhole(summary.rechargedOutMonthlyCents ?? 0)}</span>
                    </div>
                  )}
                  <div className="border-t border-s-border mt-1 pt-2 flex justify-between text-sm font-mono">
                    <span className="font-bold">Net to this tenant&apos;s P&L</span>
                    <span className="font-black" style={{ color: 'var(--erp-primary-ink)' }}>
                      {fmtPkrWhole(summary.netMonthlyCents)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="max-w-6xl mx-auto px-6 pb-12 pt-5">
        {isLoading && <div className="p-8 text-center text-sm text-s-muted">Loading positions…</div>}

        {!isLoading && positions.length === 0 && (
          <div className="rounded-xl border border-s-border bg-s-surface p-12 text-center">
            <p className="text-4xl mb-2">💼</p>
            <p className="text-sm font-semibold">No budgeted positions yet</p>
            {canEditSeats ? (
              <>
                <p className="text-xs text-s-muted mt-1 max-w-md mx-auto">
                  Start with a position for each seat the org pays for. You don't need a
                  named hire — just the designation, shift band, salary and which concept it serves.
                  Designations and departments are set up in HR → Org setup.
                </p>
                <button onClick={() => setShowAdd(true)}
                  className="mt-4 rounded-lg px-4 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90">
                  + Create the first position
                </button>
              </>
            ) : (
              <p className="text-xs text-s-muted mt-1 max-w-md mx-auto">
                HR or a manager adds the seats the org pays for in Workforce → Positions.
              </p>
            )}
          </div>
        )}

        {grouped.map((concept) => (
          <div key={concept.key} className="mt-6">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <h2 className="text-lg font-black">{concept.title}</h2>
              <p className="text-xs text-s-muted font-mono">
                {concept.headcount} ppl · share {fmtPkrWhole(concept.share)} / month
              </p>
            </div>
            <div className="rounded-xl border border-s-border bg-s-surface overflow-hidden">
              {concept.depts.map((dept, dIdx) => (
                <div key={dept.key} className={dIdx > 0 ? 'border-t border-s-border' : ''}>
                  <div className="flex items-baseline justify-between gap-3 px-4 py-3 bg-s-bg/30">
                    <p className="text-sm font-bold flex items-center gap-2">
                      <span>{dept.emoji ?? '·'}</span>
                      <span>{dept.title}</span>
                      {dept.isHeadOffice && !headOfficeSetupApplied && (
                        <span className="text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
                          style={{ background: 'rgb(var(--ink-rgb) / 0.15)', color: 'var(--erp-primary-ink)' }}>
                          Head office
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-s-muted font-mono">
                      {dept.headcount} ppl · {fmtPkrWhole(dept.share)}
                      {dept.gross !== dept.share && (
                        <span className="opacity-60"> (gross {fmtPkrWhole(dept.gross)})</span>
                      )}
                    </p>
                  </div>
                  {dept.shiftGroups.map((shift) => (
                    <div key={shift.shiftBandLabel}>
                      {shift.shiftBandLabel !== 'Any shift' && (
                        <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-s-muted bg-s-bg/20">
                          {shift.shiftBandLabel}
                        </div>
                      )}
                      {shift.positions.map((p) => (
                        <PositionRow
                          key={p.id} position={p}
                          canEdit={canEditSeats}
                          expanded={canEditSeats && editingId === p.id}
                          onExpand={() => setEditingId(editingId === p.id ? null : p.id)}
                          onClose={() => setEditingId(null)}
                          onChange={() => {
                            void qc.invalidateQueries({ queryKey: ['positions'] })
                          }}
                          departments={departments}
                          shiftBands={shiftBands}
                          designations={designations}
                          setupApplied={headOfficeSetupApplied}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {showAdd && canEditSeats && (
        <AddPositionModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); void qc.invalidateQueries({ queryKey: ['positions'] }) }}
          departments={departments}
          shiftBands={shiftBands}
          designations={designations}
        />
      )}
      {contribModal && isManager && (
        <ContributionModal
          existing={contribModal === 'new' ? null : contribModal}
          tenants={tenants}
          onClose={() => setContribModal(null)}
          onSaved={() => {
            setContribModal(null)
            void qc.invalidateQueries({ queryKey: ['positions', 'summary'] })
          }}
        />
      )}
    </div>
  )
}

function StatCard({ label, value, hint, accent, jvPartners, valueCents }: {
  label: string; value: string; hint?: string; accent: string
  jvPartners?: Array<{ label: string; pct: number }>
  valueCents?: number
}) {
  return (
    <div className="rounded-xl border border-s-border bg-s-surface p-4">
      <p className="text-[10px] uppercase tracking-wider text-s-muted font-bold">{label}</p>
      <p className="text-xl font-black mt-1" style={{ color: accent }}>{value}</p>
      {hint && <p className="text-[10px] text-s-muted mt-0.5">{hint}</p>}
      {jvPartners && jvPartners.length > 0 && valueCents !== undefined && valueCents > 0 && (
        <div className="mt-2 flex gap-1.5 flex-wrap">
          {jvPartners.map((p, i) => (
            <span key={i} className="text-[10px] font-mono rounded px-1.5 py-0.5"
              style={{ background: 'rgb(var(--erp-primary-rgb) / 0.08)', color: 'var(--erp-primary-ink)' }}>
              {p.label} {p.pct}%: {fmtPkrWhole(Math.round(valueCents * p.pct / 100))}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

type Designation = { id: string; name: string }

function PositionRow({
  position, canEdit, expanded, onExpand, onClose, onChange, departments, shiftBands, designations, setupApplied,
}: {
  position: Position
  /** False = read-only viewer (finance, or while the role loads): no expand-to-edit. */
  canEdit: boolean
  expanded: boolean
  onExpand: () => void
  onClose: () => void
  onChange: () => void
  departments: Department[]
  shiftBands: ShiftBand[]
  designations: Designation[]
  setupApplied: boolean
}) {
  const status = STATUS_META[position.status]
  const summary = (<>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="font-semibold text-sm truncate">{position.title}</p>
        {position.headcount > 1 && (
          <span className="text-[10px] font-bold rounded px-1.5 py-0.5"
            style={{ background: 'rgb(var(--erp-primary-rgb) / 0.10)', color: 'var(--erp-primary-ink)' }}>
            × {position.headcount}
          </span>
        )}
        <span className="text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
          style={{ background: status.bg, color: status.color }}>
          {status.label}
        </span>
        {position.filledBy && (
          <span className="text-[10px] text-s-muted">→ {position.filledBy.name}</span>
        )}
      </div>
      {!setupApplied && position.costShareNote && position.tenantCostShareCents !== position.monthlySalaryCents && (
        <p className="text-[10px] text-s-muted mt-0.5 italic truncate">{position.costShareNote}</p>
      )}
    </div>
    <div className="shrink-0 text-right">
      <p className="text-sm font-bold font-mono">{fmtPkrWhole(position.tenantCostShareCents)}</p>
      {position.tenantCostShareCents !== position.monthlySalaryCents && (
        <p className="text-[10px] text-s-muted font-mono opacity-70">gross {fmtPkrWhole(position.monthlySalaryCents)}</p>
      )}
    </div>
  </>)
  if (!canEdit) {
    return (
      <div className="border-t border-s-border first:border-t-0">
        <div className="w-full flex items-center gap-3 px-4 py-2.5">{summary}</div>
      </div>
    )
  }
  return (
    <div className="border-t border-s-border first:border-t-0">
      <button onClick={onExpand}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-s-bg/30 ${
          expanded ? 'bg-s-bg/40' : ''
        }`}>
        {summary}
        <span className="shrink-0 text-s-muted text-xs"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 120ms' }}>▶</span>
      </button>
      {expanded && (
        <PositionEditor position={position} onChange={onChange} onClose={onClose}
          departments={departments} shiftBands={shiftBands} designations={designations} setupApplied={setupApplied} />
      )}
    </div>
  )
}

function PositionEditor({
  position, onChange, onClose, departments, shiftBands, designations, setupApplied,
}: {
  position: Position
  onChange: () => void
  onClose: () => void
  departments: Department[]
  shiftBands: ShiftBand[]
  designations: Designation[]
  setupApplied: boolean
}) {
  const current = designations.find((d) => d.name.toLowerCase() === position.title.toLowerCase())
  const [designationId, setDesignationId] = useState(current?.id ?? '')
  const [gross, setGross] = useState(position.monthlySalaryCents)
  const [share, setShare] = useState(position.tenantCostShareCents)
  const [headcount, setHeadcount] = useState(position.headcount)
  const [status, setStatus] = useState<Position['status']>(position.status)
  const [departmentId, setDepartmentId] = useState(position.departmentId ?? '')
  const [shiftBandId, setShiftBandId] = useState(position.shiftBandId ?? '')
  const [costShareNote, setCostShareNote] = useState(position.costShareNote ?? '')
  const [notes, setNotes] = useState(position.notes ?? '')

  const save = useMutation({
    mutationFn: () => api.patch(`/positions/${position.id}`, {
      // The title is only ever set from an HR designation.
      ...(designationId && designationId !== current?.id && { designationId }),
      monthlySalaryCents: gross,
      ...(!setupApplied && { tenantCostShareCents: share }),
      headcount,
      status,
      departmentId: departmentId || null,
      shiftBandId: shiftBandId || null,
      ...(!setupApplied && { costShareNote: costShareNote.trim() || null }),
      notes: notes.trim() || null,
    }),
    onSuccess: () => { onChange(); onClose() },
  })

  const archive = useMutation({
    mutationFn: () => api.delete(`/positions/${position.id}`),
    onSuccess: () => { onChange(); onClose() },
  })

  return (
    <div className="bg-s-bg/30 border-t border-s-border px-4 py-4 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Designation" hint={current ? undefined : `"${position.title}" is not an HR designation — pick one (add it in HR → Org setup if it is missing).`}>
          <Select value={designationId} onChange={(e) => setDesignationId(e.target.value)} className={inputCls}>
            <option value="">{current ? current.name : `— ${position.title} —`}</option>
            {designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Position['status'])} className={inputCls}>
            <option value="open">Open</option>
            <option value="filled">Filled</option>
            <option value="frozen">Frozen</option>
            <option value="archived">Archived</option>
          </Select>
        </Field>
        <Field label="Department">
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputCls}>
            <option value="">— No department —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.emoji ? `${d.emoji} ` : ''}{d.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Shift band">
          <Select value={shiftBandId} onChange={(e) => setShiftBandId(e.target.value)} className={inputCls}>
            <option value="">— Any shift —</option>
            {shiftBands.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>
            ))}
          </Select>
        </Field>
        <Field label="Gross monthly salary" hint="What the person earns (full salary).">
          <MoneyInput value={gross} onChange={setGross} />
        </Field>
        {!setupApplied && (
          <Field label="Tenant cost-share" hint="What THIS tenant's P&L bears. Defaults to gross.">
            <MoneyInput value={share} onChange={setShare} />
          </Field>
        )}
        <Field label="Headcount" hint="Number of identical seats in this row.">
          <input type="number" min={1} value={headcount} onChange={(e) => setHeadcount(parseInt(e.target.value) || 1)}
            className={inputCls} />
        </Field>
        {!setupApplied && <div className="md:col-span-2">
          <Field label="Cost-share note" hint="Explain why share < gross (e.g. head office allocation, JV split).">
            <input value={costShareNote} onChange={(e) => setCostShareNote(e.target.value)} className={inputCls}
              placeholder="e.g. Head office: GS Foods bears 37.5% of gross." />
          </Field>
        </div>}
        <div className="md:col-span-2">
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + ' min-h-[60px]'} />
          </Field>
        </div>
      </div>
      {save.error && <p className="text-xs text-red-700">{(save.error as Error).message}</p>}
      <div className="flex items-center justify-between gap-2 pt-2">
        <button onClick={() => archive.mutate()} disabled={archive.isPending}
          className="rounded-lg px-3 py-2 text-xs font-bold text-red-700 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-50">
          🗑 Archive
        </button>
        <div className="flex gap-2">
          <button onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs font-bold text-s-muted border border-s-border hover:text-s-text">
            Cancel
          </button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AddPositionModal({
  onClose, onCreated, departments, shiftBands, designations,
}: {
  onClose: () => void
  onCreated: () => void
  departments: Department[]
  shiftBands: ShiftBand[]
  designations: Designation[]
}) {
  const [designationId, setDesignationId] = useState('')
  const [gross, setGross] = useState(0)
  const [share, setShare] = useState(0)
  const [shareTouched, setShareTouched] = useState(false)
  const [headcount, setHeadcount] = useState(1)
  const [departmentId, setDepartmentId] = useState('')
  const [shiftBandId, setShiftBandId] = useState('')

  // Until the operator explicitly edits the share, mirror it to gross — saves
  // them a step in the common case where the tenant pays 100%.
  function setGrossAndMaybeShare(g: number) {
    setGross(g)
    if (!shareTouched) setShare(g)
  }

  const create = useMutation({
    mutationFn: () => api.post('/positions', {
      designationId,
      monthlySalaryCents: gross,
      tenantCostShareCents: share,
      headcount,
      departmentId: departmentId || null,
      shiftBandId: shiftBandId || null,
    }),
    onSuccess: onCreated,
  })

  return (
    <Modal title="New position" onClose={onClose} wide
      dirty={!!designationId || gross > 0 || !!departmentId || !!shiftBandId || headcount !== 1}>
      <form className="space-y-0" onSubmit={(e) => { e.preventDefault(); if (designationId && gross > 0 && !create.isPending) create.mutate() }}>
        <div className="space-y-3">
          <Field label="Designation" hint={designations.length ? undefined : 'No designations yet — add them in HR → Org setup.'}>
            <Select value={designationId} onChange={(e) => setDesignationId(e.target.value)} className={inputCls} autoFocus>
              <option value="">Choose the HR designation…</option>
              {designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="Department">
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputCls}>
              <option value="">— None —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.emoji ? `${d.emoji} ` : ''}{d.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Shift band">
            <Select value={shiftBandId} onChange={(e) => setShiftBandId(e.target.value)} className={inputCls}>
              <option value="">— Any —</option>
              {shiftBands.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gross / month">
              <MoneyInput value={gross} onChange={setGrossAndMaybeShare} />
            </Field>
            <Field label="Tenant share" hint={shareTouched ? '' : 'auto-mirrors gross'}>
              <MoneyInput value={share} onChange={(v) => { setShare(v); setShareTouched(true) }} />
            </Field>
          </div>
          <Field label="Headcount" hint="Number of identical seats.">
            <NumberField value={headcount} min={1} max={500}
              onValueChange={(v) => setHeadcount(v ?? 1)} className={inputCls} />
          </Field>
        </div>
        {create.error && <p className="text-xs text-red-700 mt-3">{(create.error as Error).message}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-xs font-bold text-s-muted border border-s-border hover:text-s-text">
            Cancel
          </button>
          <button type="submit" disabled={!designationId || gross <= 0 || create.isPending}
            className="rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90 disabled:opacity-50">
            {create.isPending ? 'Creating…' : 'Create position'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

const inputCls = 'w-full rounded-md border border-s-border bg-s-bg px-3 py-2 text-sm focus:border-primary focus:outline-none'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold uppercase tracking-wider text-s-muted block mb-1">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-s-muted block mt-1">{hint}</span>}
    </label>
  )
}

interface CategoryOption { value: 'head_office' | 'commissary' | 'shared_services' | 'other'; label: string }
const CONTRIB_CATEGORIES: CategoryOption[] = [
  { value: 'head_office',     label: 'Head office (shared HQ salaries)' },
  { value: 'commissary',      label: 'Commissary (shared kitchen)' },
  { value: 'shared_services', label: 'Shared services (IT, legal, brand)' },
  { value: 'other',           label: 'Other' },
]

function ContributionModal({
  existing, tenants, onClose, onSaved,
}: {
  existing: ContributionSummary | null
  tenants: Array<{ id: string; name: string; slug: string }>
  onClose: () => void
  onSaved: () => void
}) {
  const [sourceTenantId,      setSourceTenantId]      = useState(existing?.sourceTenant.id      ?? '')
  const [destinationTenantId, setDestinationTenantId] = useState(existing?.destinationTenant.id ?? '')
  const [category,            setCategory]            = useState<CategoryOption['value']>(existing?.category ?? 'head_office')
  const [monthlyCents,        setMonthlyCents]        = useState(existing?.monthlyCents ?? 0)
  const [label,               setLabel]               = useState(existing?.label ?? '')
  const [description,         setDescription]         = useState(existing?.description ?? '')
  const [splitRows, setSplitRows] = useState<Array<{ label: string; cents: number }>>(
    existing?.internalSplit && existing.internalSplit.length > 0
      ? existing.internalSplit
      : [],
  )

  if (!existing && !sourceTenantId && tenants.length >= 2) {
    queueMicrotask(() => {
      setSourceTenantId(tenants[0]!.id)
      setDestinationTenantId(tenants[1]!.id)
    })
  }

  const splitSum = splitRows.reduce((s, r) => s + (r.cents || 0), 0)
  const sumMismatch = splitRows.length > 0 && splitSum !== monthlyCents

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        sourceTenantId,
        destinationTenantId,
        category,
        monthlyCents,
        label,
        description: description.trim() || null,
        internalSplit: splitRows.length > 0 ? splitRows : null,
      }
      return existing
        ? api.patch(`/positions/contributions/${existing.id}`, payload)
        : api.post('/positions/contributions', payload)
    },
    onSuccess: onSaved,
  })

  const confirm = useConfirm()
  const archive = useMutation({
    mutationFn: () => api.delete(`/positions/contributions/${existing!.id}`),
    onSuccess: onSaved,
  })

  const canSave = !!sourceTenantId && !!destinationTenantId
    && sourceTenantId !== destinationTenantId
    && monthlyCents > 0
    && label.trim().length > 0

  return (
    <Modal title={existing ? 'Edit contribution' : 'New inter-tenant contribution'} onClose={onClose} wide
      dirty={!!label || monthlyCents > 0 || splitRows.length > 0 || !!description}>
      <form onSubmit={(e) => { e.preventDefault(); if (canSave && !save.isPending) save.mutate() }}>
        <p className="text-xs text-s-muted mb-4">
          {existing
            ? 'Update the agreed monthly transfer or its internal split.'
            : 'Model a chargeback between two tenants you own (e.g. JV partner contributes to head office).'}
        </p>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From (source)">
              <Select value={sourceTenantId} onChange={(e) => setSourceTenantId(e.target.value)} className={inputCls}>
                <option value="">— Pick a tenant —</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="To (destination)">
              <Select value={destinationTenantId} onChange={(e) => setDestinationTenantId(e.target.value)} className={inputCls}>
                <option value="">— Pick a tenant —</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.id === sourceTenantId}>{t.name}</option>
                ))}
              </Select>
            </Field>
          </div>
          {sourceTenantId && destinationTenantId && sourceTenantId === destinationTenantId && (
            <p className="text-xs text-red-700">Source and destination must differ.</p>
          )}

          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value as CategoryOption['value'])} className={inputCls}>
              {CONTRIB_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </Field>

          <Field label="Label" hint="Short name shown on the positions/opex/projections views.">
            <input value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. GS x Viva HO contribution" className={inputCls} />
          </Field>

          <Field label="Monthly amount" hint="Total transferred each month.">
            <MoneyInput value={monthlyCents} onChange={setMonthlyCents} />
          </Field>

          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-s-muted">
                Internal split (optional)
              </span>
              <button type="button"
                onClick={() => setSplitRows([...splitRows, { label: '', cents: 0 }])}
                className="text-[10px] font-bold text-primary-ink hover:underline">
                + Add line
              </button>
            </div>
            <p className="text-[10px] text-s-muted mb-2">
              Document how the transfer breaks down internally (e.g. JV shares). Not enforced
              against the monthly amount &mdash; it&apos;s for reporting only.
            </p>
            <div className="space-y-2">
              {splitRows.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input value={row.label}
                    onChange={(e) => {
                      const next = [...splitRows]
                      next[i] = { ...next[i]!, label: e.target.value }
                      setSplitRows(next)
                    }}
                    placeholder="e.g. Garibsons 40%"
                    className={inputCls + ' flex-1'} />
                  <div className="w-40">
                    <MoneyInput value={row.cents}
                      onChange={(v) => {
                        const next = [...splitRows]
                        next[i] = { ...next[i]!, cents: v }
                        setSplitRows(next)
                      }} />
                  </div>
                  <button type="button"
                    onClick={() => setSplitRows(splitRows.filter((_, j) => j !== i))}
                    aria-label={`Remove split line ${i + 1}`}
                    className="text-red-700 hover:bg-red-400/10 rounded-md px-2 text-sm min-h-[44px] min-w-[44px]">
                    &times;
                  </button>
                </div>
              ))}
            </div>
            {splitRows.length > 0 && (
              <p className={`text-[10px] mt-2 font-mono ${sumMismatch ? 'text-amber-700' : 'text-s-muted'}`}>
                Split sum: PKR {(splitSum / 100).toLocaleString('en-PK')}
                {sumMismatch && ` (differs from monthly PKR ${(monthlyCents / 100).toLocaleString('en-PK')} — that&apos;s OK if intentional)`}
              </p>
            )}
          </div>

          <Field label="Description (optional)" hint="Context for future-you. Anything goes.">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              className={inputCls + ' min-h-[60px]'} />
          </Field>
        </div>

        <div className="flex justify-between items-center gap-2 mt-5">
          {existing ? (
            <button type="button" onClick={async () => {
                if (await confirm({ title: 'Archive this contribution?', confirmLabel: 'Archive', danger: true })) archive.mutate()
              }} disabled={archive.isPending}
              className="rounded-lg px-3 py-2 text-xs font-bold text-red-700 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-50">
              {archive.isPending ? 'Archiving…' : 'Archive'}
            </button>
          ) : <div />}
          <div className="flex gap-2">
            <button type="button" onClick={onClose}
              className="rounded-lg px-3 py-2 text-xs font-bold text-s-muted border border-s-border hover:text-s-text">
              Cancel
            </button>
            <button type="submit" disabled={!canSave || save.isPending}
              className="rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Create contribution'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
