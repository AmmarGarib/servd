'use client'
// Small shared parts of the Intern Management screens (HR → Interns): badges, fields, tabs, the reason / date dialog
// and the PDF buttons. ERP tokens only; every control is usable at 390 px.

import { useId, useState, type ReactNode } from 'react'
import { api } from '../../../lib/api'
import { btn, btnDanger, btnGhost, inp } from '../../../lib/hr'
import { apiErrors } from '../../../lib/interns'
import { FileViewModal } from '../../files/FileViewModal'
import { Modal } from '../HrShell'
import { Select } from '@/components/ui/Select'

export const labelCls = 'block text-[11px] font-bold uppercase tracking-wider text-white/55 mb-1'
export const sectionCls = 'rounded-2xl p-4 sm:p-5'

/** A status chip (s-badge-* classes from globals.css). */
export function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={cls}>{children}</span>
}

/** A labelled form control with its error under it (the API's message next to the field). */
export function Field({ label, error, hint, required, children, className = '' }: {
  label: string; error?: string; hint?: string; required?: boolean; children: (p: { id: string; invalid: boolean; describedBy?: string }) => ReactNode; className?: string
}) {
  const id = useId()
  const errId = `${id}-err`
  return (
    <div className={className}>
      <label htmlFor={id} className={labelCls}>{label}{required && <span style={{ color: 'var(--erp-danger)' }}> *</span>}</label>
      {children({ id, invalid: !!error, describedBy: error ? errId : undefined })}
      {hint && !error && <p className="text-[11px] text-white/50 mt-1">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-xs mt-1" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
    </div>
  )
}

export const invalidStyle = (invalid: boolean) => (invalid ? { borderColor: 'var(--erp-danger)' } : undefined)

/** One read-only fact (label over value) for the profile's Overview. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wider text-white/50">{label}</p>
      <div className="text-sm text-white/90 mt-0.5 break-words">{children === '' || children == null ? '—' : children}</div>
    </div>
  )
}

/** A horizontally scrolling tab strip. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: ReadonlyArray<readonly [T, string]>; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 mb-5 border-b border-white/[0.07] overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
      {tabs.map(([k, l]) => (
        <button key={k} role="tab" type="button" aria-selected={value === k} onClick={() => onChange(k)}
          className="px-4 py-2.5 text-sm font-bold border-b-2 -mb-px min-h-[44px] whitespace-nowrap"
          style={{ borderColor: value === k ? 'var(--erp-accent)' : 'transparent', color: value === k ? 'rgb(var(--fg-rgb) / 0.95)' : 'rgb(var(--fg-rgb) / 0.55)' }}>{l}</button>
      ))}
    </div>
  )
}

export function ErrorBox({ message }: { message: string }) {
  if (!message) return null
  return <p role="alert" className="text-sm break-words" style={{ color: 'var(--erp-danger)' }}>{message}</p>
}

export function Note({ tone, children }: { tone: 'warn' | 'bad' | 'info'; children: ReactNode }) {
  const c = tone === 'bad' ? 'var(--erp-danger)' : tone === 'warn' ? 'var(--erp-warning)' : 'var(--erp-primary)'
  return (
    <div role="status" className="rounded-xl p-3 text-sm text-white/85 break-words"
      style={{ background: `color-mix(in srgb, ${c} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 30%, transparent)` }}>
      {children}
    </div>
  )
}

export interface DialogField {
  key: string
  label: string
  kind: 'text' | 'textarea' | 'date' | 'month' | 'select'
  /** Minimum length of the trimmed text (a reason: 10). */
  min?: number
  required?: boolean
  initial?: string
  /** date: latest / earliest allowed. */
  max?: string
  minDate?: string
  options?: Array<{ value: string; label: string }>
  hint?: string
  placeholder?: string
}

/**
 * The one small dialog for an action that needs a reason, a date or a note (extend, complete, terminate, reject,
 * return, re-issue …). Validates the minimum lengths before sending; the API's answer is shown under the box.
 */
export function ActionDialog({ title, intro, fields, submitLabel, danger, onSubmit, onClose }: {
  title: string; intro?: ReactNode; fields: DialogField[]; submitLabel: string; danger?: boolean
  onSubmit: (values: Record<string, string>) => Promise<unknown>; onClose: () => void
}) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])))
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = fields.some((f) => (v[f.key] ?? '') !== (f.initial ?? ''))
  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    if (busy) return
    const found: Record<string, string> = {}
    for (const f of fields) {
      const t = (v[f.key] ?? '').trim()
      if ((f.required || f.min) && !t) found[f.key] = 'Required'
      else if (f.min && t.length < f.min) found[f.key] = `At least ${f.min} characters (${f.min - t.length} more)`
      else if ((f.kind === 'date' || f.kind === 'month') && t && f.minDate && t < f.minDate) found[f.key] = `Not before ${f.minDate}`
    }
    setErrs(found)
    if (Object.keys(found).length) { setErr(''); return }
    setBusy(true); setErr('')
    try { await onSubmit(Object.fromEntries(fields.map((f) => [f.key, (v[f.key] ?? '').trim()]))); onClose() }
    catch (e) {
      const a = apiErrors(e)
      setErr(a.message); setErrs(a.fields)
    } finally { setBusy(false) }
  }
  return (
    <Modal title={title} onClose={onClose} dirty={dirty}>
      <form onSubmit={submit} noValidate className="space-y-3">
        {intro && <div className="text-sm text-white/70">{intro}</div>}
        {fields.map((f) => (
          <Field key={f.key} label={f.label} required={f.required || !!f.min} error={errs[f.key]} hint={f.hint}>
            {({ id, invalid, describedBy }) => f.kind === 'textarea' ? (
              <textarea id={id} className={`${inp} min-h-[96px]`} style={invalidStyle(invalid)} aria-invalid={invalid || undefined} aria-describedby={describedBy}
                value={v[f.key] ?? ''} maxLength={1000} placeholder={f.placeholder} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            ) : f.kind === 'date' || f.kind === 'month' ? (
              <input id={id} type={f.kind} className={inp} style={invalidStyle(invalid)} aria-invalid={invalid || undefined} aria-describedby={describedBy}
                value={v[f.key] ?? ''} max={f.max} min={f.minDate} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            ) : f.kind === 'select' ? (
              <Select id={id} className={inp} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
                {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            ) : (
              <input id={id} className={inp} style={invalidStyle(invalid)} aria-invalid={invalid || undefined} aria-describedby={describedBy}
                value={v[f.key] ?? ''} maxLength={200} placeholder={f.placeholder} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            )}
          </Field>
        ))}
        <ErrorBox message={err} />
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="submit" className={danger ? btnDanger : btn} disabled={busy}>{busy ? 'Working…' : submitLabel}</button>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

/** Opens an authenticated PDF in a new tab (the tab is opened first so a pop-up blocker allows it), or prints it. */
async function openPdfTab(path: string, print: boolean): Promise<void> {
  const tab = print ? null : window.open('', '_blank')
  try {
    const blob = new Blob([await api.fetchBlob(path)], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    if (print) {
      const frame = document.createElement('iframe')
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
      frame.src = url
      frame.onload = () => {
        try { frame.contentWindow?.focus(); frame.contentWindow?.print() } catch { window.open(url, '_blank') }
        setTimeout(() => { frame.remove(); URL.revokeObjectURL(url) }, 60_000)
      }
      document.body.appendChild(frame)
    } else if (tab) {
      tab.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), 120_000)
    } else window.open(url, '_blank')
  } catch (e) {
    tab?.close()
    throw e
  }
}

/** View (a window on the page), Open in a new tab, Download and Print for a server-made PDF. */
export function PdfActions({ path, filename, label = 'PDF', className = btnGhost, extra }: { path: string; filename: string; label?: string; className?: string; extra?: ReactNode }) {
  const [viewing, setViewing] = useState(false)
  const [err, setErr] = useState('')
  const run = (p: Promise<unknown>) => { setErr(''); p.catch((e: Error) => setErr(e.message)) }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={className} onClick={() => setViewing(true)}>View {label}</button>
      <button type="button" className={className} onClick={() => run(openPdfTab(path, false))}>Open in new tab</button>
      <button type="button" className={className} onClick={() => run(api.download(`${path}${path.includes('?') ? '&' : '?'}download=1`, `${filename}.pdf`))}>Download</button>
      <button type="button" className={className} onClick={() => run(openPdfTab(path, true))}>Print</button>
      {extra}
      {err && <span role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</span>}
      {viewing && <FileViewModal path={path} mime="application/pdf" name={`${filename}.pdf`} onClose={() => setViewing(false)} />}
    </span>
  )
}

/** Loading / error / empty lines for a list. */
export function LoadState({ loading, error, onRetry }: { loading: boolean; error: unknown; onRetry?: () => void }) {
  if (loading) return <p className="text-sm text-white/55" role="status">Loading…</p>
  if (error) {
    return (
      <p className="text-sm" role="alert" style={{ color: 'var(--erp-danger)' }}>
        {(error as Error).message}{onRetry && <> <button type="button" className="underline font-bold" onClick={onRetry}>Retry</button></>}
      </p>
    )
  }
  return null
}
