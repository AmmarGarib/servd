'use client'
// Hand cash back OUT of a box — to the Garibsons cashier (Dr 2210), the safe
// (Dr 1010) or a bank account of the box's company (Dr its code); Cr 1011
// Petty cash. Managers and finance.

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import { Choice, ErrorBanner, Field, Footer, Modal, fieldCls, pkr, primaryBtn, type Box } from './ui'

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
  return <Modal title={`Return cash from ${box.name}`} onClose={onClose}>
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
    <Field label="Amount (PKR) *">
      <MoneyInput value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
      <p className="text-[10px] mt-1" style={{ color: over ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.3)' }}>
        {over ? `More than the ${pkr(box.floatCents)} in the box` : `In the box now: ${pkr(box.floatCents)}`}
      </p>
    </Field>
    <Field label="Reason *">
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Month-end float back to Jamil sb" className={fieldCls} />
    </Field>
    {save.error && <ErrorBanner error={save.error} />}
    <Footer onCancel={onClose} primary={
      <button onClick={() => save.mutate()} disabled={save.isPending || amountCents <= 0 || over || !reason.trim()} className={primaryBtn}>{save.isPending ? 'Saving…' : 'Return cash'}</button>
    } />
  </Modal>
}
