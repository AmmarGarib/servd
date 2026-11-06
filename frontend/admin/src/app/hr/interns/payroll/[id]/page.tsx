'use client'
// One intern stipend payroll (owner, 2026-11-06). Mirrors the employee payroll run: draft (HR) → with finance → waiting
// for the CEO → approved → paid. Each button shows only for the role that can use it; the server decides for real
// (separation of duties, the CEO's approval, nobody pays their own stipend).

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../../lib/api'
import { fmtPkr } from '../../../../../lib/money'
import { btn, btnGhost, card, inp, localDate } from '../../../../../lib/hr'
import {
  RUN_BADGE, RUN_STATUS_LABEL, RUN_STEPS, adjustmentsOf, apiErrors, errText, monthLabel, shortDate, type Adjustment, type StipendRunView, type StipendSlip,
} from '../../../../../lib/interns'
import { HrShell, Modal, Stat, useHrAccess } from '../../../../../components/hr/HrShell'
import { BankAccountSelect } from '../../../../../components/finance/BankAccountSelect'
import {
  EMPTY_PAYMENT_CLASSIFICATION, PaymentClassificationFields, paymentClassificationBody, paymentClassificationError, type PaymentClassificationValue,
} from '../../../../../components/finance/PaymentClassificationFields'
import { PayslipPdfButtons } from '../../../../../components/hr/SalaryBreakup'
import { ActionDialog, Badge, ErrorBox, LoadState, Note } from '../../../../../components/hr/interns/ui'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { NumberField } from '@/components/ui/NumberField'
import { Select } from '@/components/ui/Select'

type Dialog = null | 'finance-pass' | 'finance-return' | 'ceo-return-finance' | 'ceo-return-hr'

export default function InternPayrollRunPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { userId, role, isHrAdmin } = useHrAccess()
  const ceo = role === 'admin'
  const finance = role === 'finance' || ceo
  const [dialog, setDialog] = useState<Dialog>(null)
  const [paying, setPaying] = useState(false)
  const [slipId, setSlipId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const { data: run, error, isLoading, refetch } = useQuery({ queryKey: ['intern-run', id], queryFn: () => api.get<StipendRunView>(`/hr/interns/payroll/runs/${id}`) })
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['intern-run', id] }); void qc.invalidateQueries({ queryKey: ['intern-runs'] }); void qc.invalidateQueries({ queryKey: ['intern-dashboard'] }) }
  const act = useMutation({
    mutationFn: (what: 'recalculate' | 'send-to-finance' | 'approve') => api.post<{ accrual?: { posted: boolean; reason?: string } }>(`/hr/interns/payroll/runs/${id}/${what}`, {}),
    onSuccess: (r, what) => {
      setErr('')
      setInfo(what === 'approve' && r.accrual && !r.accrual.posted
        ? `Approved, but the ledger posting was refused (${r.accrual.reason ?? 'unknown reason'}). Finance re-posts it from Reconciliation → Backfill unposted.`
        : '')
      refresh()
    },
    onError: (e) => setErr(errText(e)),
  })
  const post = (path: string, body: unknown) => async () => { await api.post(`/hr/interns/payroll/runs/${id}/${path}`, body); setErr(''); setInfo(''); refresh() }

  const t = run?.totals ?? {}
  const prepared = !!run && !!userId && (run.createdById === userId || (run.preparedByIds ?? []).includes(userId) || run.sentToFinanceById === userId)
  const ask = async (what: 'send-to-finance' | 'approve') => {
    if (!run) return
    const facts = `${monthLabel(run.period)} · ${t.interns ?? 0} intern${t.interns === 1 ? '' : 's'} · net ${fmtPkr(t.netCents ?? 0)}.`
    const ok = await confirm(what === 'send-to-finance'
      ? { title: `Send the ${monthLabel(run.period)} stipends to finance?`, body: `${facts} You cannot edit it while finance has it; finance can send it back to you.`, confirmLabel: 'Send to finance' }
      : { title: `Approve the ${monthLabel(run.period)} stipends?`, body: `${facts} Approving books it: Dr 6038 Intern Stipends / Cr 2025 Stipends Payable.`, confirmLabel: 'Approve' })
    if (ok) act.mutate(what)
  }
  const banner = !run ? null
    : run.status === 'finance_review' && run.ceoReturnNote ? { tone: 'bad' as const, text: `Returned to finance for correction: ${run.ceoReturnNote}` }
    : run.status === 'finance_review' ? { tone: 'warn' as const, text: 'With finance for review — finance passes it to the CEO or returns it to HR.' }
    : run.status === 'finance_checked' ? { tone: 'info' as const, text: `Checked by finance — waiting for the CEO.${run.financeNote ? ` Finance's note: ${run.financeNote}` : ''}` }
    : run.status === 'draft' && run.ceoReturnNote && (!run.financeReturnedAt || (run.ceoReturnedAt ?? '') > run.financeReturnedAt) ? { tone: 'bad' as const, text: `Returned to HR for correction: ${run.ceoReturnNote}` }
    : run.status === 'draft' && run.financeReturnNote ? { tone: 'bad' as const, text: `Returned by finance: ${run.financeReturnNote}` }
    : null
  const slip = run?.slips.find((s) => s.id === slipId) ?? null
  const negative = (run?.slips ?? []).filter((s) => s.netCents < 0).length

  return (
    <HrShell title={run ? `Intern stipends — ${monthLabel(run.period)}` : 'Intern stipends'}
      actions={<Link href="/hr/interns?tab=payroll" className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white">All stipend payrolls</Link>}>
      <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
      {run && (
        <div className="space-y-5">
          <ol className="flex flex-wrap gap-x-1 gap-y-2 text-xs" aria-label="Payroll steps">
            {RUN_STEPS.map((s, i) => {
              const cur = RUN_STEPS.indexOf(run.status)
              const done = i < cur || run.status === 'paid'
              const on = i === cur && run.status !== 'paid'
              return (
                <li key={s} aria-current={on ? 'step' : undefined} className="flex items-center gap-1">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black"
                    style={done
                      ? { background: 'color-mix(in srgb, var(--erp-success) 16%, transparent)', color: 'var(--erp-success)' }
                      : on ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
                      : { color: 'rgb(var(--fg-rgb) / 0.5)', border: '1px solid rgb(var(--fg-rgb) / 0.2)' }}>{done ? '✓' : i + 1}</span>
                  <span className={on ? 'font-black text-white/90' : 'text-white/60'}>{RUN_STATUS_LABEL[s]}</span>
                  {i < RUN_STEPS.length - 1 && <span aria-hidden="true" className="text-white/25 mx-1">›</span>}
                </li>
              )
            })}
          </ol>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="Interns" value={t.interns ?? 0} />
            <Stat label="Prorated stipend" value={fmtPkr(t.baseCents ?? 0)} />
            <Stat label="Additions" value={fmtPkr(t.additionsCents ?? 0)} />
            <Stat label="Deductions" value={fmtPkr(t.deductionsCents ?? 0)} />
            <Stat label="Net payable" value={fmtPkr(t.netCents ?? 0)} tone="good" />
          </div>
          {banner && <Note tone={banner.tone}>{banner.text}</Note>}
          {negative > 0 && <Note tone="bad">{negative} slip{negative === 1 ? ' is' : 's are'} negative — fix the adjustments; a payroll with a negative slip cannot leave draft.</Note>}
          {info && <Note tone="warn">{info}</Note>}

          <div className="flex flex-wrap items-center gap-2">
            <Badge cls={RUN_BADGE[run.status] ?? 's-badge-muted'}>{run.statusLabel ?? RUN_STATUS_LABEL[run.status]}</Badge>
            {run.status === 'draft' && isHrAdmin && <>
              <button className={btnGhost} disabled={act.isPending} onClick={() => { setErr(''); act.mutate('recalculate') }}>Recalculate from attendance</button>
              <button className={btn} disabled={act.isPending || run.slips.length === 0} onClick={() => void ask('send-to-finance')}>Send to finance</button>
            </>}
            {run.status === 'finance_review' && finance && (!prepared || ceo) && <>
              <button className={btn} onClick={() => { setErr(''); setDialog('finance-pass') }}>Pass to CEO</button>
              <button className={btnGhost} onClick={() => { setErr(''); setDialog('finance-return') }}>Return to HR</button>
            </>}
            {run.status === 'finance_checked' && ceo && <>
              <button className={btn} disabled={act.isPending} onClick={() => void ask('approve')}>Approve</button>
              <button className={btnGhost} onClick={() => { setErr(''); setDialog('ceo-return-finance') }}>Return to finance</button>
              <button className={btnGhost} onClick={() => { setErr(''); setDialog('ceo-return-hr') }}>Return to HR</button>
            </>}
            {run.status === 'approved' && finance && <button className={btn} onClick={() => { setErr(''); setPaying(true) }}>Mark paid</button>}
            {run.status === 'paid' && (
              <span className="text-xs font-bold text-success">Paid {shortDate(run.paidOn)} · {run.paymentMethod?.replace('_', ' ')}{run.paymentReference ? ` · ref ${run.paymentReference}` : ''}</span>
            )}
            <span className="ml-auto flex flex-wrap gap-2">
              <ExportMenu className={btnGhost} label="Stipend sheet" path={`/hr/interns/payroll/runs/${id}/sheet`} filename={`intern-stipends-${run.period}`} onError={setErr} />
              {run.slips.length > 0 && <PayslipPdfButtons path={`/hr/interns/payroll/runs/${id}/slips.pdf`} filename={`stipend-slips-${run.period}`} className={btnGhost} label="all slips" />}
            </span>
          </div>
          <ErrorBox message={err} />
          {run.status === 'draft' && <p className="text-[11px] text-white/50">Slips come from each intern&rsquo;s attendance for the month. Mark attendance first (Interns → Attendance), then Recalculate. Adjustments you add stay through a recalculation.</p>}

          {run.slips.length === 0 ? (
            <div className="rounded-2xl p-8 text-center text-sm text-white/60" style={card}>No paid interns were engaged in {monthLabel(run.period)}, so there are no slips.</div>
          ) : (
            <div className="rounded-2xl overflow-x-auto" style={card}>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[10px] uppercase tracking-wider text-white/50">
                  {['Intern', 'Stipend', 'Days in month', 'Paid days', 'Absent', 'Half days', 'Unpaid leave', 'Prorated', 'Additions', 'Deductions', 'Net', ''].map((h, i) => (
                    <th key={`${h}-${i}`} className={`px-3 py-3 font-bold whitespace-nowrap${i === 0 ? ' sticky left-0 z-[1] bg-s-surface' : ''}${[1, 7, 8, 9, 10].includes(i) ? ' text-right' : ''}`}>{h || <span className="sr-only">Actions</span>}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {run.slips.map((s) => (
                    <tr key={s.id} className="border-t border-white/[0.05]">
                      <td className="px-3 py-3 sticky left-0 z-[1] bg-s-surface min-w-[10rem]">
                        <Link href={`/hr/interns/${s.intern.id}`} className="font-bold text-white/90 hover:underline">{s.intern.fullName}</Link>
                        <p className="text-[11px] text-white/50">{s.intern.internCode}{s.intern.department ? ` · ${s.intern.department}` : ''}</p>
                      </td>
                      <td className="px-3 py-3 text-white/70 whitespace-nowrap text-right tabular-nums">{fmtPkr(s.monthlyStipendCents)}</td>
                      <td className="px-3 py-3 text-white/70">{s.daysInMonth}</td>
                      <td className="px-3 py-3 text-white/70">{s.paidDays}</td>
                      <td className="px-3 py-3 text-white/70">{s.absentDays}</td>
                      <td className="px-3 py-3 text-white/70">{s.halfDays}</td>
                      <td className="px-3 py-3 text-white/70">{s.unpaidLeaveDays}</td>
                      <td className="px-3 py-3 text-white/80 whitespace-nowrap text-right tabular-nums">{fmtPkr(s.baseCents)}</td>
                      <td className="px-3 py-3 text-white/70 whitespace-nowrap text-right tabular-nums">{s.additionsCents ? `+${fmtPkr(s.additionsCents)}` : '—'}</td>
                      <td className="px-3 py-3 text-white/70 whitespace-nowrap text-right tabular-nums">{s.deductionsCents ? `−${fmtPkr(s.deductionsCents)}` : '—'}</td>
                      <td className="px-3 py-3 font-black whitespace-nowrap text-right tabular-nums" style={{ color: s.netCents < 0 ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.9)' }}>{fmtPkr(s.netCents)}</td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <button type="button" className="text-xs font-bold text-primary-ink mr-3 [@media(pointer:coarse)]:min-h-[44px]" onClick={() => { setErr(''); setSlipId(s.id) }}>{run.status === 'draft' && isHrAdmin ? 'Adjust' : 'Details'}</button>
                        <button type="button" className="text-xs font-bold text-primary-ink [@media(pointer:coarse)]:min-h-[44px]" onClick={() => { setErr(''); api.download(`/hr/interns/payroll/slips/${s.id}/pdf?download=1`, `stipend-slip-${s.intern.internCode}-${run.period}.pdf`).catch((e: Error) => setErr(e.message)) }}>PDF</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {dialog === 'finance-pass' && run && (
        <ActionDialog title={`Pass ${monthLabel(run.period)} stipends to the CEO?`} submitLabel="Pass to CEO"
          fields={[{ key: 'note', label: 'Note for the CEO (optional)', kind: 'textarea' }]} onClose={() => setDialog(null)}
          onSubmit={(v) => post('finance-pass', v['note'] ? { note: v['note'] } : {})()} />
      )}
      {dialog === 'finance-return' && run && (
        <ActionDialog title={`Return ${monthLabel(run.period)} stipends to HR`} submitLabel="Return to HR"
          fields={[{ key: 'note', label: 'What HR needs to correct', kind: 'textarea', min: 10 }]} onClose={() => setDialog(null)}
          onSubmit={(v) => post('finance-return', { note: v['note'] })()} />
      )}
      {(dialog === 'ceo-return-finance' || dialog === 'ceo-return-hr') && run && (
        <ActionDialog title={`Return ${monthLabel(run.period)} stipends to ${dialog === 'ceo-return-finance' ? 'finance' : 'HR'}`} submitLabel={`Return to ${dialog === 'ceo-return-finance' ? 'finance' : 'HR'}`}
          fields={[{ key: 'note', label: 'What needs correcting', kind: 'textarea', min: 10 }]} onClose={() => setDialog(null)}
          onSubmit={(v) => post('return', { note: v['note'], to: dialog === 'ceo-return-finance' ? 'finance' : 'hr' })()} />
      )}
      {slip && run && <SlipModal slip={slip} period={run.period} draft={run.status === 'draft' && isHrAdmin} onClose={() => setSlipId(null)} onSaved={refresh} />}
      {paying && run && <PayModal run={run} onClose={() => setPaying(false)} onPaid={refresh} />}
    </HrShell>
  )
}

/** One slip: its numbers, HR's additions / deductions (editable while draft) and the slip PDF. */
function SlipModal({ slip, period, draft, onClose, onSaved }: { slip: StipendSlip; period: string; draft: boolean; onClose: () => void; onSaved: () => void }) {
  type Row = { id?: string; kind: 'addition' | 'deduction'; label: string; amount: number | null; note: string }
  const toRow = (a: Adjustment): Row => ({ id: a.id, kind: a.kind, label: a.label, amount: a.amountCents / 100, note: a.note ?? '' })
  const initial = adjustmentsOf(slip).map(toRow)
  const [rows, setRows] = useState<Row[]>(initial)
  const [err, setErr] = useState('')
  const [rowErrs, setRowErrs] = useState<Record<number, string>>({})
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial)
  const save = useMutation({
    mutationFn: () => api.put(`/hr/interns/payroll/slips/${slip.id}/adjustments`, {
      items: rows.map((r) => ({ ...(r.id && { id: r.id }), kind: r.kind, label: r.label.trim(), amountCents: Math.round((r.amount ?? 0) * 100), ...(r.note.trim() && { note: r.note.trim() }) })),
    }),
    onSuccess: () => { onSaved(); onClose() },
    onError: (e) => setErr(apiErrors(e).message),
  })
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    const found: Record<number, string> = {}
    rows.forEach((r, i) => {
      if (r.label.trim().length < 2) found[i] = 'Give it a name (at least 2 characters)'
      else if (!((r.amount ?? 0) > 0)) found[i] = 'Type an amount above 0'
    })
    setRowErrs(found)
    if (Object.keys(found).length) { setErr('Please fix the marked lines.'); return }
    setErr('')
    save.mutate()
  }
  const facts: Array<[string, string]> = [
    ['Monthly stipend', fmtPkr(slip.monthlyStipendCents)], ['Days in month', String(slip.daysInMonth)], ['Days engaged', String(slip.daysEngaged)],
    ['Absent days', String(slip.absentDays)], ['Half days', String(slip.halfDays)], ['Unpaid leave days', String(slip.unpaidLeaveDays)], ['Paid days', String(slip.paidDays)],
    ['Prorated stipend', fmtPkr(slip.baseCents)], ['Additions', fmtPkr(slip.additionsCents)], ['Deductions', fmtPkr(slip.deductionsCents)], ['Net payable', fmtPkr(slip.netCents)],
  ]
  return (
    <Modal title={`${slip.intern.fullName} — ${monthLabel(period)}`} wide onClose={onClose} dirty={draft && dirty}>
      <form onSubmit={submit} noValidate className="grid md:grid-cols-2 gap-5">
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/50 mb-2">Stipend slip</p>
          <dl className="text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 py-1.5 border-t border-white/[0.05] first:border-t-0">
                <dt className="text-white/65">{k}</dt><dd className="font-bold text-white/90">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3"><PayslipPdfButtons path={`/hr/interns/payroll/slips/${slip.id}/pdf`} filename={`stipend-slip-${slip.intern.internCode}-${period}`} className={btnGhost} label="slip" /></div>
        </div>
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/50 mb-2">Additions &amp; deductions{draft ? '' : ' (HR edits while draft)'}</p>
          {rows.length === 0 && <p className="text-xs text-white/50">None.</p>}
          <ul className="space-y-3">
            {rows.map((r, i) => (
              <li key={r.id ?? `new-${i}`} className="rounded-lg p-2.5 space-y-2" style={{ border: `1px solid ${rowErrs[i] ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.1)'}` }}>
                <div className="grid grid-cols-2 gap-2">
                  <Select className={inp} aria-label="Kind" disabled={!draft} value={r.kind} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, kind: e.target.value as Row['kind'] } : x)))}>
                    <option value="addition">Addition</option><option value="deduction">Deduction</option>
                  </Select>
                  <NumberField className={inp} aria-label="Amount (PKR)" placeholder="Amount (PKR)" decimals={2} min={0} disabled={!draft} value={r.amount}
                    onValueChange={(n) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: n } : x)))} />
                </div>
                <input className={inp} aria-label="Label" placeholder="Label, e.g. Performance bonus" maxLength={80} disabled={!draft} value={r.label}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input className={inp} aria-label="Note" placeholder="Note (optional)" maxLength={300} disabled={!draft} value={r.note}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
                {rowErrs[i] && <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{rowErrs[i]}</p>}
                {draft && <button type="button" className="text-xs font-bold text-s-red [@media(pointer:coarse)]:min-h-[44px]" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}
              </li>
            ))}
          </ul>
          {draft && rows.length < 20 && <button type="button" className={`${btnGhost} mt-3`} onClick={() => setRows([...rows, { kind: 'addition', label: '', amount: null, note: '' }])}>+ Add a line</button>}
          <ErrorBox message={err} />
          {draft && <button type="submit" className={`${btn} mt-3 block`} disabled={save.isPending || !dirty}>{save.isPending ? 'Recalculating…' : 'Save and recalculate this slip'}</button>}
        </div>
      </form>
    </Modal>
  )
}

/** Finance marks the run paid: method, bank account, reference, date and the internal payment classification. */
function PayModal({ run, onClose, onPaid }: { run: StipendRunView; onClose: () => void; onPaid: () => void }) {
  const [method, setMethod] = useState<'cash' | 'bank_transfer' | 'cheque'>('bank_transfer')
  const [bankAccountId, setBankAccountId] = useState('')
  const [reference, setReference] = useState('')
  const [paidOn, setPaidOn] = useState(localDate())
  const [cls, setCls] = useState<PaymentClassificationValue>(EMPTY_PAYMENT_CLASSIFICATION)
  const [err, setErr] = useState('')
  const clsError = paymentClassificationError(cls)
  const needsRef = method !== 'cash' && !reference.trim()
  const pay = useMutation({
    mutationFn: () => api.post(`/hr/interns/payroll/runs/${run.id}/paid`, {
      method, paidOn, ...(method !== 'cash' && bankAccountId && { bankAccountId }), ...(method !== 'cash' && { reference: reference.trim() }), ...paymentClassificationBody(cls),
    }),
    onSuccess: () => { onPaid(); onClose() },
    onError: (e) => setErr(apiErrors(e).message),
  })
  return (
    <Modal title={`Pay stipends — ${monthLabel(run.period)}`} onClose={onClose}>
      <form className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); if (!pay.isPending && !clsError && !needsRef && paidOn) pay.mutate() }}>
        <p className="text-sm font-bold text-white/85">Net payable {fmtPkr(run.totals.netCents ?? 0)} to {run.totals.interns ?? 0} intern{run.totals.interns === 1 ? '' : 's'}</p>
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-white/55 mb-1">Paid by</span>
          <Select className={inp} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option><option value="cash">Cash (from the safe)</option>
          </Select>
        </label>
        {method !== 'cash' && (
          <>
            <BankAccountSelect id={`intern-pay-bank-${run.id}`} label="Bank account" tenantId={run.tenantId} value={bankAccountId} onChange={setBankAccountId} className={inp} />
            <label className="block">
              <span className="block text-[11px] font-bold uppercase tracking-wider text-white/55 mb-1">{method === 'cheque' ? 'Cheque number' : 'Transfer reference'} <span style={{ color: 'var(--erp-danger)' }}>*</span></span>
              <input className={inp} maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} aria-invalid={needsRef && reference.length > 0 || undefined} />
            </label>
          </>
        )}
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-wider text-white/55 mb-1">Paid on</span>
          <input type="date" className={inp} value={paidOn} max={localDate()} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
        <PaymentClassificationFields value={cls} onChange={setCls} compact />
        <p className="text-[11px] text-white/50">Clears 2025 Stipends Payable, dated the day the money left. A closed month is refused. Nobody can pay a payroll that carries their own stipend.</p>
        <ErrorBox message={err} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btn} disabled={pay.isPending || !!clsError || needsRef || !paidOn} title={clsError ?? undefined}>{pay.isPending ? 'Saving…' : 'Confirm payment'}</button>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

