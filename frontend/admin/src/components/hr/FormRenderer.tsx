'use client'
// Renders any HR format — the field list HR defines per section — as a form.
//
// Every section's screen uses this, so a format the HR team saves in the format
// editor is what staff see immediately, with no code change. All sub-components
// are at module level on purpose: a component declared inside another is a new
// type every render, and React would remount the inputs on each keystroke.

import { useId } from 'react'
import { human, inp, rs, isReportingLineField, REPORTS_TO_CEO, type HrField, type Lookups, type OrgData } from '../../lib/hr'
import { BankAccountSelect } from '../finance/BankAccountSelect'
import { Select } from '@/components/ui/Select'
import { NumberField } from '@/components/ui/NumberField'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { NavIcon } from '../ui/NavIcon'

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

// ── Validation (callers run it before the request) ──────────────────────────
const CNIC_RE = /^\d{5}-?\d{7}-?\d$/
const PK_PHONE_RE = /^(\+?92|0)?\d{9,10}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const keyIs = (f: HrField, re: RegExp) => re.test(f.key)

function isEmpty(f: HrField, v: unknown): boolean {
  if (v == null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  return false
}

/** Field key -> message for every field that is required and empty, or filled
 *  in a shape that cannot be right (CNIC, phone, email, below the minimum). */
export function validate(fields: HrField[], values: Values): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const f of fields) {
    if (f.readOnly || (f.ref === BANK_ACCOUNT_REF && !f.required)) continue
    const v = values[f.key]
    if (isEmpty(f, v)) {
      if (f.required) errors[f.key] = `${f.label} is required`
      continue
    }
    if (f.type === 'number' || f.type === 'percent' || f.type === 'money') {
      const n = Number(v)
      const min = f.type === 'money' ? 0 : f.min
      if (!Number.isFinite(n)) errors[f.key] = `${f.label} must be a number`
      else if (min != null && n < min) errors[f.key] = `${f.label} must be at least ${min}`
      continue
    }
    if (typeof v !== 'string') continue
    const text = v.trim()
    if (f.type === 'email' && !EMAIL_RE.test(text)) errors[f.key] = 'Enter a valid email address'
    // Only the CNIC NUMBER boxes (plain text). The CNIC issue / expiry DATES
    // also have "cnic" in their keys and must never be checked as a number.
    else if ((f.type === 'text' || f.type == null) && keyIs(f, /cnic/i)) {
      if (!CNIC_RE.test(text)) errors[f.key] = 'CNIC looks like 42101-1234567-1 (13 digits)'
    } else if (f.type === 'phone' || keyIs(f, /(^|_)(phone|mobile|cell)(_|$)/i)) {
      if (!PK_PHONE_RE.test(text.replace(/[\s()-]/g, ''))) errors[f.key] = 'Phone looks like 0300 1234567 or +92 300 1234567'
    }
  }
  return errors
}

/** Moves focus to the first field marked invalid (after the errors have rendered). */
export function focusFirstInvalid(root?: ParentNode | null) {
  if (typeof document === 'undefined') return
  setTimeout(() => {
    const el = (root ?? document).querySelector<HTMLElement>('[aria-invalid="true"]')
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') as ScrollBehavior })
    el.focus({ preventScroll: true })
  }, 30)
}

export function FormRenderer({ fields, value, onChange, ctx, errors }: {
  fields: HrField[]
  value: Values
  onChange: (v: Values) => void
  ctx: RenderCtx
  /** Field key -> message (from `validate`); shown under the field. */
  errors?: Record<string, string>
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
              <FieldRow key={f.key} f={f} v={value[f.key]} onSet={(v) => {
                set(f.key, v)
              }} ctx={ctx} error={errors?.[f.key]} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** One field: a real <label htmlFor>, the input, its help and its inline error. */
function FieldRow({ f, v, onSet, ctx, error }: { f: HrField; v: unknown; onSet: (v: unknown) => void; ctx: RenderCtx; error?: string }) {
  const id = useId()
  const helpId = `${id}-help`
  const errId = `${id}-err`
  const describedBy = [error ? errId : null, f.help ? helpId : null].filter(Boolean).join(' ') || undefined
  const wide = f.type === 'textarea' || f.type === 'table' || f.type === 'employees' || f.type === 'multiselect'
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      {/* The bank picker carries its own label. */}
      {f.ref !== BANK_ACCOUNT_REF && <FieldLabel f={f} id={id} />}
      <FieldInput f={f} v={v} onSet={onSet} ctx={ctx} a11y={{ id, required: !!f.required, invalid: !!error, describedBy }} />
      {error && <p id={errId} className="text-xs mt-1 font-bold" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
      {f.help && <p id={helpId} className="text-xs text-white/55 mt-1">{f.help}</p>}
    </div>
  )
}

function FieldLabel({ f, id }: { f: HrField; id: string }) {
  return (
    <label htmlFor={id} className="block text-[11px] font-bold text-white/55 mb-1">
      {f.label}{f.required && <span className="text-s-red" aria-hidden="true"> *</span>}
    </label>
  )
}

interface A11y { id?: string; required?: boolean; invalid?: boolean; describedBy?: string }

const toDateInput = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 10) : '')
const toDateTimeInput = (v: unknown) => {
  if (typeof v !== 'string' || !v) return ''
  const d = new Date(v)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function FieldInput({ f, v, onSet, ctx, a11y }: { f: HrField; v: unknown; onSet: (v: unknown) => void; ctx: RenderCtx; a11y?: A11y }) {
  const dis = ctx.disabled || f.readOnly
  // Table cells have no visible label of their own: the column name is the name.
  const aria = {
    id: a11y?.id,
    'aria-label': a11y?.id ? undefined : f.label,
    'aria-required': a11y?.required || undefined,
    'aria-invalid': a11y?.invalid || undefined,
    'aria-describedby': a11y?.describedBy,
  }
  if (f.readOnly) {
    return <div id={a11y?.id} className="rounded-lg px-3 py-2 text-sm bg-white/[0.02] border border-white/5 text-white/60 min-h-[38px]">
      {v == null || v === '' ? <span className="text-white/25">Calculated</span> : f.type === 'money' ? rs(Number(v)) : String(v)}
    </div>
  }
  if (f.ref === BANK_ACCOUNT_REF) {
    return <BankAccountSelect id={a11y?.id ?? `hr-${f.key}`} label={f.label} tenantId={ctx.tenantId} value={String(v ?? '')} onChange={(id) => onSet(id || null)} className={inp} />
  }
  switch (f.type) {
    case 'textarea':
      return <textarea {...aria} className={inp} rows={3} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value)} />
    case 'number': case 'percent':
      return (
        <NumberField {...aria} value={v == null || v === '' ? null : Number(v)} onValueChange={(n) => onSet(n)}
          decimals={f.integer ? 0 : 4} min={f.min} allowNegative={f.min == null || f.min < 0} className={inp} disabled={dis} />
      )
    case 'money':
      // Stored in paisa. MoneyInput shows rupees with grouping; an emptied box is "no value" (null), as before.
      return (
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-white/35 pointer-events-none">Rs</span>
          <MoneyInput id={a11y?.id} ariaLabel={a11y?.id ? undefined : f.label} required={a11y?.required}
            aria-invalid={a11y?.invalid || undefined} aria-describedby={a11y?.describedBy}
            value={v == null || v === '' ? 0 : Number(v)} onChange={(c) => onSet(c === 0 ? null : c)}
            className={`${inp} pl-9`} disabled={dis} />
        </div>
      )
    case 'date':
      return <input type="date" {...aria} className={inp} value={toDateInput(v)} disabled={dis} onChange={(e) => onSet(e.target.value || null)} />
    case 'datetime':
      return <input type="datetime-local" {...aria} className={inp} value={toDateTimeInput(v)} disabled={dis}
        onChange={(e) => onSet(e.target.value ? new Date(e.target.value).toISOString() : null)} />
    case 'time':
      return <input type="time" {...aria} className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)} />
    case 'boolean':
      return (
        <label className="flex items-center gap-2 min-h-[38px] text-sm text-white/80">
          <input type="checkbox" {...aria} checked={v === true} disabled={dis} onChange={(e) => onSet(e.target.checked)} className="h-4 w-4 accent-primary" />
          {v === true ? 'Yes' : 'No'}
        </label>
      )
    case 'select':
      return (
        <Select {...aria} className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)}>
          <option value="">—</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{human(o)}</option>)}
        </Select>
      )
    case 'multiselect':
      return <ChipPicker options={(f.options ?? []).map((o) => ({ id: o, label: human(o) }))} value={(v as string[]) ?? []} onSet={onSet} disabled={dis} />
    case 'employee': {
      const line = isReportingLineField(f) ? ctx.lookups?.reportingLine ?? [] : []
      if (line.length) {
        // Reporting line: the server's labels ("CEO", "<Designation> — <Name>").
        // The CEO's own HR record shows as the CEO option; a manager who has
        // left keeps their name so the saved value is still visible.
        const ceo = line.find((o) => o.ceo)
        const shown = v && ceo?.employeeId && v === ceo.employeeId ? REPORTS_TO_CEO : String(v ?? '')
        const missing = shown && !line.some((o) => o.id === shown)
          ? ctx.lookups?.employees.find((e) => e.id === shown)
          : undefined
        return (
          <Select {...aria} className={inp} value={shown} disabled={dis} onChange={(e) => onSet(e.target.value || null)}>
            <option value="">—</option>
            {line.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            {missing && <option value={missing.id}>{missing.fullName} ({human(missing.status)})</option>}
          </Select>
        )
      }
      return (
        <Select {...aria} className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)}>
          <option value="">—</option>
          {(ctx.lookups?.employees ?? []).map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.employeeCode})</option>)}
        </Select>
      )
    }
    case 'employees':
      return <ChipPicker options={(ctx.lookups?.employees ?? []).map((e) => ({ id: e.id, label: e.fullName }))} value={(v as string[]) ?? []} onSet={onSet} disabled={dis} />
    case 'location': case 'department': case 'orgunit': case 'record': {
      const opts =
        f.type === 'location' ? ctx.org?.locations ?? []
        : f.type === 'department' ? ctx.org?.departments ?? []
        : f.type === 'orgunit' ? (ctx.org?.units ?? []).filter((u) => u.kind === f.ref && u.isActive)
        : (ctx.lookups?.records?.[f.ref ?? ''] ?? []).map((r) => ({ id: r.id, name: r.label }))
      return (
        <Select {...aria} className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)}>
          <option value="">{opts.length ? '—' : f.type === 'orgunit' ? `No ${human(f.ref)} set up yet` : '—'}</option>
          {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
      )
    }
    case 'file':
      return <input type="url" {...aria} autoComplete="off" className={inp} placeholder="Paste a link to the file" value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value || null)} />
    case 'table':
      return <TableInput f={f} rows={(v as Values[]) ?? []} onSet={onSet} ctx={ctx} />
    case 'email':
      return <input type="email" {...aria} autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value)} />
    case 'phone':
      return <input type="tel" {...aria} autoComplete="tel" inputMode="tel" className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value)} />
    default: {
      const cnic = keyIs(f, /cnic/i)
      return <input type="text" {...aria} inputMode={cnic ? 'numeric' : undefined} autoComplete="off" placeholder={cnic ? '42101-1234567-1' : undefined} className={inp} value={String(v ?? '')} disabled={dis} onChange={(e) => onSet(e.target.value)} />
    }
  }
}

function ChipPicker({ options, value, onSet, disabled }: { options: Array<{ id: string; label: string }>; value: string[]; onSet: (v: unknown) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.length === 0 && <span className="text-xs text-white/35">Nothing to choose from yet</span>}
      {options.map((o) => {
        const on = value.includes(o.id)
        return (
          <button type="button" key={o.id} disabled={disabled} aria-pressed={on}
            onClick={() => onSet(on ? value.filter((x) => x !== o.id) : [...value, o.id])}
            className={`rounded-full px-3 py-1.5 text-xs font-bold border ${on ? 'bg-primary text-primary-on border-primary' : 'border-white/10 text-white/55'}`}>
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
                <td className="px-2"><button type="button" onClick={() => onSet(rows.filter((_, j) => j !== i))} className="text-white/35 hover:text-s-red" aria-label="Remove row"><NavIcon name="x" size={16} /></button></td>
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
