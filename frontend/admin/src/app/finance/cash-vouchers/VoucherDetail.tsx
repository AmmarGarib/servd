'use client'
// One cash voucher: where it is in the chain, the actions its status allows,
// the printed voucher, and — once approved — the upload of the signed paper's
// photo, which is the ONE step that puts it in cash (a petty-cash spend).
// The server decides every action; the buttons only follow the status.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api'
import { formatBrandName } from '../../../lib/brandName'
import { usePermissions } from '../../../hooks/useCan'
import { useAuthStore } from '../../../store/auth'
import { useMyTenants } from '../../../components/ui/TenantPicker'
import { amountInWords, formatPkr } from './amountInWords'
import {
  CV_BASE, CV_ROOT, boxNameOf, brandNameOf, cashierOf, errorWords, fmtDate, fmtDateTime, usePettyBoxes, useVoucher,
  type CashVoucher,
} from './data'
import { fetchPhotoUrl, kb, preparePhoto, type PreparedPhoto } from './photo'
import { PrintPortal, VoucherSheet } from './VoucherPrint'
import { VoucherForm } from './VoucherForm'
import { ErrorBanner, StatusBadge, dangerOutlineBtn, primaryBtn, secondaryBtn } from './ui'

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }

type Act = 'sign-hod' | 'approve' | 'reject' | 'cancel'
const ACT_WORD: Record<Act, 'sign' | 'approve' | 'reject' | 'cancel'> = { 'sign-hod': 'sign', approve: 'approve', reject: 'reject', cancel: 'cancel' }
const ACT_DONE: Record<Act, string> = {
  'sign-hod': 'Signed as HOD — now waiting for the director.',
  approve: 'Approved — print it; the cashier signs and pays.',
  reject: 'Voucher rejected.',
  cancel: 'Voucher cancelled.',
}

export function VoucherDetail({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data: v, isLoading, error } = useVoucher(id)
  const { data: me } = usePermissions()
  const user = useAuthStore((s) => s.user)
  const isCeo = (me?.role ?? user?.role) === 'admin'
  const { data: tenants = [] } = useMyTenants()
  // A cash keeper can read the boxes; the cashier who only holds a box
  // (403 there) opens, prints and pays a voucher but never cancels one.
  const { isSuccess: isKeeper } = usePettyBoxes()
  const [editing, setEditing] = useState(false)
  const [noteFor, setNoteFor] = useState<'reject' | 'cancel' | null>(null)
  const [note, setNote] = useState('')

  function refresh() {
    void qc.invalidateQueries({ queryKey: [CV_ROOT] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })     // the inbox and its badge
  }

  const act = useMutation({
    mutationFn: ({ kind, body }: { kind: Act; body: Record<string, unknown> }) =>
      // Pinned to the voucher's company, so the "All companies" view never asks.
      api.post<CashVoucher>(`${CV_BASE}/${id}/${kind}`, body, v?.tenantId ? { tenantId: v.tenantId } : undefined),
    meta: { inlineErrors: true },
    onSuccess: (_r, { kind }) => { toast.success(ACT_DONE[kind]); setNoteFor(null); setNote(''); refresh() },
  })

  if (isLoading) return <p className="px-7 py-10 text-sm text-white/40">Loading…</p>
  if (error || !v) {
    return (
      <div className="px-7 py-10">
        <ErrorBanner message={error ? errorWords(error) : 'This voucher was not found.'} />
        <Link href="/finance/cash-vouchers" className="inline-block mt-4 text-sm font-bold text-primary-ink hover:underline">← All cash vouchers</Link>
      </div>
    )
  }

  const companyName = v.companyName ?? v.tenant?.name ?? tenants.find((t) => t.id === v.tenantId)?.name ?? ''
  const brand = brandNameOf(v)
  const sameSigner = isCeo && !!user?.id && v.hodSignedById === user.id
  const canCancel = (isKeeper || isCeo) && v.status === 'draft' || v.status === 'hod_signed' || v.status === 'approved'
  const run = (kind: Act, body: Record<string, unknown> = {}) => { act.reset(); act.mutate({ kind, body }) }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <PrintPortal v={v} companyName={companyName} />

      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance/cash-vouchers" className="text-xs text-white/40 hover:text-white/70">← Cash vouchers</Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">Cash voucher</p>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-black text-white/90 mono">{v.number}</h1>
              <StatusBadge status={v.status} />
            </div>
            <p className="text-sm text-white/55 mt-1">
              Pay to <span className="font-bold text-white/80">{v.payeeName}</span> · {fmtDate(v.voucherDate)}
            </p>
          </div>
          <div className="text-right">
            <p className="metric-label">Amount</p>
            <p className="metric-value-xl text-white/90">PKR {formatPkr(v.amountCents)}</p>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-5xl mx-auto space-y-4">
        <Steps v={v} />

        {/* Actions */}
        <div className="rounded-2xl p-4 space-y-3" style={card}>
          <div className="flex flex-wrap items-center gap-2">
            {v.status === 'draft' && (
              <>
                <button onClick={() => run('sign-hod')} disabled={act.isPending} className={primaryBtn}>Sign as HOD</button>
                <button onClick={() => setEditing(true)} className={secondaryBtn}>Edit</button>
              </>
            )}
            {v.status === 'hod_signed' && isCeo && (
              <>
                <button disabled={act.isPending || sameSigner} className={primaryBtn}
                  onClick={() => { if (window.confirm(`Approve ${v.number} for PKR ${formatPkr(v.amountCents)} to ${v.payeeName}? The cashier may then pay against the printed voucher.`)) run('approve') }}>
                  Approve
                </button>
                <button onClick={() => { act.reset(); setNoteFor(noteFor === 'reject' ? null : 'reject') }} disabled={act.isPending} className={dangerOutlineBtn}>Reject</button>
              </>
            )}
            <button onClick={() => window.print()} className={v.status === 'approved' ? primaryBtn : secondaryBtn}>
              {v.status === 'approved' ? 'Print voucher' : v.status === 'disbursed' ? 'Print copy' : 'Print'}
            </button>
            {canCancel && (
              <button onClick={() => { act.reset(); setNoteFor(noteFor === 'cancel' ? null : 'cancel') }} disabled={act.isPending}
                className={`${dangerOutlineBtn} sm:ml-auto`}>
                Cancel voucher
              </button>
            )}
          </div>

          {v.status === 'draft' && (
            <p className="text-xs text-white/50">The HOD signs first; then it waits for the director (CEO). Edit is possible until the HOD signs.</p>
          )}
          {v.status === 'hod_signed' && !isCeo && (
            <p className="text-xs text-white/50">Signed by the HOD — waiting for the director (CEO) to approve. Do not pay until it is approved.</p>
          )}
          {v.status === 'hod_signed' && sameSigner && (
            <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>You signed this voucher as HOD. The director must be a different person from the HOD who signed.</p>
          )}
          {(v.status === 'draft' || v.status === 'hod_signed') && (
            <p className="text-xs text-white/40">Printed now, the voucher says &ldquo;NOT APPROVED — DO NOT PAY&rdquo;.</p>
          )}
          {v.status === 'approved' && (
            <p className="text-xs text-white/55">Print it and hand it to the cashier. The cashier pays and signs, the payee signs, then upload a photo of the signed paper below.</p>
          )}

          {noteFor && (
            <div className="rounded-xl p-3" style={{ background: 'var(--elevated)' }}>
              <label className="text-[11px] font-bold text-white/60">
                {noteFor === 'reject' ? 'Why is it rejected? (the HOD sees this)' : 'Why is it cancelled?'}
              </label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} autoFocus
                className="mt-1 w-full rounded-lg px-2 py-1.5 text-sm"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }} />
              <div className="mt-2 flex gap-2">
                <button disabled={act.isPending || note.trim().length < 3} onClick={() => run(noteFor, { note: note.trim() })}
                  className="rounded-lg px-3 py-1.5 text-xs font-black disabled:opacity-50 bg-s-red text-bone">
                  {act.isPending ? 'Saving…' : noteFor === 'reject' ? 'Reject voucher' : 'Cancel voucher'}
                </button>
                <button onClick={() => { setNoteFor(null); setNote('') }} className="text-xs font-bold text-white/50 px-2">Keep it</button>
              </div>
            </div>
          )}

          {act.error && <ErrorBanner message={errorWords(act.error, act.variables ? ACT_WORD[act.variables.kind] : undefined)} />}
        </div>

        {v.status === 'approved' && <UploadSigned v={v} onDone={refresh} />}
        {v.status === 'disbursed' && <PaidPanel v={v} />}
        {v.status === 'rejected' && (
          <div className="rounded-2xl p-4 bg-s-red-dim border border-s-red/30">
            <p className="text-sm font-black text-s-red">Rejected{v.rejectedByName ? ` by ${v.rejectedByName}` : ''}{v.rejectedAt ? ` · ${fmtDateTime(v.rejectedAt)}` : ''}</p>
            {v.rejectNote && <p className="text-sm text-white/75 mt-1">{v.rejectNote}</p>}
          </div>
        )}
        {v.status === 'cancelled' && (
          <div className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/75">Cancelled{v.cancelledByName ? ` by ${v.cancelledByName}` : ''}{v.cancelledAt ? ` · ${fmtDateTime(v.cancelledAt)}` : ''}</p>
            {v.cancelNote && <p className="text-sm text-white/60 mt-1">{v.cancelNote}</p>}
          </div>
        )}

        {/* Facts */}
        <div className="rounded-2xl p-5" style={card}>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <Fact label="Pay to" value={v.payeeName} />
            <Fact label="Amount" value={`PKR ${formatPkr(v.amountCents, { decimals: true })}`} />
            <Fact label="In words" value={amountInWords(v.amountCents)} wide />
            <Fact label="Purpose" value={v.purpose} wide />
            <Fact label="Category" value={v.category || '—'} />
            <Fact label="Brand / Department" value={[brand ? formatBrandName(brand) : null, v.department].filter(Boolean).join(' · ') || '—'} />
            <Fact label="Paid from" value={boxNameOf(v) ?? '—'} />
            <Fact label="Cashier" value={cashierOf(v) ?? '—'} />
            <Fact label="Prepared by" value={`${v.preparedByName ?? '—'} · ${fmtDateTime(v.createdAt)}`} />
            {companyName && <Fact label="Company" value={companyName} />}
          </dl>
        </div>

        {/* The paper */}
        <div className="rounded-2xl p-4" style={card}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm font-black text-white/80">The voucher as it prints</p>
            <p className="text-[11px] text-white/40">A5 landscape</p>
          </div>
          <div className="overflow-x-auto pb-1">
            <VoucherSheet v={v} companyName={companyName} />
          </div>
        </div>
      </div>

      {editing && (
        <VoucherForm voucher={v} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); toast.success('Draft saved.'); refresh() }} />
      )}
    </div>
  )
}

function Fact({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-[11px] uppercase tracking-wider text-white/40">{label}</dt>
      <dd className="text-white/85 font-semibold break-words">{value}</dd>
    </div>
  )
}

/** Prepared → HOD → director → paid; done steps are green (state), the rest wait. */
function Steps({ v }: { v: CashVoucher }) {
  const steps: Array<{ title: string; who: string | null; when: string | null; state: 'done' | 'bad' | 'todo' }> = [
    { title: 'Prepared', who: v.preparedByName ?? null, when: v.createdAt, state: 'done' },
    { title: 'Signed — HOD', who: v.hodSignedByName ?? null, when: v.hodSignedAt, state: v.hodSignedAt ? 'done' : 'todo' },
    v.status === 'rejected'
      ? { title: 'Rejected — director', who: v.rejectedByName ?? null, when: v.rejectedAt ?? null, state: 'bad' }
      : { title: 'Approved — director', who: v.directorSignedByName ?? null, when: v.directorSignedAt, state: v.directorSignedAt ? 'done' : 'todo' },
    { title: 'Paid — in petty cash', who: v.disbursedByName ?? cashierOf(v), when: v.disbursedAt ?? null, state: v.status === 'disbursed' ? 'done' : 'todo' },
  ]
  return (
    <ol className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {steps.map((s) => (
        <li key={s.title} className="rounded-xl p-3" style={card}>
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${s.state === 'done' ? 'bg-accent' : s.state === 'bad' ? 'bg-s-red' : 'border border-white/25'}`} />
            <span className={`text-xs font-black ${s.state === 'done' ? 'text-success' : s.state === 'bad' ? 'text-s-red' : 'text-white/45'}`}>{s.title}</span>
          </div>
          <p className="text-[11px] text-white/60 mt-1 truncate">{s.state === 'todo' ? 'Waiting' : (s.who ?? '—')}</p>
          {s.state !== 'todo' && s.when && <p className="text-[10px] text-white/40">{fmtDateTime(s.when)}</p>}
        </li>
      ))}
    </ol>
  )
}

/** Approved: the cashier has paid against the printed paper — upload its photo. */
function UploadSigned({ v, onDone }: { v: CashVoucher; onDone: () => void }) {
  const qc = useQueryClient()
  const { data: boxes } = usePettyBoxes()
  const box = boxes?.find((b) => b.id === v.boxId)
  const short = !!box && box.floatCents < v.amountCents
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [pickErr, setPickErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.previewUrl) }, [photo])

  async function onPick(file: File | undefined) {
    if (!file) return
    setPickErr(null); setPreparing(true)
    try { setPhoto(await preparePhoto(file)) } catch (e) { setPickErr(e instanceof Error ? e.message : 'That photo could not be read.') }
    finally { setPreparing(false); if (inputRef.current) inputRef.current.value = '' }
  }

  const upload = useMutation({
    mutationFn: () => api.post<CashVoucher>(`${CV_BASE}/${v.id}/disburse`, { photo: photo!.base64, mime: photo!.mime }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => {
      toast.success(`${v.number} is paid — booked as a petty-cash spend.`)
      void qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] })
      onDone()
    },
  })

  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
      <p className="text-sm font-black text-white/90">Upload the signed voucher</p>
      <p className="text-sm font-bold rounded-xl px-3 py-2 bg-s-amber-dim text-s-amber">
        Uploading the photo of the voucher signed by the cashier puts it in cash (a petty-cash spend). Only upload after the cash is paid.
      </p>
      {short && (
        <p className="text-xs text-s-red font-bold">
          {box!.name} holds PKR {formatPkr(box!.floatCents)} — less than this voucher. The cash box doesn&rsquo;t hold enough — top it up first.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className={`${photo ? secondaryBtn : primaryBtn} cursor-pointer inline-flex items-center`}>
          {preparing ? 'Preparing photo…' : photo ? 'Retake photo' : 'Take or choose photo'}
          <input ref={inputRef} type="file" accept="image/*" capture="environment" className="sr-only"
            disabled={preparing || upload.isPending} onChange={(e) => onPick(e.target.files?.[0])} />
        </label>
        {photo && (
          <button onClick={() => upload.mutate()} disabled={upload.isPending} className={primaryBtn}>
            {upload.isPending ? 'Uploading…' : 'Upload — the cash is paid'}
          </button>
        )}
      </div>
      {pickErr && <ErrorBanner message={pickErr} />}

      {photo && (
        <div className="flex flex-wrap items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.previewUrl} alt="The signed voucher, ready to upload" className="max-h-64 rounded-lg border border-white/10" />
          <p className="text-[11px] text-white/45">{photo.width} × {photo.height} · {kb(photo.bytes)} JPEG</p>
        </div>
      )}
      {upload.error && <ErrorBanner message={errorWords(upload.error, 'disburse')} />}
    </div>
  )
}

/** Paid: where it was paid from, and the signed paper. */
function PaidPanel({ v }: { v: CashVoucher }) {
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const want = v.hasPhoto !== false

  useEffect(() => {
    if (!want) return
    let live = true
    let made: string | null = null
    fetchPhotoUrl(v.id)
      .then((u) => { made = u; if (live) setUrl(u); else URL.revokeObjectURL(u) })
      .catch((e: unknown) => { if (live) setErr(errorWords(e)) })
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [v.id, want])

  const box = boxNameOf(v) ?? 'the cash box'
  const cashier = cashierOf(v) ?? 'the cashier'
  return (
    <div className="rounded-2xl p-5 space-y-3 bg-accent-dim border border-accent/60">
      <p className="text-sm font-black text-success">
        Paid from {box} by {cashier} — in petty cash
      </p>
      <p className="text-xs text-white/60">
        {v.disbursedAt ? `Signed photo uploaded ${fmtDateTime(v.disbursedAt)}` : 'Signed photo uploaded'}
        {v.disbursedByName ? ` by ${v.disbursedByName}` : ''}. It is one spend of PKR {formatPkr(v.amountCents)} on the box — see Finance → Petty cash.
      </p>
      {want && !url && !err && <p className="text-xs text-white/45">Loading the photo…</p>}
      {err && <p className="text-xs text-s-red">{err}</p>}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={`Signed voucher ${v.number}`} className="max-h-[28rem] rounded-lg border border-white/10" />
        </a>
      )}
      <Link href="/finance/petty-cash" className="inline-block text-xs font-bold text-primary-ink hover:underline">Open Petty cash →</Link>
    </div>
  )
}
