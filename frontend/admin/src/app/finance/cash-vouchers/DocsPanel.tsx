'use client'
// After the cash is paid (2026-10-15 flow): the holder uploads the supporting
// documents and says what was actually spent (and any change handed back);
// finance then verifies the documents — that books the expense.
//
//   • DocumentsPanel — multiple files (PDF, photos, Excel, Word, PowerPoint,
//     CSV, TXT). Photos are compressed like the receipts (photoPrep); every
//     other file goes up as it is (≤ 5 MB, ≤ 20 per voucher).
//   • SpentPanel — the holder's lines (what was spent) and the change returned.
//   • VerifyPanel — finance confirms the lines and the change, then books it.
// Every button follows the server's capability flags on the voucher.

import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api'
import { SpendLinesEditor, emptyLine, lineBody, linesReady, type SpendLine } from '../../../components/finance/SpendLinesEditor'
import { formatPkr } from './amountInWords'
import { CV_BASE, CV_ROOT, errorWords, fmtDateTime, usePettyBoxes, type CashVoucher, type SupportingDoc } from './data'
import { attachmentPath, kb, preparePhoto } from './photo'
import { ErrorBanner, fieldCls, primaryBtn, secondaryBtn, useSubmitOnce } from './ui'
import { Select } from '@/components/ui/Select'
import { useConfirm } from '../../../components/ui/ConfirmDialog'

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }
export const DOC_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.csv,.txt'
const MAX_DOCS = 20
const MAX_BYTES = 5 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  csv: 'text/csv', txt: 'text/plain',
}
const extOf = (name: string) => (name.split('.').pop() ?? '').toLowerCase()

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => { const s = String(r.result ?? ''); resolve(s.slice(s.indexOf(',') + 1)) }
    r.onerror = () => reject(new Error('This browser could not read the file.'))
    r.readAsDataURL(file)
  })
}

/** Photos are compressed to JPEG; everything else goes up as it is. */
async function prepareDocument(file: File): Promise<{ fileName: string; mime: string; dataBase64: string }> {
  const ext = extOf(file.name)
  if (!MIME_BY_EXT[ext]) throw new Error(`${file.name}: this file type is not accepted.`)
  if (file.type.startsWith('image/') && ext !== 'webp' || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    const p = await preparePhoto(file)
    return { fileName: file.name.replace(/\.[^.]+$/, '') + '.jpg', mime: p.mime, dataBase64: p.base64 }
  }
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 5 MB.`)
  return { fileName: file.name, mime: MIME_BY_EXT[ext]!, dataBase64: await fileToBase64(file) }
}

/** Size and type, checked on select (the same list the server takes — evidenceFile allowOffice). Photos are compressed before upload, so only other files carry the 5 MB cap. */
export function checkDocument(file: File): string | null {
  const ext = extOf(file.name)
  if (!MIME_BY_EXT[ext]) return `${file.name}: not accepted. Use PDF, photos, Excel, Word, PowerPoint, CSV or TXT.`
  const isPhoto = ['jpg', 'jpeg', 'png', 'webp'].includes(ext)
  if (!isPhoto && file.size > MAX_BYTES) return `${file.name}: ${kb(file.size)} is over the 5 MB limit.`
  if (file.size === 0) return `${file.name}: the file is empty.`
  return null
}

export function DocumentsPanel({ v, isKeeper }: { v: CashVoucher; isKeeper: boolean }) {
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const docs: SupportingDoc[] = v.documents ?? []
  const refresh = () => void qc.invalidateQueries({ queryKey: [CV_ROOT] })
  const locked = v.status === 'posted'

  async function add(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    const picked = Array.from(files)
    const refused = picked.map(checkDocument).filter((m): m is string => !!m)
    const okFiles = picked.filter((f) => !checkDocument(f))
    if (refused.length > 0) setError(refused.join('\n'))
    if (okFiles.length === 0) { if (input.current) input.current.value = ''; return }
    setBusy(true)
    try {
      let count = docs.length
      for (const [i, f] of okFiles.entries()) {
        if (count >= MAX_DOCS) { setError(`A voucher takes at most ${MAX_DOCS} documents.`); break }
        setUploading(`Uploading ${f.name}${okFiles.length > 1 ? ` (${i + 1} of ${okFiles.length})` : ''}…`)
        try {
          const body = await prepareDocument(f)
          await api.post(`${CV_BASE}/${v.id}/documents`, body, { tenantId: v.tenantId })
          count++
        } catch (e) { setError(e instanceof Error && !('code' in e) ? e.message : errorWords(e)); break }
      }
    } finally {
      setBusy(false); setUploading(null); if (input.current) input.current.value = ''; refresh()
    }
  }

  const del = useMutation({
    mutationFn: (aid: string) => api.delete(`${CV_BASE}/${v.id}/documents/${aid}`, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: refresh,
  })

  async function download(d: SupportingDoc) {
    try { await api.download(attachmentPath(v.id, d.id), d.fileName || `${v.number}-document-${d.id.slice(0, 6)}`) }
    catch (e) { setError(errorWords(e)) }
  }

  // The requester's / holder's job after the cash is paid: attach the bills. Shown big until the voucher is closed.
  const needsDocs = !!v.canUpload && v.status === 'disbursed' && !!v.expenseOnVerify && !v.closed
  return (
    <div className="rounded-2xl p-5 space-y-3"
      style={needsDocs ? { background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.45)' } : card}>
      {needsDocs && (
        <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.06)' }}>
          <p className="text-sm font-black text-white/90">{v.sentBack ? 'Finance needs more documents' : 'Attach your supporting documents'}</p>
          <p className="text-xs text-white/60">
            {v.sentBack && v.sentBackNote ? `Finance: “${v.sentBackNote}”. ` : ''}
            Attach the bills, receipts or invoices for this cash. Once they are attached the voucher is closed for you — finance checks them afterwards and books the expense.
          </p>
          <button type="button" onClick={() => input.current?.click()} disabled={busy || docs.length >= MAX_DOCS} className={primaryBtn}>
            {busy ? 'Uploading…' : docs.length ? '+ Attach more documents' : '+ Attach documents'}
          </button>
        </div>
      )}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-black text-white/90">Supporting documents</p>
          <p className="text-xs text-white/50">
            Bills, receipts, invoices — PDF, photos, Excel, Word and similar. Attached documents close the voucher; finance books the expense once it has checked them.
            {v.dueBy && v.status === 'disbursed' ? ` Due by ${fmtDateTime(v.dueBy).split(',')[0]}.` : ''}
          </p>
        </div>
        {v.canUpload && !locked && (
          <>
            <input ref={input} type="file" multiple accept={DOC_ACCEPT} className="hidden" onChange={(e) => void add(e.target.files)} />
            {!needsDocs && (
              <button type="button" onClick={() => input.current?.click()} disabled={busy || docs.length >= MAX_DOCS} className={secondaryBtn}>
                {busy ? 'Uploading…' : '+ Add documents'}
              </button>
            )}
          </>
        )}
      </div>

      {uploading && <p role="status" className="text-xs font-bold text-white/70">{uploading}</p>}
      {docs.length === 0 && (
        <p className="text-xs font-bold" style={{ color: v.status === 'disbursed' ? 'var(--erp-warning)' : undefined }}>
          {v.status === 'disbursed' && v.expenseOnVerify ? 'No documents yet — they are missing.' : 'No supporting documents attached.'}
        </p>
      )}
      {docs.length > 0 && (
        <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {docs.map((d) => (
            <li key={d.id} className="py-2 flex items-center justify-between gap-3 flex-wrap text-xs">
              <span className="min-w-0">
                <span className="font-bold text-white/85 break-all">{d.fileName || `Document ${d.id.slice(0, 6)}`}</span>
                <span className="text-white/45"> · {kb(d.sizeBytes)} · {d.uploadedByName ?? '—'} · {fmtDateTime(d.createdAt)}</span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <button type="button" onClick={() => void download(d)} className="font-bold" style={{ color: 'var(--erp-primary)' }}>Download</button>
                {!locked && (v.canUpload || isKeeper) && (
                  <button type="button" onClick={async () => {
                    const name = d.fileName || `Document ${d.id.slice(0, 6)}`
                    if (await confirm({ title: `Remove ${name}?`, body: `It is taken off ${v.number}. Finance will not see it when verifying.`, confirmLabel: 'Remove', danger: true })) del.mutate(d.id)
                  }} disabled={del.isPending}
                    className="font-bold text-s-red">Remove</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="whitespace-pre-line"><ErrorBanner message={error} /></div>}
      {del.error && <ErrorBanner message={errorWords(del.error)} />}
    </div>
  )
}

/** One default line: the voucher's own category × the amount paid. */
function defaultLines(v: CashVoucher): SpendLine[] {
  const prior = v.spend?.lines?.length ? v.spend.lines : (v.settlements ?? []).flatMap((s) => s.lines)
  if (prior.length > 0) {
    return prior.map((l) => ({
      kind: l.kind, categoryKey: l.categoryKey ?? '', accountCode: l.categoryKey ? '' : l.accountCode, amountCents: l.amountCents,
      description: l.description, conceptId: l.conceptId ?? '',
      ...(l.inventoryItemId ? { inventoryItemId: l.inventoryItemId, quantity: String(l.quantity ?? ''), unit: l.unit ?? '' } : {}),
      ...(l.capexLineId ? { capexLineId: l.capexLineId } : {}),
    }))
  }
  const cat = v.category ?? ''
  const isCode = /^\d{4}$/.test(cat)
  return [{ ...emptyLine(v.amountCents, v.purpose), categoryKey: isCode ? '' : cat, accountCode: isCode ? cat : '', conceptId: v.conceptId ?? '' }]
}

/** The holder: what was actually spent. Books nothing — finance verifies against the documents. */
export function SpentPanel({ v, isKeeper }: { v: CashVoucher; isKeeper: boolean }) {
  const qc = useQueryClient()
  const [lines, setLines] = useState<SpendLine[]>(() => defaultLines(v))
  const [note, setNote] = useState('')
  const spent = lines.reduce((s, l) => s + l.amountCents, 0)
  const save = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/spend`, {
      lines: lines.map(lineBody),
      ...(note.trim() ? { note: note.trim() } : {}),
    }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => { toast.success('Saved — finance will check it against your documents.'); void qc.invalidateQueries({ queryKey: [CV_ROOT] }) },
  })
  const ready = lines.length > 0 && linesReady(lines, Math.max(spent, 1), 'atMost')
  const submit = useSubmitOnce(save.isPending)(() => { if (!ready) return false; save.reset(); save.mutate(); return true })
  const change = v.amountCents - spent
  return (
    <form onSubmit={submit} className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
      <p className="text-sm font-black text-white/90">What was spent</p>
      <p className="text-xs text-white/50">
        Cash paid PKR {formatPkr(v.amountCents)}. List what you spent it on. Nothing is booked until finance verifies the documents.
      </p>
      <SpendLinesEditor lines={lines} onChange={setLines} totalCents={Math.max(spent, v.amountCents)} canPickAccount={isKeeper}
        tenantId={v.tenantId} fieldClassName={fieldCls} mode="atMost" />
      <p className="text-xs text-white/55">
        Spent PKR {formatPkr(spent)}
        {change > 0 ? ` — PKR ${formatPkr(change)} change to hand back` : change < 0 ? ` — PKR ${formatPkr(-change)} more than was paid; finance pays the difference` : ''}
      </p>
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)" aria-label="Note (optional)" className={fieldCls} />
      {save.error && <ErrorBanner message={errorWords(save.error)} />}
      {!ready && <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>Every line needs a category and an amount before this can be saved.</p>}
      <button type="submit" disabled={!ready || save.isPending} className={primaryBtn}>
        {save.isPending ? 'Saving…' : 'Save what was spent'}
      </button>
    </form>
  )
}

/** Finance: confirm the lines, then verify the documents and book the expense. Change / difference move through the box — or, for a voucher paid from cash on hand / a bank, that same account. */
export function VerifyPanel({ v, isKeeper }: { v: CashVoucher; isKeeper: boolean }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: boxes = [] } = usePettyBoxes()
  const companyBoxes = boxes.filter((b) => b.isActive && b.tenantId === v.tenantId)
  const [lines, setLines] = useState<SpendLine[]>(() => defaultLines(v))
  const [boxId, setBoxId] = useState(v.boxId ?? '')
  const spent = lines.reduce((s, l) => s + l.amountCents, 0)
  const change = Math.max(0, v.amountCents - spent)
  const topUp = Math.max(0, spent - v.amountCents)
  // Paid from cash on hand / a bank (2026-10-16): change goes back there and an overspend is paid from there — no box.
  const direct = !!v.paySource && v.paySource !== 'box'
  const where = direct ? (v.paidFrom ?? (v.paySource === 'bank' ? 'the bank' : 'cash on hand')) : 'the box'
  const verify = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/verify-docs`, {
      lines: lines.map(lineBody),
      ...(change > 0 ? { changeCents: change, ...(boxId && !direct ? { changeBoxId: boxId } : {}) } : {}),
      ...(topUp > 0 && boxId && !direct ? { topUpBoxId: boxId } : {}),
    }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => {
      toast.success('Documents verified — the expense is booked.')
      void qc.invalidateQueries({ queryKey: [CV_ROOT] }); void qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] })
    },
  })
  const noDocs = (v.supportingCount ?? v.documents?.length ?? 0) === 0
  const ready = lines.length > 0 && linesReady(lines, Math.max(spent, 1), 'atMost') && !noDocs
  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
      <p className="text-sm font-black text-white/90">Verify documents &amp; book the expense</p>
      <p className="text-xs text-white/50">
        Check the documents above against the lines (the holder&rsquo;s own lines are filled in if they recorded them). Cash paid PKR {formatPkr(v.amountCents)}.
      </p>
      <SpendLinesEditor lines={lines} onChange={setLines} totalCents={Math.max(spent, v.amountCents)} canPickAccount={isKeeper}
        tenantId={v.tenantId} fieldClassName={fieldCls} mode="atMost" />
      <p className="text-xs text-white/55">
        Spent PKR {formatPkr(spent)}
        {change > 0 ? ` — change PKR ${formatPkr(change)} goes back to ${where}` : topUp > 0 ? ` — PKR ${formatPkr(topUp)} over; paid to the holder from ${where} in this step` : ' — equals the cash paid'}
      </p>
      {(change > 0 || topUp > 0) && !direct && companyBoxes.length > 0 && (
        <div>
          <label htmlFor="vf-box" className="text-xs text-white/55">{change > 0 ? 'Change goes into' : 'Difference paid from'} (default: the box it was paid from)</label>
          <div className="mt-1">
            <Select id="vf-box" value={boxId} onChange={(e) => setBoxId(e.target.value)} className={fieldCls}>
              {!v.boxId && <option value="">— pick a box —</option>}
              {companyBoxes.map((b) => <option key={b.id} value={b.id}>{b.name} · PKR {formatPkr(b.floatCents)}</option>)}
            </Select>
          </div>
        </div>
      )}
      {noDocs && <p className="text-xs font-bold" style={{ color: 'var(--erp-warning)' }}>Upload at least one supporting document first.</p>}
      {verify.error && <ErrorBanner message={errorWords(verify.error)} />}
      <button disabled={!ready || verify.isPending} className={primaryBtn}
        onClick={async () => {
          if (await confirm({ title: `Verify the documents of ${v.number}?`, body: `This books PKR ${formatPkr(spent)} as expense. It cannot be undone from here.`, confirmLabel: 'Verify and book' })) { verify.reset(); verify.mutate() }
        }}>
        {verify.isPending ? 'Booking…' : 'Verify documents & book'}
      </button>
    </div>
  )
}
