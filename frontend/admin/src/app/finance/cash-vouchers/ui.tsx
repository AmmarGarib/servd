'use client'
// Small building blocks shared by the cash-voucher screens — the same look as
// the Petty cash page (modal, field, buttons), on the ERP tokens only.

import type { ReactNode } from 'react'
import { statusMeta } from './data'

export const fieldCls = 'w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none'
export const primaryBtn = 'rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50'
export const secondaryBtn = 'rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-white/65 hover:text-white hover:border-primary disabled:opacity-50'
export const dangerOutlineBtn = 'rounded-xl border border-s-red/40 px-4 py-2.5 text-sm font-bold text-s-red hover:bg-s-red-dim disabled:opacity-50'

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'} rounded-2xl overflow-hidden`}
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

export function Footer({ onCancel, primary }: { onCancel: () => void; primary: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 pt-3 border-t border-white/[0.05] -mx-5 -mb-5 px-4 py-4 mt-4 bg-white/[0.01]">
      <button onClick={onCancel} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
      {primary}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="text-xs text-white/55">{label}</label>
      <div className="mt-1">{children}</div>
      {hint && <p className="text-[11px] text-white/40 mt-1">{hint}</p>}
    </div>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="rounded-xl px-4 py-3 text-sm bg-s-red-dim text-s-red border border-s-red/30">{message}</div>
}

export function StatusBadge({ status }: { status: string }) {
  const m = statusMeta(status)
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
