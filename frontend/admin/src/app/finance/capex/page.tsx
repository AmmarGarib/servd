'use client'
// Project Tracker — unified CapEx + OpEx for any project (kitchen build,
// refurb, expansion, new brand). The CapEx tab handles one-time build cost;
// the OpEx tab handles recurring run-rate (rent, payroll, utilities) tied to
// the same project, giving full TCO. Schema: CapexProject is the parent;
// CapexLine for one-off items, OpexLine.projectId for recurring items.

import { Suspense, useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { api, deleteWithUndo } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { PositionsView } from '../../workforce/positions/view'
import { BankAccountSelect, useBankAccounts } from '../../../components/finance/BankAccountSelect'
import { errorWords, useFaCapabilities, FA_BASE } from '../../../components/fixedAssets/shared'
import { receiptMethodLabel } from '../../../components/finance/PaymentReceivedFields'
import type { Phase, Status, Payment, Line, ScopeDef, Project, Treatment } from '../../../components/fixedAssets/capexTypes'
import {
  CapitalisePanel, QuickBuyModal, DepositReturnModal, ReclassDepositModal, OrphanBanner, ExemptionLine, WhtPreview,
  useAdvanceFlags, useCapexLookups, useWithholdingPreview, quickBuyMessage,
  TREATMENT_OPTIONS, TREATMENT_LABEL, WHT_SECTION_LABEL, AUTHORITY_LABEL,
} from '../../../components/fixedAssets/CapexForms'
import { Select } from '@/components/ui/Select'
import { toast } from 'sonner'
import { useTrashPrefill } from '../../../lib/trash'
import { unwrapPrefill, pStr, pNum, type Prefill } from '../../../lib/trashPrefill'
import { Modal as SharedModal } from '../../../components/ui/Modal'
import { NumberField } from '../../../components/ui/NumberField'
import { useConfirm } from '../../../components/ui/ConfirmDialog'
import { Field, dateBounds, firstMissing, focusField, useSubmitOnce } from '../cash-vouchers/ui'

// ─── Types ────────────────────────────────────────────────────────────────
// The shapes of GET /finance/capex live in components/fixedAssets/capexTypes.ts.

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
  planning:  { label: 'Planning',   bg: 'rgb(var(--ink-rgb) / 0.12)',  fg: 'var(--erp-primary-ink)' },
  quoting:   { label: 'Quoting',    bg: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)',  fg: 'var(--erp-warning)' },
  executing: { label: 'Executing',  bg: 'rgb(var(--erp-primary-rgb) / 0.12)',   fg: 'var(--erp-primary-ink)' },
  snagging:  { label: 'Snagging',   bg: 'rgb(var(--erp-primary-rgb) / 0.12)',  fg: 'var(--erp-primary-ink)' },
  live:      { label: 'Live',       bg: 'rgb(var(--erp-accent-rgb) / 0.15)',   fg: 'var(--erp-success)' },
}

const STATUS_META: Record<Status, { label: string; fg: string }> = {
  not_quoted:    { label: 'Not quoted',    fg: 'var(--muted)' },
  quoted:        { label: 'Quoted',        fg: 'var(--erp-warning)' },
  ordered:       { label: 'Ordered',       fg: 'var(--erp-primary-ink)' },
  partial_paid:  { label: 'Paid',          fg: 'var(--erp-success)' },
  delivered:     { label: 'Delivered',     fg: 'var(--erp-success)' },
  installed:     { label: 'Installed',     fg: 'var(--erp-primary-ink)' },
  commissioned:  { label: 'Commissioned',  fg: 'var(--erp-success)' },
  snag:          { label: 'Snag',          fg: 'var(--erp-danger)' },
  done:          { label: 'Done',          fg: 'var(--erp-success)' },
}

const PKR = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

// ─── Page ─────────────────────────────────────────────────────────────────

export default function CapexTrackerPage() {
  // useSearchParams needs a Suspense boundary above it for the static build.
  return (
    <Suspense fallback={<div className="p-8 text-sm text-white/40">Loading…</div>}>
      <CapexTracker />
    </Suspense>
  )
}

function CapexTracker() {
  const qc = useQueryClient()
  const search = useSearchParams()
  const caps = useFaCapabilities()
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
  // ?quickBuy=1 (the register's "Buy equipment" and OpEx's refusal link here) opens Quick buy.
  const [quickBuy, setQuickBuy] = useState(search?.get('quickBuy') === '1')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'wait' | 'bad'; text: string } | null>(null)

  useEffect(() => {
    // ?project=<id> (the Investment dashboard and the register link here) wins over "the first project".
    const wanted = search?.get('project')
    if (!selectedId && wanted && projects.some((p) => p.id === wanted)) { setSelectedId(wanted); return }
    if (!selectedId && projects.length > 0) setSelectedId(projects[0]!.id)
  }, [projects, selectedId, search])

  const project = projects.find((p) => p.id === selectedId) ?? null

  // "Recover as copy" from the Trash (a deleted instalment, type
  // `capex_payment`): select its project, open its line and the "add
  // instalment" form pre-filled (label, amount, due date). The paid state, the
  // WHT snapshot and the posting are never copied. Only while the line exists.
  const trashPrefill = unwrapPrefill(useTrashPrefill('capex_payment'))
  const [instalmentFill, setInstalmentFill] = useState<Prefill | null>(null)
  useEffect(() => {
    if (!trashPrefill || projects.length === 0) return
    const lineId = pStr(trashPrefill, 'lineId', 'capexLineId')
    const owner = projects.find((p) => p.id === pStr(trashPrefill, 'projectId')) ?? projects.find((p) => p.lines.some((l) => l.id === lineId))
    if (!owner || !owner.lines.some((l) => l.id === lineId)) { toast.error('That instalment\'s line no longer exists, so it cannot be recreated.'); return }
    setSelectedId(owner.id); setInstalmentFill(trashPrefill)
  }, [trashPrefill, projects])

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-5 border-b border-white/[0.05]">
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="flex items-start justify-between gap-4 mt-1">
          <div>
            <h1 className="text-2xl font-black text-white/90 flex items-center gap-2">🏗 Capex</h1>
            <p className="text-sm text-white/40 mt-1 max-w-3xl">
              One-time build cost per project (kitchen builds, refurbs, equipment). Recurring run-rate lives
              in <Link href="/finance/opex" className="text-primary-ink font-bold hover:opacity-80">OpEx →</Link>;
              both feed the 12-month <Link href="/finance/projections" className="text-primary-ink font-bold hover:opacity-80">Projections →</Link>.
              {' '}
              <Link href="/finance/capital-ledger" className="text-primary-ink font-bold hover:opacity-80">
                See the roll-up in Investment Dashboard →
              </Link>
              {' · '}
              <Link href="/finance/opex" className="text-primary-ink font-bold hover:opacity-80">
                Standing OpEx (workforce + JV) →
              </Link>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { setNotice(null); setQuickBuy(true) }} className="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-black text-white/80 hover:text-white">Buy equipment</button>
            <button onClick={() => setCreating(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New project</button>
          </div>
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
              ? { background: 'rgb(var(--erp-accent-rgb) / 0.14)', border: '1px solid var(--erp-accent)' }
              : { background: 'rgb(var(--erp-primary-rgb) / 0.04)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.20)' }}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-bold text-sm" style={{ color: 'var(--erp-primary-ink)' }}>💼 Workforce</p>
              <span className="text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                style={{ background: 'rgb(var(--erp-primary-rgb) / 0.20)', color: 'var(--erp-primary-ink)' }}>
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
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <p className="text-xs text-white/45">No projects yet — start one to plan your build.</p>
            </div>
          )}
          {projects.map((p) => {
            const overBudget = p.rollups.varianceVsEnvelopeCents > 0
            return (
              <button key={p.id} onClick={() => setSelectedId(p.id)}
                className="w-full text-left rounded-xl p-3 transition-colors"
                style={selectedId === p.id
                  ? { background: 'rgb(var(--erp-accent-rgb) / 0.12)', border: '1px solid var(--erp-accent)' }
                  : { background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
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
                          background: overBudget ? 'var(--erp-danger)' : 'var(--erp-accent)',
                        }} />
                    </div>
                    <p className="text-[10px] mt-1" style={{ color: overBudget ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.4)' }}>
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
        <main className="p-4 sm:p-6 max-w-[1100px] mx-auto min-w-0">
          {notice && (
            <div className="rounded-xl px-4 py-3 text-sm mb-4 flex items-start justify-between gap-3" role="status"
              style={{
                background: `color-mix(in srgb, ${notice.tone === 'ok' ? 'var(--erp-success)' : notice.tone === 'bad' ? 'var(--erp-danger)' : 'var(--erp-warning)'} 10%, transparent)`,
                border: `1px solid color-mix(in srgb, ${notice.tone === 'ok' ? 'var(--erp-success)' : notice.tone === 'bad' ? 'var(--erp-danger)' : 'var(--erp-warning)'} 30%, transparent)`,
                color: notice.tone === 'ok' ? 'var(--erp-success)' : notice.tone === 'bad' ? 'var(--erp-danger)' : 'var(--erp-warning)',
              }}>
              <span>{notice.text}</span>
              <button onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">&times;</button>
            </div>
          )}
          <OrphanBanner />
          {selectedId === 'workforce' ? (
            <PositionsView embedded />
          ) : project ? (
            <ProjectDetail project={project} qc={qc} instalmentFill={instalmentFill} onInstalmentFillUsed={() => setInstalmentFill(null)} />
          ) : (
            <div className="rounded-2xl p-10 text-center"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <p className="font-bold text-white/85">No project selected</p>
              <p className="text-sm text-white/45 mt-1">Pick a project from the sidebar or create a new one.</p>
            </div>
          )}
        </main>
      </div>

      {creating && <CreateProjectModal
        onClose={() => setCreating(false)}
        onSaved={(id) => { qc.invalidateQueries({ queryKey: ['capex-projects'] }); setSelectedId(id); setCreating(false) }} />}

      {quickBuy && <QuickBuyModal
        onClose={() => setQuickBuy(false)}
        onDone={(r) => {
          setQuickBuy(false)
          setNotice(quickBuyMessage(r, caps.canApprove))
          void qc.invalidateQueries({ queryKey: ['capex-projects'] })
          void qc.invalidateQueries({ queryKey: ['fa-register'] })
          void qc.invalidateQueries({ queryKey: ['fa-pending-count'] })
          setSelectedId(r.projectId)
        }} />}
    </div>
  )
}

// ─── Project detail ───────────────────────────────────────────────────────

function ProjectDetail({ project, qc, instalmentFill, onInstalmentFillUsed }: { project: Project; qc: ReturnType<typeof useQueryClient>; instalmentFill?: Prefill | null; onInstalmentFillUsed?: () => void }) {
  const [editingProject, setEditingProject] = useState(false)
  const [lineFill, setLineFill] = useState<Prefill | null>(null)
  const [addingLineScope, setAddingLineScope] = useState<string | null>(null)
  const [editingLine, setEditingLine] = useState<Line | null>(null)
  const [tab, setTab] = useState<'capex' | 'opex'>('capex')
  const [editingScopes, setEditingScopes] = useState(false)
  useEffect(() => {
    if (!instalmentFill) return
    const line = project.lines.find((l) => l.id === pStr(instalmentFill, 'lineId', 'capexLineId'))
    if (!line) return
    setEditingLine(line); setLineFill(instalmentFill); onInstalmentFillUsed?.()
  }, [instalmentFill, project, onInstalmentFillUsed])
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
        style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
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
                  style={{ background: 'rgb(var(--erp-primary-rgb) / 0.20)', color: 'var(--erp-primary-ink)' }}>
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
                    style={{ background: 'rgb(var(--erp-primary-rgb) / 0.10)', color: 'var(--erp-primary-ink)' }}>
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
            ? { color: 'var(--erp-primary-ink)', borderBottom: '2px solid var(--erp-accent)', marginBottom: '-1px' }
            : { color: 'rgb(var(--fg-rgb) / 0.5)' }}>
          🏗 CapEx · build
        </button>
        <button onClick={() => setTab('opex')}
          className="px-4 py-2.5 text-sm font-bold transition-colors"
          style={tab === 'opex'
            ? { color: 'var(--erp-warning)', borderBottom: '2px solid var(--erp-accent)', marginBottom: '-1px' }
            : { color: 'rgb(var(--fg-rgb) / 0.5)' }}>
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

      {addingLineScope && <LineModal project={project} projectId={project.id} tenantId={project.tenantId} scope={addingLineScope}
        onClose={() => setAddingLineScope(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['capex-projects'] }); setAddingLineScope(null) }} />}

      {editingLine && <LineModal project={project} projectId={project.id} tenantId={project.tenantId} scope={editingLine.scope} line={editingLine} instalmentFill={lineFill}
        onClose={() => { setEditingLine(null); setLineFill(null) }}
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
  // Overdue advances and delivered-but-not-capitalised items, from the register's own rules.
  const flags = useAdvanceFlags()
  return (
    <div className="space-y-5">
      {/* Roll-up cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Budget envelope" value={PKR(project.budgetEnvelopeCents)} accent="var(--erp-primary-ink)" />
        <Stat label="Budgeted lines"  value={PKR(project.rollups.budgetedCents)} accent="var(--muted)" />
        <Stat label="Committed"        value={PKR(project.rollups.committedCents)} accent={overBudget ? 'var(--erp-danger)' : 'var(--erp-primary-ink)'} />
        <Stat label="Paid"             value={PKR(project.rollups.paidCents)} accent="var(--erp-success)" />
        <Stat
          label={overBudget ? 'Over budget' : 'Remaining'}
          value={overBudget
            ? `+ ${PKR(project.rollups.varianceVsEnvelopeCents)}`
            : PKR(project.rollups.remainingCents)}
          accent={overBudget ? 'var(--erp-danger)' : 'var(--erp-success)'}
        />
        <Stat
          label="Variance"
          value={overBudget
            ? `+ ${PKR(project.rollups.varianceVsEnvelopeCents)}`
            : `− ${PKR(Math.abs(project.rollups.varianceVsEnvelopeCents))} saved`}
          accent={overBudget ? 'var(--erp-danger)' : 'var(--erp-success)'}
        />
      </div>

      {/* The books: capex instalments post as supplier advances and delivered
          items are capitalised onto the fixed-asset register (disposed and
          voided assets are not counted as assets). */}
      {project.books && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="On the books as assets"     value={PKR(project.books.capitalisedCents)} accent="var(--erp-success)" />
          <Stat label="Advanced, not capitalised"  value={PKR(project.books.notYetCapitalisedCents)} accent="var(--erp-warning)" />
          <Stat label="Rent paid in advance"       value={PKR(project.books.prepaidCents - project.books.releasedCents)} accent="var(--erp-primary-ink)" />
          <Stat label="Fees expensed"              value={PKR(project.books.expensedCents)} accent="var(--muted)" />
          {project.books.depositHeldCents > 0 && <Stat label="Deposits held" value={PKR(project.books.depositHeldCents)} accent="var(--erp-primary-ink)" />}
          {project.books.disposedCents > 0 && <Stat label="Sold or scrapped" value={PKR(project.books.disposedCents)} accent="var(--muted)" />}
          {project.books.whtCents > 0 && <Stat label="Income tax withheld" value={PKR(project.books.whtCents)} accent="var(--muted)" />}
        </div>
      )}

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
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <header className="px-5 py-3 flex items-center justify-between gap-3"
                style={{ background: 'rgb(var(--fg-rgb) / 0.02)', borderBottom: '1px solid rgb(var(--fg-rgb) / 0.04)' }}>
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
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on hover:opacity-90">
                    + Line
                  </button>
                </div>
              </header>
              {s.lines.length === 0 ? (
                <p className="px-5 py-6 text-xs text-white/30 italic">No items in this scope.</p>
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {s.lines.map((l) => <LineRow key={l.id} line={l} flags={flags.get(l.id) ?? []} onEdit={() => onEditLine(l)} />)}
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
        <Stat label="Monthly run-rate" value={PKR(monthlyTotal)} accent="var(--erp-warning)" />
        <Stat label="Annual run-rate"  value={PKR(annualTotal)}  accent="var(--erp-warning)" />
        <Stat label="Categories"        value={String(categories.length)} accent="var(--erp-primary-ink)" />
        <Stat label="Active lines"      value={String(categories.reduce((s, c) => s + c.lineCount, 0))} accent="var(--erp-success)" />
      </div>

      {/* Empty state */}
      {categories.length === 0 && (
        <div className="rounded-2xl p-8 text-center"
          style={{ background: 'color-mix(in srgb, var(--erp-warning) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 20%, transparent)' }}>
          <p className="text-3xl mb-2">💸</p>
          <p className="font-bold text-white/85">No recurring costs tied to this project</p>
          <p className="text-sm text-white/45 mt-1 max-w-md mx-auto">
            Rent, payroll, utilities, software — anything that pays out monthly tied to this build. Add lines to see total cost of ownership beyond the one-time CapEx.
          </p>
          <button onClick={() => setAdding(true)} className="mt-4 rounded-xl bg-primary px-4 py-2 text-sm font-black text-primary-on hover:opacity-90">
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
        style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
        Cross-project / company-wide expenses (software you use everywhere, etc.) live in
        {' '}<Link href="/finance/opex" className="text-primary-ink hover:underline">/finance/opex</Link>.
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
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <header className="px-5 py-3 flex items-center justify-between gap-3"
        style={{ background: 'rgb(var(--fg-rgb) / 0.02)', borderBottom: '1px solid rgb(var(--fg-rgb) / 0.04)' }}>
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
    mutationFn: () => deleteWithUndo(`/opex/lines/${line!.id}`, { trashType: 'opex_line', id: line!.id, onRestored: () => onSaved() }),
    onSuccess: () => onSaved(),
  })

  const confirm = useConfirm()
  const bounds = dateBounds()
  const [tried, setTried] = useState(false)
  const errs: Record<string, string> = {
    'ol-category': categoryId ? '' : 'Pick a category.',
    'ol-name': name.trim() ? '' : 'Give the line a name.',
    'ol-amount': amountCents > 0 ? '' : 'Enter an amount above zero.',
    'ol-due': nextDueDate && (nextDueDate < bounds.min || nextDueDate > bounds.max) ? `Pick a date between ${bounds.min} and ${bounds.max}.` : '',
  }
  const submit = useSubmitOnce(save.isPending || del.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    save.mutate()
    return true
  })
  const dirty = !save.isPending && (name !== (line?.name ?? '') || vendor !== (line?.vendor ?? '') || amountCents !== (line?.amountCents ?? 0))

  return (
    <ModalShell title={isEdit ? 'Edit OpEx line' : 'Add OpEx line'} onClose={onClose} dirty={dirty}>
      <form id="ol-form" onSubmit={submit} className="space-y-3" noValidate>
          <div>
          <label htmlFor="ol-category" className="text-xs text-white/55">Category *</label>
          <div className="flex gap-2 mt-1">
            <Select id="ol-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={fieldCls + ' flex-1'}>
              <option value="">— pick —</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.name}</option>)}
            </Select>
            <button type="button" onClick={() => setCreatingCategory(!creatingCategory)}
              className="rounded-lg border border-white/10 px-3 text-xs text-white/55 hover:text-white">+ New</button>
          </div>
          {tried && errs['ol-category'] && <p role="alert" className="text-[11px] mt-1 font-bold" style={{ color: 'var(--erp-danger)' }}>{errs['ol-category']}</p>}
          {creatingCategory && (
            <div className="rounded-lg p-3 mt-2" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div className="grid grid-cols-[60px_1fr] gap-2">
                <input value={newCategoryEmoji} onChange={(e) => setNewCategoryEmoji(e.target.value)} placeholder="🏢" aria-label="Emoji" className={fieldCls + ' text-center text-xl'} />
                <input value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (newCategoryName.trim()) createCat.mutate() } }}
                  aria-label="New category name" placeholder="Category name (e.g. Rent, Utilities)" className={fieldCls} autoFocus />
              </div>
              {createCat.error && (
                <p className="text-xs text-s-red mt-2">Could not create: {(createCat.error as Error).message}</p>
              )}
              <div className="flex justify-between gap-2 mt-2">
                <button type="button" onClick={() => { setCreatingCategory(false); setNewCategoryName(''); setNewCategoryEmoji('') }}
                  className="text-xs text-white/55 hover:text-white">Cancel</button>
                <button type="button" onClick={() => createCat.mutate()} disabled={!newCategoryName.trim() || createCat.isPending}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on disabled:opacity-50">
                  {createCat.isPending ? 'Creating…' : '+ Create category'}
                </button>
              </div>
            </div>
          )}
        </div>
        <div>
          <label htmlFor="ol-name" className="text-xs text-white/55">Line name *</label>
          <input id="ol-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="42C kitchen rent — Phase 1" className={fieldCls + ' mt-1'} />
          {tried && errs['ol-name'] && <p role="alert" className="text-[11px] mt-1 font-bold" style={{ color: 'var(--erp-danger)' }}>{errs['ol-name']}</p>}
        </div>
        <div>
          <label htmlFor="ol-vendor" className="text-xs text-white/55">Vendor</label>
          <input id="ol-vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Landlord" className={fieldCls + ' mt-1'} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="ol-amount" className="text-xs text-white/55">Amount (PKR) *</label>
            <MoneyInput id="ol-amount" value={amountCents} onChange={setAmount} className={fieldCls + ' mt-1'} />
            {tried && errs['ol-amount'] && <p role="alert" className="text-[11px] mt-1 font-bold" style={{ color: 'var(--erp-danger)' }}>{errs['ol-amount']}</p>}
          </div>
          <div>
            <label htmlFor="ol-cadence" className="text-xs text-white/55">Cadence</label>
            <Select id="ol-cadence" value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} className={fieldCls + ' mt-1'}>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
              <option value="per_use">Per use</option>
            </Select>
          </div>
        </div>
        <div>
          <label htmlFor="ol-due" className="text-xs text-white/55">Next due</label>
          <input id="ol-due" type="date" min={bounds.min} max={bounds.max} value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} className={fieldCls + ' mt-1'} />
        </div>
      </form>
      {save.error && <ErrorBanner error={save.error} />}
      {del.error && <ErrorBanner error={del.error} />}
      <ModalFooter onCancel={onClose}>
        {isEdit && (
          <button type="button" onClick={async () => { if (await confirm({ title: `Delete ${name || 'this line'}?`, body: 'The OpEx line is removed from this project.', confirmLabel: 'Delete', danger: true })) del.mutate() }}
            disabled={del.isPending}
            className="rounded-xl border border-red-500/20 text-s-red/70 px-4 py-2.5 text-xs hover:text-s-red mr-auto disabled:opacity-50">
            {del.isPending ? 'Deleting…' : 'Delete'}
          </button>
        )}
        <button type="submit" form="ol-form" disabled={save.isPending}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
          {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Add line'}
        </button>
      </ModalFooter>
    </ModalShell>
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
  const confirm = useConfirm()
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
  async function remove(i: number) {
    const target = scopes[i]
    if (!target) return
    if (usedKeys.has(target.key)) {
      const ok = await confirm({ title: `Remove "${target.label || 'this section'}"?`, body: 'It has lines in it. They move to "Unsorted"; drag them to other sections later.', confirmLabel: 'Remove section', danger: true })
      if (!ok) return
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

  const submit = useSubmitOnce(save.isPending)(() => { save.mutate(); return true })
  const dirty = !save.isPending && JSON.stringify(scopes) !== JSON.stringify(currentScopes.map((x) => ({ ...x })))
  return (
    <ModalShell title="Customize sections" onClose={onClose} wide dirty={dirty}>
      <p className="text-xs text-white/45 -mt-1">Rename, reorder, or define your own. Lines under a removed section move to &ldquo;Unsorted&rdquo;.</p>
      <form id="scopes-form" onSubmit={submit} className="space-y-2">
          {scopes.map((s, i) => {
          const used = usedKeys.has(s.key)
          return (
            <div key={i} className="rounded-lg p-3 grid grid-cols-[24px_60px_1fr_2fr_auto_auto] gap-2 items-center"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <span className="text-xs font-mono text-white/35">{i + 1}</span>
              <input value={s.emoji ?? ''} onChange={(e) => patch(i, { emoji: e.target.value })}
                placeholder="📦" aria-label={`Section ${i + 1} emoji`} className={fieldCls + ' text-center text-lg'} />
              <input value={s.label} onChange={(e) => patch(i, { label: e.target.value })}
                aria-label={`Section ${i + 1} label`} placeholder="Label (e.g. Back of House)" className={fieldCls + ' font-bold'} />
              <input value={s.hint ?? ''} onChange={(e) => patch(i, { hint: e.target.value })}
                aria-label={`Section ${i + 1} hint`} placeholder="Hint (e.g. Kitchen equipment, walk-in, exhaust)" className={fieldCls + ' text-xs'} />
              <div className="flex items-center">
                <button type="button" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0} className="text-white/30 hover:text-white px-1 disabled:opacity-20">↑</button>
                <button type="button" aria-label="Move down" onClick={() => move(i, 1)}  disabled={i === scopes.length - 1} className="text-white/30 hover:text-white px-1 disabled:opacity-20">↓</button>
              </div>
              <button type="button" aria-label={`Remove section ${i + 1}`} onClick={() => void remove(i)} className="text-white/30 hover:text-s-red px-1"
                title={used ? 'In use — confirm to remove' : 'Remove section'}>
                {used ? '⚠' : '✕'}
              </button>
            </div>
          )
        })}

        <div className="flex items-center gap-2 pt-2">
          <button type="button" onClick={addBlank}
            className="text-xs font-bold rounded-lg px-3 py-1.5 bg-primary text-primary-on hover:opacity-90">
            + Add section
          </button>
          <button type="button" onClick={reset}
            className="text-xs text-white/55 hover:text-white">
            Reset to default
          </button>
        </div>

      </form>
      {save.error && <ErrorBanner error={save.error} />}
      <ModalFooter onCancel={onClose}>
        <button type="submit" form="scopes-form" disabled={save.isPending || scopes.length === 0} className={primaryBtn}>
          {save.isPending ? 'Saving…' : 'Save sections'}
        </button>
      </ModalFooter>
    </ModalShell>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl p-3"
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-white/35">{label}</p>
      <p className="text-sm font-black mt-1" style={{ color: accent }}>{value}</p>
    </div>
  )
}

function LineRow({ line, flags, onEdit }: { line: Line; flags: string[]; onEdit: () => void }) {
  const status = STATUS_META[line.status]
  const totalDue = line.negotiatedCents ?? line.unitCostCents * line.quantity
  const paidPct = totalDue > 0 ? Math.min(100, (line.paidCents / totalDue) * 100) : 0
  const assets = (line.ledger?.assets ?? []).filter((a) => a.status !== 'voided')
  const awaiting = !!(line.capitalisation?.pendingEventId ?? line.ledger?.capitalisation.pendingEventId)
  const treat = line.treatment && line.treatment !== 'capital' ? TREATMENT_LABEL[line.treatment] : null

  return (
    <div className="px-4 sm:px-5 py-3 hover:bg-white/[0.015] transition-colors">
      <button onClick={onEdit} className="w-full text-left" aria-label={`Open ${line.item}`}>
        <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 gap-y-2 items-center">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-bold text-white/90 break-words">{line.item}</p>
              {line.priority === 'must_have' ? null : (
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">{line.priority.replace('_', ' ')}</span>
              )}
              {line.quotes.length > 0 && (
                <span className="text-[10px] text-white/40">{line.quotes.length} quote{line.quotes.length === 1 ? '' : 's'}</span>
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

          <div className="w-24 hidden sm:block">
            <div className="h-1 rounded-full bg-white/5 overflow-hidden">
              <div className="h-full bg-accent" style={{ width: `${paidPct}%` }} />
            </div>
            <p className="text-[10px] text-white/40 mt-0.5">{Math.round(paidPct)}% paid</p>
          </div>

          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full justify-self-start sm:justify-self-auto"
            style={{ color: status.fg, background: `color-mix(in srgb, ${status.fg} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${status.fg} 25%, transparent)` }}>
            {status.label}
          </span>

          <span className="text-white/30 text-xs hidden sm:inline">›</span>
        </div>
      </button>

      {(assets.length > 0 || awaiting || treat || flags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {treat && <span className="s-badge-purple">{treat}</span>}
          {awaiting && <Link href={`${FA_BASE}/requests`} className="s-badge-amber">Awaiting capitalisation</Link>}
          {flags.includes('overdue_delivery') && <span className="s-badge-red">Advance overdue</span>}
          {flags.includes('delivered_uncapitalised') && !awaiting && <span className="s-badge-amber">Delivered, not capitalised</span>}
          {assets.map((a) => (
            <Link key={a.id} href={`${FA_BASE}/${a.id}`} className="s-badge-green">On the register{a.assetTag ? `: ${a.assetTag}` : ''}</Link>
          ))}
        </div>
      )}
    </div>
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

  const bounds = dateBounds()
  const [tried, setTried] = useState(false)
  const errs: Record<string, string> = {
    'np-name': name.trim() ? '' : 'Give the project a name.',
    'np-open': targetOpeningDate && (targetOpeningDate < bounds.min || targetOpeningDate > bounds.max) ? `Pick a date between ${bounds.min} and ${bounds.max}.` : '',
  }
  const submit = useSubmitOnce(save.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    save.mutate()
    return true
  })
  const shown = (k: string) => (tried ? errs[k] : '')
  return <ModalShell title="New CapEx project" onClose={onClose} dirty={!save.isPending && (!!name.trim() || !!address.trim() || budgetEnvelopeCents > 0)}>
    <form id="np-form" onSubmit={submit} className="space-y-4" noValidate>
    <Field label="Project name *" error={shown('np-name')}>
      <input id="np-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="42C Kitchen — Phase 1 build" className={fieldCls} autoFocus />
    </Field>
    <Field label="Project type">
      <Select value={projectType} onChange={(e) => setProjectType(e.target.value as typeof projectType)} className={fieldCls}>
        <option value="kitchen_buildout">Kitchen build-out (new from shell)</option>
        <option value="refurb">Refurb / refresh of existing space</option>
        <option value="expansion">Expansion / second site</option>
        <option value="new_brand">New brand launch</option>
        <option value="equipment_only">Equipment refresh only</option>
      </Select>
    </Field>
    <Field label="Address (optional)">
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="MM Alam Road, Lahore" className={fieldCls} />
    </Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Floor area (sqft)">
        <NumberField decimals={2} min={0} value={floorAreaSqft === '' ? null : floorAreaSqft} onValueChange={(n) => setFloorAreaSqft(n == null ? '' : n)} className={fieldCls} />
      </Field>
      <Field label="Target opening" error={shown('np-open')}>
        <input id="np-open" type="date" min={bounds.min} max={bounds.max} value={targetOpeningDate} onChange={(e) => setTargetOpeningDate(e.target.value)} className={fieldCls} />
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
      style={{ background: 'rgb(var(--erp-primary-rgb) / 0.05)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.20)' }}>
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
              className="text-[10px] font-bold text-primary-ink hover:underline">
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
                aria-label={`Partner ${i + 1} name`} placeholder={i === 0 ? 'e.g. Viva' : 'e.g. Garibsons'}
                className={fieldCls + ' flex-1'} />
              <div className="relative w-24">
                <NumberField decimals={2} min={0} max={100} value={p.pct} aria-label={`Partner ${i + 1} share (%)`}
                  onValueChange={(n) => {
                    const next = [...jvPartners]
                    next[i] = { ...next[i]!, pct: n ?? 0 }
                    setJvPartners(next)
                  }}
                  className={fieldCls + ' pr-7'} />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-white/40">%</span>
              </div>
              {jvPartners.length > 2 && (
                <button type="button"
                  onClick={() => setJvPartners(jvPartners.filter((_, j) => j !== i))}
                  className="text-s-red hover:bg-red-400/10 rounded-md px-2 text-sm">×</button>
              )}
            </div>
          ))}
          <p className={`text-[11px] font-mono ${splitOff ? 'text-s-amber' : 'text-white/40'}`}>
            Total: {splitSum}% {splitOff && '(should be 100)'}
          </p>
        </div>
      )}
    </div>

    </form>
    {save.error && <ErrorBanner error={save.error} />}
    <ModalFooter onCancel={onClose}>
      <button type="submit" form="np-form" disabled={save.isPending} className={primaryBtn}>
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
    mutationFn: () => deleteWithUndo(`/finance/capex/${project.id}`, { trashType: 'capex_project', id: project.id, onRestored: () => onSaved() }),
    onSuccess: () => onSaved(),
  })

  const confirm = useConfirm()
  const bounds = dateBounds()
  const [tried, setTried] = useState(false)
  const errs: Record<string, string> = {
    'ep-name': name.trim() ? '' : 'The project needs a name.',
    'ep-open': targetOpeningDate && (targetOpeningDate < bounds.min || targetOpeningDate > bounds.max) ? `Pick a date between ${bounds.min} and ${bounds.max}.` : '',
  }
  const submit = useSubmitOnce(save.isPending || del.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    save.mutate()
    return true
  })
  const shown = (k: string) => (tried ? errs[k] : '')
  const dirty = !save.isPending && (name !== project.name || phase !== project.phase || budgetEnvelopeCents !== project.budgetEnvelopeCents
    || contingencyPct !== project.contingencyPct || notes !== (project.notes ?? '') || address !== (project.address ?? ''))
  return <ModalShell title="Edit project" onClose={onClose} wide dirty={dirty}>
    <form id="ep-form" onSubmit={submit} className="space-y-4" noValidate>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Name *" error={shown('ep-name')}><input id="ep-name" value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} /></Field>
      <Field label="Phase">
        <Select value={phase} onChange={(e) => setPhase(e.target.value as Phase)} className={fieldCls}>
          {Object.entries(PHASE_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </Select>
      </Field>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Budget envelope (PKR)">
        <MoneyInput value={budgetEnvelopeCents} onChange={setBudgetEnvelopeCents} className={fieldCls} />
      </Field>
      <Field label="Contingency (%)">
        {/* Shown as a percent (0 to 50); the project stores the fraction (0 to 0.5), so it is converted both ways. */}
        <NumberField decimals={2} min={0} max={50}
          value={Number((contingencyPct * 100).toFixed(2))}
          onValueChange={(n) => setContingencyPct(n == null ? 0 : Number((n / 100).toFixed(4)))} className={fieldCls} />
        <Hint>{(contingencyPct * 100).toFixed(0)}% — buffer over budgeted lines (0 to 50)</Hint>
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
        <NumberField decimals={2} min={0} value={floorAreaSqft === '' ? null : floorAreaSqft} onValueChange={(n) => setFloorAreaSqft(n == null ? '' : n)} className={fieldCls} />
      </Field>
      <Field label="Target opening" error={shown('ep-open')}>
        <input id="ep-open" type="date" min={bounds.min} max={bounds.max} value={targetOpeningDate} onChange={(e) => setTargetOpeningDate(e.target.value)} className={fieldCls} />
      </Field>
    </div>
    <Field label="Notes">
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={fieldCls} />
    </Field>
    </form>
    {save.error && <ErrorBanner error={save.error} />}
    {del.error && <ErrorBanner error={del.error} />}
    <ModalFooter onCancel={onClose}>
      <button type="button"
        onClick={async () => { if (await confirm({ title: `Delete project "${project.name}"?`, body: 'Its lines, quotes and payments go with it.', confirmLabel: 'Delete project', danger: true })) del.mutate() }}
        disabled={del.isPending}
        className="rounded-xl border border-red-500/20 text-s-red/70 px-4 py-2.5 text-xs hover:text-s-red mr-auto disabled:opacity-50">
        {del.isPending ? 'Deleting…' : 'Delete project'}
      </button>
      <button type="submit" form="ep-form" disabled={save.isPending} className={primaryBtn}>
        {save.isPending ? 'Saving…' : 'Save changes'}
      </button>
    </ModalFooter>
  </ModalShell>
}

function LineModal({ project, projectId, tenantId, scope, line, onClose, onSaved, instalmentFill }: {
  project: Project; projectId: string; tenantId: string | null; scope: string; line?: Line; onClose: () => void; onSaved: () => void; instalmentFill?: Prefill | null
}) {
  const qc = useQueryClient()
  const lookups = useCapexLookups()
  const [item, setItem] = useState(line?.item ?? '')
  const [category, setCategory] = useState(line?.category ?? '')
  const [quantity, setQuantity] = useState<number | null>(line?.quantity ?? 1)
  const qty = quantity ?? 1
  const [unitCostCents, setUnitCostCents] = useState(line?.unitCostCents ?? 0)
  const [vendor, setVendor] = useState(line?.vendor ?? '')
  const [vendorContact, setVendorContact] = useState(line?.vendorContact ?? '')
  const [supplierId, setSupplierId] = useState(line?.supplierId ?? '')
  const [treatment, setTreatment] = useState<string>(line?.treatment ?? '')
  const [inputTaxCents, setInputTaxCents] = useState(line?.inputTaxCents ?? 0)
  const [inputTaxAuthority, setInputTaxAuthority] = useState(line?.inputTaxAuthority ?? '')
  const [whtSection, setWhtSection] = useState(line?.whtSection ?? '')
  const [quotedCents, setQuotedCents] = useState<number | ''>(line?.quotedCents ?? '')
  const [negotiatedCents, setNegotiatedCents] = useState<number | ''>(line?.negotiatedCents ?? '')
  const [status, setStatus] = useState<Status>(line?.status ?? 'not_quoted')
  const [priority, setPriority] = useState<'must_have' | 'nice_to_have' | 'future'>(line?.priority ?? 'must_have')
  const [leadTimeDays, setLeadTimeDays] = useState<number | ''>(line?.leadTimeDays ?? '')
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(line?.expectedDeliveryDate?.slice(0, 10) ?? '')
  const [actualDeliveryDate, setActualDeliveryDate] = useState(line?.actualDeliveryDate?.slice(0, 10) ?? '')
  const [installedDate, setInstalledDate] = useState(line?.installedDate?.slice(0, 10) ?? '')
  const [notes, setNotes] = useState(line?.notes ?? '')

  // On the register (or waiting for the CEO) the line IS capital: what it is,
  // what it costs and when it arrived are fixed (409 LINE_CAPITALISED). Void
  // the asset and prepare it again to change them.
  const onRegister = !!line && ((line.capitalisation?.assetIds.length ?? 0) > 0 || !!line.capitalisation?.pendingEventId
    || (line.ledger?.assets ?? []).some((a) => a.status !== 'voided'))
  // Once an instalment is on the books the treatment can no longer change (409 TREATMENT_LOCKED).
  const treatmentLocked = !!line && Object.values(line.ledger?.payments ?? {}).some((p) => p.status === 'posted')

  const suppliers = project.lookups.suppliers
  const supplier = suppliers.find((x) => x.id === supplierId)
  const authorities = lookups.data?.taxAuthorities ?? Object.keys(AUTHORITY_LABEL)
  const whtSections = lookups.data?.whtSections ?? Object.keys(WHT_SECTION_LABEL)

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        scope, status, priority,
        vendor: vendor || null, vendorContact: vendorContact || null,
        supplierId: supplierId || null,
        treatment: treatment || null,
        whtSection: whtSection || null,
        quotedCents: quotedCents === '' ? null : +quotedCents,
        leadTimeDays: leadTimeDays === '' ? null : +leadTimeDays,
        expectedDeliveryDate: expectedDeliveryDate ? `${expectedDeliveryDate}T00:00:00Z` : null,
        notes: notes || null,
        ...(onRegister ? {} : {
          item, quantity: qty, unitCostCents,
          category: category || null,
          negotiatedCents: negotiatedCents === '' ? null : +negotiatedCents,
          inputTaxCents,
          inputTaxAuthority: inputTaxCents > 0 && inputTaxAuthority ? inputTaxAuthority : null,
          actualDeliveryDate: actualDeliveryDate ? `${actualDeliveryDate}T00:00:00Z` : null,
          installedDate: installedDate ? `${installedDate}T00:00:00Z` : null,
        }),
      }
      if (line) return api.patch(`/finance/capex/lines/${line.id}`, payload)
      return api.post(`/finance/capex/${projectId}/lines`, payload)
    },
    onSuccess: () => onSaved(),
  })

  const del = useMutation({
    mutationFn: () => deleteWithUndo(`/finance/capex/lines/${line!.id}`, { trashType: 'capex_line', id: line!.id, onRestored: () => onSaved() }),
    onSuccess: () => onSaved(),
  })

  const confirm = useConfirm()
  const bounds = dateBounds()
  const [tried, setTried] = useState(false)
  const dateBad = (v: string) => (v && (v < bounds.min || v > bounds.max) ? `Pick a date between ${bounds.min} and ${bounds.max}.` : '')
  const errs: Record<string, string> = {
    'cl-item': item.trim() ? '' : 'Name the item.',
    'cl-qty': quantity != null && quantity >= 1 ? '' : 'Quantity must be 1 or more.',
    'cl-auth': inputTaxCents > 0 && !inputTaxAuthority && !onRegister ? 'Say which authority charged the sales tax.' : '',
    'cl-exp': dateBad(expectedDeliveryDate),
    'cl-del': dateBad(actualDeliveryDate),
    'cl-inst': dateBad(installedDate),
  }
  const shown = (k: string) => (tried ? errs[k] : '')
  const submit = useSubmitOnce(save.isPending || del.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    save.mutate()
    return true
  })
  const dirty = !save.isPending && (item !== (line?.item ?? '') || qty !== (line?.quantity ?? 1) || unitCostCents !== (line?.unitCostCents ?? 0) || notes !== (line?.notes ?? '') || vendor !== (line?.vendor ?? ''))
  return <ModalShell title={`${line ? 'Edit' : 'Add'} ${scope} line`} onClose={onClose} wide dirty={dirty}>
    <form id="cl-form" onSubmit={submit} className="space-y-4" noValidate>
    {onRegister && (
      <div className="rounded-xl px-4 py-3 text-xs text-white/70" style={{ background: 'rgb(var(--erp-accent-rgb) / 0.08)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.25)' }}>
        This item is on the fixed-asset register (or sent for approval), so its name, cost, quantity, tax and dates are fixed.
        Void the asset on the register and prepare it again to change them.
      </div>
    )}
    <Field label="Item *" error={shown('cl-item')}>
      <input id="cl-item" value={item} onChange={(e) => setItem(e.target.value)} disabled={onRegister}
        placeholder="Rational SCC 6-2/1 combi oven · 5-tier walk-in shelving · Emergency lighting set" className={fieldCls + ' disabled:opacity-60'} autoFocus />
    </Field>

    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Field label="Category">
        <input value={category} onChange={(e) => setCategory(e.target.value)} disabled={onRegister} placeholder="Cooking · Refrigeration" className={fieldCls + ' disabled:opacity-60'} />
      </Field>
      <Field label="Quantity" error={shown('cl-qty')}>
        <NumberField id="cl-qty" min={1} value={quantity} onValueChange={setQuantity} disabled={onRegister} className={fieldCls + ' disabled:opacity-60'} />
      </Field>
      <Field label="Priority">
        <Select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)} className={fieldCls}>
          <option value="must_have">Must have</option>
          <option value="nice_to_have">Nice to have</option>
          <option value="future">Future / phase 2</option>
        </Select>
      </Field>
    </div>

    <Section heading="Money">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Budgeted unit cost (PKR)">
          <MoneyInput value={unitCostCents} onChange={setUnitCostCents} disabled={onRegister} className={fieldCls + ' disabled:opacity-60'} />
          <Hint>{PKR(unitCostCents * qty)} total for qty {qty}</Hint>
        </Field>
        <Field label="Quoted (PKR)">
          <MoneyInput value={quotedCents === '' ? 0 : quotedCents} onChange={(c) => setQuotedCents(c)} className={fieldCls} placeholder="Initial quote" />
        </Field>
        <Field label="Negotiated (PKR)">
          <MoneyInput value={negotiatedCents === '' ? 0 : negotiatedCents} onChange={(c) => setNegotiatedCents(c)} disabled={onRegister} className={fieldCls + ' disabled:opacity-60'} placeholder="What you committed" />
        </Field>
      </div>
    </Section>

    <Section heading="Supplier">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Supplier on file">
          <Select value={supplierId} onChange={(e) => {
            const id = e.target.value
            setSupplierId(id)
            const picked = suppliers.find((x) => x.id === id)
            if (picked && !vendor) setVendor(picked.name)
            if (picked?.defaultTaxAuthority && !inputTaxAuthority) setInputTaxAuthority(picked.defaultTaxAuthority)
          }} className={fieldCls}>
            <option value="">Not on file</option>
            {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <Hint>Pick a supplier so income tax can be withheld at their filer rate.</Hint>
        </Field>
        <Field label="Vendor name"><input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Sialkot Steel Works" className={fieldCls} /></Field>
        <Field label="Contact (name · phone)"><input value={vendorContact} onChange={(e) => setVendorContact(e.target.value)} placeholder="Bilal · +92 300 1234567" className={fieldCls} /></Field>
      </div>
    </Section>

    <Section heading="How it is booked">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Book as">
          <Select value={treatment} onChange={(e) => setTreatment(e.target.value as Treatment | '')} disabled={treatmentLocked} className={fieldCls + ' disabled:opacity-60'}>
            {TREATMENT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </Select>
          <Hint>{treatmentLocked ? 'An instalment is already on the books as it is, so this can no longer change.' : TREATMENT_OPTIONS.find((o) => o.key === treatment)?.hint}</Hint>
        </Field>
        <Field label="Income tax withholding">
          <Select value={whtSection} onChange={(e) => setWhtSection(e.target.value)} className={fieldCls}>
            <option value="">Automatic (the supplier&rsquo;s default)</option>
            {whtSections.map((x) => <option key={x} value={x}>{WHT_SECTION_LABEL[x] ?? x}</option>)}
          </Select>
        </Field>
        <Field label="Sales tax in the price (PKR)">
          <MoneyInput value={inputTaxCents} onChange={setInputTaxCents} disabled={onRegister} className={fieldCls + ' disabled:opacity-60'} />
        </Field>
        <Field label="Sales tax charged by" error={shown('cl-auth')}>
          <Select id="cl-auth" value={inputTaxAuthority} onChange={(e) => setInputTaxAuthority(e.target.value)} disabled={onRegister || inputTaxCents === 0} className={fieldCls + ' disabled:opacity-60'}>
            <option value="">{inputTaxCents === 0 ? 'Not needed' : 'Pick the authority'}</option>
            {authorities.map((x) => <option key={x} value={x}>{AUTHORITY_LABEL[x] ?? x.toUpperCase()}</option>)}
          </Select>
          {inputTaxCents > 0 && !inputTaxAuthority && <Hint>Say which authority charged it (required to claim it).</Hint>}
        </Field>
      </div>
      <ExemptionLine supplier={supplier} />
    </Section>

    <Section heading="Status & schedule">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Status)} className={fieldCls}>
            {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </Select>
        </Field>
        <Field label="Lead time (days)">
          <NumberField min={0} value={leadTimeDays === '' ? null : leadTimeDays} onValueChange={(n) => setLeadTimeDays(n == null ? '' : n)} className={fieldCls} />
        </Field>
        <Field label="Expected delivery" error={shown('cl-exp')}>
          <input id="cl-exp" type="date" min={bounds.min} max={bounds.max} value={expectedDeliveryDate} onChange={(e) => setExpectedDeliveryDate(e.target.value)} className={fieldCls} />
        </Field>
        <Field label="Delivered on" error={shown('cl-del')}>
          <input id="cl-del" type="date" min={bounds.min} max={bounds.max} value={actualDeliveryDate} onChange={(e) => setActualDeliveryDate(e.target.value)} disabled={onRegister} className={fieldCls + ' disabled:opacity-60'} />
        </Field>
        <Field label="Installed on" error={shown('cl-inst')}>
          <input id="cl-inst" type="date" min={bounds.min} max={bounds.max} value={installedDate} onChange={(e) => setInstalledDate(e.target.value)} disabled={onRegister} className={fieldCls + ' disabled:opacity-60'} />
          <Hint>Depreciation starts from the install date, else the delivery date.</Hint>
        </Field>
      </div>
    </Section>

    <Field label="Notes">
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
        placeholder="3-year warranty, gas connection required, lead time confirmed by Bilal on call." className={fieldCls} />
    </Field>

    </form>

    {/* Quote comparison shopping — only shown when editing an existing line (outside the line's form: it has its own forms) */}
    {line && <QuotePanel line={line} onChange={() => qc.invalidateQueries({ queryKey: ['capex-projects'] })} />}

    {/* Payment schedule */}
    {line && <PaymentPanel project={project} line={line} tenantId={tenantId} fill={instalmentFill} onChange={() => qc.invalidateQueries({ queryKey: ['capex-projects'] })} />}

    {save.error && <ErrorBanner error={save.error} />}
    {del.error && <ErrorBanner error={del.error} />}

    <ModalFooter onCancel={onClose}>
      {line && (
        <button type="button" onClick={async () => { if (await confirm({ title: `Delete ${item.trim() || 'this line'}?`, body: 'Its quotes and instalments are removed with it.', confirmLabel: 'Delete line', danger: true })) del.mutate() }}
          className="rounded-xl border border-red-500/20 text-s-red/70 px-4 py-2.5 text-xs hover:text-s-red mr-auto">
          Delete line
        </button>
      )}
      <button type="submit" form="cl-form" disabled={save.isPending} className={primaryBtn}>
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
  const [quoteProblem, setQuoteProblem] = useState<string | null>(null)
  const submitQuote = useSubmitOnce(add.isPending)(() => {
    if (!vendor.trim()) { setQuoteProblem('Enter the vendor name.'); focusField('q-vendor'); return false }
    if (totalCents <= 0) { setQuoteProblem('Enter the quote total.'); focusField('q-total'); return false }
    setQuoteProblem(null)
    add.mutate()
    return true
  })
  const setWinner = useMutation({
    mutationFn: (qid: string) => api.patch(`/finance/capex/quotes/${qid}/winner`, {}),
    onSuccess: () => onChange(),
  })
  const removeQuote = useMutation({
    mutationFn: (qid: string) => deleteWithUndo(`/finance/capex/quotes/${qid}`, { trashType: 'capex_quote', id: qid, onRestored: () => onChange() }),
    onSuccess: () => onChange(),
  })

  return <Section heading={`Quotes · ${line.quotes.length}`}>
    <div className="space-y-1.5">
      {line.quotes.map((q) => (
        <div key={q.id} className="rounded-lg p-3 grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 items-center"
          style={q.isWinner
            ? { background: 'rgb(var(--erp-accent-rgb) / 0.12)', border: '1px solid var(--erp-accent)' }
            : { background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <div>
            <p className="text-sm font-bold text-white/85">{q.vendor}</p>
            {q.contactName && <p className="text-[11px] text-white/45">{q.contactName}</p>}
          </div>
          <span className="text-sm font-mono text-white/85">{PKR(q.totalCents)}</span>
          <span className="text-xs text-white/45">{q.leadTimeDays ? `${q.leadTimeDays}d` : '—'}</span>
          {q.isWinner ? (
            <span className="text-[10px] font-black uppercase tracking-wider text-success">★ Winner</span>
          ) : (
            <button onClick={() => setWinner.mutate(q.id)} className="text-[11px] text-white/55 hover:text-white">Pick</button>
          )}
          <button onClick={() => removeQuote.mutate(q.id)} className="text-white/30 hover:text-s-red">✕</button>
        </div>
      ))}
    </div>

    {adding ? (
      <form onSubmit={submitQuote} noValidate className="rounded-xl p-3 mt-2"
        style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
        <div className="grid grid-cols-2 gap-2">
          <input id="q-vendor" aria-label="Vendor name" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor name" className={fieldCls} autoFocus />
          <MoneyInput id="q-total" ariaLabel="Quote total (PKR)" value={totalCents} onChange={setTotalCents} placeholder="Total (PKR)" className={fieldCls} />
        </div>
        <div className="grid grid-cols-3 gap-2 mt-2">
          <input aria-label="Contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name" className={fieldCls} />
          <NumberField aria-label="Lead days" min={0} value={leadTimeDays === '' ? null : leadTimeDays} onValueChange={(n) => setLeadTimeDays(n == null ? '' : n)} placeholder="Lead days" className={fieldCls} />
          <input aria-label="Quote file URL" value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} placeholder="Quote file URL (optional)" className={fieldCls} />
        </div>
        {quoteProblem && <p role="alert" className="text-[11px] font-bold mt-2" style={{ color: 'var(--erp-danger)' }}>{quoteProblem}</p>}
        {add.error && <ErrorBanner error={add.error} />}
        <div className="flex gap-2 mt-2 justify-end">
          <button type="button" onClick={() => setAdding(false)} className="text-xs text-white/55 hover:text-white">Cancel</button>
          <button type="submit" disabled={add.isPending}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on disabled:opacity-50">{add.isPending ? 'Saving…' : '+ Save quote'}</button>
        </div>
      </form>
    ) : (
      <button onClick={() => setAdding(true)}
        className="w-full rounded-lg border-2 border-dashed border-white/10 px-3 py-2 text-xs text-white/55 hover:text-white hover:border-white/30 mt-2">
        + Add quote (compare vendors)
      </button>
    )}
  </Section>
}

// Instalments are paid from one of the PROJECT's company's bank accounts
// (backend lib/bankAccounts.ts moneyAccountCode): picked when scheduling or
// when marking paid; with one bank it is used automatically, with several a
// pick is required (BANK_ACCOUNT_REQUIRED). Marking one paid posts it to the
// books at once: income tax is withheld at the supplier's filer rate (gross,
// withheld and net are shown), a rent advance must say which months it covers,
// and a refundable deposit can be returned or partly kept.
function PaymentPanel({ project, line, tenantId, onChange, fill }: { project: Project; line: Line; tenantId: string | null; onChange: () => void; fill?: Prefill | null }) {
  const caps = useFaCapabilities()
  const [adding, setAdding] = useState(!!fill)
  const fillLabel = pStr(fill ?? null, 'label')
  const [label, setLabel] = useState<'deposit' | 'midpoint' | 'balance' | 'extra'>(
    fillLabel === 'deposit' || fillLabel === 'midpoint' || fillLabel === 'balance' || fillLabel === 'extra' ? fillLabel : 'deposit')
  const [amountCents, setAmountCents] = useState(pNum(fill ?? null, 'amountCents') ?? 0)
  const [dueDate, setDueDate] = useState(pStr(fill ?? null, 'dueDate')?.slice(0, 10) ?? '')
  const [bankAccountId, setBankAccountId] = useState('')
  const [paying, setPaying] = useState<Payment | null>(null)
  const [returning, setReturning] = useState<Payment | null>(null)
  const [reclassing, setReclassing] = useState<Payment | null>(null)
  const { data: banks = [] } = useBankAccounts()
  const bankName = (id: string | null) => (id ? banks.find((b) => b.id === id)?.name ?? null : null)

  const add = useMutation({
    mutationFn: () => api.post(`/finance/capex/lines/${line.id}/payments`, {
      label, amountCents, ...(dueDate && { dueDate: `${dueDate}T00:00:00Z` }),
      ...(bankAccountId && { bankAccountId }),
    }),
    onSuccess: () => { setAdding(false); setAmountCents(0); setDueDate(''); setBankAccountId(''); onChange() },
  })
  const bounds = dateBounds()
  const [schedProblem, setSchedProblem] = useState<string | null>(null)
  const submitSchedule = useSubmitOnce(add.isPending)(() => {
    if (amountCents <= 0) { setSchedProblem('Enter the instalment amount.'); focusField('sch-amount'); return false }
    if (dueDate && (dueDate < bounds.min || dueDate > bounds.max)) { setSchedProblem(`Pick a due date between ${bounds.min} and ${bounds.max}.`); focusField('sch-due'); return false }
    setSchedProblem(null)
    add.mutate()
    return true
  })
  const remove = useMutation({
    mutationFn: (pid: string) => deleteWithUndo(`/finance/capex/payments/${pid}`, { trashType: 'capex_payment', id: pid, restorable: false }),
    onSuccess: () => onChange(),
  })

  return <Section heading={`Payment schedule · ${line.payments.length}`}>
    <div className="space-y-1.5">
      {line.payments.map((p) => {
        const posted = line.ledger?.payments[p.id]
        const isDeposit = !!p.paidAt && posted?.status === 'posted' && (posted.accountCode === '1360' || line.treatment === 'deposit')
        const isLegacyPrepaid = !!p.paidAt && posted?.status === 'posted' && posted.accountCode === '1310' && p.releasedCents === 0 && line.treatment !== 'deposit'
        const gross = p.paidAmountCents ?? p.amountCents
        return (
          <div key={p.id} className="rounded-lg p-3"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-white/65 w-20">{p.label}</span>
              <span className="text-sm font-mono text-white/85">{PKR(p.amountCents)}</span>
              <span className="text-xs text-white/45 min-w-0 flex-1 basis-40">
                {p.dueDate ? `due ${new Date(p.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'no due date'}
                {p.paidAt && <span className="text-success ml-2">· paid {new Date(p.paidAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
                {bankName(p.bankAccountId) && <span className="ml-2">· {p.paidAt ? 'from' : 'to pay from'} {bankName(p.bankAccountId)}</span>}
              </span>
              {p.paidAt ? (
                p.source === 'cash'
                  ? <span className="s-badge-purple" title="Paid from petty cash or a cash request. Correct it there.">Paid in cash</span>
                  : posted?.status === 'posted'
                    ? <span className="text-[10px] font-black text-success" title={`Booked to ${posted.accountCode ?? ''}`}>PAID · ON THE BOOKS</span>
                    : <span className="text-[10px] font-black text-s-amber" title="Paid before capex posted to the books. An admin can post it.">PAID · NOT POSTED</span>
              ) : (
                <button onClick={() => setPaying(paying?.id === p.id ? null : p)}
                  className="rounded-lg bg-primary px-2.5 py-1 text-[10px] font-bold text-primary-on">Mark paid</button>
              )}
              <button onClick={() => remove.mutate(p.id)} aria-label="Delete instalment" className="text-white/30 hover:text-s-red">&times;</button>
            </div>

            {p.paidAt && (p.whtCents > 0 || p.coversMonths || isDeposit || p.whtOverrideReason) && (
              <div className="mt-2 text-[11px] text-white/55 space-y-0.5">
                {p.whtCents > 0 && <p>Income tax withheld {PKR(p.whtCents)} · net to the bank {PKR(gross - p.whtCents)}{p.whtOverrideReason ? ` · your own figure: ${p.whtOverrideReason}` : ''}</p>}
                {p.coversMonths && p.coversFrom && <p>Covers {p.coversMonths} month{p.coversMonths === 1 ? '' : 's'} from {p.coversFrom} · {PKR(p.releasedCents)} released to rent so far</p>}
                {isDeposit && (
                  <p>
                    Refundable deposit
                    {p.depositReturnedCents > 0 && ` · ${PKR(p.depositReturnedCents)} returned`}
                    {p.depositReturnedCents > 0 && (p.depositReturnMethod || p.depositReturnRef) && ` (${[p.depositReturnMethod ? receiptMethodLabel(p.depositReturnMethod) : null, p.depositReturnRef ? `ref ${p.depositReturnRef}` : null].filter(Boolean).join(', ')})`}
                    {p.depositForfeitedCents > 0 && ` · ${PKR(p.depositForfeitedCents)} kept by the landlord`}
                    {p.depositReturnedCents + p.depositForfeitedCents === 0 && ' · still held'}
                  </p>
                )}
              </div>
            )}
            {(isDeposit || (isLegacyPrepaid && caps.canApprove)) && (
              <div className="mt-2 flex flex-wrap gap-3">
                {isDeposit && <button className="text-xs font-bold text-primary-ink hover:underline" onClick={() => setReturning(p)}>Deposit back…</button>}
                {isLegacyPrepaid && caps.canApprove && <button className="text-xs font-bold text-primary-ink hover:underline" onClick={() => setReclassing(p)}>This is a security deposit, not rent…</button>}
              </div>
            )}

            {paying?.id === p.id && (
              <MarkPaidForm project={project} line={line} payment={p} tenantId={tenantId} onClose={() => setPaying(null)} onDone={() => { setPaying(null); onChange() }} />
            )}
          </div>
        )
      })}
    </div>

    {remove.error && <ErrorBanner error={remove.error} />}
    <CapitalisePanel project={project} line={line} onChange={onChange} />

    {adding ? (
      <form onSubmit={submitSchedule} noValidate className="rounded-xl p-3 mt-2"
        style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Select aria-label="Instalment type" value={label} onChange={(e) => setLabel(e.target.value as typeof label)} className={fieldCls}>
            <option value="deposit">Deposit</option>
            <option value="midpoint">Midpoint</option>
            <option value="balance">Balance</option>
            <option value="extra">Extra</option>
          </Select>
          <MoneyInput id="sch-amount" ariaLabel="Instalment amount (PKR)" value={amountCents} onChange={setAmountCents} placeholder="Amount (PKR)" className={fieldCls} />
          <input id="sch-due" type="date" min={bounds.min} max={bounds.max} value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={fieldCls} aria-label="Due date" />
        </div>
        <div className="mt-2">
          <BankAccountSelect tenantId={tenantId} value={bankAccountId} onChange={setBankAccountId}
            id={`capex-sched-bank-${line.id}`} label="To be paid from" className={fieldCls} />
        </div>
        {schedProblem && <p role="alert" className="text-[11px] font-bold mt-2" style={{ color: 'var(--erp-danger)' }}>{schedProblem}</p>}
        {add.error && <ErrorBanner error={add.error} />}
        <div className="flex gap-2 mt-2 justify-end">
          <button type="button" onClick={() => setAdding(false)} className="text-xs text-white/55 hover:text-white">Cancel</button>
          <button type="submit" disabled={add.isPending}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on disabled:opacity-50">{add.isPending ? 'Saving…' : '+ Schedule'}</button>
        </div>
      </form>
    ) : (
      <button onClick={() => setAdding(true)}
        className="w-full rounded-lg border-2 border-dashed border-white/10 px-3 py-2 text-xs text-white/55 hover:text-white hover:border-white/30 mt-2">
        + Schedule payment
      </button>
    )}

    {returning && <DepositReturnModal payment={returning} line={line} project={project} onClose={() => setReturning(null)} onDone={() => { setReturning(null); onChange() }} />}
    {reclassing && <ReclassDepositModal payment={reclassing} line={line} project={project} onClose={() => setReclassing(null)} onDone={() => { setReclassing(null); onChange() }} />}
  </Section>
}

// Mark one instalment paid: from which bank, on which day, how much, what the
// income-tax withholding comes to (gross / withheld / net) and, for a rent
// advance, the months it covers (422 PREPAID_TERM_REQUIRED without them).
function MarkPaidForm({ project, line, payment, tenantId, onClose, onDone }: {
  project: Project; line: Line; payment: Payment; tenantId: string | null; onClose: () => void; onDone: () => void
}) {
  const preview = useWithholdingPreview()
  const [bankId, setBankId] = useState(payment.bankAccountId ?? '')
  const [paidOn, setPaidOn] = useState(new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10))
  const [amount, setAmount] = useState(payment.amountCents)
  const [coversFrom, setCoversFrom] = useState(payment.coversFrom ?? '')
  const [coversMonths, setCoversMonths] = useState(payment.coversMonths ? String(payment.coversMonths) : '')
  const [needsTerm, setNeedsTerm] = useState(false)
  const [override, setOverride] = useState(false)
  const [overrideCents, setOverrideCents] = useState(0)
  const [overrideReason, setOverrideReason] = useState('')

  const supplier = project.lookups.suppliers.find((x) => x.id === line.supplierId)
  const lineTotal = line.negotiatedCents ?? line.unitCostCents * line.quantity
  const taxShare = lineTotal > 0 ? Math.round((line.inputTaxCents * amount) / lineTotal) : 0
  const termExpected = line.treatment === 'prepaid' || (!line.treatment && /\b(rent|lease)\b/i.test(`${line.scope} ${line.category ?? ''} ${line.item}`))
  const termRequired = line.treatment === 'prepaid' || needsTerm
  const wht = preview({ grossCents: amount, inputTaxCents: taxShare, section: line.whtSection, supplier, paidOn, treatment: line.treatment })

  const pay = useMutation({
    mutationFn: () => api.patch(`/finance/capex/payments/${payment.id}`, {
      paidAt: new Date(`${paidOn}T12:00:00+05:00`).toISOString(),
      paidAmountCents: amount,
      ...(bankId && { bankAccountId: bankId }),
      ...((termExpected || needsTerm) && coversFrom && coversMonths ? { coversFrom, coversMonths: Number(coversMonths) } : {}),
      ...(override ? { whtOverrideCents: overrideCents, whtOverrideReason: overrideReason.trim() } : {}),
    }),
    onSuccess: onDone,
    onError: (e) => { if ((e as { code?: string }).code === 'PREPAID_TERM_REQUIRED') setNeedsTerm(true) },
  })

  const termOk = !termRequired || (!!coversFrom && Number(coversMonths) >= 1)
  const overrideOk = !override || (overrideReason.trim().length >= 5 && overrideCents < amount)

  const [problem, setProblem] = useState<string | null>(null)
  const submitPaid = useSubmitOnce(pay.isPending)(() => {
    const bad: [string, string] | null =
      amount <= 0 ? ['mp-amount', 'Enter the amount paid.']
      : !paidOn ? ['mp-paid', 'Pick the day it was paid.']
      : !termOk ? ['mp-months', 'A rent advance needs the month it starts and how many months it covers (1 to 240).']
      : !overrideOk ? ['mp-why', 'Your own withholding figure needs a reason (5 characters or more) and must be below the amount.']
      : null
    if (bad) { setProblem(bad[1]); focusField(bad[0]); return false }
    setProblem(null)
    pay.mutate()
    return true
  })
  return (
    <form onSubmit={submitPaid} noValidate className="mt-3 space-y-3 rounded-lg p-3" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-1">
          <BankAccountSelect tenantId={tenantId} value={bankId} onChange={setBankId} id={`capex-pay-bank-${payment.id}`} label="Paid from" className={fieldCls} />
        </div>
        <Field label="Paid on"><input id="mp-paid" type="date" min="2000-01-01" value={paidOn} max={new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)} onChange={(e) => setPaidOn(e.target.value)} className={fieldCls} /></Field>
        <Field label="Amount (PKR)"><MoneyInput id="mp-amount" value={amount} onChange={setAmount} className={fieldCls} /></Field>
      </div>

      {(termExpected || needsTerm) && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Covers from${termRequired ? ' *' : ''}`}><input type="month" value={coversFrom} onChange={(e) => setCoversFrom(e.target.value)} className={fieldCls} /></Field>
          <Field label={`Covers how many months${termRequired ? ' *' : ''}`}><NumberField id="mp-months" min={1} max={240} value={coversMonths === '' ? null : Number(coversMonths)} onValueChange={(n) => setCoversMonths(n == null ? '' : String(n))} className={fieldCls} /></Field>
          <div className="col-span-2"><Hint>A rent advance is spread over the months it covers, one month at a time.</Hint></div>
        </div>
      )}

      <ExemptionLine supplier={supplier} />
      <WhtPreview result={wht} grossCents={amount} override={override ? overrideCents : null} />
      <label className="flex items-center gap-2 text-xs text-white/65">
        <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} style={{ accentColor: 'var(--erp-accent)' }} />
        Use my own withholding figure (for example, the supplier&rsquo;s certificate is not on file yet)
      </label>
      {override && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Income tax withheld (PKR)"><MoneyInput value={overrideCents} onChange={setOverrideCents} className={fieldCls} /></Field>
          <Field label="Why (at least 5 characters)"><input id="mp-why" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} className={fieldCls} /></Field>
        </div>
      )}

      {problem && <p role="alert" className="text-[11px] font-bold" style={{ color: 'var(--erp-danger)' }}>{problem}</p>}
      {pay.error && <ErrorBanner error={pay.error} />}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onClose} className="text-xs text-white/55 hover:text-white">Cancel</button>
        <button type="submit" disabled={pay.isPending}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on disabled:opacity-50">
          {pay.isPending ? 'Saving…' : `Paid ${PKR(amount)}`}
        </button>
      </div>
    </form>
  )
}

// ─── Shared bits ──────────────────────────────────────────────────────────

function ModalShell({ title, children, onClose, wide, dirty }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean; dirty?: boolean }) {
  return <SharedModal title={title} onClose={onClose} wide={wide} dirty={dirty}>{children}</SharedModal>
}
function ModalFooter({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  return <div className="flex items-center justify-between gap-3 pt-4 mt-4 border-t border-white/[0.05]">
    <button type="button" onClick={onCancel} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
    {children}
  </div>
}
function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return <div className="rounded-xl p-3 space-y-2 mt-2"
    style={{ background: 'rgb(var(--fg-rgb) / 0.015)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
    <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45">{heading}</p>
    {children}
  </div>
}
function Hint({ children }: { children: React.ReactNode }) { return <p className="text-[11px] text-white/35 mt-1">{children}</p> }
function ErrorBanner({ error }: { error: unknown }) {
  return <div className="rounded-xl px-4 py-3 text-sm text-s-red" role="alert" ref={(el) => { if (el && !el.dataset['seen']) { el.dataset['seen'] = '1'; el.scrollIntoView({ block: 'nearest' }) } }} style={{ background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' }}>{errorWords(error)}</div>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
const primaryBtn = "rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
