'use client'
// â”€â”€â”€ Budgeted positions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// What we PLAN to pay for, vs the people page (which lists who's actually
// employed). Edit a salary or headcount here and:
//   - /finance/opex Payroll budget reflects it on next load
//   - /finance/projections labour line on every ProForma reflects it
// No manual sync. The backend's /opex/payroll-snapshot and
// /financePlanning/projections/:id read straight from this table.
//
// Group hierarchy on the page (matches how the CEO thinks about it):
//   Tenant
//     â””â”€â”€ Concept (or "Head Office / Tenant-wide")
//           â””â”€â”€ Department
//                 â””â”€â”€ Shift band
//                       â””â”€â”€ Position rows

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'

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
  sourceTenant:      { id: string; name: string }
  destinationTenant: { id: string; name: string }
  direction: 'incoming' | 'outgoing'
  internalSplit: Array<{ label: string; cents: number }> | null
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
}

const STATUS_META: Record<Position['status'], { label: string; color: string; bg: string }> = {
  open:     { label: 'Open',     color: '#F59E0B', bg: 'rgba(245,158,11,0.10)' },
  filled:   { label: 'Filled',   color: '#00D4B1', bg: 'rgba(0,212,177,0.10)' },
  frozen:   { label: 'Frozen',   color: '#8E8E93', bg: 'rgba(142,142,147,0.10)' },
  archived: { label: 'Archived', color: '#6B7280', bg: 'rgba(107,114,128,0.10)' },
}

function fmtPkr(cents: number): string {
  return `PKR ${(cents / 100).toLocaleString('en-PK')}`
}

// Named export so /workforce/page.tsx can mount this inline as a tab.
// The default export below just wraps it so the standalone route still works.
export default function PositionsPage() {
  return <PositionsView />
}

export function PositionsView() {
  const qc = useQueryClient()
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

  // â”€â”€â”€ Group positions by Concept â†’ Department â†’ ShiftBand â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    <div className="min-h-screen bg-kds-bg text-kds-text">
      {/* â”€â”€â”€ Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="border-b border-kds-border bg-kds-card">
        <div className="max-w-6xl mx-auto px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs text-kds-subtext mb-1">
                <Link href="/workforce" className="hover:text-kds-text">Workforce</Link>
                <span>/</span>
                <span className="text-kds-text">Budgeted positions</span>
              </div>
              <h1 className="text-2xl font-black">Budgeted positions</h1>
              <p className="text-sm text-kds-subtext mt-1 max-w-2xl">
                Every seat the org pays for, filled or not. Edits here update the
                Payroll line in <Link href="/finance/opex" className="text-kds-green hover:underline">OpEx</Link> and
                the labour cost on every <Link href="/finance/projections" className="text-kds-green hover:underline">projection</Link> on
                next load â€” no manual sync.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowAdd(true)}
                className="rounded-lg px-3 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90">
                + New position
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* â”€â”€â”€ Roll-up cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="max-w-6xl mx-auto px-6 pt-5">
        {/* JV banner — mirrors the one on /finance/opex so the operator
            sees consistent treatment everywhere they look at JV finances. */}
        {activeTenant?.isJointVenture && jvPartners.length > 0 && (
          <Link href="/settings"
            className="block mb-4 rounded-2xl px-4 py-3 hover:bg-white/[0.03] transition-colors"
            style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.25)' }}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-black uppercase tracking-wider rounded px-1.5 py-0.5"
                  style={{ background: 'rgba(168,85,247,0.20)', color: '#C4B5FD' }}>
                  Joint venture
                </span>
                <span className="text-sm text-kds-text font-bold">{activeTenant.name}</span>
                <span className="text-xs text-kds-subtext">- partner split:</span>
                {jvPartners.map((p, i) => (
                  <span key={i} className="text-[11px] font-bold rounded px-2 py-0.5"
                    style={{ background: 'rgba(168,85,247,0.10)', color: '#DDD6FE' }}>
                    {p.label} {p.pct}%
                  </span>
                ))}
              </div>
              <span className="text-[11px] text-kds-subtext hover:underline">Edit JV config →</span>
            </div>
          </Link>
        )}

        {summary && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                label="Net monthly P&L"
                value={fmtPkr(summary.netMonthlyCents)}
                hint={
                  summary.incomingContributionMonthlyCents > 0 || summary.outgoingContributionMonthlyCents > 0
                    ? `gross ${fmtPkr(summary.totalTenantShareMonthlyCents)} +/- JV transfers`
                    : `equals gross (no contributions)`
                }
                accent="#00D4B1"
                jvPartners={jvPartners}
                valueCents={summary.netMonthlyCents}
              />
              <StatCard
                label="Annualised net"
                value={fmtPkr(summary.annualisedNetCents)}
                hint="net x 12 months"
                accent="#6366F1"
                jvPartners={jvPartners}
                valueCents={summary.annualisedNetCents}
              />
              <StatCard
                label="Headcount"
                value={summary.totalHeadcount.toString()}
                hint={`${summary.totalPositions} positions`}
                accent="#F59E0B"
              />
              <StatCard
                label="Open seats"
                value={summary.byStatus.open.toString()}
                hint={`${summary.byStatus.filled} filled, ${summary.byStatus.frozen} frozen`}
                accent={summary.byStatus.open > 0 ? '#F59E0B' : '#8E8E93'}
              />
            </div>

            {/* JV / inter-tenant contributions. Always shown (even when empty)
                so the "+ Add contribution" button is reachable for first-time
                setup. Line items document WHY net differs from gross when
                contributions exist. */}
            <div className="mt-4 rounded-xl border border-kds-border bg-kds-card overflow-hidden">
              <div className="px-4 py-3 border-b border-kds-border flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold">JV / inter-tenant contributions</p>
                  <p className="text-[11px] text-kds-subtext">
                    Subtracts incoming, adds outgoing &rarr; gives net P&L
                  </p>
                </div>
                <button onClick={() => setContribModal('new')}
                  className="rounded-lg px-3 py-1.5 text-xs font-bold border border-kds-border text-kds-text hover:border-kds-green/40 hover:text-kds-green transition-colors">
                  + Add contribution
                </button>
              </div>
              {summary.contributions.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs text-kds-subtext">
                    No inter-tenant contributions yet. Use this for JV chargebacks
                    (e.g. one tenant contributes a lump sum to another for shared
                    head-office or commissary services).
                  </p>
                </div>
              ) : (
                <div className="px-4 py-3 grid gap-2">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-kds-subtext">Position gross ({summary.totalPositions} seats)</span>
                    <span className="font-bold">{fmtPkr(summary.totalTenantShareMonthlyCents)}</span>
                  </div>
                  {summary.contributions.map((c) => (
                    <button key={c.id} type="button" onClick={() => setContribModal(c)}
                      className="text-left rounded-md px-1 py-1 -mx-1 hover:bg-kds-bg/40 transition-colors">
                      <div className="flex justify-between text-xs font-mono items-baseline">
                        <span className="text-kds-subtext flex items-center gap-1.5">
                          <span style={{ color: c.direction === 'incoming' ? '#00D4B1' : '#F59E0B' }}>
                            {c.direction === 'incoming' ? '<--' : '-->'}
                          </span>
                          {c.label}
                          <span className="text-[10px] text-kds-subtext/70">
                            ({c.direction === 'incoming' ? 'from' : 'to'}{' '}
                            {c.direction === 'incoming' ? c.sourceTenant.name : c.destinationTenant.name})
                          </span>
                        </span>
                        <span className="font-bold"
                          style={{ color: c.direction === 'incoming' ? '#00D4B1' : '#F59E0B' }}>
                          {c.direction === 'incoming' ? '-' : '+'} {fmtPkr(c.monthlyCents)}
                        </span>
                      </div>
                      {c.internalSplit && c.internalSplit.length > 0 && (
                        <div className="pl-5 pt-1 flex gap-3 flex-wrap text-[10px] text-kds-subtext font-mono">
                          {c.internalSplit.map((s, i) => (
                            <span key={i}>
                              {s.label}: {fmtPkr(s.cents)}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                  <div className="border-t border-kds-border mt-1 pt-2 flex justify-between text-sm font-mono">
                    <span className="font-bold">Net to this tenant&apos;s P&L</span>
                    <span className="font-black" style={{ color: '#00D4B1' }}>
                      {fmtPkr(summary.netMonthlyCents)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* â”€â”€â”€ Grouped list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="max-w-6xl mx-auto px-6 pb-12 pt-5">
        {isLoading && <div className="p-8 text-center text-sm text-kds-subtext">Loading positionsâ€¦</div>}

        {!isLoading && positions.length === 0 && (
          <div className="rounded-xl border border-kds-border bg-kds-card p-12 text-center">
            <p className="text-4xl mb-2">ðŸ’¼</p>
            <p className="text-sm font-semibold">No budgeted positions yet</p>
            <p className="text-xs text-kds-subtext mt-1 max-w-md mx-auto">
              Start with a position for each seat the org pays for. You don't need a
              named hire â€” just a title, shift band, salary and which concept it serves.
            </p>
            <button onClick={() => setShowAdd(true)}
              className="mt-4 rounded-lg px-4 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90">
              + Create the first position
            </button>
          </div>
        )}

        {grouped.map((concept) => (
          <div key={concept.key} className="mt-6">
            <div className="flex items-baseline justify-between gap-3 mb-2">
              <h2 className="text-lg font-black">{concept.title}</h2>
              <p className="text-xs text-kds-subtext font-mono">
                {concept.headcount} ppl Â· share {fmtPkr(concept.share)} / month
              </p>
            </div>
            <div className="rounded-xl border border-kds-border bg-kds-card overflow-hidden">
              {concept.depts.map((dept, dIdx) => (
                <div key={dept.key} className={dIdx > 0 ? 'border-t border-kds-border' : ''}>
                  <div className="flex items-baseline justify-between gap-3 px-4 py-3 bg-kds-bg/30">
                    <p className="text-sm font-bold flex items-center gap-2">
                      <span>{dept.emoji ?? 'Â·'}</span>
                      <span>{dept.title}</span>
                      {dept.isHeadOffice && (
                        <span className="text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
                          style={{ background: 'rgba(99,102,241,0.15)', color: '#A5B4FC' }}>
                          Head office
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-kds-subtext font-mono">
                      {dept.headcount} ppl Â· {fmtPkr(dept.share)}
                      {dept.gross !== dept.share && (
                        <span className="opacity-60"> (gross {fmtPkr(dept.gross)})</span>
                      )}
                    </p>
                  </div>
                  {dept.shiftGroups.map((shift) => (
                    <div key={shift.shiftBandLabel}>
                      {shift.shiftBandLabel !== 'Any shift' && (
                        <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-kds-subtext bg-kds-bg/20">
                          {shift.shiftBandLabel}
                        </div>
                      )}
                      {shift.positions.map((p) => (
                        <PositionRow
                          key={p.id} position={p}
                          expanded={editingId === p.id}
                          onExpand={() => setEditingId(editingId === p.id ? null : p.id)}
                          onClose={() => setEditingId(null)}
                          onChange={() => {
                            void qc.invalidateQueries({ queryKey: ['positions'] })
                          }}
                          departments={departments}
                          shiftBands={shiftBands}
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

      {showAdd && (
        <AddPositionModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); void qc.invalidateQueries({ queryKey: ['positions'] }) }}
          departments={departments}
          shiftBands={shiftBands}
        />
      )}
      {contribModal && (
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

// â”€â”€â”€ Stat card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function StatCard({ label, value, hint, accent, jvPartners, valueCents }: {
  label: string; value: string; hint?: string; accent: string
  jvPartners?: Array<{ label: string; pct: number }>
  valueCents?: number
}) {
  return (
    <div className="rounded-xl border border-kds-border bg-kds-card p-4">
      <p className="text-[10px] uppercase tracking-wider text-kds-subtext font-bold">{label}</p>
      <p className="text-xl font-black mt-1" style={{ color: accent }}>{value}</p>
      {hint && <p className="text-[10px] text-kds-subtext mt-0.5">{hint}</p>}
      {jvPartners && jvPartners.length > 0 && valueCents !== undefined && valueCents > 0 && (
        <div className="mt-2 flex gap-1.5 flex-wrap">
          {jvPartners.map((p, i) => (
            <span key={i} className="text-[10px] font-mono rounded px-1.5 py-0.5"
              style={{ background: 'rgba(168,85,247,0.10)', color: '#C4B5FD' }}>
              {p.label} {p.pct}%: {fmtPkr(Math.round(valueCents * p.pct / 100))}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// â”€â”€â”€ Position row + inline editor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function PositionRow({
  position, expanded, onExpand, onClose, onChange, departments, shiftBands,
}: {
  position: Position
  expanded: boolean
  onExpand: () => void
  onClose: () => void
  onChange: () => void
  departments: Department[]
  shiftBands: ShiftBand[]
}) {
  const status = STATUS_META[position.status]
  return (
    <div className="border-t border-kds-border first:border-t-0">
      <button onClick={onExpand}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-kds-bg/30 ${
          expanded ? 'bg-kds-bg/40' : ''
        }`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-sm truncate">{position.title}</p>
            {position.headcount > 1 && (
              <span className="text-[10px] font-bold rounded px-1.5 py-0.5"
                style={{ background: 'rgba(0,212,177,0.10)', color: '#00D4B1' }}>
                Ã— {position.headcount}
              </span>
            )}
            <span className="text-[9px] uppercase tracking-wider font-bold rounded px-1.5 py-0.5"
              style={{ background: status.bg, color: status.color }}>
              {status.label}
            </span>
            {position.filledBy && (
              <span className="text-[10px] text-kds-subtext">â†’ {position.filledBy.name}</span>
            )}
          </div>
          {position.costShareNote && position.tenantCostShareCents !== position.monthlySalaryCents && (
            <p className="text-[10px] text-kds-subtext mt-0.5 italic truncate">{position.costShareNote}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-bold font-mono">{fmtPkr(position.tenantCostShareCents)}</p>
          {position.tenantCostShareCents !== position.monthlySalaryCents && (
            <p className="text-[10px] text-kds-subtext font-mono opacity-70">gross {fmtPkr(position.monthlySalaryCents)}</p>
          )}
        </div>
        <span className="shrink-0 text-kds-subtext text-xs"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 120ms' }}>â–¶</span>
      </button>
      {expanded && (
        <PositionEditor position={position} onChange={onChange} onClose={onClose}
          departments={departments} shiftBands={shiftBands} />
      )}
    </div>
  )
}

function PositionEditor({
  position, onChange, onClose, departments, shiftBands,
}: {
  position: Position
  onChange: () => void
  onClose: () => void
  departments: Department[]
  shiftBands: ShiftBand[]
}) {
  const [title, setTitle] = useState(position.title)
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
      title,
      monthlySalaryCents: gross,
      tenantCostShareCents: share,
      headcount,
      status,
      departmentId: departmentId || null,
      shiftBandId: shiftBandId || null,
      costShareNote: costShareNote.trim() || null,
      notes: notes.trim() || null,
    }),
    onSuccess: () => { onChange(); onClose() },
  })

  const archive = useMutation({
    mutationFn: () => api.delete(`/positions/${position.id}`),
    onSuccess: () => { onChange(); onClose() },
  })

  return (
    <div className="bg-kds-bg/30 border-t border-kds-border px-4 py-4 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value as Position['status'])} className={inputCls}>
            <option value="open">Open</option>
            <option value="filled">Filled</option>
            <option value="frozen">Frozen</option>
            <option value="archived">Archived</option>
          </select>
        </Field>
        <Field label="Department">
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputCls}>
            <option value="">â€” No department â€”</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.emoji ? `${d.emoji} ` : ''}{d.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Shift band">
          <select value={shiftBandId} onChange={(e) => setShiftBandId(e.target.value)} className={inputCls}>
            <option value="">â€” Any shift â€”</option>
            {shiftBands.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.startTime}â€“{s.endTime})</option>
            ))}
          </select>
        </Field>
        <Field label="Gross monthly salary" hint="What the person earns (full salary).">
          <MoneyInput value={gross} onChange={setGross} />
        </Field>
        <Field label="Tenant cost-share" hint="What THIS tenant's P&L bears. Defaults to gross.">
          <MoneyInput value={share} onChange={setShare} />
        </Field>
        <Field label="Headcount" hint="Number of identical seats in this row.">
          <input type="number" min={1} value={headcount} onChange={(e) => setHeadcount(parseInt(e.target.value) || 1)}
            className={inputCls} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Cost-share note" hint="Explain why share < gross (e.g. head office allocation, JV split).">
            <input value={costShareNote} onChange={(e) => setCostShareNote(e.target.value)} className={inputCls}
              placeholder="e.g. Head office: GS Foods bears 37.5% of gross." />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls + ' min-h-[60px]'} />
          </Field>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 pt-2">
        <button onClick={() => archive.mutate()} disabled={archive.isPending}
          className="rounded-lg px-3 py-2 text-xs font-bold text-red-400 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-50">
          ðŸ—‘ Archive
        </button>
        <div className="flex gap-2">
          <button onClick={onClose}
            className="rounded-lg px-3 py-2 text-xs font-bold text-kds-subtext border border-kds-border hover:text-kds-text">
            Cancel
          </button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-lg px-3 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Savingâ€¦' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// â”€â”€â”€ Add position modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function AddPositionModal({
  onClose, onCreated, departments, shiftBands,
}: {
  onClose: () => void
  onCreated: () => void
  departments: Department[]
  shiftBands: ShiftBand[]
}) {
  const [title, setTitle] = useState('')
  const [gross, setGross] = useState(0)
  const [share, setShare] = useState(0)
  const [shareTouched, setShareTouched] = useState(false)
  const [headcount, setHeadcount] = useState(1)
  const [departmentId, setDepartmentId] = useState('')
  const [shiftBandId, setShiftBandId] = useState('')

  // Until the operator explicitly edits the share, mirror it to gross â€” saves
  // them a step in the common case where the tenant pays 100%.
  function setGrossAndMaybeShare(g: number) {
    setGross(g)
    if (!shareTouched) setShare(g)
  }

  const create = useMutation({
    mutationFn: () => api.post('/positions', {
      title,
      monthlySalaryCents: gross,
      tenantCostShareCents: share,
      headcount,
      departmentId: departmentId || null,
      shiftBandId: shiftBandId || null,
    }),
    onSuccess: onCreated,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-kds-card border border-kds-border rounded-xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-black mb-4">New position</h2>
        <div className="space-y-3">
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Chef de Partie" className={inputCls} autoFocus />
          </Field>
          <Field label="Department">
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={inputCls}>
              <option value="">â€” None â€”</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.emoji ? `${d.emoji} ` : ''}{d.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Shift band">
            <select value={shiftBandId} onChange={(e) => setShiftBandId(e.target.value)} className={inputCls}>
              <option value="">â€” Any â€”</option>
              {shiftBands.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
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
            <input type="number" min={1} value={headcount}
              onChange={(e) => setHeadcount(parseInt(e.target.value) || 1)} className={inputCls} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-xs font-bold text-kds-subtext border border-kds-border hover:text-kds-text">
            Cancel
          </button>
          <button onClick={() => create.mutate()} disabled={!title || gross <= 0 || create.isPending}
            className="rounded-lg px-3 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90 disabled:opacity-50">
            {create.isPending ? 'Creatingâ€¦' : 'Create position'}
          </button>
        </div>
      </div>
    </div>
  )
}

// â”€â”€â”€ Small UI helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const inputCls = 'w-full rounded-md border border-kds-border bg-kds-bg px-3 py-2 text-sm focus:border-kds-green focus:outline-none'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold uppercase tracking-wider text-kds-subtext block mb-1">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-kds-subtext block mt-1">{hint}</span>}
    </label>
  )
}

// ─── Contribution modal (create / edit) ───────────────────────────────────────
// One modal handles both flows — when `existing` is null we POST, otherwise
// PATCH. The internal-split editor is a dynamic list of {label, cents} chips
// the operator can add/remove. The list is purely informational (backend
// stores it as JSON, doesn't enforce it sums to monthlyCents) so we don't
// validate the sum either — let the operator document however they want.

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
  const [description,         setDescription]         = useState('')
  const [splitRows, setSplitRows] = useState<Array<{ label: string; cents: number }>>(
    existing?.internalSplit && existing.internalSplit.length > 0
      ? existing.internalSplit
      : [],
  )

  // Default direction prompt: if operator hasn't picked tenants yet and we
  // know they belong to 2+ tenants, prefill source = first, dest = second.
  // Saves a click in the JV case (which is the dominant use case).
  if (!existing && !sourceTenantId && tenants.length >= 2) {
    // Note: do this lazily — calling setState during render would loop.
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

  const archive = useMutation({
    mutationFn: () => api.delete(`/positions/contributions/${existing!.id}`),
    onSuccess: onSaved,
  })

  const canSave = !!sourceTenantId && !!destinationTenantId
    && sourceTenantId !== destinationTenantId
    && monthlyCents > 0
    && label.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-kds-card border border-kds-border rounded-xl p-6 w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-black mb-1">
          {existing ? 'Edit contribution' : 'New inter-tenant contribution'}
        </h2>
        <p className="text-xs text-kds-subtext mb-4">
          {existing
            ? 'Update the agreed monthly transfer or its internal split.'
            : 'Model a chargeback between two tenants you own (e.g. JV partner contributes to head office).'}
        </p>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From (source)">
              <select value={sourceTenantId} onChange={(e) => setSourceTenantId(e.target.value)} className={inputCls}>
                <option value="">— Pick a tenant —</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="To (destination)">
              <select value={destinationTenantId} onChange={(e) => setDestinationTenantId(e.target.value)} className={inputCls}>
                <option value="">— Pick a tenant —</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.id === sourceTenantId}>{t.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {sourceTenantId && destinationTenantId && sourceTenantId === destinationTenantId && (
            <p className="text-xs text-red-400">Source and destination must differ.</p>
          )}

          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value as CategoryOption['value'])} className={inputCls}>
              {CONTRIB_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
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
              <span className="text-[11px] font-bold uppercase tracking-wider text-kds-subtext">
                Internal split (optional)
              </span>
              <button type="button"
                onClick={() => setSplitRows([...splitRows, { label: '', cents: 0 }])}
                className="text-[10px] font-bold text-kds-green hover:underline">
                + Add line
              </button>
            </div>
            <p className="text-[10px] text-kds-subtext mb-2">
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
                    className="text-red-400 hover:bg-red-400/10 rounded-md px-2 text-sm">
                    &times;
                  </button>
                </div>
              ))}
            </div>
            {splitRows.length > 0 && (
              <p className={`text-[10px] mt-2 font-mono ${sumMismatch ? 'text-amber-400' : 'text-kds-subtext'}`}>
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
            <button onClick={() => archive.mutate()} disabled={archive.isPending}
              className="rounded-lg px-3 py-2 text-xs font-bold text-red-400 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-50">
              {archive.isPending ? 'Archiving…' : 'Archive'}
            </button>
          ) : <div />}
          <div className="flex gap-2">
            <button onClick={onClose}
              className="rounded-lg px-3 py-2 text-xs font-bold text-kds-subtext border border-kds-border hover:text-kds-text">
              Cancel
            </button>
            <button onClick={() => save.mutate()} disabled={!canSave || save.isPending}
              className="rounded-lg px-3 py-2 text-xs font-black bg-kds-green text-black hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Create contribution'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
