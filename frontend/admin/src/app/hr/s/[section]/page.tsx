'use client'
// Any HR record section — leave, overtime, candidates, promotions, loans, …
// The list, the "new" form and the detail all come from the section's format,
// so a format saved by HR changes this page with no code change.

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { card, btn, btnGhost, displayValue, human, withLeaveDays, leaveFields, STATUS_COLOR, type HrFormat, type HrRecord, recordStatusText, isManualEntry } from '../../../../lib/hr'
import { HrShell, Modal, useHrAccess, useHrLookups, useHrOrg, useHrSections } from '../../../../components/hr/HrShell'
import { FormRenderer, validate, focusFirstInvalid } from '../../../../components/hr/FormRenderer'
import { RecordDetail } from '../../../../components/hr/RecordDetail'
import { FnfPayBasis, payBasisOf } from '../../../../components/hr/FnfPayBasis'
import { OvertimePicker, otAvailableOf } from '../../../../components/hr/OvertimePicker'
import { AttendanceRegister } from '../../../../components/hr/AttendanceRegister'
import { Select } from '@/components/ui/Select'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { CompactEmptyState } from '../../../../components/ui/CompactEmptyState'

export default function HrSectionPage() {
  const { section } = useParams<{ section: string }>()
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [csvErr, setCsvErr] = useState('')
  const [backfillMsg, setBackfillMsg] = useState('')
  const { isPayrollPayer } = useHrAccess()
  const { data: sections } = useHrSections()
  // GET /hr/sections: a section whose work moved elsewhere (eobi_challan →
  // Accounting → Statutory payments) says where; its rows stay readable.
  const info = sections?.find((s) => s.key === section)
  const moved = info?.movedTo ?? null
  const { data: lookups } = useHrLookups()
  const { data: org } = useHrOrg()
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['hr-records', section, status, stageFilter],
    queryFn: () => api.get<{ format: HrFormat; formatTenantId: string; records: HrRecord[] }>(`/hr/records/${section}?${new URLSearchParams({ ...(status && { status }), ...(stageFilter && { stage: stageFilter }) })}`),
  })
  const fmt = data?.format
  const isRegister = section === 'attendance'
  // The register is not limited to the list's 1000 rows, so a clicked day may not be in it: fetch that one.
  const { data: fetched } = useQuery({
    queryKey: ['hr-record-open', section, openId],
    queryFn: () => api.get<{ record: HrRecord }>(`/hr/records/${section}/${openId}`),
    enabled: isRegister && !!openId && !data?.records.some((r) => r.id === openId),
  })
  const open = data?.records.find((r) => r.id === openId) ?? fetched?.record ?? null
  // Show the first few meaningful columns of the format in the list.
  const cols = (fmt?.fields ?? []).filter((f) => f.bind !== 'employeeId' && !['table', 'textarea', 'file'].includes(f.type)).slice(0, 4)
  const lk = { employees: lookups?.employees, records: lookups?.records, org }
  // Settlements approved before approval booked them (finance gaps #2):
  // book them now, dated today.
  const backfill = useMutation({
    mutationFn: () => api.post<{ posted: string[]; alreadyPosted: number; failed: Array<{ employee: string | null; reason: string }> }>('/hr/final-settlement/post-unposted', {}),
    onSuccess: (r) => {
      setBackfillMsg([
        `${r.posted.length} settlement(s) booked, ${r.alreadyPosted} already on the books.`,
        ...r.failed.map((f) => `${f.employee ?? 'A settlement'}: ${f.reason}`),
      ].join(' '))
      void qc.invalidateQueries({ queryKey: ['hr-records', section] })
    },
    onError: (e: Error) => setBackfillMsg(e.message),
  })

  return (
    <HrShell
      title={info?.title ?? human(section)}
      subtitle={[info ? `Spec §${info.specNo}.` : '', info?.effect ?? ''].filter(Boolean).join(' ')}
      actions={<>
        {!isRegister && <ExportMenu className={btnGhost} path={`/hr/records/${section}/export.csv`} filename={`hr-${section}`} onError={(m) => setCsvErr(m)} />}
        {section === 'final_settlement' && isPayrollPayer && (
          <button className={btnGhost} disabled={backfill.isPending} onClick={() => { setBackfillMsg(''); backfill.mutate() }}>
            {backfill.isPending ? 'Booking…' : 'Post approved settlements'}
          </button>
        )}
        {!moved && <Link href={`/hr/formats/${section}`} className={btnGhost}>Edit format</Link>}
        {!moved && <button className={btn} onClick={() => setCreating(true)}>+ New</button>}
      </>}
    >
      {moved && (
        <div className="rounded-2xl p-4 mb-4 text-sm" style={{ background: 'rgb(var(--erp-primary-dim-rgb))' }}>
          <p className="font-bold text-primary-ink">{moved.message}.</p>
          <p className="text-white/70 mt-1">The payments recorded here before are kept below for reference; they were never on the books. New ones are recorded, and booked, there.</p>
          <Link href={moved.path} className={`${btn} inline-block mt-3`}>Open {moved.label}</Link>
        </div>
      )}
      {error && <p className="text-sm text-s-red mb-4" role="alert">{(error as Error).message}{' '}<button type="button" className="underline font-bold" onClick={() => void refetch()}>Retry</button></p>}
      {csvErr && <p className="text-sm text-s-red mb-4">Export failed: {csvErr}</p>}
      {backfillMsg && <p className="text-sm text-white/70 mb-4">{backfillMsg}</p>}
      {isRegister && <AttendanceRegister onOpen={setOpenId} onExportError={(m) => setCsvErr(m)} />}
      {!isRegister && <div className="flex flex-wrap gap-2 mb-4">
        {['', 'draft', 'submitted', 'approved', 'rejected', 'cancelled'].map((s) => (
          <button key={s || 'all'} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-bold border [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:px-4 ${status === s ? 'bg-primary text-primary-on border-primary' : 'border-white/10 text-white/50'}`}>
            {s ? human(s) : 'All'}
          </button>
        ))}
        {fmt && fmt.stages.length > 0 && (
          <Select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="rounded-full px-3 py-1 text-xs bg-white/[0.04] border border-white/10 text-white/70">
            <option value="">All stages</option>
            {fmt.stages.map((s) => <option key={s} value={s}>{human(s)}</option>)}
          </Select>
        )}
        {fmt && !fmt.isDefault && <span className="ml-auto text-[11px] text-primary-ink self-center">Using HR format v{fmt.version}</span>}
      </div>}

      {!isRegister && isLoading && <p className="text-sm text-white/40 py-6 text-center" role="status">Loading…</p>}
      {!isRegister && data && data.records.length === 0 && (
        <CompactEmptyState message="Nothing here yet" detail={moved ? `Nothing was recorded here before. Use ${moved.label}.` : 'Add the first one with “+ New”.'} />
      )}
      {!isRegister && data && data.records.length > 0 && (
        <div className="rounded-2xl overflow-x-auto" style={card}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                {fmt?.fields.some((f) => f.bind === 'employeeId') && <th className="px-4 py-3 font-bold">Employee</th>}
                {cols.map((c) => <th key={c.key} className="px-4 py-3 font-bold">{c.label}</th>)}
                {fmt && fmt.stages.length > 0 && <th className="px-4 py-3 font-bold">Stage</th>}
                <th className="px-4 py-3 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)} className="border-t border-white/[0.05] cursor-pointer hover:bg-white/[0.03]">
                  {fmt?.fields.some((f) => f.bind === 'employeeId') && <td className="px-4 py-3 text-white/85 font-bold">{r.employee?.fullName ?? '—'}</td>}
                  {cols.map((c) => <td key={c.key} className="px-4 py-3 text-white/70">{displayValue(c, r.data[c.key], lk)}</td>)}
                  {fmt && fmt.stages.length > 0 && <td className="px-4 py-3 text-white/60">{human(r.stage)}</td>}
                  <td className="px-4 py-3"><span className="text-xs font-bold" style={{ color: STATUS_COLOR[r.status] }}>{recordStatusText(r)}</span>{isManualEntry(r) && <span className="s-badge-amber ml-2 text-[10px]">Entered manually</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && fmt && (
        <NewRecord section={section} format={fmt} tenantId={data?.formatTenantId ?? null} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void qc.invalidateQueries() }} />
      )}
      {open && data && (
        <Modal title={open.label ?? info?.title ?? 'Record'} wide onClose={() => setOpenId(null)}>
          <OpenRecord record={open} listFormat={data.format} listTenantId={data.formatTenantId} readOnly={!!moved}
            onChanged={() => { void qc.invalidateQueries({ queryKey: ['hr-records', section] }); void qc.invalidateQueries({ queryKey: ['hr-attendance-register'] }) }} />
        </Modal>
      )}
    </HrShell>
  )
}

/** A record shown, edited and approved against the format it was saved under
 *  — its own version, and its own company's in portfolio view — with that
 *  company's pickers. The list's format is used only when it is that one. */
function OpenRecord({ record, listFormat, listTenantId, readOnly, onChanged }: { record: HrRecord; listFormat: HrFormat; listTenantId: string; readOnly?: boolean; onChanged: () => void }) {
  const same = record.tenantId === listTenantId && record.formVersion === listFormat.version
  const { data: own, error } = useQuery({
    queryKey: ['hr-record', record.section, record.id],
    queryFn: () => api.get<{ record: HrRecord; format: HrFormat }>(`/hr/records/${record.section}/${record.id}`),
    enabled: !same,
  })
  const { data: lookups } = useHrLookups(record.tenantId)
  const { data: org } = useHrOrg(record.tenantId)
  const format = same ? listFormat : own?.format
  if (error) return <p className="text-sm text-s-red">{(error as Error).message}</p>
  if (!format) return <p className="text-sm text-white/40">Loading its format…</p>
  return (
    <>
      {!same && <p className="text-[11px] text-white/40 mb-3">Saved under format v{format.version}{record.tenantId !== listTenantId ? ' of its own company' : ''} — shown and checked against that.</p>}
      <RecordDetail key={format.version} record={record} format={format} lookups={lookups} org={org} admin={!readOnly} onChanged={onChanged} />
    </>
  )
}

function NewRecord({ section, format, tenantId, onClose, onSaved }: { section: string; format: HrFormat; tenantId: string | null; onClose: () => void; onSaved: () => void }) {
  const { data: lookups } = useHrLookups()
  const { data: org } = useHrOrg()
  const [value, setValue] = useState<Record<string, unknown>>({})
  const [err, setErr] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formRef = useRef<HTMLFormElement>(null)
  // A full & final can be calculated before it is saved (owner, 2026-10-21:
  // the form shows the days paid); saving then stamps the calculation, with
  // the overtime HR added, on the new record.
  const fnf = section === 'final_settlement'
  const [calcInfo, setCalcInfo] = useState<Record<string, unknown> | null>(null)
  const calc = useMutation({
    mutationFn: (otRecordIds?: string[]) => {
      const employeeId = value['employee'], lwd = value['lastWorkingDay']
      if (typeof employeeId !== 'string' || !employeeId || typeof lwd !== 'string' || !lwd) throw new Error('Pick the employee and the last working day first')
      return api.post<Record<string, unknown>>('/hr/final-settlement/calculate', { employeeId, lastWorkingDay: lwd, ...(otRecordIds && { otRecordIds }) })
    },
    onSuccess: (r) => {
      setErr(''); setCalcInfo(r)
      setValue((d) => ({
        ...d, salaryPayable: r['salaryPayable'], otPayable: r['otPayable'], leaveEncashment: r['leaveEncashment'], loanRecovery: r['loanRecovery'],
        incomeTax: r['incomeTax'], eobiEmployee: r['eobiEmployee'], eobiEmployer: r['eobiEmployer'], sessiEmployer: r['sessiEmployer'],
        gratuity: r['gratuity'] ?? 0, deductions: d['deductions'] ?? 0, otherAdjustments: d['otherAdjustments'] ?? 0,
      }))
    },
    onError: (e: Error) => setErr(e.message),
  })
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const created = await api.post<{ id: string }>(`/hr/records/${section}`, { data: value, submit })
      // The record is saved either way: if the stamp fails, "Calculate" on the
      // saved settlement does it again.
      if (fnf && calcInfo && created?.id) {
        await api.post('/hr/final-settlement/calculate', {
          employeeId: value['employee'], lastWorkingDay: value['lastWorkingDay'], recordId: created.id,
          otRecordIds: (calcInfo['otRecordIds'] as string[] | undefined) ?? [],
        }).catch(() => undefined)
      }
      return created
    },
    onSuccess: onSaved,
    onError: (e: Error) => setErr(e.message),
  })
  const hasWorkflow = format.workflow.length > 0
  const fields = leaveFields(section, format.fields, value)
  // Enter (and the primary button) submit; "Save as draft" skips the required check.
  const run = (submit: boolean) => {
    if (save.isPending) return
    if (submit) {
      const found = validate(fields, value)
      setErrors(found)
      if (Object.keys(found).length > 0) { setErr(''); focusFirstInvalid(formRef.current); return }
    }
    setErr('')
    save.mutate(submit)
  }
  return (
    <Modal title={`New — ${format.title}`} wide onClose={onClose} dirty={Object.keys(value).length > 0}>
      <form ref={formRef} noValidate onSubmit={(ev) => { ev.preventDefault(); run(true) }}>
        <FormRenderer fields={fields} value={value} errors={errors}
          onChange={(x) => { const nv = withLeaveDays(section, format.fields, value, x); setValue(nv); if (Object.keys(errors).length) setErrors(validate(leaveFields(section, format.fields, nv), nv)) }} ctx={{ lookups, org, tenantId }} />
        {fnf && (
          <div className="mt-4 space-y-3">
            <button type="button" className={btnGhost} disabled={calc.isPending} onClick={() => calc.mutate(undefined)}>{calc.isPending ? 'Calculating…' : 'Calculate'}</button>
            {calcInfo && Array.isArray(calcInfo['payBasis']) && <FnfPayBasis basis={payBasisOf(calcInfo['payBasis'])} salaryPayable={value['salaryPayable']} />}
            {calcInfo && otAvailableOf(calcInfo['otAvailable']).length > 0 && (
              <OvertimePicker available={otAvailableOf(calcInfo['otAvailable'])} selected={(calcInfo['otRecordIds'] as string[] | undefined) ?? []} editable pending={calc.isPending} onSave={(ids) => calc.mutate(ids)} />
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-5">
          <button type="submit" className={btn} disabled={save.isPending}>{save.isPending ? 'Saving…' : hasWorkflow ? 'Submit for approval' : 'Save'}</button>
          {hasWorkflow && <button type="button" className={btnGhost} disabled={save.isPending} onClick={() => run(false)}>Save as draft</button>}
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
        {err && <p className="text-xs text-s-red mt-3" role="alert">{err}</p>}
        {hasWorkflow && <p className="text-xs text-white/50 mt-3">Approval: {format.workflow.map((w) => w.label).join(' → ')}</p>}
      </form>
    </Modal>
  )
}
