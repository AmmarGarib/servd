'use client'
// The printed cash expense voucher — standard layout (2026-10-15): company,
// voucher no. and date, payee, particulars, account, amount / discount / total,
// amount in words, and signature boxes (Requested, Finance, CEO, Paid by,
// Received by). A4 portrait. (Format v1 was the A5 cash payment voucher.)
// A cash request prints as this paper (CV numbers): who raised it, who takes
// the cash, the category it is booked to, and when the receipts are due.
//
// One component draws it for the on-screen preview and for the
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
  @page { size: A4 portrait; margin: 8mm; }
  html, body { background: var(--surface) !important; height: auto !important; overflow: visible !important; }
  body > *:not(.cv-print-root) { display: none !important; }
  .cv-print-root { display: block !important; }
  .cv-print-root .cv-sheet { box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; border: 0 !important; }
}
`

/** What the paper says across itself, if anything. */
export function watermarkFor(status: string): string[] | null {
  if (['draft', 'hod_signed', 'submitted', 'finance_approved', 'returned'].includes(status)) return ['NOT APPROVED', 'DO NOT PAY']
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
  const discount = v.discountCents ?? 0
  const gross = v.grossCents ?? v.amountCents + discount
  const total = v.amountCents
  const words = v.amountInWords || amountInWords(total)
  const financeAt = v.financeApprovedAt ?? v.hodSignedAt ?? null
  const financeBy = v.financeApprovedByName ?? v.hodSignedByName ?? null
  const cashier = cashierOf(v)
  const payee = v.kind === 'expense' ? v.payeeName : (v.holderName ?? v.payeeName)
  const th: React.CSSProperties = { textAlign: 'left', fontSize: '8pt', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: muted, padding: '2mm 3mm', borderBottom: `1.5px solid ${rule}` }
  const td: React.CSSProperties = { padding: '2.2mm 3mm', fontSize: '10.5pt', borderBottom: `1px solid ${hair}` }

  return (
    <div className="cv-sheet" style={{
      position: 'relative', width: '194mm', minHeight: '270mm', boxSizing: 'border-box', padding: '10mm 11mm 8mm',
      background: 'var(--surface)', color: ink, fontFamily: "'Inter', system-ui, sans-serif",
      border: `1px solid ${hair}`, borderRadius: '2mm', overflow: 'hidden', breakInside: 'avoid', pageBreakInside: 'avoid',
      display: 'flex', flexDirection: 'column', gap: '5mm',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6mm', borderBottom: '2px solid var(--erp-secondary)', paddingBottom: '4mm' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '17pt', fontWeight: 900, letterSpacing: '-0.01em', color: ink, lineHeight: 1.1 }}>{companyName || ' '}</div>
          <div style={{ fontSize: '8.5pt', color: muted, marginTop: '1mm' }}>Internal voucher</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: '14pt', fontWeight: 900, letterSpacing: '0.1em', color: 'var(--erp-primary-ink)' }}>CASH EXPENSE VOUCHER</div>
          <div style={{ display: 'flex', gap: '6mm', justifyContent: 'flex-end', marginTop: '2mm' }}>
            <div><Label>Voucher No.</Label><div style={{ fontSize: '12pt', fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" }}>{v.number}</div></div>
            <div><Label>Date</Label><div style={{ fontSize: '12pt', fontWeight: 700 }}>{fmtDate(v.voucherDate)}</div></div>
          </div>
        </div>
      </div>

      {/* Payee and coding */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3.5mm' }}>
        <FieldBox label="Payee" value={payee} size="11.5pt" />
        <FieldBox label="Particulars" value={v.purpose} minH="14mm"
          size={v.purpose.length > 320 ? '8.5pt' : v.purpose.length > 160 ? '9.5pt' : '11pt'} />
        <div style={{ display: 'flex', gap: '6mm' }}>
          <FieldBox label="Expense account" value={categoryLabel} />
          <FieldBox label="Brand / Department" value={brandDept} />
        </div>
      </div>

      {/* Amounts */}
      <table style={{ width: '100%', borderCollapse: 'collapse', border: `1px solid ${hair}` }}>
        <thead>
          <tr><th style={th}>Description</th><th style={{ ...th, textAlign: 'right', width: '45mm' }}>Amount (PKR)</th></tr>
        </thead>
        <tbody>
          <tr><td style={td}>Amount</td><td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPkr(gross, { decimals: true })}</td></tr>
          <tr><td style={td}>Less: discount</td><td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{discount > 0 ? `(${formatPkr(discount, { decimals: true })})` : '—'}</td></tr>
          <tr>
            <td style={{ ...td, fontWeight: 900, borderBottom: 0, background: 'rgb(var(--ink-rgb) / 0.04)' }}>Total payable</td>
            <td style={{ ...td, fontWeight: 900, fontSize: '13pt', textAlign: 'right', borderBottom: 0, fontVariantNumeric: 'tabular-nums', background: 'rgb(var(--ink-rgb) / 0.04)' }}>
              {formatPkr(total, { decimals: true })}
            </td>
          </tr>
        </tbody>
      </table>
      <FieldBox label="Amount in words" value={words} size="10.5pt" />

      <div style={{ display: 'flex', gap: '6mm' }}>
        <FieldBox label="Raised by" value={v.preparedByName ?? '—'} />
        <FieldBox label="Paid from (cash box)" value={v.boxName ?? '—'} />
        <FieldBox label="Documents due by" value={v.dueBy ? fmtDate(v.dueBy) : '—'} />
      </div>

      {/* Signatures */}
      <div style={{ display: 'flex', gap: '2.5mm', marginTop: 'auto' }}>
        <SignBlock title="Requested by" name={v.preparedByName ?? null} line={'Raised in servd'} when={fmtDateTime(v.submittedAt ?? v.createdAt)} />
        <SignBlock title="Finance" name={financeAt ? financeBy : null} line={financeAt ? 'Approved in servd' : 'Not approved yet'} when={financeAt ? fmtDateTime(financeAt) : null} />
        <SignBlock title="CEO" name={v.directorSignedAt ? (v.directorSignedByName ?? '—') : null}
          line={v.directorSignedAt ? 'Approved in servd' : 'Not approved yet'} when={v.directorSignedAt ? fmtDateTime(v.directorSignedAt) : null} />
        <SignBlock title="Paid by" name={cashier} line={' '} when="Date: ____________" />
        <SignBlock title="Received by" name={payee} line={' '} when="Date: ____________" />
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4mm', borderTop: `1px solid ${hair}`, paddingTop: '2mm', fontSize: '7pt', color: muted }}>
        <span>Generated by servd. Cash is paid only once the CEO has approved; the expense is booked when finance verifies the supporting documents.</span>
        <span style={{ flexShrink: 0 }}>{v.disbursedAt ? `Paid ${fmtDate(v.disbursedAt)}` : ''}</span>
      </div>

      {mark && (
        <div aria-hidden style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{
            transform: 'rotate(-30deg)', textAlign: 'center', fontWeight: 900, lineHeight: 1.05, letterSpacing: '0.04em',
            color: 'color-mix(in srgb, var(--erp-danger) 30%, transparent)',
            fontSize: mark.length === 1 ? '110pt' : '46pt',
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
