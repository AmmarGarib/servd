'use client'
import { useState } from 'react'
import { Search } from 'lucide-react'
import { NumberField } from '../../ui/NumberField'
import type { TillGuest, TillWaiter } from '../../../store/pos'
import { fetchGuests, flowErrorMessage, guestBody, patchOrderInfo, useWaiters, type GuestHit, type OrderInfoView } from './flowApi'
import { FlowDialog, ErrorLine, ghostBtn, inputCls, labelCls, primaryBtn } from './ui'

export interface OrderInfoValues { waiter: TillWaiter | null; partySize: number | null; guest: TillGuest | null }

export const EMPTY_GUEST: TillGuest = { customerId: null, name: '', email: '', mobile: '', phone: '', registrationNo: '' }

// "Order Information" (owner's flow, step 3): waiter, pax, guest. For a NEW ticket the values are
// held by the till until the first Save (TILL_FLOW §3). For an open ticket (`orderId`) Save sends
// PATCH /pos/orders/:id/info.
export function OrderInfoModal({ conceptId, title, initial, orderId, onClose, onDone }: {
  conceptId: string
  title: string
  initial: OrderInfoValues
  /** An open ticket: Save changes it on the server. Absent: the values go back to the till. */
  orderId?: string
  onClose: () => void
  onDone: (v: OrderInfoValues, info?: OrderInfoView) => void
}) {
  const [waiterId, setWaiterId] = useState<string>(initial.waiter?.id ?? '')
  const [waiterCode, setWaiterCode] = useState('')
  const [pax, setPax] = useState<number | null>(initial.partySize)
  const [guest, setGuest] = useState<TillGuest>(initial.guest ?? EMPTY_GUEST)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<GuestHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const waiters = useWaiters(conceptId, '')

  const list = waiters.data ?? []
  const picked: TillWaiter | null = waiterCode.trim()
    ? { code: waiterCode.trim().toUpperCase(), name: list.find((w) => w.code.toLowerCase() === waiterCode.trim().toLowerCase())?.name ?? waiterCode.trim().toUpperCase(), id: list.find((w) => w.code.toLowerCase() === waiterCode.trim().toLowerCase())?.id }
    : waiterId ? list.find((w) => w.id === waiterId) ?? (initial.waiter?.id === waiterId ? initial.waiter : null) : null

  async function search() {
    if (q.trim().length < 2) { setError('Type at least 2 characters to search for a guest.'); return }
    setError(null); setSearching(true)
    try { setHits(await fetchGuests(conceptId, q)) } catch (e) { setError(flowErrorMessage(e, 'Could not search guests')) } finally { setSearching(false) }
  }
  function pickGuest(h: GuestHit) {
    setGuest({ customerId: h.id, name: h.name, email: h.email ?? '', mobile: h.phone ?? '', phone: h.altPhone ?? '', registrationNo: guest.registrationNo })
    setHits(null); setQ('')
  }
  // Editing a picked guest's fields turns it into typed details (the server takes one of the two).
  function edit(k: keyof TillGuest, v: string) { setGuest((g) => ({ ...g, [k]: v, customerId: null })) }

  async function save() {
    setError(null)
    const hasGuest = !!(guest.customerId || guest.name.trim() || guest.email.trim() || guest.mobile.trim() || guest.phone.trim() || guest.registrationNo.trim())
    if (hasGuest && !guest.customerId && !guest.name.trim()) { setError('Enter the guest’s name, or search for the guest.'); return }
    const values: OrderInfoValues = { waiter: picked, partySize: pax, guest: hasGuest ? guest : null }
    if (!orderId) { onDone(values); return }
    setSaving(true)
    try {
      const info = await patchOrderInfo(orderId, {
        ...(picked && (picked.id ? { waiterEmployeeId: picked.id } : { waiterCode: picked.code })),
        partySize: pax,
        ...(guest.customerId ? { customerId: guest.customerId } : hasGuest ? { guest: guestBody(guest) } : {}),
      })
      onDone({ waiter: info.waiter, partySize: info.partySize, guest: values.guest }, info)
    } catch (e) { setError(flowErrorMessage(e, 'Could not save the order information')) } finally { setSaving(false) }
  }

  return (
    <FlowDialog title="Order Information" subtitle={title} onClose={onClose} width="max-w-xl">
      <form onSubmit={(e) => { e.preventDefault(); void save() }} className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="oi-waiter" className={labelCls}>Waiter</label>
            <select id="oi-waiter" value={waiterId} onChange={(e) => { setWaiterId(e.target.value); setWaiterCode('') }} className={inputCls} disabled={!!waiterCode.trim()}>
              <option value="">{waiters.isLoading ? 'Loading…' : 'Select a waiter'}</option>
              {list.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="oi-code" className={labelCls}>or Waiter code</label>
            <input id="oi-code" value={waiterCode} onChange={(e) => setWaiterCode(e.target.value)} placeholder="GSF-0007" autoCapitalize="characters" autoComplete="off" className={inputCls} />
          </div>
        </div>
        {waiters.isError && <p className="text-xs text-kds-amber">The waiter list did not load — type the waiter code.</p>}

        <div>
          <p className={labelCls}>Pax</p>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Number of guests">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button key={n} type="button" aria-pressed={pax === n} onClick={() => setPax(pax === n ? null : n)}
                className={`h-11 w-11 rounded-lg border text-base font-bold ${pax === n ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text hover:border-kds-green'}`}>{n}</button>
            ))}
            <NumberField aria-label="Pax (number)" value={pax} onValueChange={setPax} min={1} max={500} placeholder="10+"
              className="min-h-11 w-24 rounded-lg border border-kds-border bg-kds-bg px-3 text-base text-kds-text focus:border-kds-green focus:outline-none" />
          </div>
        </div>

        <fieldset className="space-y-3 rounded-xl border border-kds-border p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-kds-subtext">Guest Detail</legend>
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="oi-search">Enter Guest Name, Mobile, Phone or Email</label>
            <input id="oi-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Enter Guest Name, Mobile, Phone or Email"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search() } }} className={inputCls} />
            <button type="button" onClick={() => void search()} disabled={searching} className={`${primaryBtn} flex shrink-0 items-center gap-2`}>
              <Search size={16} aria-hidden="true" /> {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
          {hits && (
            <ul className="max-h-40 divide-y divide-kds-border overflow-y-auto rounded-lg border border-kds-border" aria-label="Guests found">
              {hits.length === 0 && <li className="px-3 py-3 text-sm text-kds-subtext">No guest found — fill the details below.</li>}
              {hits.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => pickGuest(h)} className="flex min-h-12 w-full flex-col items-start px-3 py-2 text-left hover:bg-kds-border/40">
                    <span className="font-semibold text-kds-text">{h.name}</span>
                    <span className="text-xs text-kds-subtext">{[h.phone, h.altPhone, h.email].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {guest.customerId && <p className="text-xs font-semibold text-kds-green" role="status">Guest picked from your customers. Editing a field below turns it into typed details.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label htmlFor="oi-name" className={labelCls}>Guest Name</label><input id="oi-name" value={guest.name} onChange={(e) => edit('name', e.target.value)} className={inputCls} /></div>
            <div><label htmlFor="oi-email" className={labelCls}>Email</label><input id="oi-email" type="email" value={guest.email} onChange={(e) => edit('email', e.target.value)} className={inputCls} /></div>
            <div><label htmlFor="oi-phone" className={labelCls}>Phone</label><input id="oi-phone" inputMode="tel" value={guest.phone} onChange={(e) => edit('phone', e.target.value)} className={inputCls} /></div>
            <div><label htmlFor="oi-mobile" className={labelCls}>Mobile No</label><input id="oi-mobile" inputMode="tel" value={guest.mobile} onChange={(e) => edit('mobile', e.target.value)} className={inputCls} /></div>
            <div className="sm:col-span-2"><label htmlFor="oi-reg" className={labelCls}>Guest Registration #</label><input id="oi-reg" value={guest.registrationNo} onChange={(e) => setGuest((g) => ({ ...g, registrationNo: e.target.value }))} className={inputCls} /></div>
          </div>
        </fieldset>

        <ErrorLine text={error} />
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className={`${ghostBtn} flex-1`}>Cancel</button>
          <button type="submit" disabled={saving} className={`${primaryBtn} flex-1`}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </FlowDialog>
  )
}
