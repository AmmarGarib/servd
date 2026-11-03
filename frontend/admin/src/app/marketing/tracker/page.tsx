'use client'
// Marketing → Intern tracker (owner, 2026-11-03): one record per intern / designer — the marketing lead (per-person
// module marketing_tracker) and the CEO. Each record opens its cards, on-time vs late, revisions, weekly notes,
// monthly reviews and attendance (read from HR).
import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { Button, Dialog, DialogFooter, ErrorBanner, Field, Input, fieldCls } from '@/components/finance/ui'
import { Select } from '@/components/ui/Select'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'
import { onTimeRate, type Trackee } from './data'

export default function TrackerPage() {
  const qc = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const [adding, setAdding] = useState(false)
  const { data: rows = [], isLoading } = useQuery<Trackee[]>({
    queryKey: ['mkt-tracker', showInactive], queryFn: () => api.get(`/marketing-tracker${showInactive ? '?includeInactive=1' : ''}`),
  })
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-success">Marketing</p>
          <h1 className="text-xl font-black">Intern tracker</h1>
          <p className="text-sm text-s-muted">Interns and designers: their cards, on-time rate, notes and reviews.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Show past</label>
          <Button onClick={() => setAdding(true)}>Add a person</Button>
        </div>
      </div>
      {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
      {!isLoading && rows.length === 0 && <CompactEmptyState message="No interns or designers tracked yet." detail="Add one from their HR record." />}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {rows.map((t) => (
          <li key={t.id}>
            <Link href={`/marketing/tracker/${t.id}`} className="block rounded-xl border border-s-border bg-s-surface p-4 hover:border-primary/50">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-bold">{t.employee.fullName}</p>
                  <p className="text-xs text-s-muted">{t.roleLabel} · {t.employee.employeeCode}{!t.active ? ' · past' : ''}</p>
                </div>
                <span className="shrink-0 text-lg font-black text-success">{onTimeRate(t.stats)}</span>
              </div>
              <p className="mt-2 text-xs text-s-muted">
                {t.stats?.total ?? 0} cards · {t.stats?.onTime ?? 0} on time · <span className={t.stats?.late ? 'text-s-red' : ''}>{t.stats?.late ?? 0} late</span> · {t.stats?.revisions ?? 0} revisions
              </p>
              {!t.loginLinked && <p className="mt-1 text-xs font-semibold text-s-amber">No login linked to this HR record</p>}
            </Link>
          </li>
        ))}
      </ul>
      {adding && <AddDialog onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void qc.invalidateQueries({ queryKey: ['mkt-tracker'] }) }} />}
    </div>
  )
}

function AddDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { data: emps = [] } = useQuery<Array<{ id: string; fullName: string; employeeCode: string; userId: string | null }>>({
    queryKey: ['mkt-tracker', 'employees'], queryFn: () => api.get('/marketing-tracker/employees'),
  })
  const [employeeId, setEmployeeId] = useState('')
  const [roleLabel, setRoleLabel] = useState('Marketing intern')
  const [startDate, setStartDate] = useState(new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10))
  const [endDate, setEndDate] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function save() {
    if (!employeeId) { setErr('Pick the person from HR.'); return }
    setBusy(true); setErr(null)
    try { await api.post('/marketing-tracker', { employeeId, roleLabel, startDate, endDate: endDate || null }); onSaved() }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not add them') } finally { setBusy(false) }
  }
  return (
    <Dialog title="Track an intern or designer" onClose={onClose}>
      <div className="space-y-3">
        {err && <ErrorBanner message={err} />}
        <Field label="Person (HR record)">
          <Select className={fieldCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Pick…</option>
            {emps.map((e) => <option key={e.id} value={e.id}>{e.fullName} · {e.employeeCode}{e.userId ? '' : ' (no login)'}</option>)}
          </Select>
        </Field>
        <Field label="Role"><Input value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} maxLength={80} /></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start date"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
          <Field label="End date (optional)"><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
        </div>
      </div>
      <DialogFooter onCancel={onClose}><Button onClick={() => void save()} disabled={busy}>{busy ? 'Adding…' : 'Add'}</Button></DialogFooter>
    </Dialog>
  )
}
