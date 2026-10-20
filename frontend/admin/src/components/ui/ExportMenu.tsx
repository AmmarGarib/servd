'use client'
// THE export button for every report and account statement (owner,
// 2026-10-20: "export BS, P&L, GL, and any other report/account statement in
// PDF and Excel also"). "Export" → CSV / Excel / PDF. It downloads the
// report's own API route with `format=csv|xlsx|pdf` (backend
// lib/reportExport.ts renders all three) through api.download — the session,
// the portfolio view and the head-office lens travel exactly as on the
// screen, so an export never shows more than the page does.
//
//   <ExportMenu path="/accounting/balance-sheet?asOf=2026-10-20" filename="balance-sheet-2026-10-20" />
//
// `path` is the route WITHOUT format; `filename` is the download name without
// its extension. A new report uses this, never its own CSV button.
import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'

export type ExportFormat = 'csv' | 'xlsx' | 'pdf'

const LABEL: Record<ExportFormat, string> = { csv: 'CSV', xlsx: 'Excel (.xlsx)', pdf: 'PDF' }

export function exportPath(path: string, format: ExportFormat): string {
  return `${path}${path.includes('?') ? '&' : '?'}format=${format}`
}

export function ExportMenu({
  path, filename, formats = ['csv', 'xlsx', 'pdf'], label = 'Export', className = 's-btn-secondary text-sm', disabled, onError,
}: {
  path: string
  filename: string
  formats?: ExportFormat[]
  label?: string
  className?: string
  disabled?: boolean
  /** Shown by the page; without it the menu shows the error itself. */
  onError?: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])

  async function run(f: ExportFormat) {
    setOpen(false); setErr(null); setBusy(f)
    try {
      await api.download(exportPath(path, f), `${filename}.${f}`)
    } catch (e) {
      const msg = (e as Error).message || 'Export failed'
      if (onError) onError(msg); else setErr(msg)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" className={className} disabled={disabled || busy !== null}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {busy ? `Exporting ${LABEL[busy]}…` : label}
        <span aria-hidden className="ml-1 text-[10px]">▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 min-w-[10rem] rounded-lg border border-s-border bg-s-card py-1 shadow-lg">
          {formats.map((f) => (
            <button key={f} type="button" role="menuitem" onClick={() => void run(f)}
              className="block w-full px-3 py-1.5 text-left text-sm text-s-text hover:bg-s-bg-soft">
              {LABEL[f]}
            </button>
          ))}
        </div>
      )}
      {err && !onError && <p role="alert" className="absolute right-0 mt-1 w-64 text-xs text-s-red">{err}</p>}
    </div>
  )
}
