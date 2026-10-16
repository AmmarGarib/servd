'use client'
// useConfirm — a promise-based replacement for window.confirm (CODE-FIELDS-8),
// built on the shared Modal. Mounted once by <Providers>.
//
//   const confirm = useConfirm()
//   const r = await confirm({ title: 'Delete this table?', danger: true, confirmLabel: 'Delete' })
//   if (!r) return                       // cancelled
//   // r.reason is set when you passed `reason: { label, minLength }`
//
// Danger dialogs focus Cancel and Enter does not confirm. Without a provider
// (a test, a stray root) it falls back to window.confirm.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal'

export interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  reason?: { label: string; minLength: number }
}
export type ConfirmResult = false | { reason?: string }
type ConfirmFn = (opts: ConfirmOptions) => Promise<ConfirmResult>

const fallback: ConfirmFn = (opts) =>
  Promise.resolve(typeof window !== 'undefined' && window.confirm(opts.title) ? {} : false)

const ConfirmContext = createContext<ConfirmFn>(fallback)

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext)
}

// Imperative bridge for non-React code (lib/api.ts): the mounted provider
// registers its confirm function; askReason() asks for a reason with it.
let bridge: ConfirmFn | null = null

/** Ask for a reason (>= minLength chars) with the app's confirm dialog.
 *  Resolves to the trimmed reason, or null if cancelled / no provider mounted. */
export async function askReason(opts: { title: string; body?: ReactNode; label?: string; minLength?: number; confirmLabel?: string }): Promise<string | null> {
  if (!bridge) return null
  const r = await bridge({
    title: opts.title, body: opts.body, confirmLabel: opts.confirmLabel ?? 'Continue',
    reason: { label: opts.label ?? 'Reason', minLength: opts.minLength ?? 10 },
  })
  return r && r.reason ? r.reason : null
}

interface Pending { opts: ConfirmOptions; resolve: (r: ConfirmResult) => void }

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([])
  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<ConfirmResult>((resolve) => setQueue((q) => [...q, { opts, resolve }])),
    [],
  )
  useEffect(() => {
    bridge = confirm
    return () => { if (bridge === confirm) bridge = null }
  }, [confirm])
  const current = queue[0]
  const settle = (r: ConfirmResult) => {
    if (!current) return
    current.resolve(r)
    setQueue((q) => q.slice(1))
  }
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && <ConfirmBody key={queue.length + current.opts.title} opts={current.opts} onSettle={settle} />}
    </ConfirmContext.Provider>
  )
}

function ConfirmBody({ opts, onSettle }: { opts: ConfirmOptions; onSettle: (r: ConfirmResult) => void }) {
  const { danger, reason } = opts
  const [text, setText] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const reasonOk = !reason || text.trim().length >= reason.minLength
  const submit = () => { if (reasonOk) onSettle(reason ? { reason: text.trim() } : {}) }

  return (
    <Modal title={opts.title} onClose={() => onSettle(false)} zIndex={70}
      initialFocusRef={danger ? cancelRef : reason ? reasonRef : okRef}
      footer={
        <div className="flex justify-end gap-3">
          <button ref={cancelRef} type="button" onClick={() => onSettle(false)}
            className="s-btn-secondary">{opts.cancelLabel ?? 'Cancel'}</button>
          <button type="button" onClick={submit} disabled={!reasonOk}
            className={danger ? 's-btn-danger' : 's-btn-primary'}
            style={danger ? { background: 'var(--erp-danger)', color: 'var(--erp-on-primary)', borderColor: 'transparent' } : undefined}
            ref={okRef}>
            {opts.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      }>
      <div onKeyDown={(e) => {
        // Enter confirms only when not danger, and never from inside the reason box (new line).
        if (e.key === 'Enter' && !danger && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault(); submit()
        }
      }}>
        {opts.body && <div className="text-sm text-white/70">{opts.body}</div>}
        {reason && (
          <label className="block mt-3">
            <span className="text-xs text-white/55">{reason.label}</span>
            <textarea ref={reasonRef} value={text} onChange={(e) => setText(e.target.value)} required rows={3}
              aria-required="true" className="s-input mt-1" />
            {text.trim().length < reason.minLength && (
              <span className="text-[11px] text-white/40">At least {reason.minLength} characters.</span>
            )}
          </label>
        )}
      </div>
    </Modal>
  )
}
