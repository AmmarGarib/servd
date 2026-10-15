'use client'
// Small building blocks shared by the cash-request screens — the same look as
// the Petty cash page (modal, field, buttons), on the ERP tokens only.

import { Children, cloneElement, isValidElement, useEffect, useId, useRef, type FormEvent, type ReactElement, type ReactNode } from 'react'
import { stageMeta } from './data'
import { Modal as SharedModal } from '../../../components/ui/Modal'

export const fieldCls = 'w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none'
export const primaryBtn = 'rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50'
export const secondaryBtn = 'rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-white/65 hover:text-white hover:border-primary disabled:opacity-50'
export const dangerOutlineBtn = 'rounded-xl border border-s-red/40 px-4 py-2.5 text-sm font-bold text-s-red hover:bg-s-red-dim disabled:opacity-50'

/** Thin wrapper over the shared Modal (Escape, focus trap, dirty-close ask). */
export function Modal({ title, children, onClose, wide, dirty }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; dirty?: boolean }) {
  return <SharedModal title={title} onClose={onClose} wide={wide} dirty={dirty}>{children}</SharedModal>
}

export function Footer({ onCancel, primary }: { onCancel: () => void; primary: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 pt-3 border-t border-white/[0.05] -mx-5 -mb-5 px-4 py-4 mt-4 bg-white/[0.01]">
      <button type="button" onClick={onCancel} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
      {primary}
    </div>
  )
}

/**
 * Label + control + hint + error, wired (htmlFor, aria-describedby, aria-invalid).
 * The first element child that is not a <p> is the control and gets the id; a
 * custom widget that ignores `id` is harmless. Extra children (a preview line)
 * render after it.
 */
export function Field({ label, hint, error, required, children }: { label: string; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode }) {
  const uid = useId()
  const kids = Children.toArray(children)
  const at = kids.findIndex((k) => isValidElement(k) && k.type !== 'p' && k.type !== 'div')
  const first = at >= 0 ? (kids[at] as ReactElement<Record<string, unknown>>) : null
  const id = (first?.props['id'] as string | undefined) ?? `${uid}-f`
  const hintId = `${uid}-hint`
  const errId = `${uid}-err`
  const describedBy = [first?.props['aria-describedby'] as string | undefined, hint && !error ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined
  if (first) {
    kids[at] = cloneElement(first, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : first.props['aria-invalid'] })
  }
  return (
    <div>
      <label htmlFor={id} className="text-xs text-white/55">{label}</label>
      <div className="mt-1">{kids}</div>
      {hint && !error && <p id={hintId} className="text-[11px] text-white/40 mt-1">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-[11px] mt-1 font-bold" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
    </div>
  )
}

/** Moves focus to a field by id (the first one that is missing). */
export function focusField(id: string) {
  const el = document.getElementById(id)
  if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }) }
}

/**
 * Double-submit guard for a modal <form>. `pending` is the mutation's
 * isPending; the returned wrapper blocks a second submit in the same tick (a
 * double click / Enter + click) and releases when the request settles. Return
 * false from `run` when it did not start a request (a validation stop).
 */
export function useSubmitOnce(pending: boolean) {
  const busy = useRef(false)
  useEffect(() => { if (!pending) busy.current = false }, [pending])
  return (run: () => boolean | void) => (e?: FormEvent) => {
    e?.preventDefault()
    if (busy.current || pending) return
    busy.current = true
    if (run() === false) busy.current = false
  }
}

/** First missing field of an {id: message} map, in insertion order (empty message = fine). */
export function firstMissing(errs: Record<string, string>): string | null {
  return Object.keys(errs).find((k) => errs[k]) ?? null
}

/** Sensible bounds for a business date: 2000-01-01 .. today + 1 year (Karachi). */
export function dateBounds(): { min: string; max: string } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number) as [number, number, number]
  return { min: '2000-01-01', max: new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10) }
}

export function ErrorBanner({ message }: { message: string }) {
  return <div role="alert" ref={scrollIntoViewOnce} className="rounded-xl px-4 py-3 text-sm bg-s-red-dim text-s-red border border-s-red/30">{message}</div>
}

/** The request's step (its `stage`), in words, with its badge colour. */
export function StatusBadge({ stage }: { stage: string }) {
  const m = stageMeta(stage)
  return <span className={m.badge}>{m.label}</span>
}

/** A filter chip with its count — the approvals inbox's look (selected = servd green). */
export function Chip({ on, onClick, label, count }: { on: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick}
      className="rounded-full px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 transition-colors"
      style={on
        ? { background: 'var(--erp-accent-dim)', border: '1px solid var(--erp-accent)', color: 'var(--text)' }
        : { background: 'var(--surface)', border: '1px solid var(--border)', color: 'rgb(var(--fg-rgb) / 0.75)' }}>
      {label}
      <span className="rounded-full px-1.5 text-[10px] font-black"
        style={count > 0
          ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
          : { background: 'rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.5)' }}>
        {count}
      </span>
    </button>
  )
}

/** Brings a freshly shown error into view (once, when it appears). */
const scrollIntoViewOnce = (el: HTMLElement | null) => {
  if (el && !el.dataset['seen']) { el.dataset['seen'] = '1'; el.scrollIntoView({ block: 'nearest' }) }
}
