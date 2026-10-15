'use client'
// One employee: the master record (edited through the Employee Master format),
// documents, requests, leave, loans, salary history, letters, and their login.

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { card, btn, btnGhost, inp, rs, day, human, STATUS_COLOR, type HrRecord, type HrLogin } from '../../../../lib/hr'
import { HrShell, Stat, useHrForm, useHrLookups, useHrOrg } from '../../../../components/hr/HrShell'
import { FormRenderer } from '../../../../components/hr/FormRenderer'
import { openPrintable } from '../../../../components/hr/RecordDetail'
import { Select } from '@/components/ui/Select'

interface Profile {
  employee: Record<string, unknown> & { id: string; tenantId: string; fullName: string; employeeCode: string; status: string; employmentType: string; grossSalaryCents: number; userId: string | null; data: Record<string, unknown> }
  labels: Record<string, string | null>
  documents: Array<{ id: string; docType: string; title: string | null; fileUrl: string | null; issueDate: string | null; expiryDate: string | null; verifiedAt: string | null }>
  records: HrRecord[]
  leaveBalances: Array<{ leaveTypeId: string; name: string; paid: boolean; entitlement: number; carriedForward: number; adjustments: number; taken: number; pending: number; balance: number }>
  loans: Array<{ id: string; type: string | null; amountCents: number; installments: number; recoveredCents: number; outstandingCents: number; firstPeriod: string }>
  salaryHistory: Array<{ section: string; effectiveDate: string | null; grossCents: number; applied: boolean }>
  user: { id: string; name: string; email: string; role: string } | null
  kioskPinSet: boolean
}

const TABS = ['Profile', 'Documents', 'Requests', 'Leave', 'Loans & pay', 'Letters', 'Login & clock-in'] as const

export default function EmployeeProfilePage() {
  const { id } = useParams<{ id: string }>()
  const [tab, setTab] = useState<(typeof TABS)[number]>('Profile')
  const { data: p, error } = useQuery({ queryKey: ['hr-employee', id], queryFn: () => api.get<Profile>(`/hr/employees/${id}`) })
  const e = p?.employee
  return (
    <HrShell title={e ? e.fullName : 'Employee'} subtitle={e ? `${e.employeeCode} · ${p?.labels.designation ?? 'No designation'} · ${p?.labels.department ?? 'No department'} · ${p?.labels.branch ?? 'No branch'}` : undefined}
      actions={e && <span className="text-xs font-black uppercase tracking-wider self-center" style={{ color: STATUS_COLOR[e.status] }}>{human(e.status)}</span>}>
      {error && <p className="text-sm text-red-700">{(error as Error).message}</p>}
      {p && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
            <Stat label="Gross salary" value={rs(e!.grossSalaryCents)} />
            <Stat label="Type" value={human(e!.employmentType)} />
            <Stat label="Joined" value={day(e!['joiningDate'] as string)} />
            <Stat label="Manager" value={p.labels.manager ?? '—'} />
            <Stat label="Loans outstanding" value={rs(p.loans.reduce((a, l) => a + l.outstandingCents, 0))} />
          </div>
          <div className="flex gap-1 mb-5 overflow-x-auto">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap ${tab === t ? 'bg-primary text-primary-on' : 'text-white/50 border border-white/10'}`}>{t}</button>
            ))}
          </div>
          {tab === 'Profile' && <ProfileTab p={p} />}
          {tab === 'Documents' && <DocumentsTab p={p} />}
          {tab === 'Requests' && <RequestsTab p={p} />}
          {tab === 'Leave' && <LeaveTab p={p} />}
          {tab === 'Loans & pay' && <PayTab p={p} />}
          {tab === 'Letters' && <LettersTab p={p} />}
          {tab === 'Login & clock-in' && <LoginTab p={p} />}
        </>
      )}
    </HrShell>
  )
}

function ProfileTab({ p }: { p: Profile }) {
  const qc = useQueryClient()
  // The employee's own company's format and lists — in portfolio view that
  // need not be the active company, and the API checks against theirs.
  const { data: lookups } = useHrLookups(p.employee.tenantId)
  const { data: org } = useHrOrg(p.employee.tenantId)
  const { data: form } = useHrForm('employees', p.employee.tenantId)
  // Master fields bound to a column read the column; the rest read `data`.
  const initial = () => {
    const v: Record<string, unknown> = {}
    for (const f of form?.current.fields ?? []) v[f.key] = f.bind?.startsWith('employee.') ? p.employee[f.bind.slice(9)] : p.employee.data?.[f.key]
    return v
  }
  const [value, setValue] = useState<Record<string, unknown> | null>(null)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)
  const save = useMutation({
    mutationFn: () => api.patch(`/hr/employees/${p.employee.id}`, { data: value }),
    onSuccess: () => { setOk(true); setErr(''); void qc.invalidateQueries() },
    onError: (e: Error) => { setErr(e.message); setOk(false) },
  })
  if (!form) return <p className="text-sm text-white/40">Loading format…</p>
  const v = value ?? initial()
  return (
    <div className="rounded-2xl p-5" style={card}>
      <FormRenderer fields={form.current.fields} value={v} onChange={(x) => { setValue(x); setOk(false) }} ctx={{ lookups, org }} />
      {err && <p className="text-xs text-red-700 mt-3">{err}</p>}
      {ok && <p className="text-xs text-primary-ink mt-3">Saved.</p>}
      <div className="flex gap-2 mt-5">
        <button className={btn} disabled={save.isPending || !value} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save changes'}</button>
        {value && <button className={btnGhost} onClick={() => setValue(null)}>Discard</button>}
      </div>
      <p className="text-[11px] text-white/35 mt-3">Promotions, transfers and salary revisions should go through their own sections so they are approved and appear in the history. Editing salary here is recorded in the audit trail.</p>
    </div>
  )
}

function DocumentsTab({ p }: { p: Profile }) {
  const qc = useQueryClient()
  const { data: types = [] } = useQuery({ queryKey: ['hr-doc-types'], queryFn: () => api.get<string[]>('/hr/documents/types') })
  const [f, setF] = useState({ docType: 'cnic_front', title: '', fileUrl: '', issueDate: '', expiryDate: '' })
  const [err, setErr] = useState('')
  const add = useMutation({
    mutationFn: () => api.post('/hr/documents', { employeeId: p.employee.id, docType: f.docType, title: f.title || undefined, fileUrl: f.fileUrl || undefined, issueDate: f.issueDate || undefined, expiryDate: f.expiryDate || undefined }),
    onSuccess: () => { setErr(''); setF({ ...f, title: '', fileUrl: '', issueDate: '', expiryDate: '' }); void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  const verify = useMutation({ mutationFn: (id: string) => api.post(`/hr/documents/${id}/verify`, {}), onSuccess: () => void qc.invalidateQueries() })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/hr/documents/${id}`), onSuccess: () => void qc.invalidateQueries() })
  const soon = (d: string | null) => d && new Date(d).getTime() - Date.now() < 30 * 86_400_000
  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-4 grid grid-cols-2 md:grid-cols-6 gap-2 items-end" style={card}>
        <Select className={inp} value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })} aria-label="Document type">{types.map((t) => <option key={t} value={t}>{human(t)}</option>)}</Select>
        <input className={inp} placeholder="Title (optional)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input className={`${inp} md:col-span-2`} placeholder="Link to the file" value={f.fileUrl} onChange={(e) => setF({ ...f, fileUrl: e.target.value })} />
        <input type="date" className={inp} title="Expiry date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} aria-label="Expiry date" />
        <button className={btn} disabled={add.isPending} onClick={() => add.mutate()}>Add</button>
      </div>
      {err && <p className="text-xs text-red-700">{err}</p>}
      <div className="rounded-2xl overflow-hidden" style={card}>
        {p.documents.length === 0 && <p className="p-6 text-sm text-white/40 text-center">No documents yet.</p>}
        {p.documents.map((d) => (
          <div key={d.id} className="px-4 py-3 border-t border-white/[0.05] first:border-t-0 flex items-center gap-3 text-sm">
            <span className="font-bold text-white/85 w-48 shrink-0">{d.title || human(d.docType)}</span>
            {d.fileUrl ? <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-primary-ink text-xs hover:underline">Open</a> : <span className="text-xs text-white/30">No file</span>}
            <span className="text-xs" style={{ color: soon(d.expiryDate) ? '#a15c00' : 'rgb(var(--fg-rgb) / 0.45)' }}>{d.expiryDate ? `Expires ${day(d.expiryDate)}` : ''}</span>
            <span className="ml-auto flex gap-3">
              {d.verifiedAt ? <span className="text-xs text-primary-ink">Verified</span> : <button className="text-xs text-white/50 hover:text-white" onClick={() => verify.mutate(d.id)}>Mark verified</button>}
              <button className="text-xs text-white/35 hover:text-red-700" onClick={() => { if (confirm('Delete this document?')) del.mutate(d.id) }}>Delete</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RequestsTab({ p }: { p: Profile }) {
  if (p.records.length === 0) return <p className="text-sm text-white/40">No requests or records for this employee yet.</p>
  return (
    <div className="rounded-2xl overflow-hidden" style={card}>
      {p.records.map((r) => (
        <Link key={r.id} href={`/hr/s/${r.section}`} className="px-4 py-3 border-t border-white/[0.05] first:border-t-0 flex items-center gap-3 text-sm hover:bg-white/[0.03]">
          <span className="font-bold text-white/85 w-48 shrink-0">{human(r.section)}</span>
          <span className="text-xs text-white/50">{day(r.startDate ?? r.effectiveDate ?? r.createdAt)}</span>
          {r.amountCents != null && <span className="text-xs text-white/60">{rs(r.amountCents)}</span>}
          <span className="ml-auto text-xs font-bold" style={{ color: STATUS_COLOR[r.status] }}>{human(r.status)}</span>
        </Link>
      ))}
    </div>
  )
}

function LeaveTab({ p }: { p: Profile }) {
  if (p.leaveBalances.length === 0) return <p className="text-sm text-white/40">No leave types set up yet — add them under <Link href="/hr/s/leave_type" className="text-primary-ink">Leave types</Link>.</p>
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {p.leaveBalances.map((b) => (
        <div key={b.leaveTypeId} className="rounded-2xl p-4" style={card}>
          <p className="text-sm font-black text-white/85">{b.name} <span className="text-[10px] font-bold text-white/35">{b.paid ? 'PAID' : 'UNPAID'}</span></p>
          <p className="text-3xl font-black mt-1" style={{ color: b.balance < 0 ? '#b42318' : '#3f7d20' }}>{b.balance}</p>
          <p className="text-[11px] text-white/45 mt-1">{b.entitlement} entitled {b.carriedForward ? `+${b.carriedForward} carried ` : ''}{b.adjustments ? `${b.adjustments > 0 ? '+' : ''}${b.adjustments} adjusted ` : ''}· {b.taken} taken{b.pending ? ` · ${b.pending} pending` : ''}</p>
        </div>
      ))}
    </div>
  )
}

function PayTab({ p }: { p: Profile }) {
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="rounded-2xl p-4" style={card}>
        <p className="text-sm font-black text-white/85 mb-3">Loans & advances</p>
        {p.loans.length === 0 && <p className="text-xs text-white/40">None.</p>}
        {p.loans.map((l) => (
          <div key={l.id} className="text-sm py-2 border-t border-white/[0.05] first:border-t-0">
            <div className="flex justify-between"><span className="text-white/80">{human(l.type)} · {rs(l.amountCents)} over {l.installments} months from {l.firstPeriod}</span></div>
            <div className="h-1.5 rounded-full bg-white/5 mt-2"><div className="h-full rounded-full bg-accent" style={{ width: `${l.amountCents ? (l.recoveredCents / l.amountCents) * 100 : 0}%` }} /></div>
            <p className="text-[11px] text-white/45 mt-1">{rs(l.recoveredCents)} recovered · {rs(l.outstandingCents)} outstanding</p>
          </div>
        ))}
      </div>
      <div className="rounded-2xl p-4" style={card}>
        <p className="text-sm font-black text-white/85 mb-3">Salary history</p>
        {p.salaryHistory.length === 0 && <p className="text-xs text-white/40">No approved revisions or promotions.</p>}
        {p.salaryHistory.map((s, i) => (
          <div key={i} className="flex justify-between text-sm py-1.5 border-t border-white/[0.05] first:border-t-0">
            <span className="text-white/70">{human(s.section)} · {day(s.effectiveDate)}</span>
            <span className="text-white/85">{rs(s.grossCents)}{!s.applied && <span className="text-[10px] text-amber-700"> scheduled</span>}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function LettersTab({ p }: { p: Profile }) {
  const { data: letters = [] } = useQuery({ queryKey: ['hr-letters'], queryFn: () => api.get<Array<{ key: string; title: string }>>('/hr/letters') })
  const [msg, setMsg] = useState('')
  const render = useMutation({
    mutationFn: (key: string) => api.post<{ title: string; html: string; missing: string[] }>('/hr/letters/render', { key, employeeId: p.employee.id }),
    onSuccess: (r) => { openPrintable(r.title, r.html); setMsg(r.missing.length ? `Printed with blanks for: ${r.missing.join(', ')} — letters about a specific request are best printed from that request.` : '') },
    onError: (e: Error) => setMsg(e.message),
  })
  return (
    <div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {letters.map((l) => <button key={l.key} className="rounded-xl p-3 text-left text-sm font-bold text-white/80 hover:bg-white/[0.05]" style={card} onClick={() => render.mutate(l.key)}>{l.title}</button>)}
      </div>
      {msg && <p className="text-xs text-amber-700 mt-3">{msg}</p>}
    </div>
  )
}

function LoginTab({ p }: { p: Profile }) {
  const qc = useQueryClient()
  // HR's own list of this company's logins (names and roles only) — not the
  // managers-only /auth/users.
  const { data: logins, error } = useQuery({
    queryKey: ['hr-logins', p.employee.tenantId],
    queryFn: () => api.get<HrLogin[]>(`/hr/logins?${new URLSearchParams({ tenantId: p.employee.tenantId })}`),
    retry: false,
  })
  const [pick, setPick] = useState('')
  const [err, setErr] = useState('')
  const link = useMutation({
    mutationFn: (userId: string | null) => api.post(`/hr/employees/${p.employee.id}/link-user`, { userId }),
    onSuccess: () => { setErr(''); void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  const free = (logins ?? []).filter((u) => !u.linkedEmployee || u.linkedEmployee.id === p.employee.id)
  return (
    <div className="grid lg:grid-cols-2 gap-4 max-w-4xl">
      <div className="rounded-2xl p-5" style={card}>
        <p className="text-sm font-black text-white/85 mb-2">servd login</p>
        <p className="text-sm text-white/60 mb-3">Not everyone needs one — most kitchen staff punch in with a kiosk PIN instead. Linking a login lets this person clock in as themselves, use <strong>My HR</strong> and, if they manage people, approve their team&rsquo;s requests. One login can be linked to one employee record in each company.</p>
        {p.user ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-white/85">Linked to <strong>{p.user.name}</strong> ({p.user.email ?? 'no email'}, {human(p.user.role)})</p>
            <button className={btnGhost} onClick={() => link.mutate(null)}>Unlink</button>
          </div>
        ) : error ? (
          <p className="text-xs text-amber-700">{(error as Error).message}</p>
        ) : (
          <div className="flex gap-2">
            <Select className={inp} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Login to link">
              <option value="">Choose a login…</option>
              {free.map((u) => <option key={u.id} value={u.id}>{u.name} — {u.email ?? human(u.role)}{u.isActive ? '' : ' (inactive)'}</option>)}
            </Select>
            <button className={btn} disabled={!pick || link.isPending} onClick={() => link.mutate(pick)}>Link</button>
          </div>
        )}
        {err && <p className="text-xs text-red-700 mt-2">{err}</p>}
      </div>
      <KioskPinCard p={p} />
    </div>
  )
}

function KioskPinCard({ p }: { p: Profile }) {
  const qc = useQueryClient()
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState('')
  const save = useMutation({
    mutationFn: () => api.post(`/hr/employees/${p.employee.id}/kiosk-pin`, { pin }),
    onSuccess: () => { setPin(''); setMsg('PIN set. Tell them in person — it is not shown again.'); void qc.invalidateQueries({ queryKey: ['hr-employee'] }) },
    onError: (e: Error) => setMsg(e.message),
  })
  const clear = useMutation({
    mutationFn: () => api.delete(`/hr/employees/${p.employee.id}/kiosk-pin`),
    onSuccess: () => { setMsg('PIN removed.'); void qc.invalidateQueries({ queryKey: ['hr-employee'] }) },
    onError: (e: Error) => setMsg(e.message),
  })
  return (
    <div className="rounded-2xl p-5" style={card}>
      <p className="text-sm font-black text-white/85 mb-2">Kiosk PIN</p>
      <p className="text-sm text-white/60 mb-3">For staff without a login: they punch in and out at the shared time clock with their employee ID <strong>{p.employee.employeeCode}</strong> and this PIN. Each punch writes their attendance for the day.</p>
      {p.user ? (
        <p className="text-xs text-white/45">This person has a login, so they clock in with it — no kiosk PIN needed.</p>
      ) : (
        <>
          <p className="text-xs mb-2" style={{ color: p.kioskPinSet ? '#3f7d20' : 'rgb(var(--fg-rgb) / 0.45)' }}>{p.kioskPinSet ? 'A PIN is set.' : 'No PIN yet.'}</p>
          <div className="flex gap-2">
            <input className={inp} inputMode="numeric" maxLength={6} placeholder="4–6 digits" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} aria-label="New kiosk PIN" />
            <button className={btn} disabled={pin.length < 4 || save.isPending} onClick={() => save.mutate()}>{p.kioskPinSet ? 'Change' : 'Set'}</button>
            {p.kioskPinSet && <button className={btnGhost} disabled={clear.isPending} onClick={() => clear.mutate()}>Remove</button>}
          </div>
        </>
      )}
      {msg && <p className="text-xs text-white/60 mt-2">{msg}</p>}
    </div>
  )
}
