'use client'
// The printed cash payment voucher — format v1 (owner, 2026-10-13: "make a
// format right now basis what u think, then will change format of it later").
// A cash request prints as this paper (CV numbers): who raised it, who takes
// the cash, the category it is booked to, and when the receipts are due.
//
// A5 landscape. One component draws it for the on-screen preview and for the
// print, which goes through window.print(): <PrintPortal> mounts a second copy
// straight under <body>, and the @media print rules hide everything else, so
// only the voucher is on the paper.
//
// Until the director approves, the paper carries a large "NOT APPROVED — DO
// NOT PAY"; a rejected or cancelled voucher prints "VOID". The HOD and the
// director sign in servd (name + time from servd); the cashier and the person
// who takes the cash sign the paper. Colours are the ERP tokens (globals.css)
// — ink on white.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatBrandName } from '../../../lib/brandName'
import { amountInWords, formatPkr } from './amountInWords'
import { cashierOf, fmtDate, fmtDateTime, type CashVoucher } from './data'

const PRINT_CSS = `
.cv-print-root { display: none; }
.cv-sheet { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print {
  @page { size: A5 landscape; margin: 5mm; }
  html, body { background: var(--surface) !important; height: auto !important; overflow: visible !important; }
  body > *:not(.cv-print-root) { display: none !important; }
  .cv-print-root { display: block !important; }
  .cv-print-root .cv-sheet { box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; }
}
`

/** What the paper says across itself, if anything. */
export function watermarkFor(status: string): string[] | null {
  if (status === 'draft' || status === 'hod_signed') return ['NOT APPROVED', 'DO NOT PAY']
  if (status === 'rejected' || status === 'cancelled') return ['VOID']
  return null
}

const ink = 'var(--text)'
const muted = 'var(--muted)'
const rule = 'rgb(var(--ink-rgb) / 0.55)'
const hair = 'rgb(var(--ink-rgb) / 0.22)'

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '6.5pt', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: muted }}>
      {children}
    </div>
  )
}

function FieldBox({ label, value, grow = 1, minH, size = '10pt' }: { label: string; value: React.ReactNode; grow?: number; minH?: string; size?: string }) {
  return (
    <div style={{ flex: `${grow} 1 0`, minWidth: 0 }}>
      <Label>{label}</Label>
      <div style={{ fontSize: size, fontWeight: 600, color: ink, borderBottom: `1px dotted ${rule}`, padding: '0.6mm 0 0.8mm', minHeight: minH ?? '5mm', overflowWrap: 'anywhere' }}>
        {value}
      </div>
    </div>
  )
}

function SignBlock({ title, name, line, when }: { title: string; name: string | null; line: React.ReactNode; when: string | null }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0, border: `1px solid ${hair}`, borderRadius: '1.5mm', padding: '2mm 2.4mm', display: 'flex', flexDirection: 'column' }}>
      <Label>{title}</Label>
      <div style={{ height: '9mm', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', borderBottom: `1px solid ${rule}`, fontSize: '7.5pt', fontStyle: 'italic', color: muted, paddingBottom: '0.6mm' }}>
        {line}
      </div>
      <div style={{ fontSize: '8.5pt', fontWeight: 700, color: ink, marginTop: '1mm', minHeight: '4mm', overflowWrap: 'anywhere' }}>{name || ' '}</div>
      <div style={{ fontSize: '7pt', color: muted, minHeight: '3mm' }}>{when ?? ' '}</div>
    </div>
  )
}

export function VoucherSheet({ v, companyName, categoryLabel }: { v: CashVoucher; companyName: string; categoryLabel: string }) {
  const mark = watermarkFor(v.status)
  const brand = v.conceptName ? formatBrandName(v.conceptName) : null
  const brandDept = [brand, v.department].filter(Boolean).join(' · ') || '—'
  const hodSigned = !!v.hodSignedAt
  const dirSigned = !!v.directorSignedAt
  const cashier = cashierOf(v)

  return (
    <div className="cv-sheet" style={{
      position: 'relative', width: '198mm', minHeight: '128mm', boxSizing: 'border-box', padding: '6mm 7mm 4.5mm',
      background: 'var(--surface)', color: ink, fontFamily: "'Inter', system-ui, sans-serif",
      border: `1px solid ${hair}`, borderRadius: '2mm', overflow: 'hidden', breakInside: 'avoid', pageBreakInside: 'avoid',
      display: 'flex', flexDirection: 'column', gap: '2.6mm',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6mm', borderBottom: '2px solid var(--erp-secondary)', paddingBottom: '2.5mm' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '14pt', fontWeight: 900, letterSpacing: '-0.01em', color: ink, lineHeight: 1.1 }}>{companyName || ' '}</div>
          <div style={{ fontSize: '7.5pt', color: muted, marginTop: '0.8mm' }}>Internal voucher</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: '12pt', fontWeight: 900, letterSpacing: '0.12em', color: 'var(--erp-primary-ink)' }}>CASH PAYMENT VOUCHER</div>
          <div style={{ display: 'flex', gap: '5mm', justifyContent: 'flex-end', marginTop: '1.2mm' }}>
            <div><Label>Voucher No.</Label><div style={{ fontSize: '10.5pt', fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" }}>{v.number}</div></div>
            <div><Label>Date</Label><div style={{ fontSize: '10.5pt', fontWeight: 700 }}>{fmtDate(v.voucherDate)}</div></div>
          </div>
        </div>
      </div>

      {/* Pay to + amount */}
      <div style={{ display: 'flex', gap: '5mm', alignItems: 'stretch' }}>
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2.2mm' }}>
          <FieldBox label="Pay to" value={v.payeeName} />
          <div style={{ display: 'flex', gap: '5mm' }}>
            <FieldBox label="Brand / Department" value={brandDept} />
            <FieldBox label="Category" value={categoryLabel} />
          </div>
        </div>
        <div style={{ width: '52mm', flexShrink: 0, border: `1.5px solid ${rule}`, borderRadius: '1.5mm', padding: '2mm 3mm', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <Label>Amount (PKR)</Label>
          <div style={{ fontSize: '17pt', fontWeight: 900, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>
            {formatPkr(v.amountCents, { decimals: true })}
          </div>
        </div>
      </div>

      <FieldBox label="Amount in words" value={amountInWords(v.amountCents)} />
      {/* Up to 500 characters: a long purpose steps down so the voucher stays on one A5 sheet. */}
      <FieldBox label="Purpose" value={v.purpose} minH="9mm" size={v.purpose.length > 320 ? '7.5pt' : v.purpose.length > 160 ? '8.5pt' : '10pt'} />
      <div style={{ display: 'flex', gap: '5mm' }}>
        <FieldBox label="Raised by" value={v.preparedByName ?? '—'} />
        <FieldBox label="Paid from (cash box)" value={v.boxName ?? '—'} />
        <FieldBox label="Cashier" value={cashier ?? '—'} />
        <FieldBox label="Receipts due by" value={v.dueBy ? fmtDate(v.dueBy) : '—'} />
      </div>

      {/* Signatures */}
      <div style={{ display: 'flex', gap: '2.5mm', marginTop: '0.5mm' }}>
        <SignBlock title="Prepared & signed — HOD" name={hodSigned ? (v.hodSignedByName ?? '—') : null}
          line={hodSigned ? 'Signed in servd' : 'Not signed yet'} when={hodSigned ? fmtDateTime(v.hodSignedAt) : null} />
        <SignBlock title="Approved — Director" name={dirSigned ? (v.directorSignedByName ?? '—') : null}
          line={dirSigned ? 'Signed in servd' : 'Not approved yet'} when={dirSigned ? fmtDateTime(v.directorSignedAt) : null} />
        <SignBlock title="Cash paid by — Cashier" name={cashier} line={' '} when="Date: ____________" />
        <SignBlock title="Received by — Payee" name={v.payeeName} line={' '} when="Date: ____________" />
      </div>

      {/* Footer */}
      <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'space-between', gap: '4mm', borderTop: `1px solid ${hair}`, paddingTop: '1.5mm', fontSize: '6.5pt', color: muted }}>
        <span>Generated by servd. Cash is paid only once the director has approved. Upload the receipts in servd &rarr; Finance &rarr; Cash requests by the due date.</span>
        <span style={{ flexShrink: 0 }}>{v.disbursedAt ? `Paid ${fmtDate(v.disbursedAt)}` : ''}</span>
      </div>

      {mark && (
        <div aria-hidden style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{
            transform: 'rotate(-22deg)', textAlign: 'center', fontWeight: 900, lineHeight: 1.05, letterSpacing: '0.04em',
            color: 'color-mix(in srgb, var(--erp-danger) 30%, transparent)',
            fontSize: mark.length === 1 ? '96pt' : '40pt',
            border: '3px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)', borderRadius: '3mm', padding: '2mm 6mm',
          }}>
            {mark.map((l) => <div key={l}>{l}</div>)}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The copy that prints: mounted under <body>, hidden on screen, the only
 * thing visible on paper while this is on the page.
 */
export function PrintPortal({ v, companyName, categoryLabel }: { v: CashVoucher; companyName: string; categoryLabel: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => { setHost(document.body) }, [])
  return (
    <>
      {/* A fixed string (no data in it); set as HTML so `>` is not escaped. */}
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      {host && createPortal(<div className="cv-print-root"><VoucherSheet v={v} companyName={companyName} categoryLabel={categoryLabel} /></div>, host)}
    </>
  )
}
