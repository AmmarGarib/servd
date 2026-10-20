'use client'
// Small dark-till building blocks shared by the flow screens. Colours are the
// kds tokens only (the till stays dark with its green "go" accent).
import { useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useDialog } from '../../ui/Modal'

/** A till dialog: Escape, focus trap and scroll lock come from useDialog. */
export function FlowDialog({ title, onClose, children, width = 'max-w-md', dismissible = true, subtitle }: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
  dismissible?: boolean
  subtitle?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialog(panelRef, { onClose, dismissible })
  return (
    <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center" role="presentation">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title}
        className={`flex max-h-[94dvh] w-full ${width} flex-col rounded-t-2xl bg-kds-card outline-none sm:rounded-2xl`}
        style={{ overscrollBehavior: 'contain' }}>
        <div className="flex shrink-0 items-center justify-between border-b border-kds-border py-2 pl-5 pr-1">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-kds-text">{title}</h2>
            {subtitle && <p className="truncate text-xs text-kds-subtext">{subtitle}</p>}
          </div>
          <button type="button" data-dialog-close onClick={onClose} aria-label="Close"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-kds-subtext hover:text-kds-text"><X size={20} aria-hidden="true" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5" style={{ overscrollBehavior: 'contain' }}>{children}</div>
      </div>
    </div>
  )
}

export const inputCls = 'min-h-11 w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-base text-kds-text placeholder:text-kds-subtext focus:border-kds-green focus:outline-none'
export const labelCls = 'mb-1 block text-xs font-semibold uppercase tracking-wider text-kds-subtext'
export const primaryBtn = 'min-h-11 rounded-xl bg-kds-green px-4 py-3 font-bold text-primary-on active:scale-95 disabled:cursor-not-allowed disabled:opacity-30'
export const ghostBtn = 'min-h-11 rounded-xl border border-kds-border px-4 py-3 font-semibold text-kds-text hover:border-kds-green active:scale-95 disabled:cursor-not-allowed disabled:opacity-30'

export function ErrorLine({ text }: { text: string | null | undefined }) {
  if (!text) return null
  return <p role="alert" className="text-sm font-semibold text-kds-red">{text}</p>
}
