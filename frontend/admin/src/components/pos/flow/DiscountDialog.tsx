'use client'
import { useState } from 'react'
import { NumberField } from '../../ui/NumberField'
import { PasswordInput } from '../../ui/PasswordInput'
import { usePosStore } from '../../../store/pos'
import { fmtPkr } from '../../../lib/money'
import { FlowDialog, ErrorLine, ghostBtn, inputCls, labelCls, primaryBtn } from './ui'

// Discount on the ring-up (TILL_FLOW §4: discountCents, discountReason, manager PIN above the cap).
// The server decides the cap; a refusal (403 DISCOUNT_OVER_CAP / MANAGER_OVERRIDE_REQUIRED) is shown
// as written and the PIN box here is where the manager's PIN goes.
export function DiscountDialog({ onClose }: { onClose: () => void }) {
  const cart = usePosStore((s) => s.cart)
  const discountCents = usePosStore((s) => s.discountCents)
  const discountReason = usePosStore((s) => s.discountReason)
  const itemTotalCents = usePosStore((s) => s.itemTotalCents)
  const setDiscount = usePosStore((s) => s.setDiscount)
  const base = itemTotalCents()
  const [mode, setMode] = useState<'pkr' | 'pct'>('pkr')
  const [value, setValue] = useState<number | null>(discountCents ? discountCents / 100 : null)
  const [reason, setReason] = useState(discountReason)
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)

  const cents = value == null ? 0 : mode === 'pkr' ? Math.round(value * 100) : Math.round((base * value) / 100)

  function apply(e: React.FormEvent) {
    e.preventDefault()
    if (cents <= 0) { setError('Enter a discount above zero, or remove the discount.'); return }
    if (cents > base) { setError('The discount cannot be more than the items.'); return }
    if (!reason.trim()) { setError('A reason is required for a discount.'); return }
    setDiscount(cents, reason.trim(), pin.trim())
    onClose()
  }

  return (
    <FlowDialog title="Discount" subtitle={`${cart.length} line${cart.length !== 1 ? 's' : ''} · items ${fmtPkr(base)}`} onClose={onClose} width="max-w-sm">
      <form onSubmit={apply} className="space-y-4">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Discount type">
          {(['pkr', 'pct'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setValue(null) }}
              className={`min-h-11 rounded-lg border font-semibold ${mode === m ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>{m === 'pkr' ? 'Amount (PKR)' : 'Percent (%)'}</button>
          ))}
        </div>
        <div>
          <label htmlFor="disc-val" className={labelCls}>{mode === 'pkr' ? 'Discount (PKR)' : 'Discount (%)'}</label>
          <NumberField id="disc-val" decimals={mode === 'pkr' ? 2 : 2} min={0} value={value} onValueChange={setValue} autoFocus className={inputCls} />
          {cents > 0 && <p className="mt-1 text-xs text-kds-subtext">Takes {fmtPkr(cents)} off the items. The server works out the bill.</p>}
        </div>
        <div><label htmlFor="disc-reason" className={labelCls}>Reason (required)</label><input id="disc-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder="Loyalty, complaint, promotion…" /></div>
        <div>
          <label htmlFor="disc-pin" className={labelCls}>Manager PIN (only above your discount limit)</label>
          <PasswordInput id="disc-pin" numeric maxLength={8} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} className={inputCls} />
        </div>
        <ErrorLine text={error} />
        <div className="flex gap-3">
          {discountCents > 0 && <button type="button" onClick={() => { setDiscount(0, '', ''); onClose() }} className={`${ghostBtn} flex-1`}>Remove</button>}
          <button type="submit" className={`${primaryBtn} flex-1`}>Apply</button>
        </div>
      </form>
    </FlowDialog>
  )
}
