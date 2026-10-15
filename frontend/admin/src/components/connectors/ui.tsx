'use client'
// Small shared pieces for the Dev → API pages. Admin colour tokens only
// (s-* / .s-badge-* from tailwind.config.ts + globals.css) — no hard-coded
// colours, no emoji icons.

import { useEffect, useState, type ReactNode } from 'react'
import { Modal as SharedModal } from '../ui/Modal'
import type { FiscalDocStatus, TerminalChargeStatus } from '../../lib/connectorsApi'
import { DOC_STATUS_LABEL, CHARGE_STATUS_LABEL } from '../../lib/connectorsApi'

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

const BADGE: Record<Tone, string> = {
  ok: 's-badge-teal',
  warn: 's-badge-amber',
  bad: 's-badge-red',
  info: 's-badge-indigo',
  muted: 's-badge-muted',
}

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={BADGE[tone]} title={title}>{children}</span>
}

/** A small round status dot (health). */
export function Dot({ tone, label }: { tone: Tone; label: string }) {
  const cls = tone === 'ok' ? 'bg-s-green' : tone === 'warn' ? 'bg-s-amber' : tone === 'bad' ? 'bg-s-red' : 'bg-s-dim'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-s-muted">
      <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />
      {label}
    </span>
  )
}

export function docTone(s: FiscalDocStatus): Tone {
  switch (s) {
    case 'filed': case 'manual_filed': return 'ok'
    case 'failed': case 'rejected': case 'manual_required': return 'bad'
    case 'held': case 'waiting': case 'pending': case 'submitting': return 'warn'
    default: return 'muted'
  }
}

export function DocChip({ status, isTest }: { status: FiscalDocStatus; isTest?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={docTone(status)}>{DOC_STATUS_LABEL[status] ?? status}</Badge>
      {isTest && <TestBadge />}
    </span>
  )
}

export function chargeTone(s: TerminalChargeStatus): Tone {
  switch (s) {
    case 'recorded': case 'manual_resolved': return 'ok'
    case 'needs_attention': case 'unknown': return 'bad'
    case 'void_pending': case 'unverified': case 'approved': case 'pending': case 'sent': case 'cancel_requested': return 'warn'
    case 'voided': return 'info'
    default: return 'muted'
  }
}

export function ChargeChip({ status }: { status: TerminalChargeStatus }) {
  return <Badge tone={chargeTone(status)}>{CHARGE_STATUS_LABEL[status] ?? status}</Badge>
}

/** Filed by the built-in test driver — never a real fiscal invoice. */
export function TestBadge() {
  return <Badge tone="info" title="Filed by the built-in test driver — not a real fiscal invoice">TEST</Badge>
}

export function Card({ title, subtitle, actions, children, className = '' }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string
}) {
  return (
    <section className={`s-card p-4 sm:p-5 space-y-3 ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-bold text-s-text">{title}</h2>}
            {subtitle && <p className="text-xs text-s-muted mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[11px] font-semibold uppercase tracking-wider text-s-muted mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-s-muted mt-1">{hint}</p>}
    </div>
  )
}

export function ErrorLine({ children }: { children: ReactNode }) {
  if (!children) return null
  return <p role="alert" className="text-xs text-s-red">{children}</p>
}

export function OkLine({ children }: { children: ReactNode }) {
  if (!children) return null
  return <p className="text-xs text-s-green">{children}</p>
}

/** A full-width banner. `bad` for something that needs action, `warn` for a mode the reader must know about. */
export function Banner({ tone, title, children }: { tone: 'warn' | 'bad' | 'info'; title: ReactNode; children?: ReactNode }) {
  const cls = tone === 'bad'
    ? 'border-s-red/40 bg-s-red-dim'
    : tone === 'warn' ? 'border-s-amber/40 bg-s-amber-dim' : 'border-s-indigo/30 bg-s-indigo-dim'
  const head = tone === 'bad' ? 'text-s-red' : tone === 'warn' ? 'text-s-amber' : 'text-s-text'
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 ${cls}`}>
      <p className={`text-sm font-bold ${head}`}>{title}</p>
      {children && <div className="text-xs text-s-text mt-1 space-y-1">{children}</div>}
    </div>
  )
}

const PKT = 'Asia/Karachi'

/** "11 Oct, 14:05" in Pakistan time. */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-GB', { timeZone: PKT, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** "3 min", "2 h", "4 d" since `iso`. */
export function fmtAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

/**
 * A whole-number input with a range. The operator types freely — the raw
 * text is kept as typed (clamping on every keystroke made "2000" impossible
 * to enter when the minimum is 500). A value is passed up only when it is a
 * whole number inside [min, max]; otherwise the field shows the range inline
 * and `onValidChange(false)` lets the form disable Save.
 */
export function RangeNumberInput({ id, value, min, max, step, disabled, className = '', onChange, onValidChange, label }: {
  id?: string
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  className?: string
  label?: string
  onChange: (n: number) => void
  onValidChange?: (ok: boolean) => void
}) {
  const [raw, setRaw] = useState(String(value))
  // A new value from outside (a save, a server reset) replaces the draft —
  // unless the draft already says that number.
  useEffect(() => { setRaw((r) => (Number(r) === value && r.trim() !== '' ? r : String(value))) }, [value])
  const n = Number(raw)
  const ok = raw.trim() !== '' && Number.isInteger(n) && n >= min && n <= max
  useEffect(() => { onValidChange?.(ok) }, [ok]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <input id={id} type="number" inputMode="numeric" min={min} max={max} step={step} disabled={disabled}
        aria-label={label} aria-invalid={!ok}
        className={`s-input ${ok ? '' : 'border-s-red'} ${className}`} value={raw}
        onChange={(e) => {
          const v = e.target.value
          setRaw(v)
          const x = Number(v)
          if (v.trim() !== '' && Number.isInteger(x) && x >= min && x <= max) onChange(x)
        }} />
      {!ok && <p role="alert" className="text-[11px] text-s-red mt-1">Enter a whole number from {min} to {max}.</p>}
    </>
  )
}

/** A typed-confirmation dialog (GO LIVE / SWITCH OFF). */
export function ConfirmPhrase({ phrase, value, onChange }: { phrase: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={`Type ${phrase} to confirm`}>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={phrase}
        aria-label={`Type ${phrase} to confirm`} className="s-input max-w-[220px] font-mono" autoComplete="off" />
    </Field>
  )
}

/** Modal shell — a thin wrapper over the shared dialog (focus trap, Escape, scroll lock). */
export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <SharedModal title={title} onClose={onClose} wide={wide}>{children}</SharedModal>
}
