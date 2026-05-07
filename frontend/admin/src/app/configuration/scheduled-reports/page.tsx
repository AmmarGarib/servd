'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Report {
  id: string
  name: string
  reportType: 'sales_daily' | 'shift_summary' | 'low_stock' | 'food_cost' | 'ap_aging' | 'menu_engineering'
  cron: string
  recipients: string[]
  conceptId: string | null
  isActive: boolean
  lastRunAt: string | null
  lastStatus: string | null
  notes: string | null
}
interface Concept { id: string; name: string }

const TYPES = [
  { value: 'sales_daily', label: 'Daily sales summary' },
  { value: 'shift_summary', label: 'Shift summary (per close)' },
  { value: 'low_stock', label: 'Low stock alert' },
  { value: 'food_cost', label: 'Food cost variance' },
  { value: 'ap_aging', label: 'AP aging' },
  { value: 'menu_engineering', label: 'Menu engineering' },
]

const CRON_PRESETS = [
  { label: 'Every day at 8am', value: '0 8 * * *' },
  { label: 'Every Monday at 9am', value: '0 9 * * 1' },
  { label: 'First of month at 9am', value: '0 9 1 * *' },
  { label: 'Hourly', value: '0 * * * *' },
]

export default function ScheduledReportsPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Report | null>(null)
  const [adding, setAdding] = useState(false)
  const { data = [] } = useQuery<Report[]>({ queryKey: ['scheduled-reports'], queryFn: () => api.get('/setup/scheduled-reports') })
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/setup/scheduled-reports/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-reports'] }) })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">📊 Scheduled reports</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Daily/weekly digests delivered to your inbox automatically. No more "can you pull last week's numbers."
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">+ New schedule</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl space-y-2">
        {data.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="font-bold text-white/85">No scheduled reports</p>
            <p className="text-sm text-white/45 mt-1">Set up the daily P&amp;L digest as a starting point.</p>
          </div>
        )}
        {data.map((r) => {
          const concept = concepts.find((c) => c.id === r.conceptId)
          const typeLabel = TYPES.find((t) => t.value === r.reportType)?.label ?? r.reportType
          return (
            <div key={r.id} className="rounded-2xl p-5"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-black text-white/90">{r.name}</h3>
                    {!r.isActive && <span className="text-[10px] font-bold text-white/30 px-1.5 py-0.5 rounded bg-white/5">PAUSED</span>}
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(0,212,177,0.1)', color: '#00D4B1' }}>{typeLabel}</span>
                    {concept && <span className="text-[10px] text-white/55">{concept.name}</span>}
                  </div>
                  <p className="text-xs text-white/55 mt-1">
                    📅 <code className="font-mono text-white/65">{r.cron}</code>
                    {' · '}
                    📧 {r.recipients.length === 1 ? r.recipients[0] : `${r.recipients.length} recipients`}
                  </p>
                  {r.lastRunAt && <p className="text-[10px] text-white/30 mt-1">Last sent {new Date(r.lastRunAt).toLocaleString()} · {r.lastStatus}</p>}
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button onClick={() => setEditing(r)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                  <button onClick={() => { if (confirm(`Delete "${r.name}"?`)) del.mutate(r.id) }} className="rounded-lg border border-red-500/20 text-red-400/70 px-3 py-1.5 text-xs">Delete</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {(adding || editing) && (
        <Modal report={editing} concepts={concepts}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['scheduled-reports'] }) }} />
      )}
    </div>
  )
}

function Modal({ report, concepts, onClose, onSaved }: { report: Report | null; concepts: Concept[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(report?.name ?? '')
  const [reportType, setReportType] = useState<Report['reportType']>(report?.reportType ?? 'sales_daily')
  const [cron, setCron] = useState(report?.cron ?? '0 8 * * *')
  const [recipientsInput, setRecipientsInput] = useState((report?.recipients ?? []).join(', '))
  const [conceptId, setConceptId] = useState(report?.conceptId ?? '')

  const save = useMutation({
    mutationFn: () => {
      const recipients = recipientsInput.split(',').map((s) => s.trim()).filter(Boolean)
      const create = { name, reportType, cron, recipients, conceptId: conceptId || null }
      const update = { name, cron, recipients }
      if (report) return api.patch(`/setup/scheduled-reports/${report.id}`, update)
      return api.post('/setup/scheduled-reports', create)
    },
    onSuccess: () => onSaved(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl overflow-hidden" style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{report ? 'Edit schedule' : 'New scheduled report'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily P&L" className={fieldCls} autoFocus /></Field>
          {!report && (
            <>
              <Field label="Report type">
                <select value={reportType} onChange={(e) => setReportType(e.target.value as Report['reportType'])} className={fieldCls}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
              <Field label="Concept (blank = all)">
                <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
                  <option value="">All</option>
                  {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            </>
          )}
          <Field label="Cron expression">
            <input value={cron} onChange={(e) => setCron(e.target.value)} className={fieldCls + ' font-mono'} />
            <div className="flex flex-wrap gap-1.5 mt-2">
              {CRON_PRESETS.map((p) => (
                <button key={p.value} type="button" onClick={() => setCron(p.value)}
                  className="text-[10px] font-semibold px-2 py-1 rounded-full"
                  style={cron === p.value
                    ? { background: 'rgba(0,212,177,0.15)', color: '#00D4B1', border: '1px solid rgba(0,212,177,0.4)' }
                    : { background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  {p.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Recipients (comma-separated)">
            <textarea value={recipientsInput} onChange={(e) => setRecipientsInput(e.target.value)} rows={2} placeholder="owner@brand.pk, accounts@brand.pk" className={fieldCls} />
          </Field>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name || !cron}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : report ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
