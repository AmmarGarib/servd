'use client'
// One HR record: its values, where it is in approval, and what can be done
// with it now. Used by every section page and by the approvals inbox.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import {
  displayValue, human, day, rs, btn, btnGhost, inp, STATUS_COLOR, ROLE_LABEL, withLeaveDays, leaveFields,
  type HrFormat, type HrRecord, type Lookups, type OrgData,
} from '../../lib/hr'
import { FormRenderer, BANK_ACCOUNT_REF } from './FormRenderer'
import { useHrAccess } from './HrShell'
import { RecordMoney, BankAccountName } from './RecordMoney'
import { BankAccountSelect } from '../finance/BankAccountSelect'
import { Select } from '@/components/ui/Select'

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
  // A loan's last approver may say where it is paid out from (HR raising it
  // may not see the company's banks). Blank = what the loan says.
  const [payFrom, setPayFrom] = useState<string>(typeof record.data['paidFrom'] === 'string' ? record.data['paidFrom'] as string : '')
  const [payBank, setPayBank] = useState<string>(typeof record.data['bankAccount'] === 'string' ? record.data['bankAccount'] as string : '')
  const lk = { employees: lookups?.employees, records: lookups?.records, org }
  const base = `/hr/records/${record.section}/${record.id}`
  const done = () => { setErr(''); void qc.invalidateQueries(); onChanged() }
  const fail = (e: Error) => setErr(e.message)

  const step = format.workflow[record.currentStep]
  const pending = record.status === 'submitted' && !!step
  const loanPayout = pending && record.section === 'loan' && record.currentStep >= format.workflow.length - 1
  // A staff advance moved from an unsettled cash request (backend
  // hr/advanceLoan.ts): the cash request owns it — no edit, no cancel here.
  const fromCashRequest = record.section === 'loan' && record.data['paidFrom'] === 'cash_request'
  const editable = admin && !fromCashRequest && (format.workflow.length === 0 || ((record.status === 'draft' || record.status === 'submitted') && record.approvals.length === 0))
  // What POST /cancel allows: HR cancels anything not yet in effect; anyone
  // else only their own request, before an approver has acted on it.
  const cancellable = !fromCashRequest && (isHrAdmin
    ? !['approved', 'cancelled', 'rejected'].includes(record.status) || (record.status === 'approved' && !record.appliedAt)
    : record.createdById === userId && ['draft', 'submitted'].includes(record.status) && record.approvals.length === 0)
  // Decisions recorded outside the format's steps (a cash request's advance is
  // approved by the CEO when it is moved) — shown under the steps.
  const otherApprovals = record.approvals.filter((a) => !format.workflow.some((w) => w.key === a.step))

  const save = useMutation({ mutationFn: () => api.patch(base, { data: draft }), onSuccess: () => { setEditing(false); done() }, onError: fail })
  const submit = useMutation({ mutationFn: () => api.post(`${base}/submit`, {}), onSuccess: done, onError: fail })
  const decide = useMutation({
    mutationFn: (decision: 'approved' | 'rejected') => api.post(`${base}/decide`, {
      decision, ...(note.trim() && { note: note.trim() }),
      ...(record.section === 'overtime' && hours !== '' && { approvedHours: Number(hours) }),
      ...(decision === 'approved' && loanPayout && payFrom && { paidFrom: payFrom }),
      ...(decision === 'approved' && loanPayout && payFrom !== 'cash' && payBank && { bankAccountId: payBank }),
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
      // recordId: the server notes what it was worked out from, so approval
      // can tell if payroll moved since.
      return api.post<Record<string, unknown>>('/hr/final-settlement/calculate', { employeeId: record.employeeId, lastWorkingDay: lwd, recordId: record.id })
    },
    onSuccess: (r) => {
      setDraft((d) => ({
        ...d, salaryPayable: r['salaryPayable'], otPayable: r['otPayable'], leaveEncashment: r['leaveEncashment'], loanRecovery: r['loanRecovery'],
        incomeTax: r['incomeTax'], eobiEmployee: r['eobiEmployee'], eobiEmployer: r['eobiEmployer'], sessiEmployer: r['sessiEmployer'],
        gratuity: r['gratuity'] ?? 0,
        deductions: d['deductions'] ?? 0, otherAdjustments: d['otherAdjustments'] ?? 0,
      }))
      setEditing(true)
      const through = r['paidThrough'] ? `; payroll pays through ${String(r['paidThrough'])}${r['paidThroughStatus'] && r['paidThroughStatus'] !== 'locked' ? ` (still ${String(r['paidThroughStatus'])} — lock it before approving this)` : ''}` : ''
      const warnings = Array.isArray(r['warnings']) && r['warnings'].length ? ` ${(r['warnings'] as string[]).join(' ')}` : ''
      setMsg(`Calculated from ${String(r['leaveBalanceDays'])} day(s) of paid leave earned this leave year${through}.${gratuityText(r)} Review, then save.${warnings}`)
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
            ? <Select value={record.stage ?? ''} onChange={(e) => { if (e.target.value) stage.mutate(e.target.value) }} className="ml-auto rounded-lg px-2 py-1 text-xs bg-white/[0.04] border border-white/10 text-white/80">
                {/* A record saved before the format had stages has none yet —
                    shown as such, so picking the first stage is a change. */}
                {!record.stage && <option value="">No stage</option>}
                {format.stages.map((s) => <option key={s} value={s}>{human(s)}</option>)}
              </Select>
            : <span className="ml-auto text-xs text-white/50">{human(record.stage)}</span>
        )}
      </div>

      {editing ? (
        <div>
          <FormRenderer fields={leaveFields(record.section, format.fields, draft)} value={draft}
            onChange={(x) => setDraft(withLeaveDays(record.section, format.fields, draft, x))} ctx={{ lookups, org, tenantId: record.tenantId }} />
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
                  : f.ref === BANK_ACCOUNT_REF
                    ? (typeof record.data[f.key] === 'string' && record.data[f.key] ? <BankAccountName id={record.data[f.key] as string} /> : '—')
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
                  <span className="font-bold" style={{ color: a ? (a.decision === 'approved' ? '#3f7d20' : '#b42318') : current ? '#a15c00' : 'rgb(var(--fg-rgb) / 0.4)' }}>
                    {w.label}
                  </span>
                  <span className="text-white/40">({ROLE_LABEL[w.role]})</span>
                  {a && <span className="text-white/60">— {a.decision} by {a.byName}, {day(a.at)}{a.override ? ' (CEO override)' : ''}{a.note ? ` · “${a.note}”` : ''}</span>}
                  {current && !a && <span className="text-white/60">— waiting</span>}
                </li>
              )
            })}
          </ol>
          {otherApprovals.length > 0 && (
            <ul className="mt-2 space-y-1">
              {otherApprovals.map((a, i) => (
                <li key={`${a.step}-${i}`} className="text-xs text-white/60">
                  {human(a.decision)} by {a.byName}, {day(a.at)}{a.override ? ' (CEO override)' : ''}{a.note ? ` · “${a.note}”` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {fromCashRequest && (
        <div className="rounded-xl p-3 text-xs" style={{ background: 'rgb(var(--erp-primary-dim-rgb))' }}>
          <p className="font-bold text-primary-ink">
            Moved from an unsettled cash request{typeof record.data['cashVoucherNumber'] === 'string' ? ` (${record.data['cashVoucherNumber'] as string})` : ''}
          </p>
          <p className="mt-1 text-white/70">
            The money was paid from petty cash when the request was paid; this advance takes it over (Staff loans 1350, from Cash advances 1355) and payroll recovers it like any advance. To undo it, reverse it from the cash request — it cannot be edited or cancelled here.
          </p>
        </div>
      )}

      {record.section === 'overtime' && record.status === 'approved' && (
        <p className="text-sm text-white/70">OT amount: <strong className="text-white/90">{rs(record.amountCents)}</strong> — goes into the {day(record.startDate).split(' ').slice(1).join(' ')} payroll.</p>
      )}
      {record.section === 'leave' && record.status === 'approved' && <LeaveRotaEffects data={record.data} />}
      <RecordMoney record={record} onChanged={onChanged} />
      {record.appliedAt && <p className="text-xs text-primary-ink">Applied to the employee record on {day(record.appliedAt)}.</p>}
      {record.status === 'approved' && !record.appliedAt && ['promotion', 'transfer', 'salary_revision', 'probation_review'].includes(record.section) && record.effectiveDate && (
        <p className="text-xs text-amber-700">Takes effect on {day(record.effectiveDate)}.</p>
      )}

      {pending && (
        <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
          <p className="text-xs font-bold text-amber-700">Waiting on: {step.label}</p>
          {record.section === 'overtime' && (
            <label className="block text-xs text-white/60">Approved hours
              <input type="number" step="0.25" min={0} className={`${inp} mt-1`} value={hours} onChange={(e) => setHours(e.target.value)} />
            </label>
          )}
          {loanPayout && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-bold uppercase tracking-wider text-white/45 mb-1">Paid out from</span>
                <Select className={inp} value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                  <option value="">The way the employee is paid</option>
                  <option value="bank">Bank</option>
                  <option value="cash">Cash (the safe)</option>
                </Select>
              </label>
              {payFrom !== 'cash' && (
                <BankAccountSelect id={`loan-bank-${record.id}`} tenantId={record.tenantId} value={payBank} onChange={setPayBank} className={inp} />
              )}
              <p className="sm:col-span-2 text-[10px] text-white/40">Approving pays the loan out and books it from here.</p>
            </div>
          )}
          <input className={inp} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <button className={btn} disabled={decide.isPending} onClick={() => decide.mutate('approved')}>Approve</button>
            <button className="rounded-lg px-4 py-2 text-sm font-black bg-s-red text-[#fff] disabled:opacity-50" disabled={decide.isPending} onClick={() => decide.mutate('rejected')}>Reject</button>
          </div>
          <p className="text-[10px] text-white/35">Only the person this step belongs to can act on it; anyone else gets a message saying who.</p>
        </div>
      )}

      {err && <p className="text-xs text-red-700">{err}</p>}
      {msg && <p className="text-xs text-primary-ink">{msg}</p>}

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
          <button className="ml-auto text-xs text-white/40 hover:text-red-700" disabled={cancel.isPending}
            onClick={() => { if (confirm('Cancel this record?')) cancel.mutate() }}>Cancel record</button>
        ) : null}
      </div>
    </div>
  )
}

// What approving a full-day leave did to the rota (backend hr/routes.ts
// clearShiftsOnLeave / flagSwapsOnLeave): one-off hours set on /scheduling for
// those days were removed, and approved shift swaps on those days now leave a
// shift with nobody on it. Listed here so the manager knows what to cover.
interface RemovedShift { id?: string; date: string; conceptId?: string | null; startTime: string; endTime: string; role?: string | null }
interface AffectedSwap { swapId?: string; date: string; side?: 'requester' | 'partner'; colleagueName?: string | null; shiftName?: string | null }

const ymdDay = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function LeaveRotaEffects({ data }: { data: Record<string, unknown> }) {
  const removed = Array.isArray(data['_shiftsRemoved'])
    ? (data['_shiftsRemoved'] as RemovedShift[]).filter((r) => r && typeof r.date === 'string')
    : []
  const swaps = Array.isArray(data['_swapsAffected'])
    ? (data['_swapsAffected'] as AffectedSwap[]).filter((r) => r && typeof r.date === 'string')
    : []
  // Brand names for the removed hours: the shell brand picker's own list (any staff role reads it).
  const brands = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Array<{ id: string; name: string }>>('/concepts?view=picker'),
    staleTime: 60_000,
    enabled: removed.some((r) => !!r.conceptId),
    meta: { background: true },
    retry: false,
  })
  if (removed.length === 0 && swaps.length === 0) return null
  const brandName = (id: string | null | undefined) => (id ? brands.data?.find((b) => b.id === id)?.name ?? null : null)
  return (
    <div className="rounded-xl p-3 space-y-3 border border-white/10 bg-white/[0.03]">
      {removed.length > 0 && (
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-1.5">Shifts removed from the rota</p>
          <ul className="space-y-1">
            {removed.map((r, i) => {
              const brand = brandName(r.conceptId)
              return (
                <li key={r.id ?? i} className="text-xs text-white/75">
                  {ymdDay(r.date)} · {r.startTime}–{r.endTime}{brand ? ` · ${brand}` : ''}{r.role ? ` · ${r.role}` : ''}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {swaps.length > 0 && (
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-1.5">Swaps now uncovered</p>
          <ul className="space-y-1">
            {swaps.map((s, i) => (
              <li key={s.swapId ?? i} className="text-xs text-white/75">
                {ymdDay(s.date)} · {s.shiftName ?? 'the swapped shift'} now has nobody on it{s.colleagueName ? ` (swap with ${s.colleagueName})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[10px] text-white/35">Cover these on the rota. Cancelling the leave does not put the hours back.</p>
    </div>
  )
}

/** "Calculate"'s gratuity line, in words: the service it counted, or why none is due. */
function gratuityText(r: Record<string, unknown>): string {
  const g = r['gratuityDetail'] as {
    eligible: boolean; reason: string | null; years: number; months: number; days: number
    countedYears: number; lastGrossCents: number; daysPerYear?: number
  } | undefined
  if (!g) return ''
  if (!g.eligible) return ` No gratuity: ${g.reason ?? 'not due'}.`
  const service = `${g.years} year${g.years === 1 ? '' : 's'} ${g.months} month${g.months === 1 ? '' : 's'} ${g.days} day${g.days === 1 ? '' : 's'}`
  return ` Gratuity ${rs(r['gratuity'] as number)}: ${service} of service counts as ${g.countedYears} year${g.countedYears === 1 ? '' : 's'}, at ${g.daysPerYear ?? 30} days of the last gross salary (${rs(g.lastGrossCents)}) a year.`
}

function TableView({ f, rows, lk }: { f: HrFormat['fields'][number]; rows: Record<string, unknown>[]; lk: Parameters<typeof displayValue>[2] }) {
  return (
    <table className="w-full text-xs mt-1">
      <thead><tr>{(f.columns ?? []).map((c) => <th key={c.key} className="text-left text-white/40 font-bold pr-3">{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{(f.columns ?? []).map((c) => <td key={c.key} className="pr-3 text-white/80">{displayValue(c, r[c.key], lk)}</td>)}</tr>)}</tbody>
    </table>
  )
}
