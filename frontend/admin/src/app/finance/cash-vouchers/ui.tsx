'use client'
// Small building blocks shared by the cash-request screens — the same look as
// the Petty cash page (modal, field, buttons), on the ERP tokens only.

import type { ReactNode } from 'react'
import { stageMeta } from './data'
import { Dialog, DialogFooter, ErrorBanner as SharedErrorBanner } from '../../../components/finance/ui'

// The shared finance parts (components/finance/ui) — re-exported under the
// names these screens already use.
export {
  LinkButton, Field, FieldLabel, CheckLabel, Input, Textarea, Button, fieldCls, primaryBtn, secondaryBtn, dangerOutlineBtn, focusField, useSubmitOnce, firstMissing, dateBounds,
} from '../../../components/finance/ui'

/** Thin wrapper over the shared Dialog (Escape, focus trap, dirty-close ask). */
export function Modal({ title, children, onClose, wide, dirty }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; dirty?: boolean }) {
  return <Dialog title={title} onClose={onClose} wide={wide} dirty={dirty}>{children}</Dialog>
}

export function Footer({ onCancel, primary }: { onCancel: () => void; primary: ReactNode }) {
  return <DialogFooter onCancel={onCancel} flush>{primary}</DialogFooter>
}

export function ErrorBanner({ message }: { message: string }) {
  return <SharedErrorBanner message={message} />
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
      <span className="rounded-full px-1.5 text-xs font-black"
        style={count > 0
          ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
          : { background: 'rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.5)' }}>
        {count}
      </span>
    </button>
  )
}

