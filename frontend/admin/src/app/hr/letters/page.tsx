'use client'
// HR letters — spec §26. Every letter the spec lists, each with a working
// default. The HR team pastes in their own wording; {{placeholders}} are filled
// from the employee, the company, and the request the letter is about.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, deleteWithUndo } from '../../../lib/api'
import { card, inp, btn, btnGhost } from '../../../lib/hr'
import { HrShell, useHrLookups, useHrSections } from '../../../components/hr/HrShell'
import { LETTERS_FOR, openPrintable } from '../../../components/hr/RecordDetail'
import { Select } from '@/components/ui/Select'

interface Letter { key: string; title: string; body: string; isDefault: boolean; version: number; placeholders: string[] }

const EMPLOYEE_PLACEHOLDERS = [
  'today', 'company.name',
  'employee.fullName', 'employee.employeeCode', 'employee.cnic', 'employee.designation', 'employee.department',
  'employee.branch', 'employee.manager', 'employee.employmentType', 'employee.joiningDate', 'employee.confirmationDate',
  'employee.lastWorkingDay', 'employee.grossSalary', 'employee.basicSalary',
]

export default function HrLettersPage() {
  const { data: letters = [], error } = useQuery({ queryKey: ['hr-letters'], queryFn: () => api.get<Letter[]>('/hr/letters') })
  const [key, setKey] = useState<string | null>(null)
  const letter = letters.find((l) => l.key === key) ?? null
  useEffect(() => { if (!key && letters[0]) setKey(letters[0].key) }, [key, letters])

  return (
    <HrShell title="Letters" subtitle="Paste your own wording over any default. Placeholders like {{employee.fullName}} are filled in when a letter is printed.">
      {error && <p className="text-sm text-red-700 mb-4">{(error as Error).message}</p>}
      <div className="grid lg:grid-cols-[260px_1fr] gap-5">
        <div className="space-y-1">
          {letters.map((l) => (
            <button key={l.key} onClick={() => setKey(l.key)} className="w-full text-left rounded-lg px-3 py-2 text-sm flex items-center justify-between gap-2"
              style={{ background: key === l.key ? 'rgb(var(--erp-primary-rgb) / 0.12)' : 'transparent', color: key === l.key ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.75)' }}>
              <span>{l.title}</span>
              {!l.isDefault && <span className="text-[10px] text-white/40">v{l.version}</span>}
            </button>
          ))}
        </div>
        {letter && <Editor key={`${letter.key}-${letter.version}`} letter={letter} />}
      </div>
    </HrShell>
  )
}

function Editor({ letter }: { letter: Letter }) {
  const qc = useQueryClient()
  const { data: sections = [] } = useHrSections()
  const { data: lookups } = useHrLookups()
  const [title, setTitle] = useState(letter.title)
  const [body, setBody] = useState(letter.body)
  const [employeeId, setEmployeeId] = useState('')
  const [msg, setMsg] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)
  const dirty = title !== letter.title || body !== letter.body

  // Record placeholders: the fields of the request(s) this letter is printed from.
  const recordFields = useMemo(() => {
    const secs = Object.entries(LETTERS_FOR).filter(([, keys]) => keys.includes(letter.key)).map(([s]) => s)
    return secs.flatMap((s) => {
      const info = sections.find((x) => x.key === s)
      return (info?.format?.fields ?? []).filter((f) => f.type !== 'table').map((f) => ({ path: `record.${f.key}`, label: `${info?.title}: ${f.label}` }))
    })
  }, [sections, letter.key])

  const refresh = () => void qc.invalidateQueries({ queryKey: ['hr-letters'] })
  const save = useMutation({ mutationFn: () => api.put(`/hr/letters/${letter.key}`, { title, body }), onSuccess: () => { setMsg('Saved.'); refresh() } })
  const reset = useMutation({ mutationFn: () => deleteWithUndo(`/hr/letters/${letter.key}`, { trashType: 'hr_letter', id: letter.key, label: 'Letter override', onRestored: refresh }), onSuccess: () => { setMsg('Back to the built-in default.'); refresh() } })
  const print = useMutation({
    mutationFn: () => api.post<{ title: string; html: string; missing: string[] }>('/hr/letters/render', { key: letter.key, employeeId }),
    onSuccess: (r) => {
      openPrintable(r.title, r.html)
      setMsg(r.missing.length ? `Printed with blanks for: ${r.missing.join(', ')}. Letters about a request are best printed from that request.` : '')
    },
  })

  const insert = (path: string) => {
    const el = area.current
    const token = `{{${path}}}`
    if (!el) { setBody(body + token); return }
    const [a, b] = [el.selectionStart, el.selectionEnd]
    setBody(body.slice(0, a) + token + body.slice(b))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length) })
  }

  // Preview with placeholders shown as chips, in a sandbox: the body is HR's HTML.
  const previewHtml = body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, p: string) =>
    `<span style="background:#e0f7f3;color:#046c5c;border-radius:4px;padding:0 4px;font-family:monospace;font-size:12px">${p}</span>`)
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,'Times New Roman',serif;max-width:680px;margin:24px auto;padding:0 20px;color:#111;line-height:1.55;font-size:14px;background:#fff}table{border-collapse:collapse;margin:12px 0}td{border:1px solid #ccc;padding:6px 12px}</style></head><body>${previewHtml}</body></html>`

  return (
    <div className="space-y-4 min-w-0">
      <div className="rounded-2xl p-4 space-y-3" style={card}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[220px]">
            <span className="block text-[11px] font-bold text-white/55 mb-1">Title</span>
            <input className={inp} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <button className={btn} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
          {!letter.isDefault && <button className={btnGhost} disabled={reset.isPending} onClick={() => { if (confirm('Discard your wording and go back to the built-in default?')) reset.mutate() }}>Reset to default</button>}
        </div>
        <p className="text-[11px] text-white/40">{letter.isDefault ? 'Using the built-in default.' : `Your version ${letter.version}.`} Write in HTML — &lt;p&gt; for paragraphs, &lt;strong&gt; for bold, &lt;table&gt; for tables. Or paste from Word into the box and tidy up.</p>
        {(save.error || reset.error || print.error) && <p className="text-xs text-red-700">{((save.error || reset.error || print.error) as Error).message}</p>}
        {msg && <p className="text-xs text-white/60">{msg}</p>}
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <div className="space-y-3 min-w-0">
          <textarea ref={area} className={`${inp} font-mono text-xs`} rows={18} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="rounded-2xl p-4" style={card}>
            <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">Insert a placeholder</p>
            <div className="flex flex-wrap gap-1.5">
              {EMPLOYEE_PLACEHOLDERS.map((p) => <Chip key={p} label={p} onClick={() => insert(p)} />)}
            </div>
            {recordFields.length > 0 && (
              <>
                <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mt-3 mb-2">From the request</p>
                <div className="flex flex-wrap gap-1.5">
                  {recordFields.map((f) => <Chip key={f.path} label={f.path} title={f.label} onClick={() => insert(f.path)} />)}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="space-y-3 min-w-0">
          <iframe title="Letter preview" sandbox="" srcDoc={doc} className="w-full rounded-2xl bg-[#fff]" style={{ height: 520, border: 0 }} />
          <div className="rounded-2xl p-4 flex flex-wrap items-end gap-3" style={card}>
            <label className="block flex-1 min-w-[200px]">
              <span className="block text-[11px] font-bold text-white/55 mb-1">Print for an employee</span>
              <Select className={inp} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Pick an employee</option>
                {(lookups?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
              </Select>
            </label>
            <button className={btnGhost} disabled={!employeeId || dirty || print.isPending} onClick={() => print.mutate()} title={dirty ? 'Save first' : undefined}>Print</button>
          </div>
          {dirty && <p className="text-[11px] text-white/40">Save to print with your changes.</p>}
        </div>
      </div>
    </div>
  )
}

function Chip({ label, title, onClick }: { label: string; title?: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="rounded-full px-2.5 py-1 text-[11px] font-mono border border-white/10 text-white/60 hover:text-white hover:border-white/30">
      {label}
    </button>
  )
}
