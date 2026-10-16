'use client'
// The order's fiscal documents on the order page (spec §10): the sale filed
// with the fiscal POS at the full & final bill, and any refunds. Number,
// authority, the verification QR, and — for managers — the last error and
// Retry. Pre-bills never appear here: they are never sent to the POS.
// Light admin page: colour tokens only.

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { format } from 'date-fns'
import { ApiError } from '../../lib/api'
import { fetchOrderFiscal, isFiscalHeld, retryOrderFiscal, tillErrorMessage, type FiscalView } from './tillApi'

const STATUS_LABEL: Record<FiscalView['status'], string> = {
  filed: 'Filed',
  pending: 'Pending',
  failed: 'Failed — retrying',
  not_required: 'Not required',
  test: 'TEST',
}

const STATUS_CLASS: Record<FiscalView['status'], string> = {
  filed: 'bg-s-green-dim text-s-green',
  pending: 'bg-s-amber-dim text-s-amber',
  failed: 'bg-s-red-dim text-s-red',
  not_required: 'bg-s-bg-soft text-s-muted',
  test: 'bg-s-amber-dim text-s-amber',
}

function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 132 })
      .then((url) => { if (alive) setSrc(url) })
      .catch(() => { if (alive) setSrc(null) })
    return () => { alive = false }
  }, [text])
  if (!src) return null
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="Fiscal verification QR code" width={132} height={132} className="rounded border border-s-border" />
}

export function OrderFiscalPanel({ orderId, canRetry, onReprint }: {
  orderId: string
  /** Managers retry failed / rejected documents. */
  canRetry: boolean
  /** Reprint the full & final bill (it re-reads the fiscal number from the server). */
  onReprint?: () => void
}) {
  const qc = useQueryClient()
  const docs = useQuery({
    queryKey: ['order-fiscal', orderId],
    queryFn: () => fetchOrderFiscal(orderId),
    retry: false,
    // Shown inline (or hidden on a 403) — never the global error toast.
    meta: { inlineErrors: true },
    // A pending document files on its own; look again every 15 s while one is open.
    // A held document (company not live yet, spec §17.0) never files on its own — no polling for it.
    refetchInterval: (q) => (q.state.data?.some((d) => (d.status === 'pending' && !isFiscalHeld(d)) || d.status === 'failed') ? 15_000 : false),
  })
  const retry = useMutation({
    mutationFn: () => retryOrderFiscal(orderId),
    onSuccess: (r) => qc.setQueryData(['order-fiscal', orderId], r.fiscal),
  })

  const list = docs.data ?? []
  if (docs.isLoading || (list.length === 0 && !docs.isError)) return null
  // A role that may open the order but not the till's fiscal route (403): no panel, not an error box.
  if (docs.isError && docs.error instanceof ApiError && docs.error.status === 403) return null

  const anyFailed = list.some((d) => d.rawStatus === 'failed' || d.rawStatus === 'rejected')

  return (
    <div className="rounded-xl border border-s-border bg-s-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-widest text-s-muted">Fiscal invoice</p>
        <div className="flex gap-2">
          {canRetry && anyFailed && (
            <button type="button" onClick={() => retry.mutate()} disabled={retry.isPending}
              className="min-h-11 rounded-lg border border-s-border px-3 py-1.5 text-xs text-s-text hover:border-primary disabled:opacity-50">
              {retry.isPending ? 'Retrying…' : 'Retry filing'}
            </button>
          )}
          {onReprint && list.some((d) => d.kind === 'sale') && (
            <button type="button" onClick={onReprint}
              className="min-h-11 rounded-lg border border-s-border px-3 py-1.5 text-xs text-s-text hover:border-primary">
              Reprint bill
            </button>
          )}
        </div>
      </div>
      {docs.isError && <p className="text-xs text-s-red">{tillErrorMessage(docs.error, 'Could not load the fiscal documents')}</p>}
      {retry.isError && <p className="mb-2 text-xs text-s-red">{tillErrorMessage(retry.error, 'Retry failed')}</p>}
      <div className="space-y-4">
        {list.map((d) => {
          const qr = d.status === 'filed' || d.status === 'test' ? (d.qrPayload ?? d.verifyUrl) : null
          const held = isFiscalHeld(d)
          return (
            <div key={d.documentId} className="flex flex-wrap items-start justify-between gap-3 border-t border-s-border pt-3 first:border-t-0 first:pt-0">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-s-text">{d.kind === 'sale' ? 'Sale' : 'Refund'}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${held ? STATUS_CLASS.not_required : STATUS_CLASS[d.status]}`}>{held ? 'Held' : STATUS_LABEL[d.status]}</span>
                  {d.isTest && d.status !== 'test' && (
                    <span className="rounded-full bg-s-amber-dim px-2 py-0.5 text-[10px] font-bold uppercase text-s-amber">Test</span>
                  )}
                </div>
                {d.fiscalNumber ? (
                  <p className="font-mono text-sm text-s-text">
                    {(d.authority ?? '').toUpperCase()} {d.fiscalNumber}
                  </p>
                ) : (
                  <p className="text-xs text-s-muted">
                    {d.status === 'not_required'
                      ? 'Not filed (not required for this sale)'
                      : held
                      ? 'Held — the company is not live with the fiscal POS yet. It files once the CEO takes the company live.'
                      : 'No fiscal number yet — filed automatically'}
                  </p>
                )}
                {d.fiscalAt && <p className="text-[11px] text-s-muted">Filed {format(new Date(d.fiscalAt), 'dd MMM yyyy, HH:mm')}</p>}
                {d.status === 'test' && <p className="text-[11px] text-s-amber">TEST — not a fiscal invoice</p>}
                {d.lastError && <p className="text-[11px] text-s-red">Last error: {d.lastError}</p>}
                {d.verifyUrl && (
                  <a href={d.verifyUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary-ink hover:underline">Verify online</a>
                )}
              </div>
              {qr && <QrImage text={qr} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
