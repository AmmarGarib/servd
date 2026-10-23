'use client'
// Employee documents — spec §4, across everyone. Upload happens per employee
// (their profile's Documents tab or here); this page is for finding what is
// missing, unverified or about to expire.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, deleteWithUndo } from '../../../lib/api'
import { card, inp, btn, btnGhost, day, human, btnDanger } from '../../../lib/hr'
import { HrShell, Modal, useHrLookups } from '../../../components/hr/HrShell'
import { Select } from '@/components/ui/Select'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { RecordFiles } from '@/components/files/RecordFiles'
import { PendingFilesPicker } from '@/components/files/PendingFilesPicker'
import { uploadRecordFiles, type PickedFile } from '@/components/files/recordFiles'

interface Doc {
  id: string; employeeId: string; docType: string; title: string | null; fileUrl: string | null
  issueDate: string | null; expiryDate: string | null; verifiedAt: string | null; notes: string | null
  employee: { fullName: string; employeeCode: string }
}

const WINDOWS = [
  { v: '', label: 'All documents' },
  { v: '0', label: 'Expired' },
  { v: '30', label: 'Expiring in 30 days' },
  { v: '90', label: 'Expiring in 90 days' },
]

export default function HrDocumentsPage() {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [actErr, setActErr] = useState('')
  const [win, setWin] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [type, setType] = useState('')
  const [unverified, setUnverified] = useState(false)
  const [adding, setAdding] = useState(false)
  const { data: lookups } = useHrLookups()
  const { data: types = [] } = useQuery({ queryKey: ['hr-doc-types'], queryFn: () => api.get<string[]>('/hr/documents/types') })
  const qs = new URLSearchParams({ ...(win && { expiringDays: win }), ...(employeeId && { employeeId }) }).toString()
  const { data: docs = [], error, isLoading, refetch } = useQuery({ queryKey: ['hr-documents', qs], queryFn: () => api.get<Doc[]>(`/hr/documents${qs ? `?${qs}` : ''}`) })

  const shown = useMemo(() => docs.filter((d) => (!type || d.docType === type) && (!unverified || !d.verifiedAt)), [docs, type, unverified])
  const refresh = () => { setActErr(''); void qc.invalidateQueries({ queryKey: ['hr-documents'] }) }
  const verify = useMutation({ mutationFn: (id: string) => api.post(`/hr/documents/${id}/verify`, {}), onSuccess: refresh, onError: (e: Error) => setActErr(`Could not verify: ${e.message}`) })
  const del = useMutation({ mutationFn: (id: string) => deleteWithUndo(`/hr/documents/${id}`, { trashType: 'hr_document', id, onRestored: refresh }), onSuccess: refresh, onError: (e: Error) => setActErr(`Could not delete: ${e.message}`) })
  const now = Date.now()

  return (
    <HrShell title="Documents" subtitle="CNICs, contracts, certificates and everything else on file — with expiry and verification."
      actions={<button className={btn} onClick={() => setAdding(true)}>Add document</button>}>
      {error && <p className="text-sm text-s-red mb-4" role="alert">{(error as Error).message}{' '}<button type="button" className="underline font-bold" onClick={() => void refetch()}>Retry</button></p>}
      {actErr && <p className="text-sm text-s-red mb-4" role="alert">{actErr}</p>}
      <div className="flex flex-wrap gap-3 mb-4">
        <Select className={`${inp} max-w-[200px]`} value={win} onChange={(e) => setWin(e.target.value)}>
          {WINDOWS.map((w) => <option key={w.v} value={w.v}>{w.label}</option>)}
        </Select>
        <Select className={`${inp} max-w-[240px]`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Every employee</option>
          {(lookups?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
        </Select>
        <Select className={`${inp} max-w-[220px]`} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Every type</option>
          {types.map((t) => <option key={t} value={t}>{human(t)}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm text-white/70">
          <input type="checkbox" checked={unverified} onChange={(e) => setUnverified(e.target.checked)} className="h-4 w-4 accent-primary" />
          Unverified only
        </label>
      </div>

      <div className="rounded-2xl overflow-x-auto" style={card}>
        {isLoading ? <p className="p-8 text-center text-sm text-white/40" role="status">Loading documents…</p> : shown.length === 0 ? <p className="p-8 text-center text-sm text-white/40">{docs.length === 0 && !win && !employeeId ? 'No documents on file yet. Add the first one.' : 'No documents match.'}</p> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-white/40">
                <th className="px-4 py-2">Employee</th><th className="px-4 py-2">Document</th><th className="px-4 py-2">Issued</th>
                <th className="px-4 py-2">Expires</th><th className="px-4 py-2">Verified</th><th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const exp = d.expiryDate ? new Date(d.expiryDate).getTime() : null
                const tone = exp == null ? 'rgb(var(--fg-rgb) / 0.6)' : exp < now ? 'var(--erp-danger)' : exp < now + 30 * 86_400_000 ? 'var(--erp-warning)' : 'rgb(var(--fg-rgb) / 0.6)'
                return (
                  <tr key={d.id} className="border-t border-white/[0.05]">
                    <td className="px-4 py-2"><Link href={`/hr/employees/${d.employeeId}`} className="font-bold text-white/85 hover:underline">{d.employee.fullName}</Link> <span className="text-white/35 text-xs">{d.employee.employeeCode}</span></td>
                    <td className="px-4 py-2 text-white/75">
                      {d.fileUrl ? <a href={d.fileUrl} target="_blank" rel="noreferrer" className="hover:underline">{d.title || human(d.docType)}</a> : (d.title || human(d.docType))}
                      {d.title && <span className="text-white/35 text-xs"> · {human(d.docType)}</span>}
                      <RecordFiles ownerType="hr_document" ownerId={d.id} canUpload compact lazy />
                    </td>
                    <td className="px-4 py-2 text-white/60">{day(d.issueDate)}</td>
                    <td className="px-4 py-2" style={{ color: tone }}>{day(d.expiryDate)}</td>
                    <td className="px-4 py-2 text-white/60">{d.verifiedAt ? day(d.verifiedAt) : <button className="text-xs font-bold text-primary-ink px-2 py-2 [@media(pointer:coarse)]:min-h-[44px]" disabled={verify.isPending} onClick={() => verify.mutate(d.id)}>Verify</button>}</td>
                    <td className="px-4 py-2 text-right"><button className={`${btnDanger} !text-xs !px-2 !py-1.5 [@media(pointer:coarse)]:min-h-[44px]`} onClick={async () => {
                      const ok = await confirm({ title: 'Delete this document?', body: `${d.title || human(d.docType)} for ${d.employee.fullName} will be removed.`, confirmLabel: 'Delete', danger: true })
                      if (ok) del.mutate(d.id)
                    }}>Delete</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddDocument types={types} employees={lookups?.employees ?? []} defaultEmployee={employeeId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh() }} />}
    </HrShell>
  )
}

function AddDocument({ types, employees, defaultEmployee, onClose, onSaved }: {
  types: string[]; employees: Array<{ id: string; fullName: string; employeeCode: string }>; defaultEmployee: string; onClose: () => void; onSaved: () => void
}) {
  const [f, setF] = useState({ employeeId: defaultEmployee, docType: types[0] ?? '', title: '', issueDate: '', expiryDate: '' })
  const [formErr, setFormErr] = useState('')
  const [files, setFiles] = useState<PickedFile[]>([])
  const [uploadErr, setUploadErr] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      const doc = await api.post<{ id: string }>('/hr/documents', {
        employeeId: f.employeeId, docType: f.docType, title: f.title.trim() || undefined,
        issueDate: f.issueDate || undefined, expiryDate: f.expiryDate || undefined,
      })
      if (files.length) {
        try { await uploadRecordFiles('hr_document', doc.id, files) }
        catch (e) { return { failed: (e as Error).message } }
      }
      return { failed: '' }
    },
    onSuccess: (r) => {
      if (r.failed) { setUploadErr(`Document saved; files failed: ${r.failed}. Open it in the list to attach them again.`); return }
      onSaved()
    },
  })
  const dirty = !!(f.title || files.length || f.issueDate || f.expiryDate)
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    if (save.isPending) return
    if (!f.employeeId) { setFormErr('Pick an employee.'); return }
    if (!f.title.trim() && files.length === 0) { setFormErr('Give the document a title or attach a file.'); return }
    if (f.issueDate && f.expiryDate && f.expiryDate < f.issueDate) { setFormErr('The expiry date is before the issue date.'); return }
    setFormErr('')
    save.mutate()
  }
  return (
    <Modal title="Add document" onClose={onClose} dirty={dirty}>
      <form className="space-y-3" onSubmit={submit} noValidate>
        <L label="Employee">
          <Select className={inp} value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
            <option value="">Pick an employee</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
          </Select>
        </L>
        <L label="Type">
          <Select className={inp} value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })}>
            {types.map((t) => <option key={t} value={t}>{human(t)}</option>)}
          </Select>
        </L>
        <L label="Title"><input className={inp} value={f.title} autoComplete="off" onChange={(e) => setF({ ...f, title: e.target.value })} /></L>
        <PendingFilesPicker ownerType="hr_document" value={files} onChange={setFiles} label="Attach the file" hint="A title or a file is needed." />
        <div className="grid grid-cols-2 gap-3">
          <L label="Issued"><input type="date" className={inp} value={f.issueDate} onChange={(e) => setF({ ...f, issueDate: e.target.value })} /></L>
          <L label="Expires"><input type="date" className={inp} value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} /></L>
        </div>
        {(formErr || save.error || uploadErr) && <p className="text-xs text-s-red" role="alert">{formErr || (save.error as Error)?.message || uploadErr}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={uploadErr ? onSaved : onClose}>{uploadErr ? 'Close' : 'Cancel'}</button>
          <button type="submit" className={btn} disabled={save.isPending || !!uploadErr}>{save.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-[11px] font-bold text-white/55 mb-1">{label}</span>{children}</label>
}
