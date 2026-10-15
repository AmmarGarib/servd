'use client'
// Hand cash back OUT of a box — to the Garibsons cashier (Dr 2210), the safe
// (Dr 1010) or a bank account of the box's company (Dr its code); Cr 1011
// Petty cash. Managers and finance.

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import { Choice, ErrorBanner, Field, Footer, Modal, fieldCls, firstMissing, focusField, pkr, primaryBtn, useSubmitOnce, type Box } from './ui'

type Destination = 'garibsons' | 'safe' | 'bank'

export function ReturnModal({ box, onClose, onSaved }: { box: Box; onClose: () => void; onSaved: () => void }) {
  const [destination, setDestination] = useState<Destination>('garibsons')
  const [bankAccountId, setBankAccountId] = useState('')
  const [amountCents, setAmountCents] = useState(0)
  const [reason, setReason] = useState('')
  const over = amountCents > box.floatCents
  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/returns', {
      boxId: box.id, amountCents, destination, reason: reason.trim(),
      ...(destination === 'bank' && bankAccountId && { bankAccountId }),
    }),
    onSuccess: () => onSaved(),
  })
  const [tried, setTried] = useState(false)
  const errs: Record<string, string> = {
    'rt-amount': amountCents <= 0 ? 'Enter an amount above zero.' : over ? `More than the ${pkr(box.floatCents)} in the box.` : '',
    'rt-reason': reason.trim() ? '' : 'Say why the cash is going back.',
  }
  const shown = (k: string) => (tried ? errs[k] : '')
  const submit = useSubmitOnce(save.isPending)(() => {
    setTried(true)
    const bad = firstMissing(errs)
    if (bad) { focusField(bad); return false }
    save.mutate()
    return true
  })
  return <Modal title={`Return cash from ${box.name}`} onClose={onClose} dirty={!save.isPending && (amountCents > 0 || !!reason.trim())}>
    <form onSubmit={submit} className="space-y-3" noValidate>
    <Field label="To *">
      <Choice<Destination> value={destination} onChange={setDestination} options={[
        { value: 'garibsons', label: 'Garibsons cashier' },
        { value: 'safe', label: 'Safe' },
        { value: 'bank', label: 'Bank account' },
      ]} />
    </Field>
    {destination === 'bank' && (
      <BankAccountSelect tenantId={box.tenantId} value={bankAccountId} onChange={setBankAccountId} className={fieldCls} />
    )}
    <Field label="Amount (PKR) *" error={shown('rt-amount')}>
      <MoneyInput id="rt-amount" value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
      <p className="text-[10px] mt-1" style={{ color: over ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.3)' }}>
        {over ? `More than the ${pkr(box.floatCents)} in the box` : `In the box now: ${pkr(box.floatCents)}`}
      </p>
    </Field>
    <Field label="Reason *" error={shown('rt-reason')}>
      <input id="rt-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Month-end float back to Jamil sb" className={fieldCls} />
    </Field>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={
      <button type="submit" disabled={save.isPending} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Return cash'}</button>
    } />
    </form>
  </Modal>
}
