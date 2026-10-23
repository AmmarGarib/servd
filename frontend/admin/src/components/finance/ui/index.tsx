'use client'
// Finance's ONE set of form parts (UX ERP-9): Field (label above), Input /
// Textarea, Button (primary / secondary / danger), Dialog shell, Section card,
// and the sticky summary + action bar for long forms (ERP-11). Everything sits
// on the ERP tokens and the s-* classes in globals.css — no raw colours.
// Pages keep their own data, validation and API calls; this is look only.

import {
  Children, cloneElement, isValidElement, useEffect, useId, useRef,
  type CSSProperties,
  type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactElement, type ReactNode, type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Modal as SharedModal, useDialog } from '../../ui/Modal'
import { FIcon } from './icons'

// ── class strings (for controls that stay <input>/<Select>/<MoneyInput>) ────
export const fieldCls = 's-input'
export const primaryBtn = 's-btn-primary px-5 py-2.5 font-bold'
export const secondaryBtn = 's-btn-secondary px-4 py-2.5 font-semibold'
export const dangerBtn = 's-btn-danger px-4 py-2.5 font-semibold'
/** Kept for the older name: a quiet red button. */
export const dangerOutlineBtn = dangerBtn
export const cancelBtn = 's-btn-ghost px-4 py-2.5'

// ── controls ────────────────────────────────────────────────────────────────
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return <input {...rest} className={`s-input ${className}`.trim()} />
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return <textarea {...rest} className={`s-input ${className}`.trim()} />
}
export function Button({ variant = 'primary', size = 'md', className = '', type = 'button', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' | 'md' }) {
  const base = variant === 'primary' ? 's-btn-primary' : variant === 'secondary' ? 's-btn-secondary' : variant === 'danger' ? 's-btn-danger' : 's-btn-ghost'
  const cls = size === 'sm' ? `${base} px-3 py-1.5 text-xs font-semibold` : variant === 'primary' ? primaryBtn : variant === 'secondary' ? secondaryBtn : variant === 'danger' ? dangerBtn : cancelBtn
  return <button type={type} {...rest} className={`${cls} ${className}`.trim()} />
}

/** A text-only action (open, edit, hide, dismiss): no box, ink by tone. */
export function LinkButton({ tone = 'primary', size = 'sm', className = '', type = 'button', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'muted' | 'danger'; size?: 'sm' | 'md' }) {
  const ink = tone === 'danger' ? 'text-s-red' : tone === 'muted' ? 'text-s-muted hover:text-s-text' : 'text-primary-ink'
  return <button type={type} {...rest}
    className={`${size === 'sm' ? 'text-xs' : 'text-sm'} font-semibold hover:underline disabled:opacity-40 [@media(pointer:coarse)]:min-h-11 ${ink} ${className}`.trim()} />
}

/** A bare label in the Field style, for a control that sits apart from it (htmlFor wires it). */
export function FieldLabel({ children, htmlFor, className = '' }: { children: ReactNode; htmlFor?: string; className?: string }) {
  return <label htmlFor={htmlFor} className={`text-xs font-medium ${className}`.trim()} style={{ color: 'var(--muted)' }}>{children}</label>
}

/** Yes/no row: a checkbox (or radio) with its words, in the Field text style. */
export function CheckLabel({ children, className = '', ...rest }: { children: ReactNode; className?: string } & Omit<React.LabelHTMLAttributes<HTMLLabelElement>, 'children' | 'className'>) {
  return <label {...rest} className={`flex items-center gap-2 text-xs cursor-pointer ${className}`.trim()} style={{ color: 'var(--text)' }}>{children}</label>
}

// ── Field: label above, hint / error wired ──────────────────────────────────
/**
 * Label + control + hint + error, wired (htmlFor, aria-describedby, aria-invalid).
 * The first element child that is not a <p> is the control and gets the id; a
 * custom widget that ignores `id` is harmless. Extra children render after it.
 */
export function Field({ label, hint, error, required, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; required?: boolean; children: ReactNode }) {
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
  void required
  return (
    <div>
      <label htmlFor={id} className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{label}</label>
      <div className="mt-1">{kids}</div>
      {hint && !error && <p id={hintId} className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{hint}</p>}
      {error && <p id={errId} role="alert" className="text-xs mt-1 font-bold" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
    </div>
  )
}

/** A small helper line under a control (outside Field). */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>{children}</p>
}

// ── Dialog shell ────────────────────────────────────────────────────────────
/** Thin wrapper over the shared Modal (Escape, focus trap, dirty-close ask). */
export function Dialog({ title, children, onClose, wide, dirty }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; dirty?: boolean }) {
  return <SharedModal title={title} onClose={onClose} wide={wide} dirty={dirty}>{children}</SharedModal>
}

/** Cancel on the left, the page's action(s) on the right. */
export function DialogFooter({ onCancel, children, flush }: { onCancel: () => void; children: ReactNode; flush?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 pt-3 mt-4 ${flush ? '-mx-5 -mb-5 px-4 py-4' : ''}`}
      style={{ borderTop: '1px solid var(--border)' }}>
      <button type="button" onClick={onCancel} className={cancelBtn}>Cancel</button>
      {children}
    </div>
  )
}

// ── Section card ────────────────────────────────────────────────────────────
export function SectionCard({ heading, children, aside }: { heading: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="s-card p-3 space-y-2 mt-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>{heading}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

// ── Long forms: sticky summary + action bar (ERP-11) ────────────────────────
/** A summary strip that stays at the top of a scrolling form (key figures). */
export function StickySummary({ items }: { items: Array<{ label: string; value: ReactNode; tone?: 'good' | 'bad' }> }) {
  return (
    <div className="sticky top-0 z-10 -mx-5 -mt-5 px-5 pt-3 pb-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1"
      style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{it.label}</p>
          <p className="text-sm font-bold truncate" style={{ color: it.tone === 'bad' ? 'var(--erp-danger)' : it.tone === 'good' ? 'var(--erp-success)' : 'var(--text)' }}>{it.value}</p>
        </div>
      ))}
    </div>
  )
}

/** Cancel + actions pinned to the bottom of the dialog while the form scrolls. */
export function StickyActionBar({ onCancel, children }: { onCancel: () => void; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 -mx-5 -mb-5 px-5 py-3 mt-4"
      style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
      <button type="button" onClick={onCancel} className={cancelBtn}>Cancel</button>
      {children}
    </div>
  )
}

// ── Errors ──────────────────────────────────────────────────────────────────
const scrollIntoViewOnce = (el: HTMLElement | null) => {
  if (el && !el.dataset['seen']) { el.dataset['seen'] = '1'; el.scrollIntoView({ block: 'nearest' }) }
}
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" ref={scrollIntoViewOnce} className="rounded-xl px-4 py-3 text-sm"
      style={{ color: 'var(--erp-danger)', background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' }}>
      {message}
    </div>
  )
}

// ── Form helpers ────────────────────────────────────────────────────────────
/** Moves focus to a field by id (the first one that is missing). */
export function focusField(id: string) {
  const el = document.getElementById(id)
  if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }) }
}

/**
 * Double-submit guard for a modal <form>. `pending` is the mutation's
 * isPending; the returned wrapper blocks a second submit in the same tick and
 * releases when the request settles. Return false from `run` when it did not
 * start a request (a validation stop).
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


// ── Side panel / bottom sheet ───────────────────────────────────────────────
/**
 * A panel that slides in from the right (or a sheet from the bottom) with the
 * Modal's keyboard / focus / scroll-lock behaviour. For detail views that are
 * read next to the list; use Dialog for a form.
 */
export function SidePanel({ title, subtitle, onClose, children, side = 'right', wide, ariaLabel, flush }:
  { flush?: boolean; title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; side?: 'right' | 'bottom'; wide?: boolean; ariaLabel?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useDialog(ref, { onClose })
  if (typeof document === 'undefined') return null
  const box: CSSProperties = side === 'right'
    ? { background: 'var(--surface)', borderLeft: '1px solid var(--border)' }
    : { background: 'var(--surface)', borderTop: '1px solid var(--border)' }
  return createPortal(
    <div className={`fixed inset-0 z-50 flex bg-secondary/40 ${side === 'right' ? 'justify-end' : 'items-end justify-center'}`} onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : titleId}
        className={`${side === 'right' ? `h-full w-full ${wide ? 'max-w-xl' : 'max-w-md'}` : `w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[90dvh] rounded-t-2xl`} overflow-y-auto outline-none`}
        style={box} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-3" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0">
            <h2 id={titleId} className="font-black truncate" style={{ color: 'var(--text)' }}>{title}</h2>
            {subtitle && <p className="text-xs" style={{ color: 'var(--muted)' }}>{subtitle}</p>}
          </div>
          <button type="button" data-dialog-close onClick={onClose} aria-label="Close" className="s-btn-ghost flex h-9 w-9 items-center justify-center"><FIcon name="x" size={16} /></button>
        </div>
        <div className={flush ? '' : 'p-5'}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}
