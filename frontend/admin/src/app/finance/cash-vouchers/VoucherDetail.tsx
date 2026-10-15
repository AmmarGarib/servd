'use client'
// One cash request: where it is (Raised → HOD → Director → Paid → Receipts →
// Settled), the actions this login may take (the server's capability flags),
// paying it (the custodian picks the box and confirms the cash was handed
// over — the ONE step that moves cash: it is booked to the request's category
// at once, H3), the receipts and change afterwards (SettlePanel), and the
// printed voucher.

import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api'
import { formatBrandName } from '../../../lib/brandName'
import { useMyTenants } from '../../../components/ui/TenantPicker'
import { amountInWords, formatPkr } from './amountInWords'
import {
  CV_BASE, CV_ROOT, cashierOf, categoryWords, errorWords, fmtDate, fmtDateTime, useCategories, useMyBoxes, usePettyBoxes,
  useStaffNames, useVoucher, type CashVoucher,
} from './data'
import { PrintPortal, VoucherSheet } from './VoucherPrint'
import { VoucherForm } from './VoucherForm'
import { SettlePanel, Thumbs } from './SettlePanel'
import { ErrorBanner, StatusBadge, dangerOutlineBtn, fieldCls, primaryBtn, secondaryBtn } from './ui'
import { Select } from '@/components/ui/Select'

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }

type Act = 'sign-hod' | 'approve' | 'reject' | 'cancel'
const ACT_DONE: Record<Act, string> = {
  'sign-hod': 'Signed as HOD — now waiting for the director.',
  approve: 'Approved — the cashier can pay it.',
  reject: 'Request rejected.',
  cancel: 'Request cancelled.',
}

export function VoucherDetail({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data: v, isLoading, error } = useVoucher(id)
  const { data: tenants = [] } = useMyTenants()
  const { data: cats } = useCategories()
  const categories = cats?.categories ?? []
  // A cash keeper reads every box; anyone else gets 403 there (silently).
  const { isSuccess: isKeeper } = usePettyBoxes()
  const [editing, setEditing] = useState(false)
  const [noteFor, setNoteFor] = useState<'reject' | 'cancel' | null>(null)
  const [note, setNote] = useState('')

  function refresh() {
    void qc.invalidateQueries({ queryKey: [CV_ROOT] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })     // the inbox and its badge
    void qc.invalidateQueries({ queryKey: ['petty-cash-boxes'] })
  }

  const act = useMutation({
    mutationFn: ({ kind, body }: { kind: Act; body: Record<string, unknown> }) =>
      // Pinned to the request's company, so the "All companies" view never asks.
      api.post<CashVoucher>(`${CV_BASE}/${id}/${kind}`, body, v?.tenantId ? { tenantId: v.tenantId } : undefined),
    meta: { inlineErrors: true },
    onSuccess: (_r, { kind }) => { toast.success(ACT_DONE[kind]); setNoteFor(null); setNote(''); refresh() },
  })

  if (isLoading) return <p className="px-7 py-10 text-sm text-white/40">Loading…</p>
  if (error || !v) {
    return (
      <div className="px-7 py-10">
        <ErrorBanner message={error ? errorWords(error) : 'This request was not found.'} />
        <Link href="/finance/cash-vouchers" className="inline-block mt-4 text-sm font-bold text-primary-ink hover:underline">← All cash requests</Link>
      </div>
    )
  }

  const companyName = v.companyName ?? tenants.find((t) => t.id === v.tenantId)?.name ?? ''
  const categoryLabel = categoryWords(v.category, categories)
  const holder = v.holderName ?? v.payeeName
  const run = (kind: Act, body: Record<string, unknown> = {}) => { act.reset(); act.mutate({ kind, body }) }
  const paid = v.status === 'disbursed' || v.status === 'settled' || v.status === 'converted'

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <PrintPortal v={v} companyName={companyName} categoryLabel={categoryLabel} />

      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/finance/cash-vouchers" className="text-xs text-white/40 hover:text-white/70">← Cash requests</Link>
        <div className="flex items-start justify-between gap-4 mt-2 flex-wrap">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-success">Cash request</p>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-black text-white/90 mono">{v.number}</h1>
              <StatusBadge stage={v.stage} />
              {v.overdue && <span className="s-badge-red">Receipts overdue</span>}
            </div>
            <p className="text-sm text-white/55 mt-1">
              For <span className="font-bold text-white/80">{holder}</span> · {v.purpose}
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
            {v.canSignHod && <button onClick={() => run('sign-hod')} disabled={act.isPending} className={primaryBtn}>Sign as HOD</button>}
            {v.canApprove && (
              <button disabled={act.isPending} className={primaryBtn}
                onClick={() => { if (window.confirm(`Approve ${v.number}: PKR ${formatPkr(v.amountCents)} for ${holder}? The cashier may then pay it.`)) run('approve') }}>
                Approve
              </button>
            )}
            {v.canReject && (
              <button onClick={() => { act.reset(); setNoteFor(noteFor === 'reject' ? null : 'reject') }} disabled={act.isPending} className={dangerOutlineBtn}>Reject</button>
            )}
            {(v.canEdit || v.canEditCategory) && (
              <button onClick={() => setEditing(true)} className={secondaryBtn}>{v.canEdit ? 'Edit' : 'Change category'}</button>
            )}
            <button onClick={() => window.print()} className={secondaryBtn}>Print voucher</button>
            {v.canCancel && (
              <button onClick={() => { act.reset(); setNoteFor(noteFor === 'cancel' ? null : 'cancel') }} disabled={act.isPending}
                className={`${dangerOutlineBtn} sm:ml-auto`}>
                Cancel request
              </button>
            )}
          </div>

          {v.status === 'draft' && <p className="text-xs text-white/50">Waiting for the HOD of {holder} (their reporting manager) — or finance — to sign.</p>}
          {v.status === 'hod_signed' && !v.canApprove && (
            <p className="text-xs text-white/50">
              {v.hodSignedById && v.canReject ? 'You signed this as HOD — a different person must approve it as director.' : 'Signed by the HOD — waiting for the director (CEO). Do not pay until it is approved.'}
            </p>
          )}
          {v.status === 'approved' && !v.canPay && <p className="text-xs text-white/50">Approved — the cashier who holds the cash box pays it.</p>}
          {(v.status === 'draft' || v.status === 'hod_signed') && (
            <p className="text-xs text-white/40">Printed now, the voucher says &ldquo;NOT APPROVED — DO NOT PAY&rdquo;.</p>
          )}

          {noteFor && (
            <div className="rounded-xl p-3" style={{ background: 'var(--elevated)' }}>
              <label className="text-[11px] font-bold text-white/60">
                {noteFor === 'reject' ? 'Why is it rejected? (the requester sees this)' : 'Why is it cancelled?'}
              </label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} autoFocus
                className="mt-1 w-full rounded-lg px-2 py-1.5 text-sm"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }} />
              <div className="mt-2 flex gap-2">
                <button disabled={act.isPending || note.trim().length < 3} onClick={() => run(noteFor, { note: note.trim() })}
                  className="rounded-lg px-3 py-1.5 text-xs font-black disabled:opacity-50 bg-s-red text-bone">
                  {act.isPending ? 'Saving…' : noteFor === 'reject' ? 'Reject request' : 'Cancel request'}
                </button>
                <button onClick={() => { setNoteFor(null); setNote('') }} className="text-xs font-bold text-white/50 px-2">Keep it</button>
              </div>
            </div>
          )}

          {act.error && <ErrorBanner message={errorWords(act.error)} />}
        </div>

        {v.canNameHolder && <NameHolder v={v} onDone={refresh} />}
        {v.canPay && <PayPanel v={v} isKeeper={isKeeper} onDone={refresh} />}
        {paid && <SettlePanel v={v} isKeeper={isKeeper} />}

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
            <Fact label="Who takes the cash" value={holder} />
            <Fact label="Amount" value={`PKR ${formatPkr(v.amountCents, { decimals: true })}`} />
            <Fact label="In words" value={amountInWords(v.amountCents)} wide />
            <Fact label="Purpose" value={v.purpose} wide />
            <Fact label="Expense category" value={categoryLabel} />
            <Fact label="Brand / Department" value={[v.conceptName ? formatBrandName(v.conceptName) : null, v.department].filter(Boolean).join(' · ') || '—'} />
            <Fact label="Needed on" value={fmtDate(v.voucherDate)} />
            <Fact label="Paid from" value={v.boxName ?? '—'} />
            <Fact label="Cashier" value={cashierOf(v) ?? '—'} />
            {v.dueBy && <Fact label="Receipts due by" value={fmtDate(v.dueBy)} />}
            <Fact label="Raised by" value={`${v.preparedByName ?? '—'} · ${fmtDateTime(v.createdAt)}`} />
            {companyName && <Fact label="Company" value={companyName} />}
          </dl>
        </div>

        {v.signedPhotos.length > 0 && (
          <div className="rounded-2xl p-4 space-y-2" style={card}>
            <p className="text-sm font-black text-white/80">The signed paper (old voucher flow)</p>
            <Thumbs requestId={v.id} files={v.signedPhotos} />
          </div>
        )}

        {/* The paper */}
        <div className="rounded-2xl p-4" style={card}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm font-black text-white/80">The voucher as it prints</p>
            <p className="text-[11px] text-white/40">A5 landscape</p>
          </div>
          <div className="overflow-x-auto pb-1">
            <VoucherSheet v={v} companyName={companyName} categoryLabel={categoryLabel} />
          </div>
        </div>
      </div>

      {editing && (
        <VoucherForm voucher={v} isKeeper={isKeeper} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); toast.success('Saved.'); refresh() }} />
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

/** Raised → HOD → Director → Paid → Receipts (covered of amount) → Settled; done steps are green. */
function Steps({ v }: { v: CashVoucher }) {
  const paid = !!v.disbursedAt
  const covered = v.settledCents + v.returnedCents + v.convertedCents
  type S = { title: string; who: string | null; when: string | null; state: 'done' | 'bad' | 'todo' }
  const steps: S[] = [
    { title: 'Raised', who: v.preparedByName ?? null, when: v.createdAt, state: 'done' },
    { title: 'HOD', who: v.hodSignedByName ?? null, when: v.hodSignedAt, state: v.hodSignedAt ? 'done' : v.status === 'rejected' && !v.hodSignedAt ? 'bad' : 'todo' },
    v.status === 'rejected' && v.hodSignedAt
      ? { title: 'Director', who: v.rejectedByName ?? null, when: v.rejectedAt ?? null, state: 'bad' }
      : { title: 'Director', who: v.directorSignedByName ?? null, when: v.directorSignedAt, state: v.directorSignedAt ? 'done' : 'todo' },
    { title: 'Paid', who: cashierOf(v), when: v.disbursedAt ?? null, state: paid ? 'done' : 'todo' },
    {
      title: `Receipts ${formatPkr(covered)} of ${formatPkr(v.amountCents)}`,
      who: v.receiptCount ? `${v.receiptCount} receipt${v.receiptCount === 1 ? '' : 's'}` : null,
      when: null,
      state: v.overdue ? 'bad' : covered > 0 || v.receiptCount > 0 ? 'done' : 'todo',
    },
    { title: v.status === 'converted' ? 'Converted' : 'Settled', who: null, when: v.settledAt ?? null, state: v.status === 'settled' || v.status === 'converted' ? 'done' : 'todo' },
  ]
  return (
    <ol className="grid grid-cols-2 sm:grid-cols-6 gap-2">
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

/** Approved: the custodian picks the box and confirms the cash was handed over. */
function PayPanel({ v, isKeeper, onDone }: { v: CashVoucher; isKeeper: boolean; onDone: () => void }) {
  const { data: all = [] } = usePettyBoxes()
  const { data: mine = [] } = useMyBoxes()
  const boxes = (isKeeper ? all : mine).filter((b) => b.isActive && b.tenantId === v.tenantId)
  const fixed = !!v.boxId && !isKeeper
  const [boxId, setBoxId] = useState(v.boxId ?? (boxes.length === 1 ? boxes[0]!.id : ''))
  const chosen = boxId || (boxes.length === 1 ? boxes[0]!.id : '')
  const box = boxes.find((b) => b.id === chosen) ?? null
  const holder = v.holderName ?? v.payeeName
  const pay = useMutation({
    mutationFn: () => api.post(`${CV_BASE}/${v.id}/pay`, chosen ? { boxId: chosen } : {}, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => { toast.success(`${v.number} is paid — booked to its category.`); onDone() },
  })
  const short = !!box && box.floatCents < v.amountCents
  return (
    <div className="rounded-2xl p-5 space-y-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>
      <p className="text-sm font-black text-white/90">Pay {holder}</p>
      <p className="text-xs text-white/55">
        Hand PKR {formatPkr(v.amountCents)} to {holder} and confirm here. That takes it out of the box and books it to the request&rsquo;s
        category; {holder} then uploads the receipts.
      </p>
      {fixed ? (
        <p className="text-xs text-white/70">From <span className="font-bold">{v.boxName}</span></p>
      ) : (
        <Select value={chosen} onChange={(e) => setBoxId(e.target.value)} className={fieldCls} aria-label="Pay from which box">
          {boxes.length !== 1 && <option value="">— pay from which box —</option>}
          {boxes.map((b) => <option key={b.id} value={b.id}>{b.name} · PKR {formatPkr(b.floatCents)}</option>)}
        </Select>
      )}
      {!fixed && boxes.length === 0 && <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>You hold no open cash box of this company.</p>}
      {short && <p className="text-xs text-s-red font-bold">{box!.name} holds PKR {formatPkr(box!.floatCents)} — less than this request. Top it up first.</p>}
      {pay.error && <ErrorBanner message={errorWords(pay.error)} />}
      <button disabled={pay.isPending || (!fixed && !chosen)} className={primaryBtn}
        onClick={() => { if (window.confirm(`Cash handed to ${holder}: PKR ${formatPkr(v.amountCents)}?`)) { pay.reset(); pay.mutate() } }}>
        {pay.isPending ? 'Paying…' : `Cash handed to ${holder}`}
      </button>
    </div>
  )
}

/** A legacy paid voucher with nobody named: finance names who holds the cash. */
function NameHolder({ v, onDone }: { v: CashVoucher; onDone: () => void }) {
  const { data: staff = [] } = useStaffNames()
  const [who, setWho] = useState('')
  const save = useMutation({
    mutationFn: () => api.patch(`${CV_BASE}/${v.id}`, { holderUserId: who }, { tenantId: v.tenantId }),
    meta: { inlineErrors: true },
    onSuccess: () => { toast.success('Holder named.'); onDone() },
  })
  return (
    <div className="rounded-2xl p-5 space-y-3 bg-s-red-dim border border-s-red/30">
      <p className="text-sm font-black text-s-red">Needs review — nobody is named as holding this cash</p>
      <p className="text-xs text-white/65">Paid under the old voucher flow. Name the person who took the cash; they then bring the receipts.</p>
      <Select value={who} onChange={(e) => setWho(e.target.value)} className={fieldCls} aria-label="Who took the cash">
        <option value="">— who took the cash —</option>
        {staff.filter((u) => !u.tenantId || u.tenantId === v.tenantId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </Select>
      {save.error && <ErrorBanner message={errorWords(save.error)} />}
      <button disabled={!who || save.isPending} onClick={() => save.mutate()} className={primaryBtn}>Name the holder</button>
    </div>
  )
}
