'use client'
// The request forms of the fixed-asset register: dispose, write down, change
// the estimate, void, undo a disposal, move to another outlet / brand (on an
// asset), and write off / move / count smallwares (on a pool).
//
// Who may send what is decided by the page from the API's capability flags.
// The server decides whether a request waits for the CEO: it answers 202
// (pending) for finance and 201 (done) for the CEO's own request and for a
// move. Every POST pins the write to the row's own company.

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { MoneyInput } from '../ui/MoneyInput'
import { BankAccountSelect } from '../finance/BankAccountSelect'
import {
  FA_BASE, L, Modal, ErrorLine, inp, btnPrimary, btnGhost, money, todayIso, fmtLife, forCompany,
  type FaAsset, type FaLookups, type FaRequest,
} from './shared'

export interface RequestResult { status: 'pending' | 'posted'; applied: boolean; event: FaRequest }

export type AssetRequestKind = 'disposal' | 'impairment' | 'change_estimate' | 'void' | 'undispose' | 'transfer'

export const ASSET_REQUEST_TITLE: Record<AssetRequestKind, string> = {
  disposal: 'Dispose of this asset',
  impairment: 'Write this asset down',
  change_estimate: 'Change life or salvage value',
  void: 'Void: capitalised in error',
  undispose: 'Undo the disposal',
  transfer: 'Move to another outlet or brand',
}

const MIN_REASON = 10

function ReasonField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const short = value.trim().length > 0 && value.trim().length < MIN_REASON
  return (
    <L t="Reason (at least 10 characters)" hint={short ? `${MIN_REASON - value.trim().length} more characters` : undefined}>
      <textarea className={inp} rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </L>
  )
}

function Footer({ onClose, pending, disabled, label }: { onClose: () => void; pending: boolean; disabled: boolean; label: string }) {
  return (
    <div className="flex flex-wrap gap-2 mt-5">
      <button type="submit" disabled={pending || disabled} className={btnPrimary}>{pending ? 'Sending…' : label}</button>
      <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
    </div>
  )
}

// ─── On an asset ────────────────────────────────────────────────────────────

export function AssetRequestModal({ asset, kind, lookups, willWait, onClose, onDone }: {
  asset: FaAsset
  kind: AssetRequestKind
  lookups: FaLookups
  /** True when the caller is not the CEO: the request will wait for approval. */
  willWait: boolean
  onClose: () => void
  onDone: (r: RequestResult) => void
}) {
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(todayIso())
  // disposal
  const [dKind, setDKind] = useState('sale')
  const [proceeds, setProceeds] = useState(0)
  const [method, setMethod] = useState('bank_transfer')
  const [bankId, setBankId] = useState('')
  // impairment
  const [writeDown, setWriteDown] = useState(0)
  // change of estimate
  const [life, setLife] = useState('')
  const [changeSalvage, setChangeSalvage] = useState(false)
  const [salvage, setSalvage] = useState(asset.salvageCents)
  // transfer
  const [toConcept, setToConcept] = useState('__keep')
  const [toLocation, setToLocation] = useState('__keep')

  const brands = forCompany(lookups.brands, asset.tenantId)
  const outlets = forCompany(lookups.locations, asset.tenantId)

  const payload = (): Record<string, unknown> => {
    switch (kind) {
      case 'disposal':
        return {
          kind: dKind,
          proceedsCents: dKind === 'sale' ? proceeds : 0,
          ...(dKind === 'sale' && proceeds > 0 ? { method, ...(method !== 'cash' && bankId ? { bankAccountId: bankId } : {}) } : {}),
        }
      case 'impairment': return { amountCents: writeDown }
      case 'change_estimate':
        return {
          ...(life ? { remainingLifeMonths: Number(life) } : {}),
          ...(changeSalvage ? { salvageCents: salvage } : {}),
        }
      case 'transfer':
        return {
          ...(toConcept !== '__keep' ? { toConceptId: toConcept === '__shared' ? null : toConcept } : {}),
          ...(toLocation !== '__keep' ? { toLocationId: toLocation } : {}),
        }
      default: return {}
    }
  }

  const send = useMutation({
    mutationFn: () => api.post<RequestResult>(`${FA_BASE}/${asset.id}/requests`, {
      kind,
      reason: kind === 'transfer' && reason.trim().length < MIN_REASON ? 'Moved from the register' : reason.trim(),
      ...(kind !== 'transfer' && kind !== 'void' && kind !== 'undispose' ? { effectiveDate: date } : {}),
      payload: payload(),
    }, { tenantId: asset.tenantId }),
    onSuccess: (r) => onDone(r),
  })

  const reasonOk = kind === 'transfer' || reason.trim().length >= MIN_REASON
  const valid = reasonOk && (
    kind === 'disposal' ? (dKind !== 'sale' || proceeds >= 0) && !(dKind === 'sale' && proceeds > 0 && method !== 'cash' && lookups.bankAccounts.filter((b) => b.tenantId === asset.tenantId && b.accountCode).length > 1 && !bankId)
    : kind === 'impairment' ? writeDown > 0 && writeDown <= asset.nbvCents
    : kind === 'change_estimate' ? (!!life && Number(life) >= 1) || changeSalvage
    : kind === 'transfer' ? toConcept !== '__keep' || toLocation !== '__keep'
    : true
  )
  const gain = proceeds - asset.nbvCents
  const label = kind === 'transfer' ? 'Move now' : willWait ? 'Send to the CEO' : 'Do it now'

  return (
    <Modal title={ASSET_REQUEST_TITLE[kind]} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); send.mutate() }}>
        <p className="text-sm text-white/60">
          <strong className="text-white/90">{asset.assetTag ? `${asset.assetTag} ` : ''}{asset.name}</strong>
          {' '}· cost {money(asset.costCents)} · book value {money(asset.nbvCents)}
        </p>
        <p className="text-[11px] text-white/45 mt-1">
          {kind === 'transfer'
            ? 'A move takes effect at once and needs no approval. Depreciation from now on is charged to the new outlet and brand.'
            : willWait
              ? 'The CEO approves this before anything is posted. You can cancel it from the Requests tab while it waits.'
              : 'You are the CEO, so this posts as soon as you send it.'}
        </p>

        <div className="space-y-3 mt-4">
          {kind === 'disposal' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <L t="What happened">
                  <select className={inp} value={dKind} onChange={(e) => setDKind(e.target.value)}>
                    {lookups.disposalKinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                  </select>
                </L>
                <L t="Date"><input type="date" className={inp} value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></L>
              </div>
              {dKind === 'sale' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <L t="Sold for (PKR)"><MoneyInput value={proceeds} onChange={setProceeds} className={inp} /></L>
                    <L t="Paid by">
                      <select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
                        <option value="bank_transfer">Bank transfer</option>
                        <option value="cheque">Cheque</option>
                        <option value="online">Online payment</option>
                        <option value="cash">Cash</option>
                      </select>
                    </L>
                  </div>
                  {proceeds > 0 && method !== 'cash' && (
                    <BankAccountSelect tenantId={asset.tenantId} value={bankId} onChange={setBankId} id="fa-dispose-bank" label="Money lands in" className={inp} />
                  )}
                </>
              )}
              <p className="text-xs" style={{ color: (dKind === 'sale' ? gain : -asset.nbvCents) >= 0 ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
                {dKind === 'sale'
                  ? (gain >= 0 ? `Gain of ${money(gain)} on the sale` : `Loss of ${money(-gain)} on the sale`)
                  : `Loss of ${money(asset.nbvCents)}: the whole book value is written off`}
              </p>
            </>
          )}

          {kind === 'impairment' && (
            <>
              <L t="Write down by (PKR)" hint={`At most the book value, ${money(asset.nbvCents)}.`}>
                <MoneyInput value={writeDown} onChange={setWriteDown} className={inp} />
              </L>
              <L t="Date"><input type="date" className={inp} value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></L>
            </>
          )}

          {kind === 'change_estimate' && (
            <>
              <L t="New remaining life (months)" hint={`Now ${fmtLife(asset.usefulLifeMonths)} in total. Leave blank to keep it.`}>
                <input type="number" min={1} max={600} className={inp} value={life} onChange={(e) => setLife(e.target.value)} />
              </L>
              <label className="flex items-center gap-2 text-sm text-white/70">
                <input type="checkbox" checked={changeSalvage} onChange={(e) => setChangeSalvage(e.target.checked)} style={{ accentColor: 'var(--erp-accent)' }} />
                Change the salvage value too (now {money(asset.salvageCents)})
              </label>
              {changeSalvage && <L t="New salvage value (PKR)"><MoneyInput value={salvage} onChange={setSalvage} className={inp} /></L>}
              <L t="Takes effect from"><input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></L>
            </>
          )}

          {kind === 'void' && (
            <p className="text-sm text-white/70">
              Use this only when the item should never have been capitalised. The acquisition, every month of depreciation and any write-down are reversed,
              and the CapEx item can be prepared again. It is refused if the asset has been disposed of, written off or moved.
            </p>
          )}

          {kind === 'undispose' && (
            <p className="text-sm text-white/70">
              The disposal is reversed and the asset goes back on the register as in use. The months of depreciation since the disposal are caught up when it is applied.
            </p>
          )}

          {kind === 'transfer' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <L t="Outlet">
                <select className={inp} value={toLocation} onChange={(e) => setToLocation(e.target.value)}>
                  <option value="__keep">{asset.locationName ? `Stay at ${asset.locationName}` : 'No change'}</option>
                  {outlets.filter((o) => o.id !== asset.locationId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </L>
              <L t="Brand">
                <select className={inp} value={toConcept} onChange={(e) => setToConcept(e.target.value)}>
                  <option value="__keep">{asset.conceptName ? `Stay with ${asset.conceptName}` : 'No change (shared)'}</option>
                  {asset.conceptId && <option value="__shared">Shared across brands</option>}
                  {brands.filter((b) => b.id !== asset.conceptId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </L>
            </div>
          )}

          {kind !== 'transfer' && (
            <ReasonField value={reason} onChange={setReason}
              placeholder={kind === 'disposal' ? 'Sold to the scrap dealer after the compressor failed' : kind === 'void' ? 'Capitalised twice by mistake' : 'Why is this needed?'} />
          )}
        </div>

        <ErrorLine error={send.error} />
        <Footer onClose={onClose} pending={send.isPending} disabled={!valid} label={label} />
      </form>
    </Modal>
  )
}

// ─── On a smallwares pool ───────────────────────────────────────────────────

export type PoolRequestKind = 'write_off' | 'transfer_units' | 'count'

export interface PoolRow {
  id: string
  tenantId: string
  label: string
  classKey: string
  typeKey: string
  locationId: string
  conceptId: string | null
  unitsOnHand: number
}

export function PoolRequestModal({ pool, kind, lookups, willWait, initialUnits, onClose, onDone }: {
  pool: PoolRow
  kind: PoolRequestKind
  lookups: FaLookups
  willWait: boolean
  initialUnits?: number
  onClose: () => void
  onDone: (r: RequestResult & { countedUnits?: number; onHandUnits?: number | null; shortfallUnits?: number | null }) => void
}) {
  const [units, setUnits] = useState(initialUnits ? String(initialUnits) : '')
  const [cause, setCause] = useState('breakage')
  const [date, setDate] = useState(todayIso())
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [dest, setDest] = useState('')
  const [toLocation, setToLocation] = useState('')
  const [toConcept, setToConcept] = useState('__same')

  const sameTypePools = lookups.pools.filter((p) => p.tenantId === pool.tenantId && p.classKey === pool.classKey && p.typeKey === pool.typeKey && p.id !== pool.id)
  const outlets = forCompany(lookups.locations, pool.tenantId)
  const brands = forCompany(lookups.brands, pool.tenantId)
  const n = Number(units)

  const send = useMutation({
    mutationFn: () => {
      if (kind === 'count') {
        return api.post<RequestResult & { countedUnits: number; onHandUnits: number | null; shortfallUnits: number | null }>(
          `${FA_BASE}/pools/${pool.id}/counts`, { countedUnits: n, countedAt: date, ...(note.trim() ? { note: note.trim() } : {}) }, { tenantId: pool.tenantId })
      }
      return api.post<RequestResult>(`${FA_BASE}/pools/${pool.id}/requests`, {
        kind,
        units: n,
        effectiveDate: date,
        reason: reason.trim(),
        payload: kind === 'write_off'
          ? { cause }
          : dest && dest !== '__other'
            ? { toPoolId: dest }
            : { toLocationId: toLocation, ...(toConcept !== '__same' ? { toConceptId: toConcept === '__shared' ? null : toConcept } : {}) },
      }, { tenantId: pool.tenantId })
    },
    onSuccess: (r) => onDone(r),
  })

  const unitsOk = Number.isInteger(n) && n >= (kind === 'count' ? 0 : 1) && units !== '' && (kind === 'count' || n <= pool.unitsOnHand)
  const reasonOk = kind === 'count' || reason.trim().length >= MIN_REASON
  const destOk = kind !== 'transfer_units' || (dest && dest !== '__other') || (dest === '__other' && !!toLocation)
  const title = kind === 'count' ? 'Record a count' : kind === 'write_off' ? 'Write off units' : 'Move units to another outlet'
  const shortfall = kind === 'count' && unitsOk ? pool.unitsOnHand - n : 0

  return (
    <Modal title={`${title}: ${pool.label}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); send.mutate() }}>
        <p className="text-sm text-white/60">The books say <strong className="text-white/90">{pool.unitsOnHand}</strong> units are on hand.</p>
        <p className="text-[11px] text-white/45 mt-1">
          {kind === 'count'
            ? 'A count carries no money. If units are missing, finance can then ask the CEO to write them off.'
            : kind === 'transfer_units'
              ? 'Moving units takes effect at once and needs no approval.'
              : willWait ? 'The CEO approves a write-off before it posts.' : 'You are the CEO, so this posts as soon as you send it.'}
        </p>

        <div className="space-y-3 mt-4">
          <div className="grid grid-cols-2 gap-3">
            <L t={kind === 'count' ? 'Units counted' : 'Units'}>
              <input type="number" min={kind === 'count' ? 0 : 1} className={inp} value={units} onChange={(e) => setUnits(e.target.value)} />
            </L>
            <L t="Date"><input type="date" className={inp} value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></L>
          </div>

          {kind === 'count' && unitsOk && shortfall !== 0 && (
            <p className="text-xs" style={{ color: shortfall > 0 ? 'var(--erp-danger)' : 'var(--erp-warning)' }}>
              {shortfall > 0 ? `${shortfall} units short of what the books say.` : `${-shortfall} more units than the books say.`}
            </p>
          )}
          {kind === 'count' && (
            <L t="Note (optional)"><input className={inp} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Counted after the Friday rush" /></L>
          )}

          {kind === 'write_off' && (
            <L t="Cause">
              <select className={inp} value={cause} onChange={(e) => setCause(e.target.value)}>
                {lookups.writeOffCauses.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </L>
          )}

          {kind === 'transfer_units' && (
            <>
              <L t="Move to">
                <select className={inp} value={dest} onChange={(e) => setDest(e.target.value)}>
                  <option value="">Pick where the units go</option>
                  {sameTypePools.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  <option value="__other">Another outlet (new pool if needed)</option>
                </select>
              </L>
              {dest === '__other' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <L t="Outlet">
                    <select className={inp} value={toLocation} onChange={(e) => setToLocation(e.target.value)}>
                      <option value="">Pick an outlet</option>
                      {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </L>
                  <L t="Brand">
                    <select className={inp} value={toConcept} onChange={(e) => setToConcept(e.target.value)}>
                      <option value="__same">Same brand as this pool</option>
                      <option value="__shared">Shared across brands</option>
                      {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </L>
                </div>
              )}
            </>
          )}

          {kind !== 'count' && (
            <ReasonField value={reason} onChange={setReason}
              placeholder={kind === 'write_off' ? 'Twelve plates broken during the Eid rush' : 'Opening the new counter at Clifton'} />
          )}
        </div>

        <ErrorLine error={send.error} />
        <Footer onClose={onClose} pending={send.isPending} disabled={!unitsOk || !reasonOk || !destOk}
          label={kind === 'count' ? 'Save count' : kind === 'transfer_units' ? 'Move now' : willWait ? 'Send to the CEO' : 'Write off now'} />
      </form>
    </Modal>
  )
}
