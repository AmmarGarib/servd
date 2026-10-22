'use client'
// HR letters — spec §26. Every letter the spec lists, each with a working
// default, plus letters HR adds itself. Owner, 2026-10-22: "It should give
// option to HR to add letter in word file … employee details should be
// picked through selected employee field on auto basis" and "We don't know
// HTML language". So a letter is either HR's own Word file or typed in the
// box below (a normal text editor — no HTML), and fields are typed in plain
// words, e.g. {{Employee Name}}. Picking an employee fills them in.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, deleteWithUndo } from '../../../lib/api'
import { card, inp, btn, btnGhost } from '../../../lib/hr'
import { HrShell, useHrLookups, useHrSections } from '../../../components/hr/HrShell'
import { LETTERS_FOR, openPrintable } from '../../../components/hr/RecordDetail'
import { Select } from '@/components/ui/Select'

interface Letter {
  key: string; title: string; body: string; isDefault: boolean; custom: boolean; version: number
  hasWord: boolean; wordFileName: string | null; placeholders: string[]
}
interface Field { path: string; label: string }

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const fieldKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const fileName = (s: string) => `${s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'letter'}.docx`

async function readWord(file: File) {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(new Error('The file could not be read'))
    r.readAsDataURL(file)
  })
  return { fileName: file.name, mime: file.type || DOCX_MIME, dataBase64 }
}

export default function HrLettersPage() {
  const { data: letters = [], error } = useQuery({ queryKey: ['hr-letters'], queryFn: () => api.get<Letter[]>('/hr/letters') })
  const [key, setKey] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const letter = letters.find((l) => l.key === key) ?? null
  useEffect(() => { if ((!key || !letter) && letters[0] && !adding) setKey(letters[0].key) }, [key, letter, letters, adding])
  const builtIn = letters.filter((l) => !l.custom)
  const own = letters.filter((l) => l.custom)

  const item = (l: Letter) => (
    <button key={l.key} onClick={() => { setAdding(false); setKey(l.key) }} className="w-full text-left rounded-lg px-3 py-2 text-sm flex items-center justify-between gap-2"
      style={{ background: !adding && key === l.key ? 'rgb(var(--erp-primary-rgb) / 0.12)' : 'transparent', color: !adding && key === l.key ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.75)' }}>
      <span>{l.title}</span>
      {l.hasWord ? <span className="s-badge-purple text-[10px] rounded px-1.5">Word</span> : !l.isDefault && <span className="text-[10px] text-white/40">edited</span>}
    </button>
  )

  return (
    <HrShell title="Letters" subtitle="Use your own Word file for any letter, or type it here. Pick an employee and their details are filled in.">
      {error && <p className="text-sm text-s-red mb-4">{(error as Error).message}</p>}
      <div className="grid lg:grid-cols-[260px_1fr] gap-5">
        <div className="space-y-1">
          <button className={`${btn} w-full mb-2`} onClick={() => setAdding(true)}>+ Add a letter</button>
          {own.length > 0 && <p className="px-3 pt-1 text-[11px] font-black uppercase tracking-wider text-white/40">Your letters</p>}
          {own.map(item)}
          <p className="px-3 pt-2 text-[11px] font-black uppercase tracking-wider text-white/40">Standard letters</p>
          {builtIn.map(item)}
        </div>
        {adding ? <AddLetter onDone={(k) => { setAdding(false); if (k) setKey(k) }} />
          : letter && <Editor key={`${letter.key}-${letter.version}`} letter={letter} />}
      </div>
    </HrShell>
  )
}

function useFields() {
  return useQuery({ queryKey: ['hr-letter-fields'], queryFn: () => api.get<Field[]>('/hr/letters/fields'), staleTime: Infinity }).data ?? []
}

function AddLetter({ onDone }: { onDone: (key?: string) => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const add = useMutation({
    mutationFn: async () => api.post<{ key: string }>('/hr/letters', file ? { title, file: await readWord(file) } : { title, body: '<p>Dear {{Employee Name}},</p><p></p><p>Regards,</p><p><strong>Human Resources</strong><br/>{{Company Name}}</p>' }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['hr-letters'] }); onDone(r.key) },
  })
  return (
    <div className="rounded-2xl p-5 space-y-4 max-w-xl" style={card}>
      <h2 className="text-base font-bold">Add a letter</h2>
      <label className="block">
        <span className="block text-[11px] font-bold text-white/55 mb-1">Name of the letter</span>
        <input className={inp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Uniform issue letter" />
      </label>
      <label className="block">
        <span className="block text-[11px] font-bold text-white/55 mb-1">Your Word file (.docx)</span>
        <input type="file" accept=".docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
        <span className="block text-[11px] text-white/45 mt-1">Write the letter in Word as you normally would. Where an employee&apos;s details go, type the field in double curly brackets, e.g. {'{{Employee Name}}'} — the list of fields is on the next screen. No Word file? Leave this empty and type the letter on the next screen.</span>
      </label>
      {add.error && <p className="text-xs text-s-red">{(add.error as Error).message}</p>}
      <div className="flex gap-2">
        <button className={btn} disabled={!title.trim() || add.isPending} onClick={() => add.mutate()}>{add.isPending ? 'Adding…' : file ? 'Add letter' : 'Add and type it'}</button>
        <button className={btnGhost} onClick={() => onDone()}>Cancel</button>
      </div>
    </div>
  )
}

function Editor({ letter }: { letter: Letter }) {
  const qc = useQueryClient()
  const fields = useFields()
  const { data: sections = [] } = useHrSections()
  const { data: lookups } = useHrLookups()
  const [title, setTitle] = useState(letter.title)
  const [employeeId, setEmployeeId] = useState('')
  const [msg, setMsg] = useState('')
  const [bodyDirty, setBodyDirty] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const upload = useRef<HTMLInputElement>(null)

  // Fields of the request(s) this letter is printed from, by their form label.
  const recordFields = useMemo(() => {
    const secs = Object.entries(LETTERS_FOR).filter(([, keys]) => keys.includes(letter.key)).map(([s]) => s)
    return secs.flatMap((s) => {
      const info = sections.find((x) => x.key === s)
      return (info?.format?.fields ?? []).filter((f) => f.type !== 'table').map((f) => ({ path: `record.${f.key}`, label: f.label }))
    })
  }, [sections, letter.key])
  const allFields = useMemo(() => [...fields, ...recordFields], [fields, recordFields])

  // The stored wording shows fields in plain words: {{employee.fullName}} → {{Employee Name}}.
  const friendly = useMemo(() => letter.body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (m, p: string) => {
    const f = allFields.find((x) => x.path === p)
    return f ? `{{${f.label}}}` : m
  }), [letter.body, allFields])
  useEffect(() => { if (box.current && !bodyDirty) box.current.innerHTML = friendly }, [friendly, bodyDirty])

  // Fields typed in this letter that servd does not know (a typing mistake).
  const unknown = useMemo(() => {
    const known = new Set(allFields.flatMap((f) => [fieldKey(f.label), fieldKey(f.path)]))
    ;['today', 'todaysdate', 'name', 'employeeid', 'company', 'salary'].forEach((k) => known.add(k))
    return letter.placeholders.filter((p) => !known.has(fieldKey(p)))
  }, [letter.placeholders, allFields])

  const { data: preview } = useQuery({
    queryKey: ['hr-letter-preview', letter.key, letter.version], enabled: letter.hasWord,
    queryFn: () => api.get<{ html: string }>(`/hr/letters/${letter.key}/preview`),
  })

  const refresh = () => void qc.invalidateQueries({ queryKey: ['hr-letters'] })
  const save = useMutation({
    mutationFn: () => api.put(`/hr/letters/${letter.key}`, letter.hasWord || !bodyDirty ? { title } : { title, body: box.current?.innerHTML ?? '' }),
    onSuccess: () => { setMsg('Saved.'); setBodyDirty(false); refresh() },
  })
  const putWord = useMutation({
    mutationFn: async (f: File) => api.put<{ placeholders: string[] }>(`/hr/letters/${letter.key}/word`, { file: await readWord(f) }),
    onSuccess: () => { setMsg('Word file saved — this letter now uses it.'); setBodyDirty(false); refresh() },
  })
  const dropWord = useMutation({
    mutationFn: () => api.delete(`/hr/letters/${letter.key}/word`),
    onSuccess: () => { setMsg('The Word file is no longer used. Its text is in the box below.'); refresh() },
  })
  const reset = useMutation({
    mutationFn: () => deleteWithUndo(`/hr/letters/${letter.key}`, { trashType: 'hr_letter', id: letter.key, label: letter.custom ? 'Letter' : 'Letter override', onRestored: refresh }),
    onSuccess: () => { setMsg(letter.custom ? 'Letter removed.' : 'Back to the standard wording.'); refresh() },
  })
  const print = useMutation({
    mutationFn: () => api.post<{ title: string; html: string; missing: string[] }>('/hr/letters/render', { key: letter.key, employeeId }),
    onSuccess: (r) => {
      openPrintable(r.title, r.html)
      setMsg(r.missing.length ? `Printed with blanks for: ${r.missing.join(', ')}. Letters about a request are best printed from that request.` : '')
    },
  })
  const word = useMutation({
    mutationFn: (forEmployee: boolean) => {
      const emp = lookups?.employees.find((e) => e.id === employeeId)
      return api.download(`/hr/letters/${letter.key}/word${forEmployee ? `?employeeId=${employeeId}` : ''}`,
        fileName(forEmployee && emp ? `${letter.title} ${emp.fullName}` : letter.title))
    },
  })
  const err = save.error || putWord.error || dropWord.error || reset.error || print.error || word.error
  const dirty = title !== letter.title || bodyDirty

  const addField = (label: string) => {
    const token = `{{${label}}}`
    const el = box.current
    if (!letter.hasWord && el) {
      el.focus()
      document.execCommand('insertText', false, token)
      setBodyDirty(true)
      return
    }
    void navigator.clipboard?.writeText(token).then(() => setMsg(`Copied ${token} — paste it in your Word file.`), () => setMsg(`Type ${token} in your Word file.`))
  }
  const fmt = (cmd: string) => { box.current?.focus(); document.execCommand(cmd); setBodyDirty(true) }

  return (
    <div className="space-y-4 min-w-0">
      <div className="rounded-2xl p-4 space-y-3" style={card}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[220px]">
            <span className="block text-[11px] font-bold text-white/55 mb-1">Name of the letter</span>
            <input className={inp} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <button className={btn} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
          {letter.custom
            ? <button className={btnGhost} disabled={reset.isPending} onClick={() => { if (confirm(`Remove "${letter.title}"? It goes to the Trash.`)) reset.mutate() }}>Remove letter</button>
            : !letter.isDefault && <button className={btnGhost} disabled={reset.isPending} onClick={() => { if (confirm('Go back to the standard wording? Your version goes to the Trash.')) reset.mutate() }}>Back to standard</button>}
        </div>
        {err && <p className="text-xs text-s-red">{(err as Error).message}</p>}
        {msg && <p className="text-xs text-white/60">{msg}</p>}
      </div>

      {/* Word file */}
      <div className="rounded-2xl p-4 space-y-3" style={card}>
        <p className="text-[11px] font-black uppercase tracking-wider text-white/40">Word file</p>
        {letter.hasWord ? (
          <>
            <p className="text-sm">This letter uses your Word file <strong>{letter.wordFileName}</strong>. To change the wording, change it in Word and upload it again.</p>
            <div className="flex flex-wrap gap-2">
              <button className={btnGhost} disabled={word.isPending} onClick={() => word.mutate(false)}>Download Word file</button>
              <button className={btnGhost} disabled={putWord.isPending} onClick={() => upload.current?.click()}>{putWord.isPending ? 'Uploading…' : 'Upload a new version'}</button>
              <button className={btnGhost} disabled={dropWord.isPending} onClick={() => { if (confirm('Stop using the Word file? Its text moves into the box on this page.')) dropWord.mutate() }}>Stop using the Word file</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-white/70">Prefer Word? Download this letter as a Word file, change it in Word (add your letterhead and logo), and upload it here. From then on the letter is printed from your Word file.</p>
            <div className="flex flex-wrap gap-2">
              <button className={btnGhost} disabled={word.isPending} onClick={() => word.mutate(false)}>Download as Word</button>
              <button className={btn} disabled={putWord.isPending} onClick={() => upload.current?.click()}>{putWord.isPending ? 'Uploading…' : 'Upload Word file'}</button>
            </div>
          </>
        )}
        <input ref={upload} type="file" accept=".docx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) putWord.mutate(f) }} />
      </div>

      <div className="grid xl:grid-cols-[1fr_300px] gap-4">
        <div className="space-y-3 min-w-0">
          {letter.hasWord ? (
            <iframe title="Letter preview" sandbox="" srcDoc={pageDoc(preview?.html ?? '')} className="w-full rounded-2xl bg-[#fff]" style={{ height: 560, border: 0 }} />
          ) : (
            <div className="rounded-2xl overflow-hidden bg-[#fff]" style={{ border: '1px solid rgb(var(--ink-rgb) / 0.12)' }}>
              <div className="flex gap-1 p-2 border-b" style={{ borderColor: 'rgb(var(--ink-rgb) / 0.1)' }}>
                {[['bold', 'B', 'font-bold'], ['italic', 'I', 'italic'], ['underline', 'U', 'underline'], ['insertUnorderedList', '• List', '']].map(([cmd, label, cls]) => (
                  <button key={cmd} type="button" onMouseDown={(e) => { e.preventDefault(); fmt(cmd!) }} className={`rounded px-2.5 py-1 text-sm hover:bg-[rgb(var(--erp-primary-rgb)/0.08)] ${cls}`} style={{ color: 'rgb(var(--ink-rgb))' }}>{label}</button>
                ))}
              </div>
              <div ref={box} contentEditable suppressContentEditableWarning onInput={() => setBodyDirty(true)}
                className="min-h-[480px] p-6 text-[#111] outline-none [&_p]:mb-3 [&_table]:my-3 [&_td]:border [&_td]:border-[#ccc] [&_td]:px-3 [&_td]:py-1.5 [&_ul]:list-disc [&_ul]:pl-6"
                style={{ fontFamily: "Georgia,'Times New Roman',serif", fontSize: 14, lineHeight: 1.55 }} />
            </div>
          )}
          {unknown.length > 0 && (
            <p className="text-xs text-s-red">servd does not know these fields, so they will print as they are: {unknown.map((u) => `{{${u}}}`).join(', ')}. Check the spelling against the list.</p>
          )}
          <div className="rounded-2xl p-4 flex flex-wrap items-end gap-3" style={card}>
            <label className="block flex-1 min-w-[200px]">
              <span className="block text-[11px] font-bold text-white/55 mb-1">Make this letter for an employee</span>
              <Select className={inp} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Pick an employee</option>
                {(lookups?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
              </Select>
            </label>
            <button className={btnGhost} disabled={!employeeId || dirty || print.isPending} onClick={() => print.mutate()} title={dirty ? 'Save first' : undefined}>Print</button>
            <button className={btn} disabled={!employeeId || dirty || word.isPending} onClick={() => word.mutate(true)} title={dirty ? 'Save first' : undefined}>Download Word</button>
          </div>
          {dirty && <p className="text-[11px] text-white/40">Save first to print with your changes.</p>}
        </div>

        <div className="rounded-2xl p-4 space-y-3 h-fit" style={card}>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/40">Fields</p>
          <p className="text-[11px] text-white/50">{letter.hasWord ? 'Click one to copy it, then paste it in your Word file where it should go.' : 'Click one to put it in the letter where your cursor is.'} When you make the letter for an employee, servd fills it in.</p>
          <div className="flex flex-wrap gap-1.5">
            {fields.map((f) => <Chip key={f.path} label={`{{${f.label}}}`} onClick={() => addField(f.label)} />)}
          </div>
          {recordFields.length > 0 && (
            <>
              <p className="text-[11px] font-black uppercase tracking-wider text-white/40 pt-1">From the request</p>
              <p className="text-[11px] text-white/50">Filled when the letter is printed from that request.</p>
              <div className="flex flex-wrap gap-1.5">
                {recordFields.map((f) => <Chip key={f.path} label={`{{${f.label}}}`} onClick={() => addField(f.label)} />)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const pageDoc = (html: string) => `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,'Times New Roman',serif;max-width:680px;margin:24px auto;padding:0 20px;color:#111;line-height:1.55;font-size:14px;background:#fff}table{border-collapse:collapse;margin:12px 0}td{border:1px solid #ccc;padding:6px 12px}img{max-width:100%}</style></head><body>${html}</body></html>`

function Chip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="rounded-full px-2.5 py-1 text-[11px] border border-white/10 text-white/70 hover:text-white hover:border-white/30">
      {label}
    </button>
  )
}
