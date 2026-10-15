'use client'
// OnAccountCardPrint — the print dialog for an on-account client's QR card.
//
// The card code is shown ONCE (the API keeps only its hash and last 4), so
// this dialog is the only place it can be printed: "shown once — print now".
// The QR is drawn here with the `qrcode` package (QRCode.toDataURL, error
// correction M) — not modules/qrcodes. Credit-card size (85.6 × 54 mm) print
// layout; window.print prints only the card (the rest of the page is hidden
// by the print stylesheet below).
//
// The parent owns the code in state and passes `code={null}` to close; when
// the dialog closes (or unmounts) the QR image is dropped from state too, so
// the code lives no longer than the dialog. Only the Close button closes it
// (no backdrop click), and closing before printing asks first — the code
// cannot be shown again. Colours are ERP tokens only; the card uses the
// surface (white) and ink tokens, so it prints dark on white.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export interface OnAccountCardPrintProps {
  /** The one-time code; null = closed. */
  code: string | null
  clientName: string
  /** OA-0001 */
  accountNumber: string
  cardLabel: string
  companyName: string | null
  onClose: () => void
}

/** "ABCDEFGHIJKL" → "ABCD EFGH IJKL". */
export function groupCode(code: string, size = 4): string {
  return (code.match(new RegExp(`.{1,${size}}`, 'g')) ?? [code]).join(' ')
}

export function OnAccountCardPrint({ code, clientName, accountNumber, cardLabel, companyName, onClose }: OnAccountCardPrintProps) {
  const [qr, setQr] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [printed, setPrinted] = useState(false)

  useEffect(() => {
    setPrinted(false)
    if (!code) { setQr(null); setFailed(false); return }
    let live = true
    QRCode.toDataURL(code, { errorCorrectionLevel: 'M', margin: 1, width: 240 })
      .then((url) => { if (live) setQr(url) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false; setQr(null) }
  }, [code])

  if (!code) return null

  const close = () => {
    if (!printed && !window.confirm('The card code cannot be shown again. Close without printing?')) return
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4 oa-print-root">
      <style>{`
        .oa-card { width: 85.6mm; height: 54mm; box-sizing: border-box; }
        @media print {
          @page { size: 85.6mm 54mm; margin: 0; }
          body * { visibility: hidden !important; }
          .oa-card, .oa-card * { visibility: visible !important; }
          .oa-card { position: fixed; left: 0; top: 0; border-radius: 0 !important; border: none !important; }
        }
      `}</style>
      <div className="w-full max-w-md rounded-2xl p-6 max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        <p className="text-lg font-black text-white/90">Card for {clientName}</p>
        <p role="alert" className="mt-2 rounded-lg px-3 py-2 text-sm font-bold"
          style={{ background: 'color-mix(in srgb, var(--erp-warning) 14%, transparent)', color: 'rgb(var(--fg-rgb) / 0.9)' }}>
          Shown once — print now. The code cannot be shown again; if this card is lost, rotate it.
        </p>

        <div className="mt-4 flex justify-center">
          <div className="oa-card flex gap-3 rounded-xl p-3" style={{ background: 'var(--surface)', color: 'rgb(var(--ink-rgb))', border: '1px solid rgb(var(--ink-rgb) / 0.3)' }}>
            <div className="flex shrink-0 items-center" style={{ width: '30mm' }}>
              {qr ? <img src={qr} alt="" style={{ width: '30mm', height: '30mm' }} />
                : <span className="text-[10px]" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}>{failed ? 'QR failed' : 'Drawing QR…'}</span>}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-between">
              <div>
                <p className="text-[11px] font-black leading-tight break-words">{clientName}</p>
                <p className="text-[10px]" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}>{accountNumber} · {cardLabel}</p>
              </div>
              <p className="font-mono text-[11px] font-bold tracking-wide break-all">{groupCode(code)}</p>
              <p className="text-[7px] leading-tight" style={{ color: 'rgb(var(--ink-rgb) / 0.7)' }}>
                Valid only at {companyName ?? 'our'} outlets; report a lost card to finance.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button onClick={() => { setPrinted(true); window.print() }} disabled={!qr}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-black text-primary-on disabled:opacity-50">Print card</button>
          <button onClick={close} className="rounded-lg px-4 py-2 text-sm font-bold text-white/60 hover:text-white">Close</button>
        </div>
      </div>
    </div>
  )
}

export default OnAccountCardPrint
