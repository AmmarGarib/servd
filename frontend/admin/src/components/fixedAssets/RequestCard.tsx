'use client'
// One fixed-asset request (dispose, write down, capitalise, smallwares
// write-off …) with what it asks for, who asked, how it ended and, while it
// waits, the buttons the API says the caller may press: canDecide (the CEO
// approves or rejects with a note) and canCancel (whoever asked, or the CEO).

import { useState } from 'react'
import Link from 'next/link'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { FA_BASE, RequestStatusBadge, ErrorLine, inp, btnPrimary, btnGhost, card, fmtDay, money, type FaRequest } from './shared'
import { receiptMethodLabel } from '../finance/PaymentReceivedFields'
import { RecordFiles } from '../files/RecordFiles'

function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function str(v: unknown): string | null { return typeof v === 'string' && v ? v : null }

const DISPOSAL_WORDS: Record<string, string> = { sale: 'Sale', scrap: 'Scrapped', lost: 'Lost', stolen: 'Stolen' }
const CAUSE_WORDS: Record<string, string> = { breakage: 'breakage', loss: 'lost', theft: 'stolen', worn_out: 'worn out' }

/** The figures of a request in plain words. */
export function describeRequest(r: FaRequest): string[] {
  const p = r.payload ?? {}
  const out: string[] = []
  switch (r.kind) {
    case 'disposal': {
      const k = str(p['kind']) ?? 'sale'
      out.push(DISPOSAL_WORDS[k] ?? k)
      const proceeds = num(p['proceedsCents'])
      if (proceeds) {
        out.push(`for ${money(proceeds)}`)
        // How the buyer paid and the payment reference # (older requests may have none).
        const method = str(p['method'])
        const ref = str(p['reference'])
        out.push(`${receiptMethodLabel(method ?? 'bank')}${ref ? `, ref ${ref}` : ', no reference'}`)
      }
      const gl = num(p['gainLossCents'])
      if (r.status === 'posted' && gl !== null) out.push(gl >= 0 ? `gain ${money(gl)}` : `loss ${money(-gl)}`)
      break
    }
    case 'impairment': {
      const a = num(p['amountCents'])
      if (a) out.push(`Write down by ${money(a)}`)
      break
    }
    case 'change_estimate': {
      const life = num(p['remainingLifeMonths'])
      const salvage = num(p['salvageCents'])
      if (life) out.push(`Remaining life ${life} months`)
      if (salvage !== null) out.push(`Salvage value ${money(salvage)}`)
      break
    }
    case 'pool_write_off': {
      const u = num(p['units'])
      if (u) out.push(`${u} units, ${CAUSE_WORDS[str(p['cause']) ?? 'breakage'] ?? str(p['cause'])}`)
      if (r.amountCents) out.push(`${money(r.amountCents)} written off`)
      break
    }
    case 'pool_transfer': {
      const u = num(p['units'])
      if (u) out.push(`${u} units moved`)
      break
    }
    case 'count': {
      const c = num(p['countedUnits'])
      if (c !== null) out.push(`${c} counted`)
      const on = num(p['onHandUnits'])
      if (on !== null) out.push(`${on} on the books`)
      const short = num(p['shortfallUnits'])
      if (short) out.push(`${short} short`)
      break
    }
    case 'capitalise': {
      const k = str(p['classKey'])
      if (k) out.push(`Class: ${k.replace(/_/g, ' ')}`)
      const cost = num(p['costCents'])
      if (cost) out.push(`cost ${money(cost)}`)
      const life = num(p['usefulLifeMonths'])
      if (life) out.push(`life ${life} months`)
      const name = str(p['name'])
      if (name) out.push(name)
      if (p['conceptId'] === null) out.push('shared across brands')
      break
    }
    case 'add_existing': {
      if (r.existing?.sourceLabel) out.push(r.existing.sourceLabel)
      const v = num(p['valueCents'])
      if (v) out.push(`today's value ${money(v)}`)
      const life = num(p['remainingLifeMonths'])
      if (life) out.push(`remaining life ${life} months`)
      const k = str(p['classKey'])
      if (k) out.push(`Class: ${k.replace(/_/g, ' ')}`)
      break
    }
    default:
  }
  return out
}

export function RequestCard({ r, showSubject = true, onChanged, onNotice }: {
  r: FaRequest
  showSubject?: boolean
  onChanged: () => void
  onNotice?: (tone: 'ok' | 'wait' | 'bad', text: string) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const pinned = { tenantId: r.tenantId }

  const approve = useMutation({
    mutationFn: () => api.post(`${FA_BASE}/requests/${r.id}/approve`, {}, pinned),
    onSuccess: () => { onNotice?.('ok', `${r.kindLabel} approved and posted.`); onChanged() },
    onError: () => onChanged(),
  })
  const reject = useMutation({
    mutationFn: () => api.post(`${FA_BASE}/requests/${r.id}/reject`, { note: note.trim() }, pinned),
    onSuccess: () => { setRejecting(false); onNotice?.('ok', `${r.kindLabel} rejected.`); onChanged() },
  })
  const cancel = useMutation({
    mutationFn: () => api.post(`${FA_BASE}/requests/${r.id}/cancel`, {}, pinned),
    onSuccess: () => { onNotice?.('ok', `${r.kindLabel} cancelled.`); onChanged() },
  })

  const subject = r.asset
    ? <Link href={`${FA_BASE}/${r.asset.id}`} className="text-primary-ink font-bold hover:underline">{r.asset.assetTag ? `${r.asset.assetTag} ` : ''}{r.asset.name}</Link>
    : r.pool
      ? <Link href={`${FA_BASE}/pools`} className="text-primary-ink font-bold hover:underline">{r.pool.label}</Link>
      : r.capexLine
        ? <Link href={`/finance/capex?project=${r.capexLine.projectId}`} className="text-primary-ink font-bold hover:underline">{r.capexLine.projectName}: {r.capexLine.item}</Link>
        : r.existing?.name
          ? <span className="text-white/85 font-bold">{r.existing.name}</span>
          : null

  const facts = describeRequest(r)
  const busy = approve.isPending || reject.isPending || cancel.isPending

  return (
    <div className="rounded-2xl p-4" style={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-black text-white/90">{r.kindLabel}</p>
          {showSubject && subject && <p className="text-sm mt-0.5 break-words">{subject}</p>}
        </div>
        <RequestStatusBadge status={r.status} />
      </div>

      {facts.length > 0 && <p className="text-sm text-white/75 mt-2">{facts.join(' · ')}</p>}
      <p className="text-sm text-white/60 mt-1 break-words">&ldquo;{r.reason}&rdquo;</p>
      <p className="text-[11px] text-white/40 mt-2">
        {r.requestedByName ?? 'Someone'} asked on {fmtDay(r.requestedAt)} · effective {fmtDay(r.effectiveDate)}
        {r.companyName ? ` · ${r.companyName}` : ''}
        {r.decidedByName && r.status !== 'pending' ? ` · ${r.status === 'rejected' ? 'rejected' : r.status === 'cancelled' ? 'cancelled' : 'approved'} by ${r.decidedByName} on ${fmtDay(r.decidedAt)}` : ''}
      </p>
      {r.decisionNote && <p className="text-xs text-white/60 mt-1">Note: {r.decisionNote}</p>}
      {r.status === 'pending' && r.errorMessage && (
        <p className="text-xs text-s-red mt-2">The last attempt to post it was refused: {r.errorMessage}</p>
      )}

      {rejecting && (
        <div className="mt-3">
          <textarea className={inp} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why is it rejected? The requester sees this." aria-label="Rejection note" />
          <div className="flex gap-2 mt-2">
            <button onClick={() => reject.mutate()} disabled={busy || !note.trim()} className={btnPrimary}>{reject.isPending ? 'Rejecting…' : 'Reject request'}</button>
            <button onClick={() => setRejecting(false)} className={btnGhost}>Back</button>
          </div>
        </div>
      )}

      {r.status === 'pending' && !rejecting && (r.canDecide || r.canCancel) && (
        <div className="flex flex-wrap gap-2 mt-3">
          {r.canDecide && (
            <button onClick={() => { if (window.confirm(`Approve this ${r.kindLabel.toLowerCase()}? It posts to the books now.`)) approve.mutate() }}
              disabled={busy} className={btnPrimary}>{approve.isPending ? 'Posting…' : 'Approve'}</button>
          )}
          {r.canDecide && <button onClick={() => setRejecting(true)} disabled={busy} className={btnGhost}>Reject</button>}
          {r.canCancel && <button onClick={() => cancel.mutate()} disabled={busy} className={btnGhost}>{cancel.isPending ? 'Cancelling…' : 'Cancel request'}</button>}
        </div>
      )}
      {/* An existing asset's documents sit on the request until the CEO approves (then on the asset). */}
      {r.kind === 'add_existing' && r.status !== 'posted' && (
        <div className="mt-3">
          <RecordFiles ownerType="fixed_asset" ownerId={r.id} tenantId={r.tenantId} canUpload={r.status === 'pending' && r.canCancel}
            title="Purchase or transfer documents" compact lazy />
        </div>
      )}
      <ErrorLine error={approve.error ?? reject.error ?? cancel.error} />
    </div>
  )
}
