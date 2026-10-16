'use client'
// Employee master — spec §3. The add form is the Employee Master format.

import Link from 'next/link'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { api } from '../../../lib/api'
import { card, btn, btnGhost, rs, day, human, STATUS_BADGE, type HrField } from '../../../lib/hr'
import { HrShell, Modal, useHrForm, useHrLookups, useHrOrg } from '../../../components/hr/HrShell'
import { FormRenderer, validate, focusFirstInvalid } from '../../../components/hr/FormRenderer'

interface Row {
  id: string; employeeCode: string; fullName: string; phone: string | null; status: string; employmentType: string
  joiningDate: string | null; grossSalaryCents: number; department: string | null; designation: string | null; branch: string | null; manager: string | null; userId: string | null
}

export default function EmployeesPage() {
  // useSearchParams needs a Suspense boundary in a statically built page.
  return <Suspense fallback={null}><Employees /></Suspense>
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase() || '?'
}

const STATUS_CHIPS: Array<[string, string]> = [['current', 'Current'], ['all', 'Everyone'], ['resigned', 'Resigned'], ['terminated', 'Terminated'], ['separated', 'Separated']]

function Employees() {
  const router = useRouter()
  const path = usePathname()
  const sp = useSearchParams()
  // q and status live in the URL, so Back and a shared link restore them.
  const urlQ = sp.get('q') ?? ''
  const status = sp.get('status') ?? 'current'
  const [q, setQ] = useState(urlQ)
  const [adding, setAdding] = useState(false)
  const [csvErr, setCsvErr] = useState('')
  const writeUrl = (next: { q?: string; status?: string }) => {
    const p = new URLSearchParams(sp.toString())
    const nq = next.q ?? q
    const ns = next.status ?? status
    if (nq) p.set('q', nq); else p.delete('q')
    if (ns !== 'current') p.set('status', ns); else p.delete('status')
    const qs = p.toString()
    router.replace(qs ? `${path}?${qs}` : (path ?? '/hr/employees'), { scroll: false })
  }
  // Debounced: one request per pause in typing, not one per key.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => { if (q !== urlQ) writeUrl({ q }) }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])
  // Back / forward changes the URL: follow it.
  useEffect(() => { setQ(urlQ) }, [urlQ])
  const { data: rows = [], error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['hr-employees', urlQ, status],
    queryFn: () => api.get<Row[]>(`/hr/employees?${new URLSearchParams({ ...(urlQ && { q: urlQ }), ...(status !== 'all' && { status }) })}`),
    placeholderData: keepPreviousData,
  })
  return (
    <HrShell title="Employees" subtitle="The central HR database. Everyone employed — with or without a servd login."
      actions={<>
        <button className={btnGhost} onClick={() => { setCsvErr(''); api.download('/hr/reports/employees.csv', 'hr-employee-master.csv').catch((e: Error) => setCsvErr(e.message)) }}>Export CSV</button>
        <button className={btn} onClick={() => setAdding(true)}>+ Add employee</button>
      </>}>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative w-full sm:w-72">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, CNIC, phone"
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ(''); writeUrl({ q: '' }) } }}
            autoComplete="off" enterKeyHint="search"
            className="rounded-lg px-3 py-2 pr-10 text-sm bg-white/[0.04] border border-white/10 text-white/90 w-full [&::-webkit-search-cancel-button]:appearance-none" aria-label="Search employees" />
          {q && (
            <button type="button" aria-label="Clear search" onClick={() => { setQ(''); writeUrl({ q: '' }) }}
              className="absolute right-0 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center text-white/45 hover:text-white/80">✕</button>
          )}
        </div>
        {STATUS_CHIPS.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={status === k} onClick={() => writeUrl({ status: k })}
            className={`rounded-full px-3 py-1 text-xs font-bold border [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:px-4 ${status === k ? 'bg-primary text-primary-on border-primary' : 'border-white/10 text-white/50'}`}>{l}</button>
        ))}
        <span className="text-xs text-white/40" role="status" aria-live="polite">{isFetching && !isLoading ? 'Updating…' : ''}</span>
      </div>
      {error && (
        <p className="text-sm text-s-red mb-3" role="alert">{(error as Error).message}{' '}
          <button type="button" className="underline font-bold" onClick={() => void refetch()}>Retry</button></p>
      )}
      {csvErr && <p className="text-sm text-s-red mb-3">Export failed: {csvErr}</p>}
      <div className="rounded-2xl overflow-x-auto" style={card}>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wider text-white/55">
            {['ID', 'Name', 'Designation', 'Department', 'Branch', 'Type', 'Joined', 'Gross', 'Status'].map((h) => <th key={h} className="px-4 py-3 font-bold">{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-t border-white/[0.05] hover:bg-white/[0.03]">
                <td className="px-4 py-3 text-white/50 font-mono text-xs">{e.employeeCode}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-black"
                      style={{ background: 'rgb(var(--erp-primary-dim-rgb))', color: 'var(--erp-primary-ink)' }}>{initials(e.fullName)}</span>
                    <div className="min-w-0">
                      <Link href={`/hr/employees/${e.id}`} className="text-[15px] font-black text-white/90 hover:underline inline-block">{e.fullName}</Link>
                      {e.userId && <span className="ml-1 text-[10px] text-primary-ink" title="Has a servd login">●</span>}
                      <p className="text-xs text-white/55">{e.designation ?? 'No designation'}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-white/65">{e.designation ?? '—'}</td>
                <td className="px-4 py-3 text-white/65">{e.department ?? '—'}</td>
                <td className="px-4 py-3 text-white/65">{e.branch ?? '—'}</td>
                <td className="px-4 py-3 text-white/65">{human(e.employmentType)}</td>
                <td className="px-4 py-3 text-white/65">{day(e.joiningDate)}</td>
                <td className="px-4 py-3 text-white/80">{rs(e.grossSalaryCents)}</td>
                <td className="px-4 py-3"><span className={STATUS_BADGE[e.status] ?? 's-badge-muted'}>{human(e.status)}</span></td>
              </tr>
            ))}
            {isLoading && <tr><td colSpan={9} className="px-4 py-10 text-center text-white/40">Loading employees…</td></tr>}
            {!isLoading && !error && rows.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-white/40">
                {urlQ || status !== 'current'
                  ? <>No employees match. <button type="button" className="underline font-bold" onClick={() => { setQ(''); router.replace(path ?? '/hr/employees', { scroll: false }) }}>Clear filters</button></>
                  : <>No employees yet. <button type="button" className="underline font-bold" onClick={() => setAdding(true)}>Add the first one</button></>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {adding && <AddEmployee onClose={() => setAdding(false)} />}
    </HrShell>
  )
}

function AddEmployee({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const router = useRouter()
  const { data: lookups } = useHrLookups()
  const { data: org } = useHrOrg()
  const { data: form } = useHrForm('employees')
  const fields = form?.current.fields ?? []
  // HR may rename any field's key, so the name and the defaults are found by
  // the column they fill, not by key.
  const [value, setValue] = useState<Record<string, unknown> | null>(null)
  const v = value ?? masterDefaults(fields)
  const nameKey = fields.find((f) => f.bind === 'employee.fullName')?.key
  const named = !!nameKey && typeof v[nameKey] === 'string' && !!(v[nameKey] as string).trim()
  const [err, setErr] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const formRef = useRef<HTMLFormElement>(null)
  const save = useMutation({
    mutationFn: () => api.post<{ id: string }>('/hr/employees', { data: v }),
    onSuccess: (e) => { void qc.invalidateQueries(); router.push(`/hr/employees/${e.id}`) },
    onError: (e: Error) => setErr(e.message),
  })
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (save.isPending) return
    const found = validate(fields, v)
    if (nameKey && !named && !found[nameKey]) found[nameKey] = 'Full name is required'
    setErrors(found)
    if (Object.keys(found).length > 0) { setErr(''); focusFirstInvalid(formRef.current); return }
    setErr('')
    save.mutate()
  }
  return (
    <Modal title="Add employee" wide onClose={onClose} dirty={value !== null}>
      <form ref={formRef} onSubmit={submit} noValidate>
        {form ? <FormRenderer fields={fields} value={v} errors={errors}
          onChange={(nv) => { setValue(nv); if (Object.keys(errors).length) setErrors(validate(fields, nv)) }} ctx={{ lookups, org }} />
          : <p className="text-sm text-white/40">Loading format…</p>}
        <div className="flex flex-wrap items-center gap-2 mt-5">
          <button type="submit" className={btn} disabled={save.isPending || !form}>{save.isPending ? 'Saving…' : 'Add employee'}</button>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
        {err && <p className="text-xs text-s-red mt-3" role="alert">{err}</p>}
      </form>
    </Modal>
  )
}

const MASTER_DEFAULTS: Record<string, unknown> = { 'employee.status': 'active', 'employee.employmentType': 'probation' }
function masterDefaults(fields: HrField[]): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const f of fields) if (f.bind && f.bind in MASTER_DEFAULTS) v[f.key] = MASTER_DEFAULTS[f.bind]
  return v
}
