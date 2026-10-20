'use client'
import { useState } from 'react'
import { Menu } from 'lucide-react'
import { fmtPkrWhole } from '../../../lib/money'
import type { TillDelivery } from '../../../store/pos'
import { useDeliveryZones } from './flowApi'
import { ErrorLine, inputCls, labelCls, primaryBtn } from './ui'

export const EMPTY_DELIVERY: TillDelivery = { name: '', phone: '', address: '', notes: '', zoneId: null, cod: false }

// Delivery (owner's flow, step 7): customer, phone, address, zone — then the order screen.
// The payment choice (Pay now / Cash on delivery) travels with the ticket when it is created
// (TILL_FLOW §7 `delivery.cod`), so it is asked here and again at settle until the ticket exists.
export function DeliveryForm({ conceptId, initial, onMenu, onContinue }: {
  conceptId: string
  initial: TillDelivery | null
  onMenu: () => void
  onContinue: (d: TillDelivery) => void
}) {
  const [d, setD] = useState<TillDelivery>(initial ?? EMPTY_DELIVERY)
  const [error, setError] = useState<string | null>(null)
  const zones = useDeliveryZones(conceptId)
  const zoneList = zones.data ?? []
  const set = <K extends keyof TillDelivery>(k: K, v: TillDelivery[K]) => setD((x) => ({ ...x, [k]: v }))

  function go(e: React.FormEvent) {
    e.preventDefault()
    if (!d.name.trim() || !d.phone.trim() || !d.address.trim()) { setError('Enter the customer’s name, phone and address.'); return }
    if (zoneList.length > 0 && !d.zoneId) { setError('Pick the delivery zone — this brand delivers by zone.'); return }
    setError(null)
    onContinue(d)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-kds-border bg-kds-card px-3 py-2">
        <button type="button" onClick={onMenu} aria-label="Open the till menu" className="flex h-11 w-11 items-center justify-center rounded-lg text-kds-text hover:bg-kds-border/60"><Menu size={22} aria-hidden="true" /></button>
        <h1 className="text-lg font-bold text-kds-text">Delivery</h1>
      </div>
      <form onSubmit={go} className="mx-auto w-full max-w-xl flex-1 space-y-4 overflow-y-auto p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor="dl-name" className={labelCls}>Customer name</label><input id="dl-name" value={d.name} onChange={(e) => set('name', e.target.value)} className={inputCls} autoFocus /></div>
          <div><label htmlFor="dl-phone" className={labelCls}>Phone</label><input id="dl-phone" inputMode="tel" value={d.phone} onChange={(e) => set('phone', e.target.value)} className={inputCls} /></div>
        </div>
        <div><label htmlFor="dl-addr" className={labelCls}>Address</label><textarea id="dl-addr" rows={2} value={d.address} onChange={(e) => set('address', e.target.value)} className={inputCls} /></div>
        {zones.isError || zoneList.length > 0 ? (
          <div>
            <label htmlFor="dl-zone" className={labelCls}>Delivery zone</label>
            <select id="dl-zone" value={d.zoneId ?? ''} onChange={(e) => set('zoneId', e.target.value || null)} className={inputCls}>
              <option value="">Select a zone</option>
              {zoneList.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name} — fee {fmtPkrWhole(z.feeCents)}{z.estimatedMinutes ? ` · ~${z.estimatedMinutes} min` : ''}{z.minOrderCents ? ` · min ${fmtPkrWhole(z.minOrderCents)}` : ''}
                </option>
              ))}
            </select>
            {zones.isError && <p className="mt-1 text-xs text-kds-amber">The zones did not load. Reload, or ask a manager.</p>}
          </div>
        ) : null}
        <div><label htmlFor="dl-notes" className={labelCls}>Notes for the rider (optional)</label><input id="dl-notes" value={d.notes} onChange={(e) => set('notes', e.target.value)} className={inputCls} /></div>
        <div>
          <p className={labelCls}>Payment</p>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="How the customer pays">
            <button type="button" aria-pressed={!d.cod} onClick={() => set('cod', false)} className={`min-h-12 rounded-lg border px-3 font-semibold ${!d.cod ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>Pay now</button>
            <button type="button" aria-pressed={d.cod} onClick={() => set('cod', true)} className={`min-h-12 rounded-lg border px-3 font-semibold ${d.cod ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>Cash on delivery</button>
          </div>
        </div>
        <ErrorLine text={error} />
        <button type="submit" className={`${primaryBtn} w-full py-4 text-lg`}>Continue to the order</button>
      </form>
    </div>
  )
}
