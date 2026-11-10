'use client'
// The per-line tools of a bank statement line, shared by Reconciliation → Bank
// Imports and Finance → Bank reconciliation: book an adjustment (posts the
// voucher at once), match by hand to a journal line already booked, ignore
// with a reason. The API rules live in backend reconciliation/routes.ts.
import { CheckLabel, Input, LinkButton } from '@/components/finance/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, ApiError } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { Select } from '@/components/ui/Select'
import { DialogForm, RupeeField } from '../PaymentReceivedFields'
import { cardPayoutErrorText } from '../../../app/reconciliation/CardPayouts'

export interface BankLine {
  id: string
  amountCents: number
  description: string
}

interface ChartAccount { code: string; name: string; isActive: boolean; type: string }

interface SplitRow { code: string; type: 'debit' | 'credit'; amount: string }

const toCents = (pkr: string) => Math.round((parseFloat(pkr) || 0) * 100)

export function AdjustForm({ line, raastAccount, hint, onDone, onCancel }: { line: BankLine; hint?: string; raastAccount: boolean; onDone: () => void; onCancel: () => void }) {
  const inflow = line.amountCents > 0
  const abs = Math.abs(line.amountCents)
  const bankSide: 'debit' | 'credit' = inflow ? 'debit' : 'credit'
  const otherSide: 'debit' | 'credit' = inflow ? 'credit' : 'debit'
  const [split, setSplit] = useState(false)
  const { data: accounts = [] } = useQuery<ChartAccount[]>({
    queryKey: ['chart-of-accounts'], queryFn: () => api.get('/setup/chart-of-accounts'), staleTime: 60_000, retry: false,
  })
  const listId = `acct-list-${line.id}`
  const [contra, setContra] = useState('')
  const [memo, setMemo] = useState('')
  const [rows, setRows] = useState<SplitRow[]>([
    { code: '', type: otherSide, amount: (abs / 100).toFixed(2) },
    { code: '6080', type: bankSide, amount: '' },
  ])

  const debits  = (bankSide === 'debit'  ? abs : 0) + rows.filter((r) => r.type === 'debit').reduce((t, r) => t + toCents(r.amount), 0)
  const credits = (bankSide === 'credit' ? abs : 0) + rows.filter((r) => r.type === 'credit').reduce((t, r) => t + toCents(r.amount), 0)
  const off = debits - credits
  const splitReady = rows.every((r) => r.code.trim() && toCents(r.amount) > 0) && off === 0

  const adjust = useMutation({
    mutationFn: () => api.post(`/reconciliation/bank/lines/${line.id}/adjust`, split
      ? { memo: memo.trim(), lines: rows.map((r) => ({ accountCode: r.code.trim(), type: r.type, amountCents: toCents(r.amount) })) }
      : { memo: memo.trim(), contraAccountCode: contra.trim() }),
    onSuccess: onDone,
  })
  const setRow = (i: number, patch: Partial<SplitRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const inp = 's-input'

  return (
    <DialogForm busy={adjust.isPending} onSubmit={() => adjust.mutate()}
      missing={!memo.trim() ? 'Add a memo — what this is.' : split ? (splitReady ? null : 'Every line needs a code and an amount, and the lines must balance.') : (!contra.trim() ? 'Enter the account code to book it to.' : null)}>
    <div className="px-4 py-3 space-y-2 text-xs">
      <datalist id={listId}>
        {accounts.filter((a) => a.isActive !== false).map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
      </datalist>
      <p className="text-s-muted">Booking posts the voucher to the ledger at once.{hint ? ` ${hint}` : ''}</p>
      {inflow && raastAccount && (
        <p role="alert" className="rounded-lg border border-s-amber/40 bg-s-amber-dim px-3 py-2 text-s-text">
          This account receives Raast QR payments. If this credit is a customer&rsquo;s Raast payment for a bill, match it on the Raast tab instead —
          the sale already booked it to this bank account, so an adjustment would book it twice.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <CheckLabel className="inline-flex items-center gap-1"><input type="radio" name={`adjust-mode-${line.id}`} checked={!split} onChange={() => setSplit(false)} /> One account</CheckLabel>
        <CheckLabel className="inline-flex items-center gap-1"><input type="radio" name={`adjust-mode-${line.id}`} checked={split} onChange={() => setSplit(true)} /> Split (e.g. card settlement less fee)</CheckLabel>
      </div>
      {!split ? (
        <div className="flex flex-wrap gap-2">
          <Input value={contra} onChange={(e) => setContra(e.target.value)} aria-label="Account code" list={listId} placeholder="Account code, e.g. 6080" className={`${inp} w-full sm:w-56`} />
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-s-muted">
            This line: <span className="font-mono">{bankSide === 'debit' ? 'Dr' : 'Cr'} {fmtPkr(abs)}</span> to the statement&rsquo;s account. Other side:
          </p>
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input value={r.code} onChange={(e) => setRow(i, { code: e.target.value })} aria-label={`Line ${i + 1} account code`} list={listId} placeholder="code" className={`${inp} w-20 font-mono`} />
              <Select value={r.type} onChange={(e) => setRow(i, { type: e.target.value as 'debit' | 'credit' })} className={`${inp} w-auto px-1.5 py-0.5`}>
                <option value="debit">Dr</option>
                <option value="credit">Cr</option>
              </Select>
              <span className="w-28"><RupeeField label={`Line ${i + 1} amount (PKR)`} value={r.amount} onChange={(v) => setRow(i, { amount: v })} className={`${inp} w-full text-right`} /></span>
              {rows.length > 1 && <LinkButton tone="muted" size="md" type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</LinkButton>}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <LinkButton size="md" type="button" onClick={() => setRows((rs) => [...rs, { code: '', type: otherSide, amount: '' }])}>+ Add line</LinkButton>
            <span className={off === 0 ? 'text-success' : 'text-s-red'}>
              {off === 0 ? 'Balanced' : `Off by ${fmtPkr(Math.abs(off))} (${off > 0 ? 'more debits' : 'more credits'})`}
            </span>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={memo} onChange={(e) => setMemo(e.target.value)} aria-label="Memo" placeholder="memo (what this is)" className={`${inp} flex-1 min-w-[10rem]`} />
        <LinkButton size="md"
          type="submit"
          disabled={adjust.isPending}>
          {adjust.isPending ? 'Booking…' : 'Book'}
        </LinkButton>
        <LinkButton tone="muted" size="md" type="button" onClick={onCancel}>Cancel</LinkButton>
      </div>
      {adjust.error && (
        <p role="alert" className="text-s-red">
          {adjust.error instanceof ApiError && adjust.error.code === 'USE_CARD_PAYOUT_CONFIRM'
            ? cardPayoutErrorText(adjust.error)
            : (adjust.error as Error).message}
        </p>
      )}
    </div>
    </DialogForm>
  )
}

// Ignore needs a reason (≥ 10 characters, audited); it can be undone with "Bring back".
export function IgnoreForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  const ok = reason.trim().length >= 10
  return (
    <div className="px-4 py-3 flex flex-wrap items-center gap-2 text-xs">
      <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Why ignore this line"
        placeholder="Why is this line ignored? (at least 10 characters)" className="flex-1 min-w-[14rem]" />
      <LinkButton size="md" type="button" disabled={!ok || busy} onClick={() => onSubmit(reason.trim())}>{busy ? 'Saving…' : 'Ignore line'}</LinkButton>
      <LinkButton tone="muted" size="md" type="button" onClick={onCancel}>Cancel</LinkButton>
    </div>
  )
}

export interface MatchCandidate {
  journalLineId: string; entryId: string; entryDate: string; reference: string | null; description: string; memo: string | null; amountCents: number
}

// Pair the line with the journal line that already booked it (a payment that
// cleared late, outside the import's window). Never an adjustment — that
// would book the money twice. The API lists only live, free lines of the
// same amount on this statement's account.
export function ManualMatch({ line, onCancel, onDone }: { line: BankLine; onCancel: () => void; onDone: () => void }) {
  const [days, setDays] = useState(45)
  const { data: cands = [], isLoading, error } = useQuery<MatchCandidate[]>({
    queryKey: ['bank-line-candidates', line.id, days],
    queryFn: () => api.get(`/reconciliation/bank/lines/${line.id}/candidates?days=${days}`),
  })
  const match = useMutation({
    mutationFn: (journalLineId: string) => api.post(`/reconciliation/bank/lines/${line.id}/match`, { journalLineId }),
    onSuccess: onDone,
  })
  return (
    <div className="px-4 py-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-s-muted">Journal lines of {fmtPkr(line.amountCents)} within</span>
        <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="bg-s-card border border-s-border rounded px-1.5 py-0.5 text-s-text">
          {[15, 45, 90, 180, 400].map((d) => <option key={d} value={d}>{d} days</option>)}
        </Select>
        <LinkButton tone="muted" size="md" type="button" onClick={onCancel}>Cancel</LinkButton>
      </div>
      {isLoading && <p className="text-s-muted">Looking…</p>}
      {error && <p role="alert" className="text-s-red">{(error as Error).message}</p>}
      {!isLoading && !error && cands.length === 0 && <NearMisses lineId={line.id} days={days} />}
      {cands.length > 0 && (
        <ul className="space-y-1">
          {cands.map((c) => (
            <li key={c.journalLineId} className="flex flex-wrap items-center gap-3">
              <span className="text-s-muted whitespace-nowrap">{c.entryDate.slice(0, 10)}</span>
              <span className="text-s-text flex-1 min-w-[12rem]">{c.description}{c.reference && <span className="text-s-muted"> · {c.reference}</span>}</span>
              <span className="font-mono">{fmtPkr(c.amountCents)}</span>
              <LinkButton size="md" type="button" disabled={match.isPending} onClick={() => match.mutate(c.journalLineId)}>Match</LinkButton>
            </li>
          ))}
        </ul>
      )}
      {match.error && <p role="alert" className="text-s-red">{(match.error as Error).message}</p>}
    </div>
  )
}


interface NearMiss {
  reason: 'other_account' | 'other_company' | 'wrong_side' | 'split' | 'taken' | 'reversed' | 'outside_window'
  entryId: string; entryDate: string; reference: string | null; description: string
  accountCode: string; accountName: string; companyName: string | null; amountCents: number; side: 'debit' | 'credit'
  takenBy?: { statementLineId: string; postedDate: string; description: string } | null
}

const NEAR_MISS_TEXT: Record<NearMiss['reason'], (m: NearMiss) => string> = {
  other_account: (m) => `Booked to ${m.accountCode} ${m.accountName}, not this bank's account. Edit the entry and move that line to this bank (same amount — applies at once), then match.`,
  other_company: (m) => `Booked in ${m.companyName ?? 'another company'}, not in this bank's company. Cancel it there and book it in the right company.`,
  wrong_side: (m) => `On this account but as a ${m.side} — the other way round. Correct the entry, then match.`,
  split: () => 'Split over several lines on this account that add up to this amount. A bank line matches ONE book line — edit the entry into one line on this bank, then match.',
  taken: (m) => `Already matched to the bank line of ${m.takenBy ? m.takenBy.postedDate.slice(0, 10) + ' (' + m.takenBy.description + ')' : 'another date'}. If that match is wrong, Unmatch it here — the entry then shows above to match.`,
  reversed: () => 'This entry was reversed (or is a reversal), so it is not in the books any more.',
  outside_window: () => 'Dated outside the days chosen above — pick more days.',
}

// When nothing can be matched, say where the money WAS booked and why it cannot be picked (owner, 2026-11-10).
function NearMisses({ lineId, days }: { lineId: string; days: number }) {
  const { data = [], isLoading } = useQuery<NearMiss[]>({
    queryKey: ['bank-line-near-misses', lineId, days],
    queryFn: () => api.get(`/reconciliation/bank/lines/${lineId}/near-misses?days=${days}`),
  })
  if (isLoading) return <p className="text-s-muted">Looking…</p>
  if (data.length === 0) {
    return <p className="text-s-muted">No journal line of this amount on this account — nor anywhere else in the books within these days. Book an adjustment if the money was never booked.</p>
  }
  return (
    <div className="space-y-2">
      <p className="text-s-text font-medium">Nothing can be matched yet — this amount is in the books here:</p>
      <ul className="space-y-2">
        {data.map((m, i) => (
          <li key={`${m.entryId}-${m.reason}-${i}`} className="rounded border border-s-border bg-s-card px-2.5 py-2 space-y-0.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-s-muted whitespace-nowrap">{m.entryDate.slice(0, 10)}</span>
              <span className="text-s-text flex-1 min-w-[10rem] break-words">{m.description}{m.reference && <span className="text-s-muted"> · {m.reference}</span>}</span>
              <span className="font-mono whitespace-nowrap">{fmtPkr(m.amountCents)}</span>
            </div>
            <p className="text-s-muted">{m.accountCode} {m.accountName}{m.companyName ? ` · ${m.companyName}` : ''}</p>
            <p className="text-s-amber">{NEAR_MISS_TEXT[m.reason](m)}</p>
            {m.reason === 'taken' && m.takenBy && <UnmatchTaken lineId={lineId} taken={m.takenBy} />}
          </li>
        ))}
      </ul>
    </div>
  )
}

// Undo the OTHER bank line's match from inside the match box (owner, 2026-11-10: "add the Unmatch button in the
// match box"). Same route and rules as Reconciliation → Bank Imports (finance with accounting / the CEO; a line in a
// CEO-approved reconciliation, a card payout or a Raast line is refused with its reason). Then the entry is free and
// appears in the list above.
function UnmatchTaken({ lineId, taken }: { lineId: string; taken: NonNullable<NearMiss['takenBy']> }) {
  const qc = useQueryClient()
  const [sure, setSure] = useState(false)
  const unmatch = useMutation({
    mutationFn: () => api.post(`/reconciliation/bank/lines/${taken.statementLineId}/unmatch`, { reason: 'Unmatched from the match box of another bank line' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bank-line-candidates', lineId] })
      void qc.invalidateQueries({ queryKey: ['bank-line-near-misses', lineId] })
      void qc.invalidateQueries({ queryKey: ['bank-lines'] })
      void qc.invalidateQueries({ queryKey: ['brs'] })
    },
  })
  const err = unmatch.error
  return (
    <div className="flex flex-wrap items-center gap-3 pt-1">
      {!sure ? (
        <LinkButton size="md" type="button" onClick={() => setSure(true)}>Unmatch that line</LinkButton>
      ) : (
        <>
          <span className="text-s-text">Undo the match on the bank line of {taken.postedDate.slice(0, 10)}?</span>
          <LinkButton size="md" type="button" disabled={unmatch.isPending} onClick={() => unmatch.mutate()}>{unmatch.isPending ? 'Undoing…' : 'Yes, unmatch'}</LinkButton>
          <LinkButton tone="muted" size="md" type="button" onClick={() => setSure(false)}>Keep it</LinkButton>
        </>
      )}
      {err && (
        <p role="alert" className="w-full text-s-red">
          {err instanceof ApiError && err.code === 'RAAST_MATCHED_LINE' ? 'That line is matched to a Raast payment — unmatch it on Reconciliation → Raast.'
            : err instanceof ApiError && err.code === 'CARD_PAYOUT_LINE' ? cardPayoutErrorText(err)
            : (err as Error).message}
        </p>
      )}
    </div>
  )
}
