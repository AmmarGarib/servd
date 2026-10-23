'use client'
// After the cash is paid (H3: it was booked to the request's category the
// moment it left the box): the holder uploads the receipts, says what they
// were for, and hands back any change.
//   • Receipts — photos or PDFs, kept for the file; they book nothing.
//   • Submit receipts — lines (expense / stock item / equipment) up to what is
//     still open. A line in another category, stock or equipment moves the
//     money there; a line in the same category books nothing new.
//   • Settlements — what was submitted, its lines and receipts; finance may
//     move an expense line to another account.
//   • Change returned — cash back into a box (its custodian or finance).
// Every button follows the server's capability flags on the request.

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { ReceiptUploader, type UploadedReceipt } from '../../../components/finance/ReceiptUploader'
import { SpendLinesEditor, emptyLine, lineBody, linesReady, type SpendLine } from '../../../components/finance/SpendLinesEditor'
import { formatPkr } from './amountInWords'
import {
  CV_BASE, CV_ROOT, categoryWords, errorWords, fmtDate, fmtDateTime, useCategories, useMyBoxes, usePettyBoxes,
  type CashVoucher, type ReceiptMeta, type Settlement,
} from './data'
import { attachmentPath, fetchAttachmentUrl, kb } from './photo'
import { Button, ErrorBanner, fieldCls, Input, LinkButton, primaryBtn, secondaryBtn } from './ui'
import { Select } from '@/components/ui/Select'

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }
const MAX_RECEIPTS = 20

const KIND_WORD: Record<string, string> = { expense: 'Expense', stock: 'Stock', capex: 'Equipment' }

export function SettlePanel({ v, isKeeper }: { v: CashVoucher; isKeeper: boolean }) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [CV_ROOT] })
    void qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] })
  }
  const open = v.remainingCents
  const unsettled = useMemo(() => v.receipts.filter((r) => !r.settlementId), [v.receipts])
  const [receipts, setReceipts] = useState<UploadedReceipt[]>(unsettled)
  useEffect(() => { setReceipts(unsettled) }, [unsettled])
  const [lines, setLines] = useState<SpendLine[]>([emptyLine(open)])
  const [note, setNote] = useState('')
  const pin = { tenantId: v.tenantId }

  const settle = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/settlements`, {
      lines: lines.map(lineBody),
      receiptIds: receipts.map((r) => r.id),
      ...(note.trim() && { note: note.trim() }),
    }, pin),
    meta: { inlineErrors: true },
    onSuccess: () => {
      toast.success('Receipts submitted.')
      setLines([emptyLine(0)])
      setNote('')
      refresh()
    },
  })

  const settled = v.settlements ?? []
  const covered = v.settledCents + v.returnedCents + v.convertedCents
  const ready = linesReady(lines, open, 'atMost') && receipts.length > 0

  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-5 space-y-2" style={card}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-black text-white/90">Receipts</p>
            <p className="text-xs text-s-muted">
              Paid {fmtDateTime(v.disbursedAt)}{(v.paidFrom ?? v.boxName) ? ` from ${v.paidFrom ?? v.boxName}` : ''}{v.paidAccountCode ? ` — booked to ${v.paidAccountCode}` : ''}.
              {v.dueBy && v.status === 'disbursed' ? ` Receipts due by ${fmtDate(v.dueBy)}.` : ''}
            </p>
          </div>
          <div className="text-right">
            <p className="metric-label">Covered</p>
            <p className={`text-sm font-black ${open === 0 ? 'text-success' : 'text-white/85'}`}>
              PKR {formatPkr(covered)} of {formatPkr(v.amountCents)}
            </p>
            {open > 0 && <p className="text-xs" style={{ color: v.overdue ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.5)' }}>PKR {formatPkr(open)} still open{v.overdue ? ' — overdue' : ''}</p>}
          </div>
        </div>
        {v.canUploadReceipts ? (
          <ReceiptUploader
            uploadPath={`${CV_BASE}/${v.id}/receipts`}
            extraBody={{}}
            filePath={(id) => attachmentPath(v.id, id)}
            deletePath={(id) => `${CV_BASE}/${v.id}/receipts/${id}`}
            receipts={receipts}
            onChange={(next) => { setReceipts(next); refresh() }}
            max={Math.max(0, MAX_RECEIPTS - (v.receiptCount - unsettled.length))}
            label="Receipts not yet submitted"
          />
        ) : unsettled.length > 0 ? (
          <Thumbs requestId={v.id} files={unsettled} />
        ) : null}
      </div>

      {v.canSettle && (
        <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
          <p className="text-sm font-black text-white/90">Submit receipts</p>
          <p className="text-xs text-s-muted">
            Say what the receipts above were for. A line in the request&rsquo;s own category books nothing new; another category, stock
            or equipment moves the money there. Up to PKR {formatPkr(open)}.
          </p>
          <SpendLinesEditor lines={lines} onChange={setLines} totalCents={open} canPickAccount={isKeeper}
            tenantId={v.tenantId} fieldClassName={fieldCls} mode="atMost" />
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)" className={fieldCls} />
          {receipts.length === 0 && <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>Add the receipts first — every submission needs at least one.</p>}
          {settle.error && <ErrorBanner message={errorWords(settle.error)} />}
          <Button type="submit" onClick={() => { settle.reset(); settle.mutate() }} disabled={!ready || settle.isPending}>
            {settle.isPending ? 'Submitting…' : `Submit ${receipts.length} receipt${receipts.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}

      {settled.length > 0 && (
        <div className="rounded-2xl p-5 space-y-3" style={card}>
          <p className="text-sm font-black text-white/90">Submitted</p>
          {settled.map((s) => <SettlementCard key={s.id} v={v} s={s} onChanged={refresh} />)}
        </div>
      )}

      {v.canReturnChange && <ChangePanel v={v} isKeeper={isKeeper} onDone={refresh} />}
    </div>
  )
}

function SettlementCard({ v, s, onChanged }: { v: CashVoucher; s: Settlement; onChanged: () => void }) {
  const { data: cats } = useCategories()
  const categories = (cats?.categories ?? []).filter((c) => c.kind === 'expense')
  const [editing, setEditing] = useState<string | null>(null)
  const [pick, setPick] = useState('')
  const reclass = useMutation({
    mutationFn: ({ lineId, categoryKey }: { lineId: string; categoryKey: string }) =>
      api.patch(`${CV_BASE}/${v.id}/settlements/${s.id}/lines/${lineId}`, { categoryKey }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => { toast.success('Line moved — the entry was reposted.'); setEditing(null); onChanged() },
  })
  return (
    <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
      <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
        <span className="font-black text-white/80">#{s.seq} · {fmtDateTime(s.createdAt)}{s.submittedByName ? ` · ${s.submittedByName}` : ''}</span>
        <span className="font-black text-white/85">PKR {formatPkr(s.totalCents)}</span>
      </div>
      {s.note && <p className="text-xs text-s-muted">{s.note}</p>}
      <ul className="space-y-1">
        {s.lines.map((l) => (
          <li key={l.id} className="text-xs flex items-center justify-between gap-2 flex-wrap">
            <span className="text-white/75 min-w-0">
              <span className="s-badge-muted mr-1">{KIND_WORD[l.kind] ?? l.kind}</span>
              {l.description}
              {l.kind === 'stock' && l.quantity != null ? ` · ${l.quantity} ${l.unit ?? ''}` : ''}
              <span className="text-white/40"> → {l.kind === 'expense' ? categoryWords(l.categoryKey ?? l.accountCode, categories) : l.accountCode}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="font-bold text-white/80 tabular-nums">{formatPkr(l.amountCents)}</span>
              {v.canReclass && l.kind === 'expense' && editing !== l.id && (
                <LinkButton type="button" onClick={() => { reclass.reset(); setEditing(l.id); setPick(l.categoryKey ?? '') }}  style={{ color: 'var(--erp-primary)' }}>Move</LinkButton>
              )}
            </span>
            {editing === l.id && (
              <span className="w-full flex items-center gap-2">
                <Select value={pick} onChange={(e) => setPick(e.target.value)} className={`${`${fieldCls} !py-1`} w-auto`}>
                  <option value="">— another category —</option>
                  {categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
                </Select>
                <Button size="sm" type="submit" disabled={!pick || reclass.isPending} onClick={() => reclass.mutate({ lineId: l.id, categoryKey: pick })}>Move</Button>
                <button onClick={() => setEditing(null)} className="text-xs text-s-muted px-1">Keep</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {s.attachments.length > 0 && <Thumbs requestId={v.id} files={s.attachments} />}
      {reclass.error && <ErrorBanner message={errorWords(reclass.error)} />}
    </div>
  )
}

/** Change handed back into a box: Dr petty cash / Cr the account the request was paid to. */
function ChangePanel({ v, isKeeper, onDone }: { v: CashVoucher; isKeeper: boolean; onDone: () => void }) {
  const { data: all = [] } = usePettyBoxes()
  const { data: mine = [] } = useMyBoxes()
  const boxes = (isKeeper ? all : mine).filter((b) => b.isActive && b.tenantId === v.tenantId)
  const [amountCents, setAmountCents] = useState(0)
  const [boxId, setBoxId] = useState(v.boxId ?? '')
  const back = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/return-change`, { amountCents, ...(boxId && boxId !== v.boxId ? { boxId } : {}) }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => { toast.success(`PKR ${formatPkr(amountCents)} back in the box.`); setAmountCents(0); onDone() },
  })
  return (
    <div className="rounded-2xl p-5 space-y-3" style={card}>
      <p className="text-sm font-black text-white/90">Change returned</p>
      <p className="text-xs text-s-muted">Cash the holder hands back. Up to PKR {formatPkr(v.remainingCents)}.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <MoneyInput value={amountCents} onChange={setAmountCents} className={fieldCls} ariaLabel="Change in rupees" />
        {boxes.length > 0 && (
          <Select value={boxId} onChange={(e) => setBoxId(e.target.value)} className={fieldCls} aria-label="Into which box">
            {!v.boxId && <option value="">— into which box —</option>}
            {boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
      </div>
      {back.error && <ErrorBanner message={errorWords(back.error)} />}
      <Button variant="secondary" type="submit" onClick={() => { back.reset(); back.mutate() }} disabled={back.isPending || amountCents <= 0 || amountCents > v.remainingCents || !boxId}>
        {back.isPending ? 'Saving…' : 'Change is back in the box'}
      </Button>
    </div>
  )
}

/** Receipt thumbnails, read with the session (a PDF shows as a tile). */
export function Thumbs({ requestId, files }: { requestId: string; files: ReceiptMeta[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f) => <Thumb key={f.id} requestId={requestId} file={f} />)}
    </div>
  )
}

function Thumb({ requestId, file }: { requestId: string; file: ReceiptMeta }) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  const isImage = file.mime.startsWith('image/')
  useEffect(() => {
    if (!isImage) return
    let live = true
    let made: string | null = null
    fetchAttachmentUrl(requestId, file.id)
      .then((u) => { made = u; if (live) setUrl(u); else URL.revokeObjectURL(u) })
      .catch(() => { if (live) setErr(true) })
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [requestId, file.id, isImage])
  async function open() {
    try { window.open(url ?? await fetchAttachmentUrl(requestId, file.id), '_blank', 'noopener') } catch { setErr(true) }
  }
  return (
    <button type="button" onClick={open} aria-label="Open receipt"
      className="w-20 h-20 rounded-lg overflow-hidden flex items-center justify-center"
      style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }}>
      {url
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={url} alt="Receipt" className="w-full h-full object-cover" />
        : <span className="text-xs font-bold text-white/55 px-1 text-center">{err ? 'Not loaded' : file.mime === 'application/pdf' ? 'PDF' : 'Photo'}<br />{kb(file.sizeBytes)}</span>}
    </button>
  )
}
