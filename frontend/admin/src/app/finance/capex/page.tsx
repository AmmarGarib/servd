'use client'
// Project Tracker — unified CapEx + OpEx for any project (kitchen build,
// refurb, expansion, new brand). The CapEx tab handles one-time build cost;
// the OpEx tab handles recurring run-rate (rent, payroll, utilities) tied to
// the same project, giving full TCO. Schema: CapexProject is the parent;
// CapexLine for one-off items, OpexLine.projectId for recurring items.

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { PositionsView } from '../../workforce/positions/page'

// ─── Types ────────────────────────────────────────────────────────────────

type Phase = 'planning' | 'quoting' | 'executing' | 'snagging' | 'live'
type Status =
  | 'not_quoted' | 'quoted' | 'ordered' | 'partial_paid'
  | 'delivered' | 'installed' | 'commissioned' | 'snag' | 'done'

interface Quote {
  id: string
  vendor: string
  contactName: string | null
  contactPhone: string | null
  totalCents: number
  leadTimeDays: number | null
  validUntil: string | null
  fileUrl: string | null
  notes: string | null
  isWinner: boolean
}
interface Payment {
  id: string
  label: 'deposit' | 'midpoint' | 'balance' | 'extra'
  amountCents: number
  dueDate: string | null
  paidAt: string | null
  paidAmountCents: number | null
  paymentRef: string | null
}
interface Line {
  id: string
  scope: string
  category: string | null
  item: string
  quantity: number
  unitCostCents: number
  vendor: string | null
  vendorContact: string | null
  quotedCents: number | null
  negotiatedCents: number | null
  paidCents: number
  status: Status
  priority: 'must_have' | 'nice_to_have' | 'future'
  leadTimeDays: number | null
  expectedDeliveryDate: string | null
  actualDeliveryDate: string | null
  installedDate: string | null
  documentUrls: { label: string; url: string }[] | null
  photoUrls: string[] | null
  warrantyMonths: number | null
  notes: string | null
  quotes: Quote[]
  payments: Payment[]
}
interface ScopeDef { key: string; label: string; emoji?: string | null; hint?: string | null }

interface Project {
  id: string
  name: string
  conceptId: string | null
  locationId: string | null
  projectType: string
  phase: Phase
  budgetEnvelopeCents: number
  contingencyPct: number
  consultantFeesCents: number
  taxCents: number
  targetOpeningDate: string | null
  actualOpeningDate: string | null
  address: string | null
  floorAreaSqft: number | null
  notes: string | null
  scopeConfig: ScopeDef[] | null
  isJointVenture?: boolean
  jvPartners?: Array<{ label: string; pct: number }> | null
  lines: Line[]
  rollups: {
    budgetedCents: number
    quotedCents: number
    committedCents: number
    paidCents: number
    remainingCents: number
    contingencyCents: number
    totalAskCents: number
    varianceVsEnvelopeCents: number
  }
}

// Scope catalog — keeps the UI legible. Operator can add lines under any
// scope; this just orders + emojis them so the page reads naturally.
const SCOPES = [
  { key: 'BOH',        emoji: '🍳', label: 'Back of House',  hint: 'Kitchen equipment, cooking line, walk-in, exhaust' },
  { key: 'FOH',        emoji: '🪑', label: 'Front of House', hint: 'Dining furniture, bar, host stand, seating' },
  { key: 'AG',         emoji: '✨', label: 'AG / Finishing', hint: 'Flooring, paint, lighting, decor, ceiling' },
  { key: 'Equipment',  emoji: '🛠', label: 'Small wares',     hint: 'Smallwares, utensils, plate-up, bar tools' },
  { key: 'MEP',        emoji: '⚡', label: 'MEP',             hint: 'Mechanical · Electrical · Plumbing · HVAC' },
  { key: 'Civil',      emoji: '🏗', label: 'Civil',           hint: 'Demo, framing, drywall, masonry, glazing' },
  { key: 'Tech',       emoji: '💻', label: 'Tech',            hint: 'POS terminals, KDS screens, Wi-Fi, cameras' },
  { key: 'Branding',   emoji: '🎨', label: 'Branding',        hint: 'Signage, exterior, install of brand assets' },
  { key: 'Permits',    emoji: '📑', label: 'Permits & Legal', hint: 'FBR, FCO, building permits, professional fees' },
  { key: 'SoftCosts',  emoji: '📐', label: 'Soft Costs',      hint: 'Architect, consultant, project management' },
  { key: 'Other',      emoji: '📦', label: 'Other',           hint: 'Anything that doesn’t fit above' },
] as const

const PHASE_META: Record<Phase, { label: string; bg: string; fg: string }> = {
  planning:  { label: 'Planning',   bg: 'rgba(99,102,241,0.12)',  fg: '#A5B4FC' },
  quoting:   { label: 'Quoting',    bg: 'rgba(245,158,11,0.12)',  fg: '#FCD34D' },
  executing: { label: 'Executing',  bg: 'rgba(0,212,177,0.12)',   fg: '#00D4B1' },
  snagging:  { label: 'Snagging',   bg: 'rgba(168,85,247,0.12)',  fg: '#D8B4FE' },
  live:      { label: 'Live',       bg: 'rgba(34,197,94,0.15)',   fg: '#86EFAC' },
}

const STATUS_META: Record<Status, { label: string; fg: string }> = {
  not_quoted:    { label: 'Not quoted',    fg: '#9CA3AF' },
  quoted:        { label: 'Quoted',        fg: '#FCD34D' },
  ordered:       { label: 'Ordered',       fg: '#A5B4FC' },
  partial_paid:  { label: 'Paid',          fg: '#86EFAC' },
  delivered:     { label: 'Delivered',     fg: '#5EEAD4' },
  installed:     { label: 'Installed',     fg: '#7DD3FC' },
  commissioned:  { label: 'Commissioned',  fg: '#86EFAC' },
  snag:          { label: 'Snag',          fg: '#FCA5A5' },
  done:          { label: 'Done',          fg: '#34D399' },
}

const PKR = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

// ─── Page ─────────────────────────────────────────────────────────────────

export default function CapexTrackerPage() {
  const qc = useQueryClient()
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['capex-projects'],
    queryFn: () => api.get('/finance/capex'),
  })
  // 'workforce' is a synthetic "project" representing the tenant-wide workforce
  // overview (positions feed). Selecting it swaps the right pane for the
  // PositionsView so the user sees their standing labour cost in the same
  // place they review projects. Otherwise selectedId is a real project id.
  const [selectedId, setSelectedId] = useState<string | 'workforce' | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!selectedId && projects.length > 0) setSelectedId(projects[0]!.id)
  }, [projects, selectedId])

  const project = projects.find((p) => p.id === selectedId) ?? null

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-5 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-1">
          <div>
            <h1 className="text-2xl font-black text-white/90 flex items-center gap-2">🏗 Project Tracker</h1>
            <p className="text-sm text-white/40 mt-1 max-w-3xl">
              CapEx + OpEx in one place per project. One-time build cost on the CapEx tab, recurring run-rate
              (rent, payroll, utilities) on the OpEx tab. Full total cost of ownership in one view.
              {' '}
              <Link href="/finance/capital-ledger" className="text-kds-green font-bold hover:opacity-80">
                See the roll-up in Investment Dashboard →
              </Link>
              {' · '}
              <Link href="/finance/opex" className="text-kds-green font-bold hover:opacity-80">
                Standing OpEx (workforce + JV) →
              </Link>
            </p>
          </div>
          <button onClick={() => setCreating(true)} className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">+ New project</button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-0">
        {/* Left rail: project list */}
        <aside className="border-r border-white/[0.05] p-4 space-y-2 max-h-screen overflow-y-auto">
          {/* Pinned workforce item — tenant-wide labour budget sits above all
              projects since it's standing cost, not project-specific. Click
              swaps the right pane to the PositionsView. */}
          <button onClick={() => setSelectedId('workforce')}
            className="w-full text-left rounded-xl p-3 transition-colors"
            style={selectedId === 'workforce'
              ? { background: 'rgba(168,85,247,0.10)', border: '1px solid rgba(168,85,247,0.45)' }
              : { background: 'rgba(168,85,247,0.04)', border: '1px solid rgba(168,85,247,0.20)' }}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-bold text-sm" style={{ color: '#C4B5FD' }}>💼 Workforce</p>
              <span className="text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                style={{ background: 'rgba(168,85,247,0.20)', color: '#C4B5FD' }}>
                Standing
              </span>
            </div>
            <p className="text-[11px] text-white/45 mt-1">
              Positions + JV contributions feed
            </p>
          </button>

          <div className="text-[10px] uppercase tracking-wider text-white/40 font-bold pt-2 pb-1 px-1">
            Projects
          </div>

          {projects.length === 0 && (
            <div className="rounded-xl p-4 text-center"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs text-white/45">No projects yet — start one to plan your build.</p>
            </div>
          )}
          {projects.map((p) => {
            const overBudget = p.rollups.varianceVsEnvelopeCents > 0
            return (
              <button key={p.id} onClick={() => setSelectedId(p.id)}
                className="w-full text-left rounded-xl p-3 transition-colors"
                style={selectedId === p.id
                  ? { background: 'rgba(0,212,177,0.08)', border: '1px solid rgba(0,212,177,0.4)' }
                  : { background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-bold text-sm text-white/90 truncate">{p.name}</p>
                  <span className="text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: PHASE_META[p.phase].bg, color: PHASE_META[p.phase].fg }}>
                    {PHASE_META[p.phase].label}
                  </span>
                </div>
                <p className="text-[11px] text-white/45 mt-1">
                  {p.lines.length} lines · {PKR(p.rollups.committedCents)}
                </p>
                {p.budgetEnvelopeCents > 0 && (
                  <>
                    <div className="h-1 rounded-full mt-2 overflow-hidden bg-white/5">
                      <div className="h-full"
                        style={{
                          width: `${Math.min(100, (p.rollups.committedCents / p.budgetEnvelopeCents) * 100)}%`,
                          background: overBudget ? '#FCA5A5' : '#00D4B1',
                        }} />
                    </div>
                    <p className="text-[10px] mt-1" style={{ color: overBudget ? '#FCA5A5' : 'rgba(255,255,255,0.4)' }}>
                      {overBudget
                        ? `${PKR(p.rollups.varianceVsEnvelopeCents)} over envelope`
                        : `${PKR(p.rollups.remainingCents)} of ${PKR(p.budgetEnvelopeCents)} remaining`}
                    </p>
                  </>
                )}
              </button>
            )
          })}
        </aside>

        {/* Detail */}
        <main className="p-6 max-w-[1100px]">
          {selectedId === 'workforce' ? (
            <PositionsView embedded />
          ) : project ? (
            <ProjectDetail project={project} qc={qc} />
          ) : (
            <div className="rounded-2xl p-10 text-center"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="font-bold text-white/85">No project selected</p>
              <p className="text-sm text-white/45 mt-1">Pick a project from the sidebar or create a new one.</p>
            </div>
          )}
        </main>
      </div>

      {creating && <CreateProjectModal
        onClose={() => setCreating(false)}
        onSaved={(id) => { qc.invalidateQueries({ queryKey: ['capex-projects'] }); setSelectedId(id); setCreating(false) }} />}
    </div>
  )
}

// ─── Project detail ───────────────────────────────────────────────────────

function ProjectDetail({ project, qc }: { project: Project; qc: ReturnType<typeof useQueryClient> }) {
  const [editingProject, setEditingProject] = useState(false)
  const [addingLineScope, setAddingLineScope] = useState<string | null>(null)
  const [editingLine, setEditingLine] = useState<Line | null>(null)
  const [tab, setTab] = useState<'capex' | 'opex'>('capex')
  const [editingScopes, setEditingScopes] = useState(false)
  const overBudget = project.rollups.varianceVsEnvelopeCents > 0

  // Use the project's custom scope config if it has one, else the platform
  // default. Lines with an unknown scope (e.g. an old scope that was renamed
  // away) bucket into a "Misc" catch-all so they don't disappear.
  const activeScopes: ScopeDef[] = project.scopeConfig && project.scopeConfig.length > 0
    ? project.scopeConfig
    : SCOPES.map((s) => ({ key: s.key, label: s.label, emoji: s.emoji, hint: s.hint }))

  const knownKeys = new Set(activeScopes.map((s) => s.key))
  const orphanLines = project.lines.filter((l) => !knownKeys.has(l.scope))

  const linesByScope: Array<ScopeDef & { lines: Line[] }> = activeScopes.map((s) => ({
    ...s,
    lines: project.lines.filter((l) => l.scope === s.key),
  }))
  if (orphanLines.length > 0) {
    linesByScope.push({ key: '__orphan__', label: 'Unsorted', emoji: '📦', hint: 'Lines whose section was renamed or removed', lines: orphanLines })
  }

  return (
    <div className="space-y-5">
      {/* Header card */}
      <div className="rounded-2xl p-5"
        style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-2xl font-black text-white/90">{project.name}</h2>
              <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded"
                style={{ background: PHASE_META[project.phase].bg, color: PHASE_META[project.phase].fg }}>
                {PHASE_META[project.phase].label}
              </span>
              {project.isJointVenture && (
                <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded"
                  style={{ background: 'rgba(168,85,247,0.20)', color: '#C4B5FD' }}>
                  Joint venture
                </span>
              )}
            </div>
            <p className="text-xs text-white/45 mt-1.5">
              {project.projectType.replace(/_/g, ' ')}
              {project.address ? ` · ${project.address}` : ''}
              {project.floorAreaSqft ? ` · ${project.floorAreaSqft.toLocaleString()} sqft` : ''}
              {project.targetOpeningDate ? ` · target opens ${new Date(project.targetOpeningDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
            </p>
            {project.isJointVenture && project.jvPartners && project.jvPartners.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-white/45">Partner split:</span>
                {project.jvPartners.map((p, i) => (
                  <span key={i} className="text-[11px] font-bold rounded px-2 py-0.5"
                    style={{ background: 'rgba(168,85,247,0.10)', color: '#DDD6FE' }}>
                    {p.label} {p.pct}% · {PKR(Math.round(project.rollups.totalAskCents * p.pct / 100))}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setEditingProject(true)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">
            Edit project
          </button>
        </div>
      </div>

      {/* Tab switcher: CapEx (one-time build) vs OpEx (recurring run-rate) */}
      <div className="flex gap-2 border-b border-white/[0.06]">
        <button onClick={() => setTab('capex')}
          className="px-4 py-2.5 text-sm font-bold transition-colors"
          style={tab === 'capex'
            ? { color: '#00D4B1', borderBottom: '2px solid #00D4B1', marginBottom: '-1px' }
            : { color: 'rgba(255,255,255,0.5)' }}>
          🏗 CapEx · build
        </button>
        <button onClick={() => setTab('opex')}
          className="px-4 py-2.5 text-sm font-bold transition-colors"
          style={tab === 'opex'
            ? { color: '#FCD34D', borderBottom: '2px solid #FCD34D', marginBottom: '-1px' }
            : { color: 'rgba(255,255,255,0.5)' }}>
          💸 OpEx · run-rate
        </button>
      </div>

      {tab === 'capex' && <CapexTab project={project} overBudget={overBudget} linesByScope={linesByScope}
        onEditLine={(l) => setEditingLine(l)} onAddLineScope={(s) => setAddingLineScope(s)}
        onCustomizeScopes={() => setEditingScopes(true)} />}
      {tab === 'opex' && <OpexTab projectId={project.id} qc={qc} />}

      {editingScopes && <ScopesEditorModal project={project}
        currentScopes={activeScopes}
        onClose={() => setEditingScopes(false)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['capex-projects'] }); setEditingScopes(false) }} />}

      {editingProject && <EditProjectModal project={project}
        onClose={() => setEditingProject(false)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['capex-projects'] }); setEditingProject(false) }} />}

      {addingLineScope && <LineModal projectId={project.id} scope={addingLineScope}
        onClose={() => setAddingLineScope(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['capex-projects'] }); setAddingLineScope(null) }} />}

      {editingLine && <LineModal projectId={project.id} scope={editingLine.scope} line={editingLine}
        onClose={() => setEditingLine(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['capex-projects'] }); setEditingLine(null) }} />}
    </div>
  )
}

function CapexTab({ project, overBudget, linesByScope, onEditLine, onAddLineScope, onCustomizeScopes }: {
  project: Project
  overBudget: boolean
  linesByScope: Array<ScopeDef & { lines: Line[] }>
  onEditLine: (l: Line) => void
  onAddLineScope: (s: string) => void
  onCustomizeScopes: () => void
}) {
  return (
    <div className="space-y-5">
      {/* Roll-up cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Budget envelope" value={PKR(project.budgetEnvelopeCents)} accent="#A5B4FC" />
        <Stat label="Budgeted lines"  value={PKR(project.rollups.budgetedCents)} accent="#9CA3AF" />
        <Stat label="Committed"        value={PKR(project.rollups.committedCents)} accent={overBudget ? '#FCA5A5' : '#00D4B1'} />
        <Stat label="Paid"             value={PKR(project.rollups.paidCents)} accent="#86EFAC" />
        <Stat
          label={overBudget ? 'Over budget' : 'Remaining'}
          value={overBudget
            ? `+ ${PKR(project.rollups.varianceVsEnvelopeCents)}`
            : PKR(project.rollups.remainingCents)}
          accent={overBudget ? '#FCA5A5' : '#5EEAD4'}
        />
        <Stat
          label="Variance"
          value={overBudget
            ? `+ ${PKR(project.rollups.varianceVsEnvelopeCents)}`
            : `− ${PKR(Math.abs(project.rollups.varianceVsEnvelopeCents))} saved`}
          accent={overBudget ? '#FCA5A5' : '#86EFAC'}
        />
      </div>

      {/* Customize sections */}
      <div className="flex justify-end">
        <button onClick={onCustomizeScopes}
          className="text-xs font-bold text-white/55 hover:text-white inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10">
          🛠 Customize sections
        </button>
      </div>

      {/* Scope sections */}
      <div className="space-y-3">
        {linesByScope.map((s) => {
          const scopeTotal = s.lines.reduce((acc, l) => acc + (l.negotiatedCents ?? l.unitCostCents * l.quantity), 0)
          return (
            <section key={s.key} className="rounded-2xl overflow-hidden"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <header className="px-5 py-3 flex items-center justify-between gap-3"
                style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{s.emoji}</span>
                  <div>
                    <p className="font-black text-white/90 text-sm">{s.label}</p>
                    <p className="text-[10px] text-white/40">{s.hint}</p>
                  </div>
                  <span className="ml-2 text-xs text-white/45">({s.lines.length})</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-black text-white/85">{PKR(scopeTotal)}</span>
                  <button onClick={() => onAddLineScope(s.key)}
                    className="rounded-lg bg-kds-green px-3 py-1.5 text-xs font-bold text-black hover:opacity-90">
                    + Line
                  </button>
                </div>
              </header>
              {s.lines.length === 0 ? (
                <p className="px-5 py-6 text-xs text-white/30 italic">No items in this scope.</p>
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {s.lines.map((l) => <LineRow key={l.id} line={l} onEdit={() => onEditLine(l)} />)}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// Project-scoped OpEx tab — recurring costs tied to this build (rent during
// construction, soft costs, ongoing utilities once live). Reads from /opex
// with projectId filter.
function OpexTab({ projectId, qc }: { projectId: string; qc: ReturnType<typeof useQueryClient> }) {
  const { data: categories = [] } = useQuery<OpexCategory[]>({
    queryKey: ['project-opex', projectId],
    queryFn: () => api.get(`/opex/categories?projectId=${projectId}`),
  })
  const { data: allCategories = [] } = useQuery<OpexCategory[]>({
    queryKey: ['opex-categories'],
    queryFn: () => api.get('/opex/categories'),
  })
  const [adding, setAdding] = useState(false)
  const [editingLine, setEditingLine] = useState<OpexLine | null>(null)

  const monthlyTotal = categories.reduce((s, c) => s + c.monthlyExpectedCents, 0)
  const annualTotal = monthlyTotal * 12

  return (
    <div className="space-y-5">
      {/* OpEx roll-ups */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Monthly run-rate" value={PKR(monthlyTotal)} accent="#FCD34D" />
        <Stat label="Annual run-rate"  value={PKR(annualTotal)}  accent="#FCD34D" />
        <Stat label="Categories"        value={String(categories.length)} accent="#A5B4FC" />
        <Stat label="Active lines"      value={String(categories.reduce((s, c) => s + c.lineCount, 0))} accent="#86EFAC" />
      </div>

      {/* Empty state */}
      {categories.length === 0 && (
        <div className="rounded-2xl p-8 text-center"
          style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.18)' }}>
          <p className="text-3xl mb-2">💸</p>
          <p className="font-bold text-white/85">No recurring costs tied to this project</p>
          <p className="text-sm text-white/45 mt-1 max-w-md mx-auto">
            Rent, payroll, utilities, software — anything that pays out monthly tied to this build. Add lines to see total cost of ownership beyond the one-time CapEx.
          </p>
          <button onClick={() => setAdding(true)} className="mt-4 rounded-xl bg-kds-green px-4 py-2 text-sm font-black text-black hover:opacity-90">
            + Add OpEx line
          </button>
        </div>
      )}

      {categories.length > 0 && (
        <>
          {categories.map((c) => (
            <ProjectOpexCategory key={c.id} category={c} onEditLine={setEditingLine} />
          ))}
          <button onClick={() => setAdding(true)}
            className="w-full rounded-xl border-2 border-dashed border-white/15 px-4 py-3 text-sm font-bold text-white/55 hover:text-white hover:border-white/30">
            + Add OpEx line for this project
          </button>
        </>
      )}

      {/* Cross-link to company-wide OpEx */}
      <div className="rounded-xl p-3 text-xs text-white/55"
        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
        Cross-project / company-wide expenses (software you use everywhere, etc.) live in
        {' '}<Link href="/finance/opex" className="text-[#00D4B1] hover:underline">/finance/opex</Link>.
        Add them here only when they're specifically scoped to this build.
      </div>

      {adding && <ProjectOpexLineModal projectId={projectId} categories={allCategories} qc={qc}
        onClose={() => setAdding(false)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['project-opex', projectId] }); qc.invalidateQueries({ queryKey: ['opex-categories'] }); setAdding(false) }} />}

      {editingLine && <ProjectOpexLineModal projectId={projectId} categories={allCategories} qc={qc}
        line={editingLine}
        onClose={() => setEditingLine(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['project-opex', projectId] }); qc.invalidateQueries({ queryKey: ['opex-categories'] }); setEditingLine(null) }} />}
    </div>
  )
}

interface OpexLine {
  id: string; categoryId: string; name: string; vendor: string | null
  amountCents: number; cadence: 'monthly' | 'quarterly' | 'annual' | 'per_use'
  nextDueDate: string | null
}
interface OpexCategory {
  id: string; name: string; emoji: string | null
  budgetMonthlyCents: number; monthlyExpectedCents: number; overBudgetPct: number
  lineCount: number; notes: string | null
  lines: OpexLine[]
}

function ProjectOpexCategory({ category, onEditLine }: { category: OpexCategory; onEditLine: (l: OpexLine) => void }) {
  return (
    <section className="rounded-2xl overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <header className="px-5 py-3 flex items-center justify-between gap-3"
        style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <div className="flex items-center gap-2">
          {category.emoji && <span className="text-2xl">{category.emoji}</span>}
          <div>
            <p className="font-black text-white/90 text-sm">{category.name}</p>
            <p className="text-[10px] text-white/40">{category.lineCount} line{category.lineCount === 1 ? '' : 's'}</p>
          </div>
        </div>
        <span className="text-sm font-black text-white/85">{PKR(category.monthlyExpectedCents)}/mo</span>
      </header>
      <div className="divide-y divide-white/[0.04]">
        {category.lines.map((l) => (
          <button key={l.id} onClick={() => onEditLine(l)}
            className="w-full text-left px-5 py-3 flex items-center justify-between gap-3 hover:bg-white/[0.015] transition-colors">
            <div>
              <p className="text-sm font-bold text-white/85">{l.name}</p>
              <p className="text-[11px] text-white/45">
                {l.vendor ?? <em>no vendor</em>}
                {l.nextDueDate && ` · due ${new Date(l.nextDueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-white/85">{PKR(l.amountCents)}<span className="text-[10px] text-white/45">/{l.cadence === 'monthly' ? 'mo' : l.cadence === 'quarterly' ? 'qtr' : l.cadence === 'annual' ? 'yr' : 'use'}</span></span>
              <span className="text-white/30 text-xs">›</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}

function ProjectOpexLineModal({ projectId, categories, qc, line, onClose, onSaved }: {
  projectId: string; categories: OpexCategory[]; qc: ReturnType<typeof useQueryClient>; line?: OpexLine; onClose: () => void; onSaved: () => void
}) {
  const isEdit = !!line
  const [categoryId, setCategoryId] = useState(line?.categoryId ?? categories[0]?.id ?? '')
  const [name, setName] = useState(line?.name ?? '')
  const [vendor, setVendor] = useState(line?.vendor ?? '')
  const [amountCents, setAmount] = useState(line?.amountCents ?? 0)
  const [cadence, setCadence] = useState<'monthly' | 'quarterly' | 'annual' | 'per_use'>(line?.cadence ?? 'monthly')
  const [nextDueDate, setNextDueDate] = useState(line?.nextDueDate?.slice(0, 10) ?? '')
  const [creatingCategory, setCreatingCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryEmoji, setNewCategoryEmoji] = useState('')

  const createCat = useMutation({
    mutationFn: () => api.post<{ id: string }>('/opex/categories', { name: newCategoryName.trim(), emoji: newCategoryEmoji.trim() || null }),
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: ['opex-categories'] })
      setCategoryId(created.id)
      setCreatingCategory(false)
      setNewCategoryName('')
      setNewCategoryEmoji('')
    },
  })

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        categoryId, projectId, name, vendor: vendor || null,
        amountCents, cadence,
        nextDueDate: nextDueDate ? `${nextDueDate}T00:00:00Z` : null,
      }
      return isEdit ? api.patch(`/opex/lines/${line!.id}`, payload) : api.post('/opex/lines', payload)
    },
    onSuccess: () => onSaved(),
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/opex/lines/${line!.id}`),
    onSuccess: () => onSaved(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{isEdit ? 'Edit OpEx line' : 'Add OpEx line'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs text-white/55">Category *</label>
            <div className="flex gap-2 mt-1">
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={fieldCls + ' flex-1'}>
                <option value="">— pick —</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
              </select>
              <button type="button" onClick={() => setCreatingCategory(!creatingCategory)}
                className="rounded-lg border border-white/10 px-3 text-xs text-white/55 hover:text-white">+ New</button>
            </div>
            {creatingCategory && (
              <div className="rounded-lg p-3 mt-2" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="grid grid-cols-[60px_1fr] gap-2">
                  <input value={newCategoryEmoji} onChange={(e) => setNewCategoryEmoji(e.target.value)} placeholder="🏢" className={fieldCls + ' text-center text-xl'} />
                  <input value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newCategoryName.trim()) createCat.mutate() }}
                    placeholder="Category name (e.g. Rent, Utilities)" className={fieldCls} autoFocus />
                </div>
                {createCat.error && (
                  <p className="text-xs text-red-400 mt-2">Could not create: {(createCat.error as Error).message}</p>
                )}
                <div className="flex justify-between gap-2 mt-2">
                  <button onClick={() => { setCreatingCategory(false); setNewCategoryName(''); setNewCategoryEmoji('') }}
                    className="text-xs text-white/55 hover:text-white">Cancel</button>
                  <button onClick={() => createCat.mutate()} disabled={!newCategoryName.trim() || createCat.isPending}
                    className="rounded-lg bg-kds-green px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50">
                    {createCat.isPending ? 'Creating…' : '+ Create category'}
                  </button>
                </div>
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-white/55">Line name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="42C kitchen rent — Phase 1" className={fieldCls + ' mt-1'} />
          </div>
          <div>
            <label className="text-xs text-white/55">Vendor</label>
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Landlord" className={fieldCls + ' mt-1'} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/55">Amount (PKR) *</label>
              <MoneyInput value={amountCents} onChange={setAmount} className={fieldCls + ' mt-1'} />
            </div>
            <div>
              <label className="text-xs text-white/55">Cadence</label>
              <select value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} className={fieldCls + ' mt-1'}>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="per_use">Per use</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-white/55">Next due</label>
            <input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} className={fieldCls + ' mt-1'} />
          </div>
          {save.error && <div className="rounded-xl px-4 py-3 text-sm text-red-400" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>{(save.error as Error).message}</div>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <div className="flex items-center gap-3 ml-auto">
            {isEdit && (
              <button onClick={() => { if (confirm(`Delete "${name}"?`)) del.mutate() }}
                disabled={del.isPending}
                className="rounded-xl border border-red-500/20 text-red-400/70 px-4 py-2.5 text-xs hover:text-red-300 disabled:opacity-50">
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            )}
            <button onClick={() => save.mutate()} disabled={save.isPending || !categoryId || !name.trim() || amountCents <= 0}
              className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add line'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Per-project scope customization. Add / rename / re-emoji / reorder / delete
// any section. Lines under a deleted scope move to "Unsorted" automatically
// (caught at render time, not destructive on the DB).
function ScopesEditorModal({ project, currentScopes, onClose, onSaved }: {
  project: Project
  currentScopes: ScopeDef[]
  onClose: () => void
  onSaved: () => void
}) {
  const [scopes, setScopes] = useState<ScopeDef[]>(currentScopes.map((s) => ({ ...s })))
  const usedKeys = new Set(project.lines.map((l) => l.scope))

  const save = useMutation({
    mutationFn: () => {
      // Slug-ify any newly-added scopes that have an empty key based on label
      const cleaned = scopes
        .filter((s) => s.label.trim().length > 0)
        .map((s) => ({
          key:   (s.key || s.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'scope',
          label: s.label.trim(),
          emoji: s.emoji?.trim() || null,
          hint:  s.hint?.trim() || null,
        }))
      // De-dupe keys (suffix on collision)
      const seen = new Set<string>()
      const final = cleaned.map((s) => {
        let k = s.key, i = 2
        while (seen.has(k)) { k = `${s.key}_${i}`; i++ }
        seen.add(k)
        return { ...s, key: k }
      })
      return api.patch(`/finance/capex/${project.id}`, { scopeConfig: final })
    },
    onSuccess: () => onSaved(),
  })

  function patch(i: number, p: Partial<ScopeDef>) {
    setScopes((prev) => prev.map((s, idx) => idx === i ? { ...s, ...p } : s))
  }
  function remove(i: number) {
    const target = scopes[i]
    if (!target) return
    if (usedKeys.has(target.key)) {
      if (!confirm(`"${target.label}" has lines in it. Remove the section anyway? Lines will move to "Unsorted" — drag them to other sections later.`)) return
    }
    setScopes((prev) => prev.filter((_, idx) => idx !== i))
  }
  function move(i: number, dir: -1 | 1) {
    setScopes((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
  }
  function addBlank() {
    setScopes((prev) => [...prev, { key: '', label: '', emoji: '📦' }])
  }
  function reset() {
    setScopes(SCOPES.map((s) => ({ key: s.key, label: s.label, emoji: s.emoji, hint: s.hint })))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <div>
            <h2 className="font-black text-white/90">Customize sections</h2>
            <p className="text-xs text-white/45 mt-0.5">Rename, reorder, or define your own. Lines under a removed section move to &ldquo;Unsorted&rdquo;.</p>
          </div>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>

        <div className="p-5 space-y-2 max-h-[70vh] overflow-y-auto">
          {scopes.map((s, i) => {
            const used = usedKeys.has(s.key)
            return (
              <div key={i} className="rounded-lg p-3 grid grid-cols-[24px_60px_1fr_2fr_auto_auto] gap-2 items-center"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <span className="text-xs font-mono text-white/35">{i + 1}</span>
                <input value={s.emoji ?? ''} onChange={(e) => patch(i, { emoji: e.target.value })}
                  placeholder="📦" className={fieldCls + ' text-center text-lg'} />
                <input value={s.label} onChange={(e) => patch(i, { label: e.target.value })}
                  placeholder="Label (e.g. Back of House)" className={fieldCls + ' font-bold'} />
                <input value={s.hint ?? ''} onChange={(e) => patch(i, { hint: e.target.value })}
                  placeholder="Hint (e.g. Kitchen equipment, walk-in, exhaust)" className={fieldCls + ' text-xs'} />
                <div className="flex items-center">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="text-white/30 hover:text-white px-1 disabled:opacity-20">↑</button>
                  <button onClick={() => move(i, 1)}  disabled={i === scopes.length - 1} className="text-white/30 hover:text-white px-1 disabled:opacity-20">↓</button>
                </div>
                <button onClick={() => remove(i)} className="text-white/30 hover:text-red-400 px-1"
                  title={used ? 'In use — confirm to remove' : 'Remove section'}>
                  {used ? '⚠' : '✕'}
                </button>
              </div>
            )
          })}

          <div className="flex items-center gap-2 pt-2">
            <button onClick={addBlank}
              className="text-xs font-bold rounded-lg px-3 py-1.5 bg-kds-green text-black hover:opacity-90">
              + Add section
            </button>
            <button onClick={reset}
              className="text-xs text-white/55 hover:text-white">
              Reset to default
            </button>
          </div>

          {save.error && <ErrorBanner error={save.error} />}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || scopes.length === 0}
            className={primaryBtn}>
            {save.isPending ? 'Saving…' : 'Save sections'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl p-3"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/35">{label}</p>
      <p className="text-sm font-black mt-1" style={{ color: accent }}>{value}</p>
    </div>
  )
}

function LineRow({ line, onEdit }: { line: Line; onEdit: () => void }) {
  const status = STATUS_META[line.status]
  const totalDue = line.negotiatedCents ?? line.unitCostCents * line.quantity
  const paidPct = totalDue > 0 ? Math.min(100, (line.paidCents / totalDue) * 100) : 0

  return (
    <button onClick={onEdit} className="w-full text-left px-5 py-3 hover:bg-white/[0.015] transition-colors">
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-white/90 truncate">{line.item}</p>
            {line.priority === 'must_have' ? null : (
              <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">{line.priority.replace('_', ' ')}</span>
            )}
            {line.quotes.length > 0 && (
              <span className="text-[10px] text-white/40">📋 {line.quotes.length}q</span>
            )}
          </div>
          <p className="text-[11px] text-white/45 mt-0.5">
            {line.vendor ?? <em>no vendor</em>}
            {line.leadTimeDays ? ` · ${line.leadTimeDays}d lead` : ''}
            {line.expectedDeliveryDate ? ` · ETA ${new Date(line.expectedDeliveryDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
          </p>
        </div>

        <div className="text-right whitespace-nowrap">
          <p className="text-xs text-white/45">qty {line.quantity}</p>
          <p className="text-sm font-mono text-white/85">{PKR(totalDue)}</p>
        </div>

        <div className="w-24">
          <div className="h-1 rounded-full bg-white/5 overflow-hidden">
            <div className="h-full bg-kds-green" style={{ width: `${paidPct}%` }} />
          </div>
          <p className="text-[10px] text-white/40 mt-0.5">{Math.round(paidPct)}% paid</p>
        </div>

        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
          style={{ color: status.fg, background: `${status.fg}1a`, border: `1px solid ${status.fg}40` }}>
          {status.label}
        </span>

        <span className="text-white/30 text-xs">›</span>
      </div>
    </button>
  )
}

// ─── Modals ───────────────────────────────────────────────────────────────

function CreateProjectModal({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState('')
  const [projectType, setProjectType] = useState<'kitchen_buildout' | 'refurb' | 'expansion' | 'new_brand' | 'equipment_only'>('kitchen_buildout')
  const [address, setAddress] = useState('')
  const [floorAreaSqft, setFloorAreaSqft] = useState<number | ''>('')
  const [targetOpeningDate, setTargetOpeningDate] = useState('')
  const [budgetEnvelopeCents, setBudgetEnvelopeCents] = useState(0)
  // JV toggle. When on, partner rows below are required and every CapEx +
  // OpEx line on this project will render partner-split chips next to its
  // amount. Independent of tenant-level JV — useful when a single build is
  // partner-funded inside a wholly-owned tenant.
  const [isJointVenture, setIsJointVenture] = useState(false)
  const [jvPartners, setJvPartners] = useState<Array<{ label: string; pct: number }>>([
    { label: '', pct: 50 },
    { label: '', pct: 50 },
  ])
  const splitSum = jvPartners.reduce((s, p) => s + (p.pct || 0), 0)
  const splitOff = isJointVenture && Math.abs(splitSum - 100) > 0.01

  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>('/finance/capex', {
      name, projectType, budgetEnvelopeCents,
      ...(address && { address }),
      ...(floorAreaSqft && { floorAreaSqft: +floorAreaSqft }),
      ...(targetOpeningDate && { targetOpeningDate: `${targetOpeningDate}T00:00:00Z` }),
      isJointVenture,
      ...(isJointVenture && jvPartners.length > 0 && {
        jvPartners: jvPartners.filter((p) => p.label.trim()),
      }),
    }),
    onSuccess: (created) => onSaved(created.id),
  })

  return <ModalShell title="New CapEx project" onClose={onClose}>
    <Field label="Project name *">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="42C Kitchen — Phase 1 build" className={fieldCls} autoFocus />
    </Field>
    <Field label="Project type">
      <select value={projectType} onChange={(e) => setProjectType(e.target.value as typeof projectType)} className={fieldCls}>
        <option value="kitchen_buildout">Kitchen build-out (new from shell)</option>
        <option value="refurb">Refurb / refresh of existing space</option>
        <option value="expansion">Expansion / second site</option>
        <option value="new_brand">New brand launch</option>
        <option value="equipment_only">Equipment refresh only</option>
      </select>
    </Field>
    <Field label="Address (optional)">
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="MM Alam Road, Lahore" className={fieldCls} />
    </Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Floor area (sqft)">
        <input type="number" value={floorAreaSqft} onChange={(e) => setFloorAreaSqft(e.target.value === '' ? '' : +e.target.value)} className={fieldCls} />
      </Field>
      <Field label="Target opening">
        <input type="date" value={targetOpeningDate} onChange={(e) => setTargetOpeningDate(e.target.value)} className={fieldCls} />
      </Field>
    </div>
    <Field label="Budget envelope (PKR) *">
      <MoneyInput value={budgetEnvelopeCents} onChange={setBudgetEnvelopeCents} className={fieldCls} placeholder="e.g. 10,000,000" />
      <Hint>The cap. Lines committed above this fire an exception flag.</Hint>
    </Field>

    {/* Joint-venture section. Off by default; flipping it on reveals the
        partner-share editor. The split applies to EVERY CapEx + OpEx line
        on this project automatically — set once here, see chips everywhere. */}
    <div className="rounded-xl p-3"
      style={{ background: 'rgba(168,85,247,0.05)', border: '1px solid rgba(168,85,247,0.20)' }}>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={isJointVenture}
          onChange={(e) => setIsJointVenture(e.target.checked)} />
        <span className="text-sm font-bold text-white/85">Joint venture</span>
        <span className="text-[11px] text-white/40">Flip on if a partner co-funds this build.</span>
      </label>
      {isJointVenture && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-white/55 font-bold">
              Partner shares
            </span>
            <button type="button"
              onClick={() => setJvPartners([...jvPartners, { label: '', pct: 0 }])}
              className="text-[10px] font-bold text-[#C4B5FD] hover:underline">
              + Add partner
            </button>
          </div>
          {jvPartners.map((p, i) => (
            <div key={i} className="flex gap-2">
              <input value={p.label}
                onChange={(e) => {
                  const next = [...jvPartners]
                  next[i] = { ...next[i]!, label: e.target.value }
                  setJvPartners(next)
                }}
                placeholder={i === 0 ? 'e.g. Viva' : 'e.g. Garibsons'}
                className={fieldCls + ' flex-1'} />
              <div className="relative w-24">
                <input type="number" min={0} max={100} value={p.pct}
                  onChange={(e) => {
                    const next = [...jvPartners]
                    next[i] = { ...next[i]!, pct: parseFloat(e.target.value) || 0 }
                    setJvPartners(next)
                  }}
                  className={fieldCls + ' pr-7'} />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-white/40">%</span>
              </div>
              {jvPartners.length > 2 && (
                <button type="button"
                  onClick={() => setJvPartners(jvPartners.filter((_, j) => j !== i))}
                  className="text-red-400 hover:bg-red-400/10 rounded-md px-2 text-sm">×</button>
              )}
            </div>
          ))}
          <p className={`text-[11px] font-mono ${splitOff ? 'text-amber-400' : 'text-white/40'}`}>
            Total: {splitSum}% {splitOff && '(should be 100)'}
          </p>
        </div>
      )}
    </div>

    {save.error && <ErrorBanner error={save.error} />}
    <ModalFooter onCancel={onClose}>
      <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className={primaryBtn}>
        {save.isPending ? 'Creating…' : 'Create project →'}
      </button>
    </ModalFooter>
  </ModalShell>
}

function EditProjectModal({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(project.name)
  const [phase, setPhase] = useState<Phase>(project.phase)
  const [budgetEnvelopeCents, setBudgetEnvelopeCents] = useState(project.budgetEnvelopeCents)
  const [contingencyPct, setContingencyPct] = useState(project.contingencyPct)
  const [consultantFeesCents, setConsultantFeesCents] = useState(project.consultantFeesCents)
  const [taxCents, setTaxCents] = useState(project.taxCents)
  const [targetOpeningDate, setTargetOpeningDate] = useState(project.targetOpeningDate?.slice(0, 10) ?? '')
  const [address, setAddress] = useState(project.address ?? '')
  const [floorAreaSqft, setFloorAreaSqft] = useState<number | ''>(project.floorAreaSqft ?? '')
  const [notes, setNotes] = useState(project.notes ?? '')

  const save = useMutation({
    mutationFn: () => api.patch(`/finance/capex/${project.id}`, {
      name, phase, budgetEnvelopeCents, contingencyPct, consultantFeesCents, taxCents,
      targetOpeningDate: targetOpeningDate ? `${targetOpeningDate}T00:00:00Z` : null,
      address: address || null,
      floorAreaSqft: floorAreaSqft === '' ? null : +floorAreaSqft,
      notes: notes || null,
    }),
    onSuccess: () => onSaved(),
  })
  const del = useMutation({
    mutationFn: () => api.delete(`/finance/capex/${project.id}`),
    onSuccess: () => onSaved(),
  })

  return <ModalShell title="Edit project" onClose={onClose} wide>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} /></Field>
      <Field label="Phase">
        <select value={phase} onChange={(e) => setPhase(e.target.value as Phase)} className={fieldCls}>
          {Object.entries(PHASE_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
      </Field>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Budget envelope (PKR)">
        <MoneyInput value={budgetEnvelopeCents} onChange={setBudgetEnvelopeCents} className={fieldCls} />
      </Field>
      <Field label="Contingency %">
        <input type="number" step="0.01" min={0} max={0.5} value={contingencyPct} onChange={(e) => setContingencyPct(+e.target.value || 0)} className={fieldCls} />
        <Hint>{(contingencyPct * 100).toFixed(0)}% — buffer over budgeted lines</Hint>
      </Field>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Consultant fees (PKR)">
        <MoneyInput value={consultantFeesCents} onChange={setConsultantFeesCents} className={fieldCls} />
      </Field>
      <Field label="Tax (PKR)">
        <MoneyInput value={taxCents} onChange={setTaxCents} className={fieldCls} />
      </Field>
    </div>
    <Field label="Address"><input value={address} onChange={(e) => setAddress(e.target.value)} className={fieldCls} /></Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Floor area (sqft)">
        <input type="number" value={floorAreaSqft} onChange={(e) => setFloorAreaSqft(e.target.value === '' ? '' : +e.target.value)} className={fieldCls} />
      </Field>
      <Field label="Target opening">
        <input type="date" value={targetOpeningDate} onChange={(e) => setTargetOpeningDate(e.target.value)} className={fieldCls} />
      </Field>
    </div>
    <Field label="Notes">
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={fieldCls} />
    </Field>
    {save.error && <ErrorBanner error={save.error} />}
    {del.error && <ErrorBanner error={del.error} />}
    <ModalFooter onCancel={onClose}>
      <button
        onClick={() => { if (confirm(`Delete project "${project.name}"? Lines, quotes and payments will go with it.`)) del.mutate() }}
        disabled={del.isPending}
        className="rounded-xl border border-red-500/20 text-red-400/70 px-4 py-2.5 text-xs hover:text-red-300 mr-auto disabled:opacity-50">
        {del.isPending ? 'Deleting…' : 'Delete project'}
      </button>
      <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className={primaryBtn}>
        {save.isPending ? 'Saving…' : 'Save changes'}
      </button>
    </ModalFooter>
  </ModalShell>
}

function LineModal({ projectId, scope, line, onClose, onSaved }: {
  projectId: string; scope: string; line?: Line; onClose: () => void; onSaved: () => void
}) {
  const qc = useQueryClient()
  const [item, setItem] = useState(line?.item ?? '')
  const [category, setCategory] = useState(line?.category ?? '')
  const [quantity, setQuantity] = useState(line?.quantity ?? 1)
  const [unitCostCents, setUnitCostCents] = useState(line?.unitCostCents ?? 0)
  const [vendor, setVendor] = useState(line?.vendor ?? '')
  const [vendorContact, setVendorContact] = useState(line?.vendorContact ?? '')
  const [quotedCents, setQuotedCents] = useState<number | ''>(line?.quotedCents ?? '')
  const [negotiatedCents, setNegotiatedCents] = useState<number | ''>(line?.negotiatedCents ?? '')
  const [status, setStatus] = useState<Status>(line?.status ?? 'not_quoted')
  const [priority, setPriority] = useState<'must_have' | 'nice_to_have' | 'future'>(line?.priority ?? 'must_have')
  const [leadTimeDays, setLeadTimeDays] = useState<number | ''>(line?.leadTimeDays ?? '')
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(line?.expectedDeliveryDate?.slice(0, 10) ?? '')
  const [notes, setNotes] = useState(line?.notes ?? '')

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        scope, item, quantity, unitCostCents, status, priority,
        category: category || null, vendor: vendor || null, vendorContact: vendorContact || null,
        quotedCents: quotedCents === '' ? null : +quotedCents,
        negotiatedCents: negotiatedCents === '' ? null : +negotiatedCents,
        leadTimeDays: leadTimeDays === '' ? null : +leadTimeDays,
        expectedDeliveryDate: expectedDeliveryDate ? `${expectedDeliveryDate}T00:00:00Z` : null,
        notes: notes || null,
      }
      if (line) return api.patch(`/finance/capex/lines/${line.id}`, payload)
      return api.post(`/finance/capex/${projectId}/lines`, payload)
    },
    onSuccess: () => onSaved(),
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/finance/capex/lines/${line!.id}`),
    onSuccess: () => onSaved(),
  })

  return <ModalShell title={`${line ? 'Edit' : 'Add'} ${scope} line`} onClose={onClose} wide>
    <Field label="Item *">
      <input value={item} onChange={(e) => setItem(e.target.value)}
        placeholder="Rational SCC 6-2/1 combi oven · 5-tier walk-in shelving · Emergency lighting set" className={fieldCls} autoFocus />
    </Field>

    <div className="grid grid-cols-3 gap-3">
      <Field label="Category">
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Cooking · Refrigeration" className={fieldCls} />
      </Field>
      <Field label="Quantity">
        <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(+e.target.value || 1)} className={fieldCls} />
      </Field>
      <Field label="Priority">
        <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)} className={fieldCls}>
          <option value="must_have">Must have</option>
          <option value="nice_to_have">Nice to have</option>
          <option value="future">Future / phase 2</option>
        </select>
      </Field>
    </div>

    <Section heading="Money">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Budgeted unit cost (PKR)">
          <MoneyInput value={unitCostCents} onChange={setUnitCostCents} className={fieldCls} />
          <Hint>{PKR(unitCostCents * quantity)} total for qty {quantity}</Hint>
        </Field>
        <Field label="Quoted (PKR)">
          <MoneyInput value={quotedCents === '' ? 0 : quotedCents} onChange={(c) => setQuotedCents(c)} className={fieldCls} placeholder="Initial quote" />
        </Field>
        <Field label="Negotiated (PKR)">
          <MoneyInput value={negotiatedCents === '' ? 0 : negotiatedCents} onChange={(c) => setNegotiatedCents(c)} className={fieldCls} placeholder="What you committed" />
        </Field>
      </div>
    </Section>

    <Section heading="Vendor">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Vendor"><input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Sialkot Steel Works" className={fieldCls} /></Field>
        <Field label="Contact (name · phone)"><input value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} placeholder="Bilal · +92 300 1234567" className={fieldCls} /></Field>
      </div>
    </Section>

    <Section heading="Status & schedule">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)} className={fieldCls}>
            {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Lead time (days)">
          <input type="number" value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value === '' ? '' : +e.target.value)} className={fieldCls} />
        </Field>
        <Field label="Expected delivery">
          <input type="date" value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} className={fieldCls} />
        </Field>
      </div>
    </Section>

    <Field label="Notes">
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
        placeholder="3-year warranty, gas connection required, lead time confirmed by Bilal on call." className={fieldCls} />
    </Field>

    {/* Quote comparison shopping — only shown when editing an existing line */}
    {line && <QuotePanel line={line} onChange={() => qc.invalidateQueries({ queryKey: ['capex-projects'] })} />}

    {/* Payment schedule */}
    {line && <PaymentPanel line={line} onChange={() => qc.invalidateQueries({ queryKey: ['capex-projects'] })} />}

    {save.error && <ErrorBanner error={save.error} />}

    <ModalFooter onCancel={onClose}>
      {line && (
        <button onClick={() => { if (confirm('Delete this line?')) del.mutate() }}
          className="rounded-xl border border-red-500/20 text-red-400/70 px-4 py-2.5 text-xs hover:text-red-300 mr-auto">
          Delete line
        </button>
      )}
      <button onClick={() => save.mutate()} disabled={save.isPending || !item.trim()} className={primaryBtn}>
        {save.isPending ? 'Saving…' : line ? 'Save changes' : 'Add line'}
      </button>
    </ModalFooter>
  </ModalShell>
}

function QuotePanel({ line, onChange }: { line: Line; onChange: () => void }) {
  const [adding, setAdding] = useState(false)
  const [vendor, setVendor] = useState('')
  const [totalCents, setTotalCents] = useState(0)
  const [leadTimeDays, setLeadTimeDays] = useState<number | ''>('')
  const [contactName, setContactName] = useState('')
  const [fileUrl, setFileUrl] = useState('')

  const add = useMutation({
    mutationFn: () => api.post(`/finance/capex/lines/${line.id}/quotes`, {
      vendor, totalCents,
      ...(leadTimeDays !== '' && { leadTimeDays: +leadTimeDays }),
      ...(contactName && { contactName }),
      ...(fileUrl && { fileUrl }),
    }),
    onSuccess: () => { setAdding(false); setVendor(''); setTotalCents(0); setLeadTimeDays(''); setContactName(''); setFileUrl(''); onChange() },
  })
  const setWinner = useMutation({
    mutationFn: (qid: string) => api.patch(`/finance/capex/quotes/${qid}/winner`, {}),
    onSuccess: () => onChange(),
  })
  const removeQuote = useMutation({
    mutationFn: (qid: string) => api.delete(`/finance/capex/quotes/${qid}`),
    onSuccess: () => onChange(),
  })

  return <Section heading={`Quotes · ${line.quotes.length}`}>
    <div className="space-y-1.5">
      {line.quotes.map((q) => (
        <div key={q.id} className="rounded-lg p-3 grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 items-center"
          style={q.isWinner
            ? { background: 'rgba(0,212,177,0.08)', border: '1px solid rgba(0,212,177,0.4)' }
            : { background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div>
            <p className="text-sm font-bold text-white/85">{q.vendor}</p>
            {q.contactName && <p className="text-[11px] text-white/45">{q.contactName}</p>}
          </div>
          <span className="text-sm font-mono text-white/85">{PKR(q.totalCents)}</span>
          <span className="text-xs text-white/45">{q.leadTimeDays ? `${q.leadTimeDays}d` : '—'}</span>
          {q.isWinner ? (
            <span className="text-[10px] font-black uppercase tracking-wider text-[#00D4B1]">★ Winner</span>
          ) : (
            <button onClick={() => setWinner.mutate(q.id)} className="text-[11px] text-white/55 hover:text-white">Pick</button>
          )}
          <button onClick={() => removeQuote.mutate(q.id)} className="text-white/30 hover:text-red-400">✕</button>
        </div>
      ))}
    </div>

    {adding ? (
      <div className="rounded-xl p-3 mt-2"
        style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="grid grid-cols-2 gap-2">
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor name" className={fieldCls} autoFocus />
          <MoneyInput value={totalCents} onChange={setTotalCents} placeholder="Total (PKR)" className={fieldCls} />
        </div>
        <div className="grid grid-cols-3 gap-2 mt-2">
          <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name" className={fieldCls} />
          <input type="number" value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value === '' ? '' : +e.target.value)} placeholder="Lead days" className={fieldCls} />
          <input value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} placeholder="Quote file URL (optional)" className={fieldCls} />
        </div>
        <div className="flex gap-2 mt-2 justify-end">
          <button onClick={() => setAdding(false)} className="text-xs text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => add.mutate()} disabled={add.isPending || !vendor.trim() || totalCents <= 0}
            className="rounded-lg bg-kds-green px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50">+ Save quote</button>
        </div>
      </div>
    ) : (
      <button onClick={() => setAdding(true)}
        className="w-full rounded-lg border-2 border-dashed border-white/10 px-3 py-2 text-xs text-white/55 hover:text-white hover:border-white/30 mt-2">
        + Add quote (compare vendors)
      </button>
    )}
  </Section>
}

function PaymentPanel({ line, onChange }: { line: Line; onChange: () => void }) {
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState<'deposit' | 'midpoint' | 'balance' | 'extra'>('deposit')
  const [amountCents, setAmountCents] = useState(0)
  const [dueDate, setDueDate] = useState('')

  const add = useMutation({
    mutationFn: () => api.post(`/finance/capex/lines/${line.id}/payments`, {
      label, amountCents, ...(dueDate && { dueDate: `${dueDate}T00:00:00Z` }),
    }),
    onSuccess: () => { setAdding(false); setAmountCents(0); setDueDate(''); onChange() },
  })
  const markPaid = useMutation({
    mutationFn: (p: Payment) => api.patch(`/finance/capex/payments/${p.id}`, {
      paidAt: new Date().toISOString(),
      paidAmountCents: p.amountCents,
    }),
    onSuccess: () => onChange(),
  })
  const remove = useMutation({
    mutationFn: (pid: string) => api.delete(`/finance/capex/payments/${pid}`),
    onSuccess: () => onChange(),
  })

  return <Section heading={`Payment schedule · ${line.payments.length}`}>
    <div className="space-y-1.5">
      {line.payments.map((p) => (
        <div key={p.id} className="rounded-lg p-3 grid grid-cols-[80px_auto_1fr_auto_auto] gap-2 items-center"
          style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <span className="text-xs font-bold uppercase tracking-wider text-white/65">{p.label}</span>
          <span className="text-sm font-mono text-white/85">{PKR(p.amountCents)}</span>
          <span className="text-xs text-white/45">
            {p.dueDate ? `due ${new Date(p.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'no due date'}
            {p.paidAt && <span className="text-[#00D4B1] ml-2">· paid {new Date(p.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
          </span>
          {p.paidAt ? (
            <span className="text-[10px] font-black text-[#00D4B1]">✓ PAID</span>
          ) : (
            <button onClick={() => markPaid.mutate(p)} className="rounded-lg bg-kds-green px-2.5 py-1 text-[10px] font-bold text-black">Mark paid</button>
          )}
          <button onClick={() => remove.mutate(p.id)} className="text-white/30 hover:text-red-400">✕</button>
        </div>
      ))}
    </div>

    {adding ? (
      <div className="rounded-xl p-3 mt-2"
        style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="grid grid-cols-3 gap-2">
          <select value={label} onChange={(e) => setLabel(e.target.value as typeof label)} className={fieldCls}>
            <option value="deposit">Deposit</option>
            <option value="midpoint">Midpoint</option>
            <option value="balance">Balance</option>
            <option value="extra">Extra</option>
          </select>
          <MoneyInput value={amountCents} onChange={setAmountCents} placeholder="Amount (PKR)" className={fieldCls} />
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={fieldCls} />
        </div>
        <div className="flex gap-2 mt-2 justify-end">
          <button onClick={() => setAdding(false)} className="text-xs text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => add.mutate()} disabled={add.isPending || amountCents <= 0}
            className="rounded-lg bg-kds-green px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50">+ Schedule</button>
        </div>
      </div>
    ) : (
      <button onClick={() => setAdding(true)}
        className="w-full rounded-lg border-2 border-dashed border-white/10 px-3 py-2 text-xs text-white/55 hover:text-white hover:border-white/30 mt-2">
        + Schedule payment
      </button>
    )}
  </Section>
}

// ─── Shared bits ──────────────────────────────────────────────────────────

function ModalShell({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
    <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-2xl overflow-hidden`}
      style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
        <h2 className="font-black text-white/90">{title}</h2>
        <button onClick={onClose} className="text-white/40 text-xl">✕</button>
      </div>
      <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">{children}</div>
    </div>
  </div>
}
function ModalFooter({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  return <div className="flex items-center justify-between gap-3 pt-4 mt-4 border-t border-white/[0.05]">
    <button onClick={onCancel} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
    {children}
  </div>
}
function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return <div className="rounded-xl p-3 space-y-2 mt-2"
    style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.05)' }}>
    <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45">{heading}</p>
    {children}
  </div>
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div>
}
function Hint({ children }: { children: React.ReactNode }) { return <p className="text-[11px] text-white/35 mt-1">{children}</p> }
function ErrorBanner({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : 'Failed'
  return <div className="rounded-xl px-4 py-3 text-sm text-red-400" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>{msg}</div>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
const primaryBtn = "rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50"
