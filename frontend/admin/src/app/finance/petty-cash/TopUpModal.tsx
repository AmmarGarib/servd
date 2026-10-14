'use client'
// Top up a box — and the same "where did the cash come from" picker for a new
// box's opening float. The server books it Dr 1011 Petty cash / Cr the source
// (backend accounting/pettyCashPosting.ts):
//   Garibsons cashier (the default — GS Foods holds no cash) → 2210 Due to Garibsons
//   Safe → 1010 · Bank account → that bank's code · Till drawer → 1015, taken
//   out of an open drawer as a pay-out (managers and finance only).

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { BankAccountSelect } from '../../../components/finance/BankAccountSelect'
import { Choice, ErrorBanner, Field, Footer, Modal, fieldCls, pinRefusal, pkr, primaryBtn, type Box } from './ui'

export type TopupSource = 'garibsons' | 'safe' | 'bank' | 'till'

export interface SourceValue { source: TopupSource; bankAccountId: string; shiftId: string }
export const DEFAULT_SOURCE: SourceValue = { source: 'garibsons', bankAccountId: '', shiftId: '' }

/** The body fields for a source (empty ones dropped). */
export function sourceBody(v: SourceValue) {
  return {
    ...(v.source === 'bank' && v.bankAccountId && { bankAccountId: v.bankAccountId }),
    ...(v.source === 'till' && { shiftId: v.shiftId }),
  }
}
export const sourceReady = (v: SourceValue) => v.source !== 'till' || !!v.shiftId

interface Drawer { id: string; openedAt: string; locationName: string | null; cashierName: string }

/**
 * Where the cash came from. `boxId` lists the open drawers of the box's
 * company (a new box has none yet: the till is offered once the box exists).
 */
export function SourcePicker({ value, onChange, tenantId, boxId, allowTill }: {
  value: SourceValue
  onChange: (v: SourceValue) => void
  tenantId: string | null
  boxId: string | null
  allowTill: boolean
}) {
  const { data, isError } = useQuery<{ drawers: Drawer[] }>({
    queryKey: ['petty-cash-open-drawers', boxId],
    queryFn: () => api.get(`/trustops/petty-cash/open-drawers?boxId=${encodeURIComponent(boxId!)}`),
    enabled: allowTill && !!boxId && value.source === 'till',
    retry: false, meta: { background: true },
  })
  const drawers = data?.drawers ?? []
  return <div className="space-y-2">
    <Choice<TopupSource> value={value.source} onChange={(source) => onChange({ ...value, source })} options={[
      { value: 'garibsons', label: 'Garibsons cashier' },
      { value: 'safe', label: 'Safe' },
      { value: 'bank', label: 'Bank account' },
      { value: 'till', label: 'Till drawer', disabled: !allowTill || !boxId },
    ]} />
    {value.source === 'garibsons' && <p className="text-[10px] text-white/35">Owed back to Garibsons (2210 Due to Garibsons).</p>}
    {value.source === 'bank' && (
      <BankAccountSelect tenantId={tenantId} value={value.bankAccountId} onChange={(bankAccountId) => onChange({ ...value, bankAccountId })} className={fieldCls} />
    )}
    {value.source === 'till' && (
      <Field label="Open drawer *">
        <select value={value.shiftId} onChange={(e) => onChange({ ...value, shiftId: e.target.value })} className={fieldCls}>
          <option value="">{isError ? 'Drawers unavailable' : drawers.length === 0 ? 'No open drawer in this company' : '— pick the drawer —'}</option>
          {drawers.map((d) => (
            <option key={d.id} value={d.id}>{d.cashierName}{d.locationName ? ` · ${d.locationName}` : ''} · opened {new Date(d.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</option>
          ))}
        </select>
        <p className="text-[10px] text-white/35 mt-1">Shown on the drawer as a pay-out; its count expects less cash. Nothing goes to the bank deposit.</p>
      </Field>
    )}
  </div>
}

export function TopUpModal({ box, isKeeper, onClose, onSaved }: { box: Box; isKeeper: boolean; onClose: () => void; onSaved: () => void }) {
  const [amountCents, setAmountCents] = useState(0)
  const [reason, setReason] = useState('')
  const [src, setSrc] = useState<SourceValue>(DEFAULT_SOURCE)
  const [managerOverridePin, setManagerOverridePin] = useState('')
  const overLimit = amountCents > box.topUpLimitCents
  const save = useMutation({
    mutationFn: () => api.post('/trustops/petty-cash/movements', {
      boxId: box.id, type: 'topup', amountCents, reason: reason.trim(), source: src.source, ...sourceBody(src),
      ...(overLimit && managerOverridePin && { managerOverridePin }),
    }),
    onSuccess: () => onSaved(),
  })
  return <Modal title={`Top up ${box.name}`} onClose={onClose}>
    <Field label="From *">
      <SourcePicker value={src} onChange={setSrc} tenantId={box.tenantId} boxId={box.id} allowTill={isKeeper} />
    </Field>
    <Field label="Amount (PKR) *">
      <MoneyInput value={amountCents} onChange={setAmountCents} className={fieldCls} autoFocus ariaLabel="Amount in rupees" />
      <p className="text-[10px] text-white/30 mt-1">In the box now: {pkr(box.floatCents)} · limit without a PIN {pkr(box.topUpLimitCents)}</p>
    </Field>
    <Field label="Reason *">
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Weekly float from Jamil sb" className={fieldCls} />
    </Field>
    {overLimit && (
      <Field label="Manager PIN *">
        <input type="password" inputMode="numeric" value={managerOverridePin} onChange={(e) => setManagerOverridePin(e.target.value)} placeholder="Above the box's top-up limit" className={fieldCls} />
      </Field>
    )}
    {save.error && <ErrorBanner error={pinRefusal(save.error) ?? save.error} />}
    <Footer onCancel={onClose} primary={
      <button onClick={() => save.mutate()} disabled={save.isPending || amountCents <= 0 || !reason.trim() || !sourceReady(src) || (overLimit && !managerOverridePin)} className={primaryBtn}>
        {save.isPending ? 'Saving…' : 'Top up'}
      </button>
    } />
  </Modal>
}
