'use client'
// One HR record: its values, where it is in approval, and what can be done
// with it now. Used by every section page and by the approvals inbox.

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import {
  displayValue, human, day, rs, btn, btnGhost, inp, STATUS_COLOR, ROLE_LABEL, withLeaveDays, leaveFields,
  type HrFormat, type HrRecord, type Lookups, type OrgData,
} from '../../lib/hr'
import { FormRenderer } from './FormRenderer'
import { useHrAccess } from './HrShell'

// Letters that make sense from a record — spec §26.
export const LETTERS_FOR: Record<string, string[]> = {
  offer: ['offer_letter'],
  probation_review: ['confirmation_letter', 'probation_extension_letter'],
  salary_revision: ['salary_revision_letter'],
  promotion: ['promotion_letter'],
  transfer: ['transfer_letter'],
  er_case: ['warning_letter', 'show_cause_notice'],
  termination: ['termination_letter'],
  resignation: ['resignation_acceptance'],
  final_settlement: ['final_settlement_statement'],
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A letter's HTML is written by HR users and printed by whoever clicks, so it
// is printed from a sandboxed frame that runs no script — an onerror or a
// <script> in a template does nothing, and cannot reach this page's session.
// allow-same-origin only lets this page call print() on the frame; without
// allow-scripts the frame's own content still cannot run. The API sanitises
// templates too; this holds even if something gets past it.
export function openPrintable(title: string, html: string) {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeText(title)}</title>
<style>body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:48px auto;padding:0 24px;color:#111;line-height:1.55;font-size:15px}
table{border-collapse:collapse;margin:12px 0}td{border:1px solid #ccc;padding:6px 12px}@media print{body{margin:0}}</style>
</head><body>${html}</body></html>`
  frame.onload = () => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    // print() returns once the dialog closes; give it a moment either way.
    setTimeout(() => frame.remove(), 1000)
  }
  document.body.appendChild(frame)
}

export function RecordDetail({ record, format, lookups, org, admin, onChanged }: {
  record: HrRecord
  format: HrFormat
  lookups?: Lookups
  org?: OrgData
  admin: boolean
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const { userId, isHrAdmin } = useHrAccess()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, unknown>>(record.data)
  const [note, setNote] = useState('')
  // An earlier approver's hours, when one cut the claim — otherwise the hours claimed.
  const [hours, setHours] = useState<string>(record.section === 'overtime'
    ? String(typeof record.data['approvedHours'] === 'number' ? record.data['approvedHours'] : record.quantity ?? '')
    : '')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const lk = { employees: lookups?.employees, records: lookups?.records, org }
  const base = `/hr/records/${record.section}/${record.id}`
  const done = () => { setErr(''); void qc.invalidateQueries(); onChanged() }
  const fail = (e: Error) => setErr(e.message)

  const step = format.workflow[record.currentStep]
  const pending = record.status === 'submitted' && !!step
  const editable = admin && (format.workflow.length === 0 || ((record.status === 'draft' || record.status === 'submitted') && record.approvals.length === 0))
  // What POST /cancel allows: HR cancels anything not yet in effect; anyone
  // else only their own request, before an approver has acted on it.
  const cancellable = isHrAdmin
    ? !['approved', 'cancelled', 'rejected'].includes(record.status) || (record.status === 'approved' && !record.appliedAt)
    : record.createdById === userId && ['draft', 'submitted'].includes(record.status) && record.approvals.length === 0

  const save = useMutation({ mutationFn: () => api.patch(base, { data: draft }), onSuccess: () => { setEditing(false); done() }, onError: fail })
  const submit = useMutation({ mutationFn: () => api.post(`${base}/submit`, {}), onSuccess: done, onError: fail })
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => api.post(`${base}/decide`, {
      decision, ...(note.trim() && { note: note.trim() }),
      ...(record.section === 'overtime' && hours !== '' && { approvedHours: Number(hours) }),
    }),
    onSuccess: () => { setNote(''); done() }, onError: fail,
  })
  const stage = useMutation({ mutationFn: (s: string) => api.post(`${base}/stage`, { stage: s }), onSuccess: done, onError: fail })
  const cancel = useMutation({ mutationFn: () => api.post(`${base}/cancel`, {}), onSuccess: done, onError: fail })
  const hire = useMutation({
    mutationFn: () => api.post<{ id: string; employeeCode: string }>(`/hr/records/offer/${record.id}/create-employee`, {}),
    onSuccess: (e) => { setMsg(`Employee ${e.employeeCode} created.`); done() }, onError: fail,
  })
  const calc = useMutation({
    mutationFn: async () => {
      const lwd = (draft['lastWorkingDay'] as string) || record.endDate
      if (!record.employeeId || !lwd) throw new Error('Set the employee and last working day first')
      return api.post<Record<string, number | boolean | string | null>>('/hr/final-settlement/calculate', { employeeId: record.employeeId, lastWorkingDay: lwd })
    },
    onSuccess: (r) => {
      setDraft((d) => ({ ...d, salaryPayable: r['salaryPayable'], otPayable: r['otPayable'], leaveEncashment: r['leaveEncashment'], loanRecovery: r['loanRecovery'], deductions: d['deductions'] ?? 0, otherAdjustments: d['otherAdjustments'] ?? 0 }))
      setEditing(true)
      setMsg(`Calculated from ${r['leaveBalanceDays']} day(s) of paid leave earned this leave year${r['paidThrough'] ? `; salary already paid by payroll through ${r['paidThrough']}` : ''}. Review, then save.`)
    },
    onError: fail,
  })
  const letter = useMutation({
    mutationFn: (key: string) => api.post<{ title: string; html: string; missing: string[] }>('/hr/letters/render', { key, recordId: record.id }),
    onSuccess: (r) => { openPrintable(r.title, r.html); if (r.missing.length) setMsg(`Printed with blanks for: ${r.missing.join(', ')}`) },
    onError: fail,
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-black uppercase tracking-wider" style={{ color: STATUS_COLOR[record.status] }}>{record.status}</span>
        {record.employee && <span className="text-sm text-white/70">· {record.employee.fullName} ({record.employee.employeeCode})</span>}
        {format.stages.length > 0 && (
          admin
            ? <select value={record.stage ?? ''} onChange={(e) => { if (e.target.value) stage.mutate(e.target.value) }} className="ml-auto rounded-lg px-2 py-1 text-xs bg-white/[0.04] border border-white/10 text-white/80">
                {/* A record saved before the format had stages has none yet —
                    shown as such, so picking the first stage is a change. */}
                {!record.stage && <option value="">No stage</option>}
                {format.stages.map((s) => <option key={s} value={s}>{human(s)}</option>)}
              </select>
            : <span className="ml-auto text-xs text-white/50">{human(record.stage)}</span>
        )}
      </div>

      {editing ? (
        <div>
          <FormRenderer fields={leaveFields(record.section, format.fields, draft)} value={draft}
            onChange={(x) => setDraft(withLeaveDays(record.section, format.fields, draft, x))} ctx={{ lookups, org }} />
          <div className="flex gap-2 mt-4">
            <button className={btn} disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
            <button className={btnGhost} onClick={() => { setEditing(false); setDraft(record.data) }}>Cancel</button>
          </div>
        </div>
      ) : (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
          {format.fields.map((f) => (
            <div key={f.key} className={f.type === 'textarea' || f.type === 'table' ? 'sm:col-span-2' : ''}>
              <dt className="text-[10px] font-bold uppercase tracking-wider text-white/35">{f.label}</dt>
              <dd className="text-sm text-white/85 whitespace-pre-wrap">
                {f.type === 'table' && Array.isArray(record.data[f.key]) && (record.data[f.key] as unknown[]).length
                  ? <TableView f={f} rows={record.data[f.key] as Record<string, unknown>[]} lk={lk} />
                  : displayValue(f, record.data[f.key], lk)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {format.workflow.length > 0 && (
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Approval</p>
          <ol className="space-y-1.5">
            {format.workflow.map((w, i) => {
              const a = record.approvals.find((x) => x.step === w.key)
              const current = pending && i === record.currentStep
              return (
                <li key={w.key} className="flex items-baseline gap-2 text-xs">
                  <span className="w-4 text-white/35">{i + 1}.</span>
                  <span className="font-bold" style={{ color: a ? (a.decision === 'approved' ? '#34d399' : '#f87171') : current ? '#f59e0b' : 'rgba(255,255,255,0.4)' }}>
                    {w.label}
                  </span>
                  <span className="text-white/40">({ROLE_LABEL[w.role]})</span>
                  {a && <span className="text-white/60">— {a.decision} by {a.byName}, {day(a.at)}{a.override ? ' (CEO override)' : ''}{a.note ? ` · “${a.note}”` : ''}</span>}
                  {current && !a && <span className="text-white/60">— waiting</span>}
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {record.section === 'overtime' && record.status === 'approved' && (
        <p className="text-sm text-white/70">OT amount: <strong className="text-white/90">{rs(record.amountCents)}</strong> — goes into the {day(record.startDate).split(' ').slice(1).join(' ')} payroll.</p>
      )}
      {record.appliedAt && <p className="text-xs text-kds-green">Applied to the employee record on {day(record.appliedAt)}.</p>}
      {record.status === 'approved' && !record.appliedAt && ['promotion', 'transfer', 'salary_revision', 'probation_review'].includes(record.section) && record.effectiveDate && (
        <p className="text-xs text-amber-400">Takes effect on {day(record.effectiveDate)}.</p>
      )}

      {pending && (
        <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
          <p className="text-xs font-bold text-amber-300">Waiting on: {step.label}</p>
          {record.section === 'overtime' && (
            <label className="block text-xs text-white/60">Approved hours
              <input type="number" step="0.25" min={0} className={`${inp} mt-1`} value={hours} onChange={(e) => setHours(e.target.value)} />
            </label>
          )}
          <input className={inp} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <button className={btn} disabled={decide.isPending} onClick={() => decide.mutate('approved')}>Approve</button>
            <button className="rounded-lg px-4 py-2 text-sm font-black bg-red-500/80 text-white disabled:opacity-50" disabled={decide.isPending} onClick={() => decide.mutate('rejected')}>Reject</button>
          </div>
          <p className="text-[10px] text-white/35">Only the person this step belongs to can act on it; anyone else gets a message saying who.</p>
        </div>
      )}

      {err && <p className="text-xs text-red-400">{err}</p>}
      {msg && <p className="text-xs text-kds-green">{msg}</p>}

      <div className="flex flex-wrap gap-2 pt-2 border-t border-white/[0.06]">
        {editable && !editing && <button className={btnGhost} onClick={() => { setDraft(record.data); setEditing(true) }}>Edit</button>}
        {admin && record.status === 'draft' && <button className={btn} disabled={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</button>}
        {editable && record.section === 'final_settlement' && (
          <button className={btnGhost} disabled={calc.isPending} onClick={() => calc.mutate()}>{calc.isPending ? 'Calculating…' : 'Calculate'}</button>
        )}
        {admin && record.section === 'offer' && record.status === 'approved' && !record.data['_employeeId'] && (
          <button className={btn} disabled={hire.isPending} onClick={() => hire.mutate()}>Create employee</button>
        )}
        {admin && (LETTERS_FOR[record.section] ?? []).map((k) => (
          <button key={k} className={btnGhost} disabled={letter.isPending} onClick={() => letter.mutate(k)}>Print {human(k).toLowerCase()}</button>
        ))}
        {cancellable ? (
          <button className="ml-auto text-xs text-white/40 hover:text-red-400" disabled={cancel.isPending}
            onClick={() => { if (confirm('Cancel this record?')) cancel.mutate() }}>Cancel record</button>
        ) : null}
      </div>
    </div>
  )
}

function TableView({ f, rows, lk }: { f: HrFormat['fields'][number]; rows: Record<string, unknown>[]; lk: Parameters<typeof displayValue>[2] }) {
  return (
    <table className="w-full text-xs mt-1">
      <thead><tr>{(f.columns ?? []).map((c) => <th key={c.key} className="text-left text-white/40 font-bold pr-3">{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{(f.columns ?? []).map((c) => <td key={c.key} className="pr-3 text-white/80">{displayValue(c, r[c.key], lk)}</td>)}</tr>)}</tbody>
    </table>
  )
}
