'use client'
// "Move to another company" on an asset's page (owner, 2026-11-23). The giver's door to the one
// company-to-company transfer: at book value, no gain or loss; the receiving company gets a new
// register entry with the name, serial, class, supplier, warranty, months of life left and the
// documents. Finance's ask waits for the CEO; the CEO's own applies at once.
//   GET  /accounting/fixed-assets/:id/move-company/options?date=
//   POST /accounting/fixed-assets/:id/move-company

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { FA_BASE, L, Modal, ErrorLine, inp, btnPrimary, btnGhost, money, todayIso, fmtLife, type FaAsset } from './shared'
import { Select } from '@/components/ui/Select'
import type { RequestResult } from './RequestForms'

interface Company { tenantId: string; name: string; locations: Array<{ id: string; name: string }>; brands: Array<{ id: string; name: string }>; hasClass: boolean; classLabel: string | null }
interface Options {
  date: string; companies: Company[]; bookValueCents: number | null; costCents: number | null
  remainingLifeMonths: number | null; blocked: string | null; pending: boolean; appliesAtOnce: boolean
}

export function MoveToCompanyModal({ asset, onClose, onDone }: { asset: FaAsset; onClose: () => void; onDone: (r: RequestResult, companyName: string) => void }) {
  const [date, setDate] = useState(todayIso())
  const [company, setCompany] = useState('')
  const [location, setLocation] = useState('')
  const [brand, setBrand] = useState('')
  const [reason, setReason] = useState('')

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['fa-move-company', asset.id, date],
    queryFn: () => api.get<Options>(`${FA_BASE}/${asset.id}/move-company/options?date=${date}`),
  })
  const picked = data?.companies.find((c) => c.tenantId === company) ?? null
  const save = useMutation({
    mutationFn: () => api.post<RequestResult>(`${FA_BASE}/${asset.id}/move-company`, {
      tenantId: company, date, locationId: location || null, conceptId: brand || null, reason: reason.trim(),
    }, { tenantId: asset.tenantId }),
    onSuccess: (r) => onDone(r, picked?.name ?? 'the other company'),
  })

  const needsOutlet = !!picked && !brand && !location
  const short = reason.trim().length > 0 && reason.trim().length < 10
  const stop = data?.blocked ?? (data?.pending ? 'A move of this asset to another company is already waiting for the CEO.' : null)
  const ready = !!picked && picked.hasClass && !needsOutlet && reason.trim().length >= 10 && !stop && !isLoading
  const dirty = !!company || !!reason

  return (
    <Modal title="Move to another company" onClose={onClose} dirty={dirty}>
      <p className="text-sm text-white/85 break-words">
        <span className="font-bold">{asset.assetTag ? `${asset.assetTag} ` : ''}{asset.name}</span>
        <span className="text-white/55"> · cost {money(asset.costCents)}</span>
      </p>
      <p className="text-xs text-s-muted mt-1">
        It leaves {asset.companyName}&apos;s register and goes onto the other company&apos;s at its book value on the day of the move, with no gain or loss.
        The other company then owes {asset.companyName} that amount. Its name, serial number, class, supplier, warranty, months of life left and documents go with it.
        {data && !data.appliesAtOnce ? ' The CEO approves the move before anything is booked.' : ''}
      </p>

      {loadError ? <ErrorLine error={loadError} /> : null}
      {stop && <p className="text-xs text-s-red mt-3" role="alert">{stop}</p>}
      {data && data.companies.length === 0 && (
        <p className="text-xs text-s-red mt-3" role="alert">You do not belong to another servd company, so there is nowhere to move it. The CEO can do this move.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
        <L t="Move to company">
          <Select className={inp} value={company} onChange={(e) => { setCompany(e.target.value); setLocation(''); setBrand('') }}>
            <option value="">Pick a company</option>
            {(data?.companies ?? []).map((c) => <option key={c.tenantId} value={c.tenantId}>{c.name}</option>)}
          </Select>
        </L>
        <L t="Date of the move" hint="Not in the future, and not in a closed month of either company">
          <input type="date" className={inp} value={date} max={todayIso()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </L>
        {picked && (
          <>
            <L t={`Outlet at ${picked.name}`} hint={needsOutlet ? 'Shared equipment needs its outlet' : undefined}>
              <Select className={inp} value={location} onChange={(e) => setLocation(e.target.value)}>
                <option value="">{picked.locations.length ? 'Pick an outlet' : 'No outlets yet'}</option>
                {picked.locations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            </L>
            <L t="Brand">
              <Select className={inp} value={brand} onChange={(e) => setBrand(e.target.value)}>
                <option value="">Shared across brands</option>
                {picked.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </L>
          </>
        )}
      </div>

      {picked && !picked.hasClass && (
        <p className="text-xs text-s-red mt-3" role="alert">
          {picked.name} does not have the class &ldquo;{asset.classLabel}&rdquo; switched on. Switch it on under Classes &amp; policy in {picked.name} first.
        </p>
      )}

      {data && data.bookValueCents != null && !data.blocked && (
        <dl className="grid grid-cols-2 gap-3 mt-4 rounded-xl p-3 text-sm" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.06)' }}>
          <div><dt className="text-[11px] font-bold uppercase tracking-wider text-white/45">Book value on that day</dt><dd className="font-black text-white/90">{money(data.bookValueCents)}</dd></div>
          <div><dt className="text-[11px] font-bold uppercase tracking-wider text-white/45">Life left</dt><dd className="font-black text-white/90">{data.remainingLifeMonths ? fmtLife(data.remainingLifeMonths) : '—'}</dd></div>
        </dl>
      )}

      <div className="mt-3">
        <L t="Reason (at least 10 characters)" hint={short ? `${10 - reason.trim().length} more characters` : undefined}>
          <textarea className={inp} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is moving, e.g. the machine now works in the Flipd kitchen" />
        </L>
      </div>

      <ErrorLine error={save.error} />
      <div className="flex flex-wrap gap-2 mt-5">
        <button className={btnPrimary} disabled={!ready || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Sending…' : data?.appliesAtOnce ? 'Move now' : 'Send to the CEO'}
        </button>
        <button className={btnGhost} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}
