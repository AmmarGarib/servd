'use client'
// What a loan or a full & final settlement put on the books, and — for an
// approved settlement — "Mark paid". The server books it (backend hr/ledger.ts):
// approval accrues the settlement to Wages Payable, paying clears it against
// the bank picked, the company's only bank, or the safe, on the day it was
// paid. Loans are paid out on approval from the place on the loan.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { btn, btnGhost, day, inp, localDate, rs, type HrFormat, type HrRecord } from '../../lib/hr'
import { BankAccountSelect, useBankAccounts } from '../finance/BankAccountSelect'
import { useHrAccess } from './HrShell'

interface Posting { id: string; reference: string; entryDate: string; description: string | null }
interface PaidFrom { method?: 'bank' | 'cash'; code?: string; bankAccountId?: string | null }

/** "Bank — HBL Operations (1021)" / "Cash on hand (1010)". */
export function usePaidFromLabel() {
  const { data: banks } = useBankAccounts()
  return (p: PaidFrom | null | undefined) => {
    if (!p?.method) return null
    if (p.method === 'cash') return `Cash${p.code ? ` (${p.code})` : ''}`
    const bank = p.bankAccountId ? banks?.find((b) => b.id === p.bankAccountId) : null
    return `Bank${bank ? ` — ${bank.name}` : ''}${p.code ? ` (${p.code})` : ''}`
  }
}

/** A bank account's name, for a record that holds its id. */
export function BankAccountName({ id }: { id: string }) {
  const label = usePaidFromLabel()
  return <>{label({ method: 'bank', bankAccountId: id })}</>
}

const KIND: Record<string, string> = {
  'hr.loan.disbursement': 'Paid out',
  'hr.loan.disbursement.reversal': 'Reversed (loan cancelled)',
  'hr.final_settlement.accrual': 'Booked to Wages Payable',
  'hr.final_settlement.accrual.reversal': 'Reversed (settlement cancelled)',
  'hr.final_settlement.payment': 'Payment',
}

export function RecordMoney({ record, onChanged }: { record: HrRecord; onChanged: () => void }) {
  const money = record.section === 'loan' || record.section === 'final_settlement'
  if (!money || (record.status !== 'approved' && record.status !== 'cancelled')) return null
  return <MoneyPanel record={record} onChanged={onChanged} />
}

function MoneyPanel({ record, onChanged }: { record: HrRecord; onChanged: () => void }) {
  const { data } = useQuery({
    queryKey: ['hr-record', record.section, record.id],
    queryFn: () => api.get<{ record: HrRecord; format: HrFormat; postings?: Posting[] }>(`/hr/records/${record.section}/${record.id}`),
  })
  const label = usePaidFromLabel()
  const d = record.data
  const postings = data?.postings ?? []
  const paidFrom = d['_paidFrom'] as PaidFrom | undefined
  const settlement = record.section === 'final_settlement'
  const approved = record.status === 'approved'
  const paidOn = typeof d['_paidOn'] === 'string' ? d['_paidOn'] : null
  // A cancelled record that never reached the books has nothing to show.
  if (!approved && postings.length === 0) return null

  return (
    <div className="rounded-xl p-3 space-y-2 border border-white/10 bg-white/[0.03]">
      <p className="text-[11px] font-black uppercase tracking-wider text-white/40">On the books</p>
      {record.section === 'loan' && paidFrom && (
        <p className="text-sm text-white/75">Paid out from <strong className="text-white/90">{label(paidFrom)}</strong> when it was approved.</p>
      )}
      {settlement && paidOn && (
        <p className="text-sm text-success font-bold">
          Paid {rs(typeof d['_paidCents'] === 'number' ? d['_paidCents'] : record.amountCents)} on {day(paidOn)} from {label(paidFrom) ?? '—'}
        </p>
      )}
      {settlement && approved && !paidOn && (
        <p className="text-sm text-white/70">Not paid yet — net {rs(record.amountCents)}.</p>
      )}
      {postings.length > 0 ? (
        <ul className="space-y-1">
          {postings.map((p) => {
            const kind = p.reference.slice(0, p.reference.lastIndexOf(':'))
            return (
              <li key={p.id} className="text-xs text-white/65">
                {KIND[kind] ?? kind} · {day(p.entryDate)} · <span className="font-mono text-white/45 break-all">{p.reference}</span>
              </li>
            )
          })}
        </ul>
      ) : data && approved ? (
        <p className="text-xs text-amber-700">
          {settlement
            ? 'Not on the books yet (approved before approval booked it). "Mark paid" books it first, or use "Post approved settlements" on the list.'
            : 'Nothing was posted for this record.'}
        </p>
      ) : null}
      {settlement && approved && !paidOn && <MarkSettlementPaid record={record} onChanged={onChanged} />}
    </div>
  )
}

function MarkSettlementPaid({ record, onChanged }: { record: HrRecord; onChanged: () => void }) {
  const qc = useQueryClient()
  const { isPayrollApprover } = useHrAccess()
  const [open, setOpen] = useState(false)
  const [method, setMethod] = useState<'bank' | 'cash'>('bank')
  const [bankAccountId, setBankAccountId] = useState('')
  const [paidOn, setPaidOn] = useState(localDate())
  const [err, setErr] = useState('')
  const pay = useMutation({
    mutationFn: () => api.post(`/hr/final-settlement/${record.id}/paid`, {
      ...(method === 'cash' ? { cash: true } : bankAccountId ? { bankAccountId } : {}),
      paidOn,
    }),
    onSuccess: () => { setErr(''); setOpen(false); void qc.invalidateQueries(); onChanged() },
    onError: (e: Error) => setErr(e.message),
  })
  if (!isPayrollApprover) return <p className="text-[11px] text-white/40">The CEO, a co-owner or management marks it paid.</p>
  if (!open) return <button className={btn} onClick={() => setOpen(true)}>Mark paid</button>
  return (
    <div className="space-y-3 pt-1">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Paid from">
        {(['bank', 'cash'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} onClick={() => setMethod(m)}
            className={`rounded-full px-3 py-1 text-xs font-bold border ${method === m ? 'bg-primary text-primary-on border-primary' : 'border-white/10 text-white/55'}`}>
            {m === 'bank' ? 'By bank' : 'In cash (the safe)'}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {method === 'bank' && (
          <BankAccountSelect id={`fnf-bank-${record.id}`} tenantId={record.tenantId} value={bankAccountId} onChange={setBankAccountId} className={inp} />
        )}
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-white/45 mb-1">Paid on</span>
          <input type="date" className={inp} value={paidOn} max={localDate()} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
      </div>
      <p className="text-xs text-white/55">Clears {rs(record.amountCents)} from Wages Payable, dated the day it was paid.</p>
      {err && <p className="text-xs text-red-700">{err}</p>}
      <div className="flex gap-2">
        <button className={btn} disabled={pay.isPending || !paidOn} onClick={() => pay.mutate()}>{pay.isPending ? 'Saving…' : 'Confirm payment'}</button>
        <button className={btnGhost} onClick={() => { setOpen(false); setErr('') }}>Cancel</button>
      </div>
    </div>
  )
}
