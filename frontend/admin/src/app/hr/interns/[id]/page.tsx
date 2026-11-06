'use client'
// One intern (HR → Interns → profile): Overview, Attendance, Stipends, Documents, Certificates, History. The buttons
// shown depend on the intern's status and the caller's role (HR / the CEO); the server decides for real.

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { fmtPkr } from '../../../../lib/money'
import { btn, btnGhost, card, rs } from '../../../../lib/hr'
import {
  CERT_BADGE, EVENT_LABEL, INTERN_BADGE, RUN_BADGE, RUN_STATUS_LABEL, addMonths, durationLabel, errText, monthLabel, pktToday, shortDate, shortDateTime, thisMonth,
  useInternLookups, ymd, type AttendanceStatus, type InternDetail, type InternEvent, type InternLookups,
} from '../../../../lib/interns'
import { HrShell, useHrAccess } from '../../../../components/hr/HrShell'
import { InternForm } from '../../../../components/hr/interns/InternForm'
import { MonthDays } from '../../../../components/hr/interns/MonthDays'
import { AttendanceLegend, type AttendanceIntern } from '../../../../components/hr/interns/AttendanceTab'
import { ActionDialog, Badge, ErrorBox, Fact, LoadState, Note, PdfActions, Tabs } from '../../../../components/hr/interns/ui'
import { RecordFiles } from '../../../../components/files/RecordFiles'
import { PayslipPdfButtons } from '../../../../components/hr/SalaryBreakup'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Modal } from '../../../../components/hr/HrShell'
import { Select } from '@/components/ui/Select'
import { inp } from '../../../../lib/hr'

const TABS = [['overview', 'Overview'], ['attendance', 'Attendance'], ['stipends', 'Stipends'], ['documents', 'Documents'], ['certificates', 'Certificates'], ['history', 'History']] as const
type Tab = (typeof TABS)[number][0]
type Dialog = null | 'extend' | 'complete' | 'terminate' | 'reject' | 'login' | 'generate' | 'reissue'

export default function InternProfilePage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { role, isHrAdmin } = useHrAccess()
  const ceo = role === 'admin'
  const { data: lk } = useInternLookups()
  const [tab, setTab] = useState<Tab>('overview')
  const [editing, setEditing] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [err, setErr] = useState('')
  const { data: i, error, isLoading, refetch } = useQuery({ queryKey: ['intern', id], queryFn: () => api.get<InternDetail>(`/hr/interns/${id}`) })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['intern', id] })
    void qc.invalidateQueries({ queryKey: ['interns'] })
    void qc.invalidateQueries({ queryKey: ['intern-dashboard'] })
    void qc.invalidateQueries({ queryKey: ['intern-attendance'] })
  }
  const act = useMutation({
    mutationFn: (what: 'submit' | 'approve') => api.post(`/hr/interns/${id}/${what}`, {}),
    onSuccess: () => { setErr(''); refresh() },
    onError: (e) => setErr(errText(e)),
  })
  const post = (path: string, body: unknown) => async () => { await api.post(`/hr/interns/${id}/${path}`, body); setErr(''); refresh() }

  async function ask(what: 'submit' | 'approve') {
    if (!i) return
    const ok = await confirm(what === 'submit'
      ? { title: ceo ? `Enroll ${i.fullName} now?` : `Submit ${i.fullName} for approval?`, body: ceo ? 'As the CEO your own submission makes the intern active at once.' : 'The CEO approves the enrolment. You can still edit it until then.', confirmLabel: ceo ? 'Enroll' : 'Submit' }
      : { title: `Approve ${i.fullName}?`, body: 'The intern becomes active: attendance and stipends can start.', confirmLabel: 'Approve' })
    if (ok) act.mutate(what)
  }

  const closed = !!i && (i.status === 'completed' || i.status === 'terminated')
  const liveCert = i?.certificates.find((c) => !c.supersededAt) ?? null

  return (
    <HrShell title={i ? i.fullName : 'Intern'} subtitle={i ? `${i.internCode}${i.department ? ` · ${i.department}` : ''}${i.designation ? ` · ${i.designation}` : ''}` : undefined}
      actions={<Link href="/hr/interns?tab=register" className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white">Back to register</Link>}>
      <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
      {i && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge cls={INTERN_BADGE[i.status] ?? 's-badge-muted'}>{i.statusLabel}</Badge>
            <Badge cls={CERT_BADGE[i.certificateStatus] ?? 's-badge-muted'}>Certificate: {i.certificateStatusLabel}</Badge>
            <Badge cls={i.internshipType === 'paid' ? 's-badge-green' : 's-badge-muted'}>{i.internshipType === 'paid' ? `Paid · ${rs(i.monthlyStipendCents)}/month` : 'Unpaid'}</Badge>
            {isHrAdmin && (
              <span className="ml-auto flex flex-wrap gap-2">
                {!editing && <button type="button" className={btnGhost} onClick={() => { setTab('overview'); setEditing(true) }}>Edit</button>}
                {i.status === 'draft' && <button type="button" className={btn} disabled={act.isPending} onClick={() => void ask('submit')}>{ceo ? 'Enroll now' : 'Submit for approval'}</button>}
                {i.status === 'pending_approval' && ceo && <>
                  <button type="button" className={btn} disabled={act.isPending} onClick={() => void ask('approve')}>Approve</button>
                  <button type="button" className={btnGhost} onClick={() => setDialog('reject')}>Reject</button>
                </>}
                {i.status === 'active' && <>
                  <button type="button" className={btnGhost} onClick={() => setDialog('extend')}>Extend</button>
                  <button type="button" className={btn} onClick={() => setDialog('complete')}>Mark completed</button>
                </>}
                {(i.status === 'draft' || i.status === 'pending_approval' || i.status === 'active') && (
                  <button type="button" className="s-btn-danger text-sm font-black" onClick={() => setDialog('terminate')}>Terminate</button>
                )}
              </span>
            )}
          </div>
          <ErrorBox message={err} />
          {i.status === 'draft' && i.rejectionNote && <Note tone="bad">Sent back by the CEO: {i.rejectionNote}</Note>}
          {i.status === 'pending_approval' && <Note tone="warn">Waiting for the CEO&rsquo;s approval.{ceo ? '' : ' You can still edit the details.'}</Note>}
          {i.status === 'terminated' && <Note tone="bad">Terminated effective {shortDate(i.terminationEffectiveDate)}{i.terminationReason ? ` — ${i.terminationReason}` : ''}</Note>}

          <Tabs tabs={TABS} value={tab} onChange={(t) => { setTab(t); if (t !== 'overview') setEditing(false) }} label="Intern" />

          {tab === 'overview' && (editing
            ? <div className="max-w-4xl"><InternForm mode="edit" intern={i} onSaved={() => { setEditing(false); refresh() }} onCancel={() => setEditing(false)} /></div>
            : <Overview i={i} lk={lk} canLink={isHrAdmin} onLink={() => setDialog('login')} />)}
          {tab === 'attendance' && <AttendanceView i={i} lk={lk} canMark={isHrAdmin && (i.status === 'active' || closed)} />}
          {tab === 'stipends' && <Stipends i={i} />}
          {tab === 'documents' && (
            <div className="rounded-2xl p-4 sm:p-5 max-w-3xl" style={card}>
              <RecordFiles ownerType="intern_document" ownerId={i.id} tenantId={i.tenantId} canUpload={isHrAdmin} title="Documents (CNIC / B-form, student card, NOC, CV)" emptyText="No documents attached yet." />
            </div>
          )}
          {tab === 'certificates' && (
            <Certificates i={i} liveCertId={liveCert?.id ?? null} canAct={isHrAdmin}
              onGenerate={() => setDialog('generate')} onReissue={() => setDialog('reissue')} onChanged={refresh} />
          )}
          {tab === 'history' && <History events={i.events} lk={lk} />}
        </div>
      )}

      {i && dialog === 'extend' && (
        <ActionDialog title={`Extend ${i.fullName}'s internship`} submitLabel="Extend" onClose={() => setDialog(null)}
          intro={<>Current end date: <b>{i.endDate ? shortDate(i.endDate) : 'none (open-ended)'}</b>. The new end date must be later.</>}
          fields={[
            { key: 'endDate', label: 'New end date', kind: 'date', required: true, minDate: i.endDate ? ymd(i.endDate) : undefined, initial: '' },
            { key: 'reason', label: 'Reason', kind: 'textarea', min: 10 },
          ]}
          onSubmit={(v) => post('extend', { endDate: v['endDate'], reason: v['reason'] })()} />
      )}
      {i && dialog === 'complete' && (
        <ActionDialog title={`Mark ${i.fullName} as completed`} submitLabel="Mark completed" onClose={() => setDialog(null)}
          intro="The internship ends. A certificate can then be generated."
          fields={[
            { key: 'completedOn', label: 'Completed on', kind: 'date', required: true, initial: pktToday(), max: pktToday() },
            { key: 'remarks', label: 'Final remarks (optional)', kind: 'textarea' },
          ]}
          onSubmit={(v) => post('complete', { completedOn: v['completedOn'], ...(v['remarks'] && { remarks: v['remarks'] }) })()} />
      )}
      {i && dialog === 'terminate' && (
        <ActionDialog title={`Terminate ${i.fullName}'s internship`} submitLabel="Terminate" danger onClose={() => setDialog(null)}
          intro="This ends the internship. It cannot be undone."
          fields={[
            { key: 'effectiveDate', label: 'Effective date', kind: 'date', required: true, initial: pktToday() },
            { key: 'reason', label: 'Reason', kind: 'textarea', min: 10 },
          ]}
          onSubmit={(v) => post('terminate', { reason: v['reason'], effectiveDate: v['effectiveDate'] })()} />
      )}
      {i && dialog === 'reject' && (
        <ActionDialog title={`Send ${i.fullName}'s enrolment back`} submitLabel="Send back" onClose={() => setDialog(null)}
          intro="The enrolment returns to draft with your note; HR fixes it and submits again."
          fields={[{ key: 'note', label: 'What needs correcting', kind: 'textarea', min: 10 }]}
          onSubmit={(v) => post('reject', { note: v['note'] })()} />
      )}
      {i && dialog === 'generate' && (
        <ActionDialog title="Generate the Certificate of Internship" submitLabel="Generate" onClose={() => setDialog(null)}
          fields={[{ key: 'remarks', label: 'Remarks printed on the certificate (optional)', kind: 'textarea' }]}
          onSubmit={(v) => post('certificates', v['remarks'] ? { remarks: v['remarks'] } : {})()} />
      )}
      {i && dialog === 'reissue' && (
        <ActionDialog title="Re-issue the certificate" submitLabel="Re-issue" onClose={() => setDialog(null)}
          intro="A new certificate with a new number replaces the current one; the old one stays in the history as superseded."
          fields={[
            { key: 'reason', label: 'Reason', kind: 'textarea', min: 10 },
            { key: 'remarks', label: 'Remarks printed on the certificate (optional)', kind: 'textarea' },
          ]}
          onSubmit={(v) => post('certificates/reissue', { reason: v['reason'], ...(v['remarks'] && { remarks: v['remarks'] }) })()} />
      )}
      {i && dialog === 'login' && <LoginLinkModal intern={i} onClose={() => setDialog(null)} onDone={refresh} />}
    </HrShell>
  )
}

function Overview({ i, lk, canLink, onLink }: { i: InternDetail; lk: InternLookups | undefined; canLink: boolean; onLink: () => void }) {
  const group = (title: string, children: React.ReactNode) => (
    <section className="rounded-2xl p-4 sm:p-5" style={card}>
      <h2 className="text-sm font-black text-white/90 mb-3">{title}</h2>
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  )
  return (
    <div className="space-y-4">
      {group('Personal', <>
        <Fact label="Intern ID">{i.internCode}</Fact><Fact label="Full name">{i.fullName}</Fact><Fact label="Father / guardian">{i.fatherName}</Fact>
        <Fact label="CNIC / B-form">{i.cnic}</Fact><Fact label="Date of birth">{i.dateOfBirth ? shortDate(i.dateOfBirth) : ''}</Fact><Fact label="Gender">{i.gender ? i.gender[0]!.toUpperCase() + i.gender.slice(1) : ''}</Fact>
        <Fact label="Phone">{i.phone}</Fact><Fact label="Email">{i.email}</Fact><Fact label="Address">{i.address}</Fact>
        <Fact label="Emergency contact">{[i.emergencyContactName, i.emergencyContactPhone].filter(Boolean).join(' · ')}</Fact>
      </>)}
      {group('Academic', <>
        <Fact label="Institution">{i.institution}</Fact><Fact label="Degree / program">{i.degree}</Fact><Fact label="Field of study">{i.fieldOfStudy}</Fact>
        <Fact label="Semester / year">{i.semester}</Fact><Fact label="Student ID / reg. no.">{i.studentRegNo}</Fact>
      </>)}
      {group('Internship', <>
        <Fact label="Department">{i.department}</Fact><Fact label="Position">{i.designation}</Fact>
        <Fact label="Supervisor">{i.supervisor ? `${i.supervisor.fullName} · ${i.supervisor.employeeCode}` : ''}</Fact>
        <Fact label="Start date">{shortDate(i.startDate)}</Fact><Fact label="End date">{i.endDate ? shortDate(i.endDate) : 'Open-ended'}</Fact>
        <Fact label="Duration">{durationLabel(i.startDate, i.completedOn ?? i.terminationEffectiveDate ?? i.endDate)}</Fact>
        <Fact label="Type">{i.internshipType === 'paid' ? 'Paid' : 'Unpaid'}</Fact>
        <Fact label="Monthly stipend">{i.internshipType === 'paid' ? fmtPkr(i.monthlyStipendCents) : ''}</Fact>
        <Fact label="Working days">{[...i.workingDays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => lk?.weekdays.find((w) => w.value === d)?.label ?? d).join(', ')}</Fact>
        <Fact label="Working hours">{i.workingHours}</Fact>
        {i.completedOn && <Fact label="Completed on">{shortDate(i.completedOn)}</Fact>}
        {i.terminationEffectiveDate && <Fact label="Terminated on">{shortDate(i.terminationEffectiveDate)}</Fact>}
      </>)}
      <section className="rounded-2xl p-4 sm:p-5" style={card}>
        <h2 className="text-sm font-black text-white/90 mb-3">Remarks and login</h2>
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Fact label="Performance remarks"><span className="whitespace-pre-wrap">{i.performanceRemarks}</span></Fact>
          <Fact label="servd login">
            {i.login ? <>{i.login.name} · {i.login.email ?? i.login.role}</> : <span className="text-white/60">Not linked (optional)</span>}
            {canLink && <button type="button" className="ml-2 text-xs font-bold text-primary-ink underline" onClick={onLink}>{i.login ? 'Change' : 'Link a login'}</button>}
          </Fact>
        </div>
      </section>
    </div>
  )
}

function AttendanceView({ i, lk, canMark }: { i: InternDetail; lk: InternLookups | undefined; canMark: boolean }) {
  const qc = useQueryClient()
  const [month, setMonth] = useState(thisMonth())
  const [err, setErr] = useState('')
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['intern-attendance', 'one', i.id, month],
    queryFn: () => api.get<{ interns: AttendanceIntern[] }>(`/hr/interns/attendance?${new URLSearchParams({ month, internId: i.id })}`),
    enabled: i.status === 'active' || i.status === 'completed' || i.status === 'terminated',
  })
  const mark = useMutation({
    mutationFn: (v: { date: string; status: AttendanceStatus }) => api.put(`/hr/interns/${i.id}/attendance/${v.date}`, { status: v.status }),
    onSuccess: () => { setErr(''); void qc.invalidateQueries({ queryKey: ['intern-attendance'] }); void qc.invalidateQueries({ queryKey: ['intern', i.id] }) },
    onError: (e) => setErr(errText(e)),
  })
  if (i.status === 'draft' || i.status === 'pending_approval') return <Note tone="info">Attendance is kept for approved interns only.</Note>
  const row = data?.interns[0]
  const label = (s: string) => lk?.attendanceLabels[s] ?? s
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex flex-wrap items-end gap-1">
        <button type="button" className={`${btnGhost} !px-3`} aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
        <label className="text-[11px] text-white/55">Month<input type="month" className={`${inp} mt-0.5`} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
        <button type="button" className={`${btnGhost} !px-3`} aria-label="Next month" disabled={month >= thisMonth()} onClick={() => setMonth(addMonths(month, 1))}>›</button>
      </div>
      <AttendanceLegend labels={lk?.attendanceLabels} />
      <ErrorBox message={err} />
      <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
      {data && !row && <Note tone="info">{i.fullName} was not engaged in {monthLabel(month)}.</Note>}
      {row && (
        <>
          <p className="text-sm text-white/80 flex flex-wrap gap-x-4 gap-y-1">
            {Object.entries(row.summary).filter(([, n]) => n > 0).map(([s, n]) => <span key={s}><b>{n}</b> {label(s)}</span>)}
            {!Object.values(row.summary).some((n) => n > 0) && <span className="text-white/55">Nothing marked this month.</span>}
          </p>
          <div className="rounded-2xl p-3 sm:p-4" style={card}>
            <MonthDays month={month} days={row.days} startDate={row.startDate} lastDay={row.lastDay} workingDays={row.workingDays} labels={lk?.attendanceLabels}
              onSet={canMark ? (date, status) => mark.mutate({ date, status }) : undefined} busy={mark.isPending} />
          </div>
          {canMark && <p className="text-[11px] text-white/50">Tap a day to set its status. A month whose stipend payroll has left draft is locked.</p>}
        </>
      )}
    </div>
  )
}

function Stipends({ i }: { i: InternDetail }) {
  if (i.internshipType !== 'paid' && i.stipends.length === 0) return <Note tone="info">This is an unpaid internship — no stipends.</Note>
  if (i.stipends.length === 0) return <Note tone="info">No stipend has been calculated yet. It appears once a stipend payroll includes this intern.</Note>
  return (
    <div className="rounded-2xl overflow-x-auto max-w-3xl" style={card}>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs uppercase tracking-wider text-white/55">{['Month', 'Payroll', 'Paid days', 'Net', 'Slip'].map((h) => <th key={h} className={`px-4 py-3 font-bold whitespace-nowrap${h === 'Net' ? ' text-right' : ''}`}>{h}</th>)}</tr></thead>
        <tbody>
          {i.stipends.map((s) => (
            <tr key={s.slipId} className="border-t border-white/[0.05]">
              <td className="px-4 py-3 font-bold text-white/90 whitespace-nowrap"><Link href={`/hr/interns/payroll/${s.runId}`} className="hover:underline">{monthLabel(s.period)}</Link></td>
              <td className="px-4 py-3"><Badge cls={RUN_BADGE[s.runStatus] ?? 's-badge-muted'}>{RUN_STATUS_LABEL[s.runStatus] ?? s.runStatus}</Badge></td>
              <td className="px-4 py-3 text-white/75">{s.paidDays}</td>
              <td className="px-4 py-3 font-bold text-white/90 whitespace-nowrap text-right tabular-nums">{fmtPkr(s.netCents)}</td>
              <td className="px-4 py-3"><PayslipPdfButtons path={`/hr/interns/payroll/slips/${s.slipId}/pdf`} filename={`stipend-slip-${i.internCode}-${s.period}`} className="text-xs font-bold text-primary-ink underline" label="slip" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Certificates({ i, liveCertId, canAct, onGenerate, onReissue, onChanged }: {
  i: InternDetail; liveCertId: string | null; canAct: boolean; onGenerate: () => void; onReissue: () => void; onChanged: () => void
}) {
  const [err, setErr] = useState('')
  const issue = useMutation({
    mutationFn: (certId: string) => api.post(`/hr/interns/certificates/${certId}/issue`, {}),
    onSuccess: () => { setErr(''); onChanged() },
    onError: (e) => setErr(errText(e)),
  })
  const live = i.certificates.find((c) => c.id === liveCertId) ?? null
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex flex-wrap items-center gap-2">
        <Badge cls={CERT_BADGE[i.certificateStatus] ?? 's-badge-muted'}>{i.certificateStatusLabel}</Badge>
        {i.certificateNumber && <span className="text-sm text-white/70">{i.certificateNumber}</span>}
      </div>
      {i.status !== 'completed' && !live && <Note tone="info">A certificate can be generated once the internship is marked completed.</Note>}
      <ErrorBox message={err} />
      {canAct && (
        <div className="flex flex-wrap gap-2">
          {i.status === 'completed' && !live && <button type="button" className={btn} onClick={onGenerate}>Generate certificate</button>}
          {live?.status === 'generated' && <button type="button" className={btn} disabled={issue.isPending} onClick={() => issue.mutate(live.id)}>{issue.isPending ? 'Issuing…' : 'Issue certificate'}</button>}
          {live && <button type="button" className={btnGhost} onClick={onReissue}>Re-issue</button>}
        </div>
      )}
      {i.certificates.length === 0 ? <p className="text-sm text-white/55">No certificates yet.</p> : (
        <ul className="space-y-3">
          {i.certificates.map((c) => (
            <li key={c.id} className="rounded-2xl p-4" style={card}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-black text-white/90">{c.number}</span>
                <Badge cls={CERT_BADGE[c.status] ?? 's-badge-muted'}>{c.status === 'reissued' ? 'Re-issued' : c.status[0]!.toUpperCase() + c.status.slice(1)}</Badge>
                {c.supersededAt && <Badge cls="s-badge-muted">Superseded</Badge>}
              </div>
              <p className="text-xs text-white/60 mt-1">
                Generated {shortDateTime(c.createdAt)}{c.issuedAt ? ` · issued ${shortDateTime(c.issuedAt)}` : ''}
                {c.reissueReason ? ` · re-issued because: ${c.reissueReason}` : ''}
              </p>
              {c.remarks && <p className="text-xs text-white/70 mt-1">Remarks: {c.remarks}</p>}
              {canAct && <div className="mt-3"><PdfActions path={`/hr/interns/certificates/${c.id}/pdf`} filename={`certificate-${c.number}`} label="certificate" /></div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Before → after of an event's changed values, with ids turned into names. */
function changeLines(e: InternEvent, lk: InternLookups | undefined): string[] {
  const after = e.after && typeof e.after === 'object' ? (e.after as Record<string, unknown>) : null
  if (!after) return []
  const before = e.before && typeof e.before === 'object' ? (e.before as Record<string, unknown>) : {}
  const nice = (k: string, v: unknown): string => {
    if (v == null || v === '') return '—'
    if (k === 'departmentId') return lk?.departments.find((d) => d.id === v)?.name ?? String(v)
    if (k === 'supervisorEmployeeId') return lk?.supervisors.find((s) => s.id === v)?.fullName ?? String(v)
    if (k === 'monthlyStipendCents') return fmtPkr(Number(v))
    if (/Date$|^endDate$|^startDate$/.test(k)) return shortDate(String(v))
    return String(v)
  }
  const names: Record<string, string> = { departmentId: 'Department', supervisorEmployeeId: 'Supervisor', monthlyStipendCents: 'Monthly stipend', internshipType: 'Type', startDate: 'Start', endDate: 'End', status: 'Status', number: 'Certificate' }
  return Object.keys(after).filter((k) => k !== 'userId' && k in names).map((k) => `${names[k]}: ${nice(k, before[k])} → ${nice(k, after[k])}`)
}

function History({ events, lk }: { events: InternEvent[]; lk: InternLookups | undefined }) {
  if (events.length === 0) return <p className="text-sm text-white/55">No history yet.</p>
  return (
    <ol className="max-w-3xl space-y-0">
      {events.map((e) => (
        <li key={e.id} className="relative pl-6 pb-5 border-l border-white/[0.12] ml-2">
          <span aria-hidden="true" className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full" style={{ background: 'var(--erp-primary)' }} />
          <p className="text-sm font-black text-white/90">{EVENT_LABEL[e.kind] ?? e.kind.replace(/_/g, ' ')}{e.effectiveDate ? <span className="font-normal text-white/60"> · effective {shortDate(e.effectiveDate)}</span> : null}</p>
          <p className="text-xs text-white/55">{shortDateTime(e.createdAt)}{e.actorName ? ` · ${e.actorName}` : ''}</p>
          {e.note && <p className="text-sm text-white/75 mt-1 whitespace-pre-wrap break-words">{e.note}</p>}
          {changeLines(e, lk).map((l) => <p key={l} className="text-xs text-white/65 mt-0.5">{l}</p>)}
        </li>
      ))}
    </ol>
  )
}

/** Link (or unlink) the intern's servd login — optional. */
function LoginLinkModal({ intern, onClose, onDone }: { intern: InternDetail; onClose: () => void; onDone: () => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['hr-logins', intern.tenantId],
    queryFn: () => api.get<Array<{ id: string; name: string; email: string | null; role: string; isActive: boolean }>>(`/hr/logins?${new URLSearchParams({ tenantId: intern.tenantId })}`),
  })
  const [userId, setUserId] = useState(intern.userId ?? '')
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => api.put(`/hr/interns/${intern.id}/login`, { userId: userId || null }),
    onSuccess: () => { onDone(); onClose() },
    onError: (e) => setErr(errText(e)),
  })
  return (
    <Modal title={`servd login for ${intern.fullName}`} onClose={onClose} dirty={userId !== (intern.userId ?? '')}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!save.isPending) save.mutate() }}>
        <p className="text-sm text-white/70">Optional. A linked login lets the intern appear on the marketing tracker with their cards. The login must belong to this company and to no other intern.</p>
        <LoadState loading={isLoading} error={error} />
        {data && (
          <label className="block">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-white/55 mb-1">Login</span>
            <Select className={inp} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">No login (unlinked)</option>
              {data.filter((u) => u.isActive || u.id === userId).map((u) => <option key={u.id} value={u.id}>{u.name} · {u.role}{u.email ? ` · ${u.email}` : ''}</option>)}
            </Select>
          </label>
        )}
        <ErrorBox message={err} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btn} disabled={save.isPending || !data}>{save.isPending ? 'Saving…' : 'Save'}</button>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
