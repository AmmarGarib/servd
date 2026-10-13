'use client'
// Renders any HR format — the field list HR defines per section — as a form.
//
// Every section's screen uses this, so a format the HR team saves in the format
// editor is what staff see immediately, with no code change. All sub-components
// are at module level on purpose: a component declared inside another is a new
// type every render, and React would remount the inputs on each keystroke.

import { useState } from 'react'
import { human, inp, type HrField, type Lookups, type OrgData } from '../../lib/hr'
import { BankAccountSelect } from '../finance/BankAccountSelect'

type Values = Record<string, unknown>

/** A text field whose ref is this holds a bank account id of the record's
 *  company (backend hr/forms.ts BANK_ACCOUNT_REF) — shown as the one picker. */
export const BANK_ACCOUNT_REF = 'bank_account'

export interface RenderCtx {
  lookups?: Lookups
  org?: OrgData
  disabled?: boolean
  /** The record's company — whose banks a bank-account field offers. */
  tenantId?: string | null
}

export function FormRenderer({ fields, value, onChange, ctx }: {
  fields: HrField[]
  value: Values
  onChange: (v: Values) => void
  ctx: RenderCtx
}) {
  // Preserve the format's order, but keep grouped fields together under a heading.
  const groups: Array<{ name: string | null; fields: HrField[] }> = []
  for (const f of fields) {
    const g = f.group ?? null
    const last = groups[groups.length - 1]
    if (last && last.name === g) last.fields.push(f)
    else groups.push({ name: g, fields: [f] })
  }
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v })
  return (
    <div className="space-y-5">
      {groups.map((g, i) => (
        <div key={`${g.name ?? 'main'}-${i}`}>
          {g.name && <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">{g.name}</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {g.fields.map((f) => (
              <div key={f.key} className={f.type === 'textarea' || f.type === 'table' || f.type === 'employees' || f.type === 'multiselect' ? 'sm:col-span-2' : ''}>
                {/* The bank picker carries its own label. */}
                {f.ref !== BANK_ACCOUNT_REF && <FieldLabel f={f} />}
                <FieldInput f={f} v={value[f.key]} onSet={(v) => set(f.key, v)} ctx={ctx} />
                {f.help && <p className="text-[10px] text-white/35 mt-1">{f.help}</p>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function FieldLabel({ f }: { f: HrField }) {
  return (
    <span className="block text-[11px] font-bold text-white/55 mb-1">
      {f.label}{f.required && <span className="text-red-700"> *</span>}
    </span>
  )
}

const toDateInput = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 10) : '')
const toDateTimeInput = (v: unknown) => {
  if (typeof v !== 'string' || !v) return ''
  const d = new Date(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function FieldInput({ f, v, onSet, ctx }: { f: HrField; v: unknown; onSet: (v: unknown) => void; ctx: RenderCtx }) {
  const dis = ctx.disabled || f.readOnly
  if (f.readOnly) {
    return <div className="rounded-lg px-3 py-2 text-sm bg-white/[0.02] border border-white/5 text-white/60 min-h-[38px]">
      {v == null || v === '' ? <span className="text-white/25">Calculated</span> : f.type === 'money' ? `Rs ${(Number(v) / 100).toLocaleString('en-PK')}` : String(v)}
    </div>
  }
  if (f.ref === BANK_ACCOUNT_REF) {
    return <BankAccountSelect id={`hr-${f.key}`} label={f.label} tenantId={ctx.tenantId} value={String(v ?? '')} onChange={(id) => onSet(id || null)} className={inp} />
  }
  switch (f.type) {
    case 'textarea':
      return <textarea className={inp} rows={3} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value)} />
    case 'number': case 'percent':
      return <NumberInput value={v} scale={1} step={f.integer ? 1 : 'any'} min={f.min} className={inp} disabled={dis} onSet={onSet} />
    case 'money':
      return (
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-white/35">Rs</span>
          <NumberInput value={v} scale={100} step="any" min={0} className={`${inp} pl-9`} disabled={dis} onSet={onSet} />
        </div>
      )
    case 'date':
      return <input type="date" className={inp} value={toDateInput(v)} disabled={dis} onChange={(e) => onSet(e.target.value || null)} />
    case 'datetime':
      return <input type="datetime-local" className={inp} value={toDateTimeInput(v)} disabled={dis}
        onChange={(e) => onSet(e.target.value ? new Date(e.target.value).toISOString() : null)} />
    case 'time':
      return <input type="time" className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)} />
    case 'boolean':
      return (
        <label className="flex items-center gap-2 min-h-[38px] text-sm text-white/80">
          <input type="checkbox" checked={v === true} disabled={dis} onChange={(e) => onSet(e.target.checked)} className="h-4 w-4 accent-primary" />
          {v === true ? 'Yes' : 'No'}
        </label>
      )
    case 'select':
      return (
        <select className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)}>
          <option value="">—</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{human(o)}</option>)}
        </select>
      )
    case 'multiselect':
      return <ChipPicker options={(f.options ?? []).map((o) => ({ id: o, label: human(o) }))} value={(v as string[]) ?? []} onSet={onSet} disabled={dis} />
    case 'employee':
      return (
        <select className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)}>
          <option value="">—</option>
          {(ctx.lookups?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
        </select>
      )
    case 'employees':
      return <ChipPicker options={(ctx.lookups?.employees ?? []).map((e) => ({ id: e.id, label: e.fullName }))} value={(v as string[]) ?? []} onSet={onSet} disabled={dis} />
    case 'location': case 'department': case 'orgunit': case 'record': {
      const opts =
        f.type === 'location' ? ctx.org?.locations ?? []
        : f.type === 'department' ? ctx.org?.departments ?? []
        : f.type === 'orgunit' ? (ctx.org?.units ?? []).filter((u) => u.kind === f.ref && u.isActive)
        : (ctx.lookups?.records?.[f.ref ?? ''] ?? []).map((r) => ({ id: r.id, name: r.label }))
      return (
        <select className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)}>
          <option value="">{opts.length ? '—' : f.type === 'orgunit' ? `No ${human(f.ref)} set up yet` : '—'}</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )
    }
    case 'file':
      return <input type="url" className={inp} placeholder="Paste a link to the file" value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)} />
    case 'table':
      return <TableInput f={f} rows={(v as Values[]) ?? []} onSet={onSet} ctx={ctx} />
    case 'email':
      return <input type="email" className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value)} />
    case 'phone':
      return <input type="tel" className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value)} />
    default:
      return <input type="text" className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value)} />
  }
}

/** A number box that keeps what is typed. Rendering it back from the stored
 *  number would turn "12.0" into "12" mid-keystroke, so 12.05 could never be
 *  typed; the text is kept, and only replaced when the value changes from
 *  outside (a reset, a calculation). Money is stored in paisa (scale 100). */
function NumberInput({ value, scale, onSet, ...rest }: {
  value: unknown; scale: number; onSet: (v: unknown) => void
  step: number | 'any'; min?: number; className: string; disabled?: boolean
}) {
  const toText = (x: unknown) => (x == null || x === '' ? '' : String(Number(x) / scale))
  const parse = (t: string) => (t === '' ? null : scale === 1 ? Number(t) : Math.round(Number(t) * scale))
  const [text, setText] = useState(() => toText(value))
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (parse(text) !== value) setText(toText(value))
  }
  return <input type="number" {...rest} value={text} onChange={(e) => { setText(e.target.value); onSet(parse(e.target.value)) }} />
}

function ChipPicker({ options, value, onSet, disabled }: { options: Array<{ id: string; label: string }>; value: string[]; onSet: (v: unknown) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.length === 0 && <span className="text-xs text-white/35">Nothing to choose from yet</span>}
      {options.map((o) => {
        const on = value.includes(o.id)
        return (
          <button type="button" key={o.id} disabled={disabled}
            onClick={() => onSet(on ? value.filter((x) => x !== o.id) : [...value, o.id])}
            className={`rounded-full px-2.5 py-1 text-xs font-bold border ${on ? 'bg-primary text-primary-on border-primary' : 'border-white/10 text-white/55'}`}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function TableInput({ f, rows, onSet, ctx }: { f: HrField; rows: Values[]; onSet: (v: unknown) => void; ctx: RenderCtx }) {
  const cols = f.columns ?? []
  const update = (i: number, k: string, v: unknown) => onSet(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  return (
    <div className="rounded-lg border border-white/10 overflow-x-auto">
      {rows.length > 0 && (
        <table className="w-full text-xs">
          <thead><tr>{cols.map((c) => <th key={c.key} className="px-2 py-1.5 text-left text-white/40 font-bold">{c.label}</th>)}<th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-white/5">
                {cols.map((c) => (
                  <td key={c.key} className="px-1 py-1 min-w-[120px]">
                    <FieldInput f={c} v={r[c.key]} onSet={(v) => update(i, c.key, v)} ctx={ctx} />
                  </td>
                ))}
                <td className="px-2"><button type="button" onClick={() => onSet(rows.filter((_, j) => j !== i))} className="text-white/35 hover:text-red-700" aria-label="Remove row">✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" disabled={ctx.disabled} onClick={() => onSet([...rows, {}])} className="w-full text-left px-3 py-2 text-xs font-bold text-white/50 hover:text-white">
        + Add {f.label.toLowerCase().replace(/s$/, '')}
      </button>
    </div>
  )
}
