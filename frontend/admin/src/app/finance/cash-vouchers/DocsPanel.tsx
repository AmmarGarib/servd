'use client'
// After the cash is paid: the holder uploads the supporting documents and
// finance checks them. The expense is ONE entry (owner, 2026-10-16) — booked
// at pay, or, for a voucher paid under the old hold flow, at this check;
// nothing posts to 1357 any more and nothing is recorded line by line.
//
//   • DocumentsPanel — multiple files (PDF, photos, Excel, Word, PowerPoint,
//     CSV, TXT). Photos are compressed like the receipts (photoPrep); every
//     other file goes up as it is (≤ 5 MB, ≤ 20 per voucher).
//   • VerifyPanel — finance marks the documents checked (no lines, no change).
//   • ResolveByJournalPanel — a voucher still held on 1357 that cannot be booked
//     here: finance posts a manual journal (Dr the right account / Cr 1357) and
//     marks the voucher "Resolved by journal entry" (owner, 2026-10-16). Books nothing.
// Every button follows the server's capability flags on the voucher.

import Link from 'next/link'
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api'
import { formatPkr } from './amountInWords'
import { CV_BASE, CV_ROOT, errorWords, fmtDateTime, useCategories, type CashVoucher, type SupportingDoc } from './data'
import { attachmentPath, kb, preparePhoto } from './photo'
import { Button, CheckLabel, ErrorBanner, fieldCls, FieldLabel, Input, LinkButton, primaryBtn, secondaryBtn, Textarea } from './ui'
import { Select } from '@/components/ui/Select'
import { useConfirm } from '../../../components/ui/ConfirmDialog'
import { Modal } from '../../../components/ui/Modal'

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

  // View in the browser (owner, 2026-10-16: "see the document without downloading"): photos and PDFs open in
  // a viewer; Office / text files can only be downloaded. Always shown with the type the upload was checked as.
  const [viewing, setViewing] = useState<{ name: string; url: string; kind: 'image' | 'pdf' } | null>(null)
  const viewable = (d: SupportingDoc) => d.mime.startsWith('image/') || d.mime === 'application/pdf'
  async function view(d: SupportingDoc) {
    try {
      const blob = await api.fetchBlob(attachmentPath(v.id, d.id))
      const typed = new Blob([blob], { type: d.mime })
      setViewing({ name: d.fileName || `Document ${d.id.slice(0, 6)}`, url: URL.createObjectURL(typed), kind: d.mime === 'application/pdf' ? 'pdf' : 'image' })
    } catch (e) { setError(errorWords(e)) }
  }
  function closeViewer() {
    if (viewing) URL.revokeObjectURL(viewing.url)
    setViewing(null)
  }

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
            Attach the bills, receipts or invoices for this cash. Once they are attached the voucher is closed for you — finance checks them afterwards{v.bookedAtPay ? '' : ' and books the expense'}.
          </p>
          <Button type="button" onClick={() => input.current?.click()} disabled={busy || docs.length >= MAX_DOCS}>
            {busy ? 'Uploading…' : docs.length ? '+ Attach more documents' : '+ Attach documents'}
          </Button>
        </div>
      )}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-black text-white/90">Supporting documents</p>
          <p className="text-xs text-s-muted">
            Bills, receipts, invoices — PDF, photos, Excel, Word and similar. Attached documents close the voucher;
            {v.bookedAtPay ? ' the expense was booked when finance paid it, so they are kept under the voucher and book nothing.' : ' finance books the expense once it has checked them.'}
            {v.dueBy && v.status === 'disbursed' ? ` Due by ${fmtDateTime(v.dueBy).split(',')[0]}.` : ''}
          </p>
        </div>
        {v.canUpload && !locked && (
          <>
            <input ref={input} type="file" multiple accept={DOC_ACCEPT} className="hidden" onChange={(e) => void add(e.target.files)} />
            {!needsDocs && (
              <Button variant="secondary" type="button" onClick={() => input.current?.click()} disabled={busy || docs.length >= MAX_DOCS}>
                {busy ? 'Uploading…' : '+ Add documents'}
              </Button>
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
                {viewable(d) && (
                  <LinkButton size="md" type="button" onClick={() => void view(d)}  style={{ color: 'var(--erp-primary)' }}>View</LinkButton>
                )}
                <LinkButton size="md" type="button" onClick={() => void download(d)}  style={{ color: 'var(--erp-primary)' }}>Download</LinkButton>
                {!locked && (v.canUpload || isKeeper) && (
                  <LinkButton tone="danger" size="md" type="button" onClick={async () => {
                    const name = d.fileName || `Document ${d.id.slice(0, 6)}`
                    if (await confirm({ title: `Remove ${name}?`, body: `It is taken off ${v.number}. Finance will not see it when verifying.`, confirmLabel: 'Remove', danger: true })) del.mutate(d.id)
                  }} disabled={del.isPending}>Remove</LinkButton>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="whitespace-pre-line"><ErrorBanner message={error} /></div>}
      {del.error && <ErrorBanner message={errorWords(del.error)} />}
      {viewing && (
        <Modal title={viewing.name} onClose={closeViewer} wide>
          {viewing.kind === 'pdf' ? (
            <iframe src={viewing.url} title={viewing.name} className="w-full rounded-lg" style={{ height: '75vh', border: '1px solid var(--border)' }} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={viewing.url} alt={viewing.name} className="mx-auto max-h-[75vh] max-w-full rounded-lg object-contain" />
          )}
        </Modal>
      )}
    </div>
  )
}

/**
 * Finance's check of a voucher booked at pay (owner, 2026-10-16: "It should pass only one entry when booked by
 * finance"): the expense is already on the books, so this only marks the documents checked — no lines, no change,
 * no money. A difference is corrected with a manual journal.
 */
function CheckDocsPanel({ v }: { v: CashVoucher }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const check = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/verify-docs`, {}, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => {
      toast.success('Documents checked.')
      void qc.invalidateQueries({ queryKey: [CV_ROOT] })
    },
  })
  const noDocs = (v.supportingCount ?? v.documents?.length ?? 0) === 0
  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
      <p className="text-sm font-black text-white/90">Check the documents</p>
      <p className="text-xs text-s-muted">
        PKR {formatPkr(v.amountCents)} was booked as expense in one entry when it was paid{v.paidFrom ? ` from ${v.paidFrom}` : ''}.
        Check the documents above against it and mark them checked — this books nothing.
        If less or more was spent, correct it with a manual journal on{' '}
        <Link href="/accounting/journal" className="underline font-bold">Finance → Journal</Link>, or send the voucher back for documents.
      </p>
      {noDocs && <p className="text-xs font-bold" style={{ color: 'var(--erp-warning)' }}>Upload at least one supporting document first.</p>}
      {check.error && <ErrorBanner message={errorWords(check.error)} />}
      <Button type="submit" disabled={noDocs || check.isPending} 
        onClick={async () => {
          if (await confirm({ title: `Mark the documents of ${v.number} checked?`, body: 'The expense is already booked; this posts nothing.', confirmLabel: 'Mark documents checked' })) { check.reset(); check.mutate() }
        }}>
        {check.isPending ? 'Saving…' : 'Mark documents checked'}
      </Button>
    </div>
  )
}

/** Finance's documents check. A voucher booked at pay gets CheckDocsPanel; one still held from the old flow gets HoldVerifyPanel. */
export function VerifyPanel({ v }: { v: CashVoucher; isKeeper?: boolean }) {
  if (v.bookedAtPay) return <CheckDocsPanel v={v} />
  return <HoldVerifyPanel v={v} />
}

/**
 * A voucher paid under the old hold flow and not booked yet (owner, 2026-10-16: "Don't post any entry in 1357 …
 * only book one entry when confirmed by finance"): checking its documents books it as ONE expense entry in its
 * category — no lines, no change, no overspend (a manual journal corrects a difference).
 */
function HoldVerifyPanel({ v }: { v: CashVoucher }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: cats } = useCategories()
  const categories = (cats?.categories ?? []).filter((c) => c.kind === 'expense')
  const [category, setCategory] = useState(v.category ?? '')
  const changed = category !== (v.category ?? '')
  const verify = useMutation({
    mutationFn: async () => {
      // The expense account first (finance only, books nothing), then the check books the one entry in it.
      if (changed) {
        const isCode = /^\d{4}$/.test(category)
        await api.patch(`${CV_BASE}/${v.id}`, isCode ? { accountCode: category } : { categoryKey: category }, { tenantId: v.tenantId })
      }
      return api.post(`${CV_BASE}/${v.id}/verify-docs`, {}, { tenantId: v.tenantId })
    },
    meta: { inlineErrors: true },
    onSuccess: () => {
      toast.success('Documents checked — the expense is booked in one entry.')
      void qc.invalidateQueries({ queryKey: [CV_ROOT] })
    },
  })
  const noDocs = (v.supportingCount ?? v.documents?.length ?? 0) === 0
  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
      <p className="text-sm font-black text-white/90">Check the documents &amp; book the expense</p>
      <p className="text-xs text-s-muted">
        This voucher was paid before the one-entry rule and its expense is not booked yet. Checking the documents books
        PKR {formatPkr(v.amountCents)} as expense in ONE entry, in its category. If less or more was spent, correct it with a
        manual journal on <Link href="/accounting/journal" className="underline font-bold">Finance → Journal</Link>.
      </p>
      <div>
        <FieldLabel htmlFor="hv-category">Expense account</FieldLabel>
        <div className="mt-1">
          <Select id="hv-category" value={category} onChange={(e) => setCategory(e.target.value)} className={fieldCls}>
            {!categories.some((c) => c.key === category) && category && <option value={category}>{category}</option>}
            <option value="">— pick —</option>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
          </Select>
        </div>
      </div>
      {noDocs && <p className="text-xs font-bold" style={{ color: 'var(--erp-warning)' }}>Upload at least one supporting document first.</p>}
      {verify.error && <ErrorBanner message={errorWords(verify.error)} />}
      <Button type="submit" disabled={noDocs || !category || verify.isPending} 
        onClick={async () => {
          if (await confirm({ title: `Check the documents of ${v.number}?`, body: `This books PKR ${formatPkr(v.amountCents)} as expense in one entry. It cannot be undone from here.`, confirmLabel: 'Check and book' })) { verify.reset(); verify.mutate() }
        }}>
        {verify.isPending ? 'Booking…' : 'Check documents & book'}
      </Button>
    </div>
  )
}

interface ResolveCandidate { id: string; entryDate: string; description: string; creditCents: number; matches: boolean }

/**
 * "Resolved by journal entry" (owner, 2026-10-16: "add the resolved button, and make it block the close"): a voucher
 * still held on 1357 that the documents check cannot book (equipment, stock lines, a hold of another amount, a refused
 * posting) is corrected with a manual journal — Dr the right account / Cr 1357 for the held amount — and marked done
 * here. It posts nothing; the month close is blocked while any voucher is still held.
 */
export function ResolveByJournalPanel({ v }: { v: CashVoucher }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [entryId, setEntryId] = useState('')
  const [note, setNote] = useState('')
  const cands = useQuery<{ heldCents: number; holdDate: string; items: ResolveCandidate[] }>({
    queryKey: [CV_ROOT, 'resolve-candidates', v.id],
    queryFn: () => api.get(`${CV_BASE}/${v.id}/resolve-candidates`),
    enabled: open,
    retry: false,
  })
  const resolve = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/resolve-by-journal`, { journalEntryId: entryId.trim(), note: note.trim() }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => {
      toast.success(`${v.number} marked resolved by the journal entry.`)
      void qc.invalidateQueries({ queryKey: [CV_ROOT] })
    },
  })
  const held = cands.data?.heldCents ?? v.amountCents
  const items = cands.data?.items ?? []
  const ready = entryId.trim().length > 0 && note.trim().length >= 10
  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--erp-warning) 45%, transparent)' }}>
      <p className="text-sm font-black text-white/90">Still held on 1357 — resolve by journal entry</p>
      <p className="text-xs text-s-muted">
        This voucher was paid under the old hold flow and its expense is not booked. If it cannot be booked by checking
        its documents (equipment, stock, a different amount), post a manual journal on{' '}
        <Link href="/accounting/journal" className="underline font-bold">Finance → Journal</Link> — debit the right account,
        credit 1357 for PKR {formatPkr(held)} under the same brand — then mark the voucher resolved by that entry here.
        This posts nothing. The month cannot be closed while a voucher is still held.
      </p>
      {!open ? (
        <Button variant="secondary" type="submit"  onClick={() => setOpen(true)}>Resolved by journal entry…</Button>
      ) : (
        <div className="space-y-3">
          {cands.error && <ErrorBanner message={errorWords(cands.error)} />}
          {cands.isLoading && <p className="text-xs text-s-muted">Loading manual entries…</p>}
          {cands.data && (items.length === 0 ? (
            <p className="text-xs text-s-muted">No unused manual entry crediting 1357 since this voucher was paid. Post it on Finance → Journal first, or paste its id below.</p>
          ) : (
            <div className="space-y-1.5" role="radiogroup" aria-label="Manual journal entries that credit 1357">
              {items.map((e) => (
                <CheckLabel key={e.id} className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs cursor-pointer"
                  style={{ border: `1px solid ${entryId === e.id ? 'var(--erp-primary)' : 'var(--border)'}` }}>
                  <input type="radio" name={`resolve-${v.id}`} checked={entryId === e.id} onChange={() => setEntryId(e.id)} className="mt-0.5" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-bold text-white/85 truncate">{e.description}</span>
                    <span className="block text-white/50">{fmtDateTime(e.entryDate)} · credits 1357 PKR {formatPkr(e.creditCents)}</span>
                  </span>
                  {e.matches
                    ? <span className="text-success font-bold">Clears it</span>
                    : <span className="font-bold" style={{ color: 'var(--erp-warning)' }}>Different amount / brand</span>}
                </CheckLabel>
              ))}
            </div>
          ))}
          <div>
            <FieldLabel htmlFor={`resolve-entry-${v.id}`}>Journal entry id</FieldLabel>
            <Input id={`resolve-entry-${v.id}`} value={entryId} onChange={(e) => setEntryId(e.target.value)} className={`${`${fieldCls} mt-1 font-mono`} w-auto font-mono`} placeholder="Pick above or paste the entry id" />
          </div>
          <div>
            <FieldLabel htmlFor={`resolve-note-${v.id}`}>Note (what the entry corrected, at least 10 characters)</FieldLabel>
            <Textarea id={`resolve-note-${v.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={`${`${fieldCls} mt-1`} w-auto`} />
          </div>
          {resolve.error && <ErrorBanner message={errorWords(resolve.error)} />}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!ready || resolve.isPending} 
              onClick={async () => {
                if (await confirm({
                  title: `Mark ${v.number} resolved by this journal entry?`,
                  body: `The entry must credit 1357 by PKR ${formatPkr(held)}. This posts nothing, and the entry can no longer be reversed or edited afterwards.`,
                  confirmLabel: 'Mark resolved',
                })) { resolve.reset(); resolve.mutate() }
              }}>
              {resolve.isPending ? 'Saving…' : 'Mark resolved'}
            </Button>
            <Button variant="secondary" type="submit"  onClick={() => { setOpen(false); setEntryId(''); setNote('') }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}
