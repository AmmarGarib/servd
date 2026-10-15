'use client'
// One employee: the master record (edited through the Employee Master format),
// documents, requests, leave, loans, salary history, letters, and their login.

import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, deleteWithUndo } from '../../../../lib/api'
import { card, btn, btnGhost, inp, rs, day, human, STATUS_COLOR, type HrRecord, type HrLogin } from '../../../../lib/hr'
import { HrShell, Stat, useHrForm, useHrLookups, useHrOrg } from '../../../../components/hr/HrShell'
import { FormRenderer, validate, focusFirstInvalid } from '../../../../components/hr/FormRenderer'
import { openPrintable } from '../../../../components/hr/RecordDetail'
import { Select } from '@/components/ui/Select'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { usePermissions } from '../../../../hooks/useCan'
import { OffboardButtons, FLOOR_LOGIN_ROLES } from '../../../../components/hr/OffboardButtons'
import { roleLabel } from '../../../../lib/appRoles'

interface Profile {
  employee: Record<string, unknown> & { id: string; tenantId: string; fullName: string; employeeCode: string; status: string; employmentType: string; grossSalaryCents: number; userId: string | null; data: Record<string, unknown> }
  labels: Record<string, string | null>
  documents: Array<{ id: string; docType: string; title: string | null; fileUrl: string | null; issueDate: string | null; expiryDate: string | null; verifiedAt: string | null }>
  records: HrRecord[]
  leaveBalances: Array<{ leaveTypeId: string; name: string; paid: boolean; entitlement: number; carriedForward: number; adjustments: number; taken: number; pending: number; balance: number }>
  loans: Array<{ id: string; type: string | null; amountCents: number; installments: number; recoveredCents: number; outstandingCents: number; firstPeriod: string }>
  salaryHistory: Array<{ section: string; effectiveDate: string | null; grossCents: number; applied: boolean }>
  user: { id: string; name: string; email: string; role: string; status?: 'pending' | 'active' | 'suspended' } | null
  kioskPinSet: boolean
}

const TABS = ['Profile', 'Documents', 'Requests', 'Leave', 'Loans & pay', 'Letters', 'Login & clock-in'] as const
type Tab = (typeof TABS)[number]
// The tab lives in ?tab= so reload, Back and a shared link land on it.
const TAB_SLUG: Record<Tab, string> = { Profile: 'profile', Documents: 'documents', Requests: 'requests', Leave: 'leave', 'Loans & pay': 'pay', Letters: 'letters', 'Login & clock-in': 'login' }
const tabFromSlug = (s: string | null): Tab => TABS.find((t) => TAB_SLUG[t] === s) ?? 'Profile'

export default function EmployeeProfilePage() {
  return <Suspense fallback={null}><EmployeeProfile /></Suspense>
}

function EmployeeProfile() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const path = usePathname()
  const sp = useSearchParams()
  const confirm = useConfirm()
  const tab = tabFromSlug(sp.get('tab'))
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // The Profile form reports whether it holds unsaved edits.
  const dirty = useRef(false)
  const setDirty = useCallback((d: boolean) => { dirty.current = d }, [])
  const { data: p, error, isLoading } = useQuery({ queryKey: ['hr-employee', id], queryFn: () => api.get<Profile>(`/hr/employees/${id}`) })
  const e = p?.employee

  const askDiscard = useCallback(async () => {
    if (!dirty.current) return true
    const r = await confirm({ title: 'Discard your changes?', body: 'The profile has edits that are not saved.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true })
    if (r) dirty.current = false
    return !!r
  }, [confirm])

  // Hard leave (reload, close, address bar) and in-app links both ask first.
  useEffect(() => {
    const beforeUnload = (ev: BeforeUnloadEvent) => { if (dirty.current) { ev.preventDefault(); ev.returnValue = '' } }
    const onClick = (ev: MouseEvent) => {
      if (!dirty.current || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return
      const a = (ev.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || a.target === '_blank' || a.origin !== window.location.origin) return
      if (a.pathname === window.location.pathname && a.search === window.location.search) return
      ev.preventDefault(); ev.stopPropagation()
      void askDiscard().then((ok) => { if (ok) router.push(a.pathname + a.search + a.hash) })
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', onClick, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', onClick, true) }
  }, [askDiscard, router])

  const go = async (t: Tab) => {
    if (t === tab) return
    if (tab === 'Profile' && !(await askDiscard())) return
    const q = new URLSearchParams(sp.toString())
    if (t === 'Profile') q.delete('tab'); else q.set('tab', TAB_SLUG[t])
    const qs = q.toString()
    router.replace(qs ? `${path}?${qs}` : (path ?? ''), { scroll: false })
  }
  const onTabKey = (ev: React.KeyboardEvent, i: number) => {
    const last = TABS.length - 1
    const next = ev.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : ev.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : ev.key === 'Home' ? 0 : ev.key === 'End' ? last : -1
    if (next < 0) return
    ev.preventDefault()
    tabRefs.current[next]?.focus()
    void go(TABS[next]!)
  }
  return (
    <HrShell title={e ? e.fullName : 'Employee'} subtitle={e ? `${e.employeeCode} · ${p?.labels.designation ?? 'No designation'} · ${p?.labels.department ?? 'No department'} · ${p?.labels.branch ?? 'No branch'}` : undefined}
      actions={e && <span className="text-xs font-black uppercase tracking-wider self-center" style={{ color: STATUS_COLOR[e.status] }}>{human(e.status)}</span>}>
      {error && <p className="text-sm text-red-700" role="alert">{(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-white/40">Loading employee…</p>}
      {p && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
            <Stat label="Gross salary" value={rs(e!.grossSalaryCents)} />
            <Stat label="Type" value={human(e!.employmentType)} />
            <Stat label="Joined" value={day(e!['joiningDate'] as string)} />
            <Stat label="Manager" value={p.labels.manager ?? '—'} />
            <Stat label="Loans outstanding" value={rs(p.loans.reduce((a, l) => a + l.outstandingCents, 0))} />
          </div>
          <div role="tablist" aria-label="Employee sections" className="flex gap-1 mb-5 overflow-x-auto">
            {TABS.map((t, i) => (
              <button key={t} ref={(el) => { tabRefs.current[i] = el }} type="button" role="tab" id={`emp-tab-${TAB_SLUG[t]}`} aria-selected={tab === t} aria-controls="emp-tabpanel"
                tabIndex={tab === t ? 0 : -1} onKeyDown={(ev) => onTabKey(ev, i)} onClick={() => void go(t)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap [@media(pointer:coarse)]:min-h-[44px] ${tab === t ? 'bg-primary text-primary-on' : 'text-white/50 border border-white/10'}`}>{t}</button>
            ))}
          </div>
          <div role="tabpanel" id="emp-tabpanel" aria-labelledby={`emp-tab-${TAB_SLUG[tab]}`}>
            {tab === 'Profile' && <ProfileTab p={p} onDirty={setDirty} />}
            {tab === 'Documents' && <DocumentsTab p={p} />}
            {tab === 'Requests' && <RequestsTab p={p} />}
            {tab === 'Leave' && <LeaveTab p={p} />}
            {tab === 'Loans & pay' && <PayTab p={p} />}
            {tab === 'Letters' && <LettersTab p={p} />}
            {tab === 'Login & clock-in' && <LoginTab p={p} />}
          </div>
        </>
      )}
    </HrShell>
  )
}

function ProfileTab({ p, onDirty }: { p: Profile; onDirty: (d: boolean) => void }) {
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
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formRef = useRef<HTMLFormElement>(null)
  const save = useMutation({
    mutationFn: () => api.patch(`/hr/employees/${p.employee.id}`, { data: value }),
    onSuccess: () => { setOk(true); setErr(''); setValue(null); void qc.invalidateQueries() },
    onError: (e: Error) => { setErr(e.message); setOk(false) },
  })
  useEffect(() => { onDirty(value !== null) }, [value, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])
  if (!form) return <p className="text-sm text-white/40">Loading format…</p>
  const v = value ?? initial()
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!value || save.isPending) return
    const found = validate(form.current.fields, v)
    setErrors(found)
    if (Object.keys(found).length > 0) { setErr(''); focusFirstInvalid(formRef.current); return }
    save.mutate()
  }
  return (
    <form ref={formRef} onSubmit={submit} noValidate className="rounded-2xl p-5" style={card}>
      <FormRenderer fields={form.current.fields} value={v} errors={errors}
        onChange={(x) => { setValue(x); setOk(false); if (Object.keys(errors).length) setErrors(validate(form.current.fields, x)) }} ctx={{ lookups, org }} />
      <div className="flex flex-wrap items-center gap-2 mt-5">
        <button type="submit" className={btn} disabled={save.isPending || !value}>{save.isPending ? 'Saving…' : 'Save changes'}</button>
        {value && <button type="button" className={btnGhost} onClick={() => { setValue(null); setErrors({}); setErr('') }}>Discard</button>}
        {value && <span className="text-xs text-white/50">Unsaved changes</span>}
      </div>
      {err && <p className="text-xs text-red-700 mt-3" role="alert">{err}</p>}
      <p className="text-xs text-primary-ink mt-3" role="status" aria-live="polite">{ok ? 'Saved.' : ''}</p>
      <p className="text-xs text-white/50 mt-3">Promotions, transfers and salary revisions should go through their own sections so they are approved and appear in the history. Editing salary here is recorded in the audit trail.</p>
    </form>
  )
}

function DocumentsTab({ p }: { p: Profile }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: types = [] } = useQuery({ queryKey: ['hr-doc-types'], queryFn: () => api.get<string[]>('/hr/documents/types') })
  const [f, setF] = useState({ docType: 'cnic_front', title: '', fileUrl: '', issueDate: '', expiryDate: '' })
  const [err, setErr] = useState('')
  const add = useMutation({
    mutationFn: () => api.post('/hr/documents', { employeeId: p.employee.id, docType: f.docType, title: f.title.trim() || undefined, fileUrl: f.fileUrl.trim() || undefined, issueDate: f.issueDate || undefined, expiryDate: f.expiryDate || undefined }),
    onSuccess: () => { setErr(''); setF({ ...f, title: '', fileUrl: '', issueDate: '', expiryDate: '' }); void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  const verify = useMutation({ mutationFn: (id: string) => api.post(`/hr/documents/${id}/verify`, {}), onSuccess: () => void qc.invalidateQueries(), onError: (e: Error) => setErr(`Could not verify: ${e.message}`) })
  const del = useMutation({ mutationFn: (id: string) => deleteWithUndo(`/hr/documents/${id}`, { trashType: 'hr_document', id, onRestored: () => void qc.invalidateQueries() }), onSuccess: () => void qc.invalidateQueries(), onError: (e: Error) => setErr(`Could not delete: ${e.message}`) })
  const soon = (d: string | null) => d && new Date(d).getTime() - Date.now() < 30 * 86_400_000
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (add.isPending) return
    if (!f.title.trim() && !f.fileUrl.trim()) { setErr('Give the document a title or a link to the file.'); return }
    if (f.issueDate && f.expiryDate && f.expiryDate < f.issueDate) { setErr('The expiry date is before the issue date.'); return }
    setErr('')
    add.mutate()
  }
  const lbl = 'block text-[11px] font-bold text-white/55 mb-1'
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-3 items-end" style={card}>
        <div><span className={lbl}>Type</span>
          <Select className={inp} value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })} aria-label="Document type">{types.map((t) => <option key={t} value={t}>{human(t)}</option>)}</Select></div>
        <label><span className={lbl}>Title</span>
          <input className={inp} placeholder="e.g. CNIC front" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoComplete="off" /></label>
        <label className="md:col-span-2"><span className={lbl}>Link to the file</span>
          <input type="url" className={inp} placeholder="https://…" value={f.fileUrl} onChange={(e) => setF({ ...f, fileUrl: e.target.value })} autoComplete="off" /></label>
        <label><span className={lbl}>Issue date</span>
          <input type="date" className={inp} value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} /></label>
        <label><span className={lbl}>Expiry date</span>
          <input type="date" className={inp} value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} /></label>
        <button type="submit" className={`${btn} sm:col-span-2 md:col-span-6 md:justify-self-start`} disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add document'}</button>
      </form>
      {err && <p className="text-xs text-red-700" role="alert">{err}</p>}
      <div className="rounded-2xl overflow-hidden" style={card}>
        {p.documents.length === 0 && <p className="p-6 text-sm text-white/40 text-center">No documents yet.</p>}
        {p.documents.map((d) => (
          <div key={d.id} className="px-4 py-3 border-t border-white/[0.05] first:border-t-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-bold text-white/85 sm:w-48 shrink-0">{d.title || human(d.docType)}</span>
            {d.fileUrl ? <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-primary-ink text-xs hover:underline">Open</a> : <span className="text-xs text-white/30">No file</span>}
            <span className="text-xs" style={{ color: soon(d.expiryDate) ? '#a15c00' : 'rgb(var(--fg-rgb) / 0.45)' }}>{d.expiryDate ? `Expires ${day(d.expiryDate)}` : ''}</span>
            <span className="ml-auto flex gap-1">
              {d.verifiedAt ? <span className="text-xs text-primary-ink">Verified</span> : <button type="button" className="text-xs text-white/50 hover:text-white px-2 py-2 [@media(pointer:coarse)]:min-h-[44px]" disabled={verify.isPending} onClick={() => verify.mutate(d.id)}>Mark verified</button>}
              <button type="button" className="text-xs text-white/50 hover:text-red-700 px-2 py-2 [@media(pointer:coarse)]:min-h-[44px]" onClick={async () => {
                const ok = await confirm({ title: 'Delete this document?', body: `${d.title || human(d.docType)} will be removed from ${p.employee.fullName}'s file.`, confirmLabel: 'Delete', danger: true })
                if (ok) del.mutate(d.id)
              }}>Delete</button>
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
          <p className="text-3xl font-black mt-1" style={{ color: b.balance < 0 ? 'var(--erp-danger)' : '#3f7d20' }}>{b.balance}</p>
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
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-white/85">Linked to <strong>{p.user.name}</strong> ({p.user.email ?? 'no email'}, {human(p.user.role)})</p>
              {p.user.status && <LoginStatusChip status={p.user.status} />}
              <button className={btnGhost} onClick={() => link.mutate(null)}>Unlink</button>
            </div>
            <OffboardButtons login={p.user} onDone={() => void qc.invalidateQueries()} />
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
        {!p.user && <CreateLoginForm p={p} />}
      </div>
      <KioskPinCard p={p} />
      <WorkLocationsCard p={p} />
    </div>
  )
}

const LOGIN_STATUS: Record<'pending' | 'active' | 'suspended', { label: string; color: string }> = {
  pending:   { label: 'Waiting for the CEO', color: 'var(--erp-warning)' },
  active:    { label: 'Active',              color: 'var(--erp-success)' },
  suspended: { label: 'Offboarded',          color: 'var(--erp-danger)' },
}
function LoginStatusChip({ status }: { status: 'pending' | 'active' | 'suspended' }) {
  const m = LOGIN_STATUS[status]
  return <span className="text-[10px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5"
    style={{ color: m.color, background: `color-mix(in srgb, ${m.color} 12%, transparent)` }}>{m.label}</span>
}

/** Create a login for this employee (POST /auth/staff/invite, employeeId sent). Roles come from GET /permissions/me →
 *  childRoles. HR's floor logins (cashier, FOH, BOH, kitchen, expediter) are active at once and linked here; manager
 *  and office logins wait for the CEO in the approvals inbox and link when approved. */
function CreateLoginForm({ p }: { p: Profile }) {
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const childRoles = me?.childRoles ?? []
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(p.employee.fullName)
  const [email, setEmail] = useState(typeof p.employee.personalEmail === 'string' ? p.employee.personalEmail : '')
  const [phone, setPhone] = useState(typeof p.employee.phone === 'string' ? p.employee.phone : '')
  const [role, setRole] = useState('')
  const [err, setErr] = useState('')
  const [done, setDone] = useState<{ status: string; linked: boolean } | null>(null)
  const create = useMutation({
    mutationFn: () => api.post<{ status: string; linkedEmployeeId?: string | null }>('/auth/staff/invite', {
      name: name.trim(), email: email.trim(), role, employeeId: p.employee.id, ...(phone.trim() ? { phone: phone.trim() } : {}),
    }),
    onSuccess: (r) => { setErr(''); setDone({ status: r?.status ?? 'pending', linked: !!r?.linkedEmployeeId }); setOpen(false); void qc.invalidateQueries() },
    onError: (e: Error) => setErr(e.message),
  })
  if (childRoles.length === 0) return null
  if (done) {
    return (
      <p className="text-sm text-white/70 mt-3">
        {done.status === 'active'
          ? `Login created and active now${done.linked ? ' — linked to this employee' : ''}.`
          : 'Login created — waiting for the CEO to approve it in the approvals inbox. It links to this employee when approved.'}
      </p>
    )
  }
  if (!open) return <button type="button" className={`${btn} mt-3`} onClick={() => setOpen(true)}>Create login</button>
  return (
    <form className="mt-4 space-y-2 border-t border-white/10 pt-4" onSubmit={(e) => { e.preventDefault(); if (!create.isPending) create.mutate() }}>
      <p className="text-sm font-black text-white/85">Create login</p>
      <input className={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" />
      <input className={inp} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Company email" aria-label="Email" type="email" />
      <input className={inp} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Mobile (needed for floor staff)" aria-label="Mobile" />
      <Select className={inp} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
        <option value="">Choose a role…</option>
        {childRoles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
      </Select>
      <p className="text-xs text-white/45">
        {!role ? 'Floor staff (cashier, FOH, BOH, kitchen, expediter) can sign in at once; manager and office logins wait for the CEO.'
          : FLOOR_LOGIN_ROLES.includes(role) && (me?.role === 'hr' || me?.role === 'admin')
            ? 'Active at once — they sign in with a code sent to this mobile.'
            : 'Waits for the CEO to approve it.'}
      </p>
      {err && <p className="text-xs text-red-700">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" className={btn} disabled={!role || !name.trim() || !email.trim() || create.isPending}>{create.isPending ? 'Creating…' : 'Create login'}</button>
        <button type="button" className={btnGhost} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  )
}

interface WorkLoc { locationId: string; name?: string; radiusMetres: number | null; isPrimary: boolean; hasPin?: boolean }
interface LocationOpt { id: string; name: string; tenantId?: string | null; latitude?: number | string | null; longitude?: number | string | null }

/** Where this person may punch (owner, 2026-10-15). One or more of the company's locations; the time clock measures
 *  every punch against them. A punch outside is never refused — it is recorded and flagged for HR. */
function WorkLocationsCard({ p }: { p: Profile }) {
  const qc = useQueryClient()
  const empId = p.employee.id
  const { data: saved } = useQuery({ queryKey: ['hr-work-locations', empId], queryFn: () => api.get<{ items: WorkLoc[] }>(`/hr/employees/${empId}/work-locations`) })
  const { data: all = [] } = useQuery({ queryKey: ['locations'], queryFn: () => api.get<LocationOpt[]>('/locations') })
  const [items, setItems] = useState<WorkLoc[] | null>(null)
  const [add, setAdd] = useState('')
  const [msg, setMsg] = useState('')
  const [ok, setOk] = useState(false)
  // Only the employee's own company's locations (the API refuses any other).
  const mine = all.filter((l) => !l.tenantId || l.tenantId === p.employee.tenantId)
  const cur = items ?? saved?.items ?? []
  const pinOf = (id: string) => {
    const l = mine.find((x) => x.id === id)
    if (l) return l.latitude != null && l.longitude != null && l.latitude !== '' && l.longitude !== ''
    return cur.find((c) => c.locationId === id)?.hasPin ?? true
  }
  const nameOf = (id: string) => mine.find((x) => x.id === id)?.name ?? cur.find((c) => c.locationId === id)?.name ?? id
  const edit = (next: WorkLoc[]) => { setItems(next); setOk(false); setMsg('') }
  const save = useMutation({
    mutationFn: () => api.put(`/hr/employees/${empId}/work-locations`, { items: cur.map((c) => ({ locationId: c.locationId, radiusMetres: c.radiusMetres ?? null, isPrimary: c.isPrimary })) }),
    onSuccess: () => { setOk(true); setMsg(''); setItems(null); void qc.invalidateQueries({ queryKey: ['hr-work-locations', empId] }); void qc.invalidateQueries({ queryKey: ['hr-employee'] }) },
    onError: (e: Error) => { setMsg(e.message); setOk(false) },
  })
  const available = mine.filter((l) => !cur.some((c) => c.locationId === l.id))
  return (
    <div className="rounded-2xl p-5 lg:col-span-2" style={card}>
      <p className="text-sm font-black text-white/85 mb-2">Work locations</p>
      <p className="text-sm text-white/60 mb-3">Where this person works. Their clock-in is measured against these. A punch from anywhere else is still recorded, and flagged for HR.</p>
      {cur.length === 0 && <p className="text-xs text-white/45 mb-3">None set — punches are measured against all of the company&rsquo;s locations.</p>}
      <div className="space-y-2 mb-3">
        {cur.map((c) => (
          <div key={c.locationId} className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
            <span className="text-sm font-bold text-white/85 min-w-[140px]">{nameOf(c.locationId)}</span>
            <label className="flex items-center gap-1.5 text-xs text-white/60">
              <input type="radio" name="primary-work-location" checked={c.isPrimary} onChange={() => edit(cur.map((x) => ({ ...x, isPrimary: x.locationId === c.locationId })))} /> Primary
            </label>
            <input className={`${inp} max-w-[150px]`} inputMode="numeric" placeholder="Radius (m)" aria-label={`Radius in metres for ${nameOf(c.locationId)}`}
              value={c.radiusMetres ?? ''} onChange={(e) => { const n = e.target.value.replace(/\D/g, ''); edit(cur.map((x) => x.locationId === c.locationId ? { ...x, radiusMetres: n ? Number(n) : null } : x)) }} />
            {!pinOf(c.locationId) && <span className="text-[11px]" style={{ color: 'var(--erp-danger)' }}>No map pin — punches here cannot be measured. Set the pin under Configuration → Locations.</span>}
            <button className="ml-auto text-xs text-white/40 hover:text-red-700" onClick={() => {
              const rest = cur.filter((x) => x.locationId !== c.locationId)
              edit(rest.length && !rest.some((x) => x.isPrimary) ? rest.map((x, i) => ({ ...x, isPrimary: i === 0 })) : rest)
            }}>Remove</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2 max-w-md">
        <Select className={inp} value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Add a work location">
          <option value="">Add a location…</option>
          {available.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <button className={btnGhost} disabled={!add || cur.length >= 10} onClick={() => { edit([...cur, { locationId: add, radiusMetres: null, isPrimary: cur.length === 0 }]); setAdd('') }}>Add</button>
      </div>
      <p className="text-[11px] text-white/35 mt-2">Radius is optional — blank uses the location&rsquo;s own radius, then the company&rsquo;s. The primary location is shown as the Branch Location.</p>
      {msg && <p className="text-xs text-red-700 mt-2">{msg}</p>}
      {ok && <p className="text-xs text-primary-ink mt-2">Saved.</p>}
      <div className="flex gap-2 mt-3">
        <button className={btn} disabled={!items || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save work locations'}</button>
        {items && <button className={btnGhost} onClick={() => { setItems(null); setMsg('') }}>Discard</button>}
      </div>
    </div>
  )
}

function KioskPinCard({ p }: { p: Profile }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState('')
  const [bad, setBad] = useState(false)
  const save = useMutation({
    mutationFn: () => api.post(`/hr/employees/${p.employee.id}/kiosk-pin`, { pin }),
    onSuccess: () => { setPin(''); setBad(false); setMsg('PIN set. Tell them in person — it is not shown again.'); void qc.invalidateQueries({ queryKey: ['hr-employee'] }) },
    onError: (e: Error) => { setBad(true); setMsg(e.message) },
  })
  const clear = useMutation({
    mutationFn: () => api.delete(`/hr/employees/${p.employee.id}/kiosk-pin`),
    onSuccess: () => { setBad(false); setMsg('PIN removed.'); void qc.invalidateQueries({ queryKey: ['hr-employee'] }) },
    onError: (e: Error) => { setBad(true); setMsg(e.message) },
  })
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (save.isPending) return
    if (pin.length < 4) { setBad(true); setMsg('The PIN is 4 to 6 digits.'); return }
    setMsg(''); save.mutate()
  }
  const remove = async () => {
    const ok = await confirm({ title: 'Remove the kiosk PIN?', body: `${p.employee.fullName} will no longer be able to punch at the kiosk until a new PIN is set.`, confirmLabel: 'Remove PIN', danger: true })
    if (ok) clear.mutate()
  }
  return (
    <div className="rounded-2xl p-5" style={card}>
      <p className="text-sm font-black text-white/85 mb-2">Kiosk PIN</p>
      <p className="text-sm text-white/60 mb-3">For staff without a login: they punch in and out at the shared time clock with their employee ID <strong>{p.employee.employeeCode}</strong> and this PIN. Each punch writes their attendance for the day.</p>
      {p.user ? (
        <p className="text-xs text-white/45">This person has a login, so they clock in with it — no kiosk PIN needed.</p>
      ) : (
        <form onSubmit={submit}>
          <p className="text-xs mb-2" style={{ color: p.kioskPinSet ? '#3f7d20' : 'rgb(var(--fg-rgb) / 0.45)' }}>{p.kioskPinSet ? 'A PIN is set.' : 'No PIN yet.'}</p>
          <div className="flex flex-wrap gap-2">
            <PasswordInput numeric className={inp} wrapperClassName="flex-1 min-w-[160px]" maxLength={6} autoComplete="new-password" placeholder="4–6 digits"
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} aria-label="New kiosk PIN" aria-invalid={bad && pin.length < 4 ? true : undefined} />
            <button type="submit" className={btn} disabled={pin.length < 4 || save.isPending}>{save.isPending ? 'Saving…' : p.kioskPinSet ? 'Change' : 'Set'}</button>
            {p.kioskPinSet && <button type="button" className={btnGhost} disabled={clear.isPending} onClick={() => void remove()}>Remove</button>}
          </div>
        </form>
      )}
      {msg && <p className={`text-xs mt-2 ${bad ? 'text-red-700' : 'text-white/60'}`} role={bad ? 'alert' : 'status'}>{msg}</p>}
    </div>
  )
}
