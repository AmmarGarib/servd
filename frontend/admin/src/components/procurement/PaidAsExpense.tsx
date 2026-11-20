'use client'
// "Paid already — booked as an expense" on an open supplier bill (owner, 2026-11-20). The cash was handed over through
// a cash voucher / box spend that booked an EXPENSE instead of paying the bill, so the bill stayed Open and the cost
// is in the books twice. One click: the bill is marked paid and the duplicate expense is taken out of the account
// picked (POST /procurement/bills/:id/paid-as-expense). Finance and the CEO only — the server decides.
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../lib/api'
import { fmtPkrWhole } from '../../lib/money'
import { Field, Input, ErrorBanner, DialogFooter, Button } from '../finance/ui'
import { Select } from '../ui/Select'
import { Modal } from '../ui/Modal'
import { MoneyInput } from '../ui/MoneyInput'

interface Options { accounts: Array<{ code: string; name: string; section: string }>; brands: Array<{ id: string; name: string }> }
const SECTION: Record<string, string> = { cost_of_sales: 'Cost of sales', operating_expense: 'Operating expenses', contra_revenue: 'Discounts & refunds' }

export function PaidAsExpense({ bill, onDone, onClose }: {
  bill: { id: string; billNumber: string; supplierName: string; dueCents: number }
  onDone: () => void; onClose: () => void
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['procurement', 'bill', bill.id, 'paid-as-expense-options'],
    queryFn: () => api.get<Options>(`/procurement/bills/${bill.id}/paid-as-expense/options`),
  })
  const [amount, setAmount] = useState<number>(bill.dueCents)
  const [account, setAccount] = useState('')
  const [brand, setBrand] = useState('')
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)
  const amountErr = !amount || amount <= 0 ? 'Enter the amount that was paid.' : amount > bill.dueCents ? `Only ${fmtPkrWhole(bill.dueCents)} is still owed on this bill.` : null
  const reasonErr = reason.trim().length < 10 ? 'Say how it was paid (at least 10 characters).' : null
  const valid = !amountErr && !!account && !reasonErr
  const mut = useMutation({
    mutationFn: () => api.post<{ status: string; amountCents: number; accountCode: string; accountName: string }>(`/procurement/bills/${bill.id}/paid-as-expense`, {
      amountCents: amount, accountCode: account, conceptId: brand || null, reason: reason.trim(),
    }),
    onSuccess: (r) => {
      toast.success(`Bill ${bill.billNumber} is ${r.status === 'paid' ? 'paid' : 'partially paid'} — ${fmtPkrWhole(r.amountCents)} taken out of ${r.accountCode} ${r.accountName}.`)
      onDone(); onClose()
    },
  })
  const groups = Object.keys(SECTION).map((s) => ({ s, rows: (data?.accounts ?? []).filter((a) => a.section === s) })).filter((g) => g.rows.length > 0)
  const dirty = !!account || !!reason.trim() || !!brand

  return (
    <Modal title={`Paid already — bill ${bill.billNumber}`} onClose={onClose} dirty={dirty}>
      <form noValidate className="space-y-4" onSubmit={(e) => { e.preventDefault(); setTried(true); if (valid && !mut.isPending) mut.mutate() }}>
        <p className="text-sm text-s-muted">
          Use this when {bill.supplierName} was already paid in cash and that cash was booked as an expense instead of against this bill.
          The bill is marked paid and the same amount is taken out of the expense account you pick, so the cost is counted once. No cash moves.
        </p>
        {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
        {error && <ErrorBanner message={(error as Error).message} />}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Amount already paid (PKR)" required hint={`Still owed: ${fmtPkrWhole(bill.dueCents)}`} error={tried ? amountErr : null}>
            <MoneyInput value={amount} onChange={setAmount} className="s-input w-full" />
          </Field>
          <Field label="Brand it was booked under" hint="Leave as is if it was not booked to a brand.">
            <Select value={brand} onChange={(e) => setBrand(e.target.value)} className="s-input w-full">
              <option value="">No brand</option>
              {(data?.brands ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Account the expense sits in now" required hint="The account the cash was booked to — or where you have since moved it."
          error={tried && !account ? 'Pick the account.' : null}>
          <Select value={account} onChange={(e) => setAccount(e.target.value)} className="s-input w-full">
            <option value="">Pick an account…</option>
            {groups.map((g) => (
              <optgroup key={g.s} label={SECTION[g.s]}>
                {g.rows.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="How it was paid" required error={tried ? reasonErr : null}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} className="s-input w-full" maxLength={400} placeholder="e.g. Paid from cash voucher CV-00042 to the buyer" />
        </Field>
        {mut.error && <ErrorBanner message={(mut.error as Error).message} />}
        <DialogFooter onCancel={onClose}>
          <Button type="submit" disabled={mut.isPending}>{mut.isPending ? 'Saving…' : 'Mark as paid'}</Button>
        </DialogFooter>
      </form>
    </Modal>
  )
}
