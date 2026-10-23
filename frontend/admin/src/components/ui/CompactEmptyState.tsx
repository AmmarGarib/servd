'use client'
import Link from 'next/link'
import type { ReactNode } from 'react'

interface Props {
  /** Inline SVG (or any node). Defaults to a plain tray icon. Never an emoji. */
  icon?: ReactNode
  /** One line: what is empty and, if needed, what to do. */
  message: string
  /** Optional second line (smaller). Can hold links. */
  detail?: ReactNode
  /** 'dark' = kitchen screens (`.erp-kitchen-dark`, kds-* tokens). */
  tone?: 'light' | 'dark'
  action?: { label: string; onClick?: () => void; href?: string }
}

const TrayIcon = (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 13l3-8h12l3 8" /><path d="M3 13v6h18v-6" /><path d="M3 13h5l1 3h6l1-3h5" />
  </svg>
)

/**
 * The one empty-state style for operations pages (owner ERP-15, 2026-10-16):
 * an icon, one line, one main button. No examples, no explainers.
 */
export function CompactEmptyState({ icon, message, detail, tone = 'light', action }: Props) {
  const dark = tone === 'dark'
  const cls = dark
    ? 'rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-kds-bg hover:opacity-90'
    : 'rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90'
  return (
    <div className={`flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center ${
      dark ? 'border-kds-border bg-kds-card' : 'border-s-border'}`}>
      <span className={dark ? 'text-kds-subtext' : 'text-s-muted'}>{icon ?? TrayIcon}</span>
      <p className={`text-sm font-semibold ${dark ? 'text-kds-text' : 'text-s-text'}`}>{message}</p>
      {detail && <p className={`-mt-1 text-xs ${dark ? 'text-kds-subtext' : 'text-s-muted'}`}>{detail}</p>}
      {action && (action.href
        ? <Link href={action.href} className={cls}>{action.label}</Link>
        : <button type="button" onClick={action.onClick} className={cls}>{action.label}</button>)}
    </div>
  )
}
