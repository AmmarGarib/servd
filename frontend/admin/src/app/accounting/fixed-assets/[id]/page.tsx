'use client'
// One fixed asset: what it cost and is worth, its depreciation schedule (posted
// and forecast), everything that has happened to it, and the requests finance
// can raise (dispose, write down, change the estimate, move, void, undo a
// disposal). Only the descriptive fields can be edited here; what drives the
// books goes through a request, and the CEO approves it (the approve and
// reject buttons appear only when the API says canDecide).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTrashPrefill } from '../../../../lib/trash'
import { unwrapPrefill, pStr, type Prefill } from '../../../../lib/trashPrefill'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import {
  FA_BASE, FaFrame, Stat, Notice, AssetStatusBadge, Modal, L, ErrorLine, card, inp, btnPrimary, btnGhost, money, fmtDay, fmtLife, fmtMonth, pct,
  errorWords, forCompany, useFaLookups, type FaAsset, type FaRequest,
} from '../../../../components/fixedAssets/shared'
import { AssetRequestModal, ASSET_REQUEST_TITLE, type AssetRequestKind, type RequestResult } from '../../../../components/fixedAssets/RequestForms'
import { RequestCard } from '../../../../components/fixedAssets/RequestCard'
import { ScheduleTable, type PostedMonth, type UpcomingMonth } from '../../../../components/fixedAssets/ScheduleTable'
import { Select } from '@/components/ui/Select'
import { RecordFiles } from '@/components/files/RecordFiles'

interface DocLink { label?: string; url: string }
interface TaxYear {
  taxYear: number; rateBp: number; initialAllowanceBp: number; openingWdvCents: number; additionsCents: number
  initialAllowanceCents: number; depreciationCents: number; disposalProceedsCents: number; closingWdvCents: number; frozen: boolean
}
interface AssetDetail {
  asset: FaAsset
  schedule: { posted: PostedMonth[]; upcoming: UpcomingMonth[]; nextChargeCents: number }
  events: FaRequest[]
  tax: { toConfirm: boolean; note: string | null; years: TaxYear[] }
  capex: { lineId: string; item: string; status: string; quantity: number; actualDeliveryDate: string | null; projectId: string; projectName: string; unit: number | null } | null
  journal: Array<{ id: string; reference: string | null; entryDate: string; description: string | null }>
  documentUrls: DocLink[] | null
  photoUrls: DocLink[] | null
}

export default function FixedAssetPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id ?? ''
  const qc = useQueryClient()
  const { data: lookups } = useFaLookups()
  const [asking, setAsking] = useState<AssetRequestKind | null>(null)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'wait' | 'bad'; text: string } | null>(null)

  const { data, isLoading, error } = useQuery<AssetDetail>({
    queryKey: ['fa-asset', id],
    queryFn: () => api.get<AssetDetail>(`${FA_BASE}/${id}`),
    enabled: !!id,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['fa-asset', id] })
    void qc.invalidateQueries({ queryKey: ['fa-register'] })
    void qc.invalidateQueries({ queryKey: ['fa-pending-count'] })
    void qc.invalidateQueries({ queryKey: ['fa-requests'] })
  }

  const a = data?.asset

  // "Recover as copy" from the Trash (a rejected / cancelled asset request):
  // reopen the same request on this asset, pre-filled. It goes through the
  // normal request route, so the CEO approves it again.
  const trashPrefill = unwrapPrefill(useTrashPrefill('fixed_asset_request'))
  const [askPrefill, setAskPrefill] = useState<Prefill | null>(null)
  const [pendingAsk, setPendingAsk] = useState<Prefill | null>(null)
  useEffect(() => { if (trashPrefill) setPendingAsk(trashPrefill) }, [trashPrefill])
  const canWrite = !!lookups?.capabilities.canWrite
  const isCeo = !!lookups?.capabilities.canApprove
  const pendingEvents = (data?.events ?? []).filter((e) => e.status === 'pending')
  const history = (data?.events ?? []).filter((e) => e.status !== 'pending')
  const isLayer = a?.kind === 'pool_layer'

  function done(r: RequestResult) {
    setAsking(null)
    setAskPrefill(null)
    setNotice(r.status === 'pending'
      ? { tone: 'wait', text: `${r.event.kindLabel} sent to the CEO. Nothing posts until it is approved.` }
      : { tone: 'ok', text: `${r.event.kindLabel} done and posted.` })
    refresh()
  }

  useEffect(() => {
    if (!pendingAsk || !a || !lookups) return
    const kind = pStr(pendingAsk, 'kind') as AssetRequestKind | undefined
    setPendingAsk(null)
    const other = pStr(pendingAsk, 'assetId')
    if (other && other !== a.id) { setNotice({ tone: 'bad', text: 'That request was on a different asset. Open that asset to recover it.' }); return }
    if (!kind || !(kind in ASSET_REQUEST_TITLE) || !canWrite || isLayer) { setNotice({ tone: 'bad', text: 'This request cannot be raised again on this asset.' }); return }
    setAskPrefill(pendingAsk); setAsking(kind)
  }, [pendingAsk, a, lookups, canWrite, isLayer])

  const actions: Array<{ kind: AssetRequestKind; label: string }> = []
  if (a && canWrite && !isLayer) {
    if (a.status === 'active') {
      actions.push({ kind: 'disposal', label: 'Dispose' }, { kind: 'impairment', label: 'Write down' }, { kind: 'change_estimate', label: 'Change life or salvage' },
        { kind: 'transfer', label: 'Move' }, { kind: 'void', label: 'Void' })
    } else if (a.status === 'disposed') {
      actions.push({ kind: 'undispose', label: 'Undo disposal' })
    }
  }

  return (
    <FaFrame
      title={a ? `${a.assetTag ? `${a.assetTag} ` : ''}${a.name}` : 'Asset'}
      back={{ href: FA_BASE, label: '← Register' }}
      subtitle={a && (
        <span className="flex flex-wrap items-center gap-2">
          <AssetStatusBadge status={a.status} />
          <span>{a.classLabel}</span>
          <span>· {a.companyName}</span>
          {a.pendingRequestCount > 0 && <span className="s-badge-amber">Request waiting</span>}
        </span>
      )}
      actions={a && canWrite && a.status !== 'voided' && (
        <button className={btnGhost} onClick={() => setEditing(true)}>Edit details</button>
      )}
    >
      {isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {error && <Notice tone="bad">{errorWords(error)}</Notice>}
      {notice && <Notice tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Notice>}

      {a && data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Cost" value={money(a.costCents)} />
            <Stat label="Depreciated" value={money(a.accumulatedCents)} />
            <Stat label="Book value" value={money(a.nbvCents)} />
            <Stat label={a.status === 'active' ? 'Next month charge' : 'Status'} value={a.status === 'active' ? money(data.schedule.nextChargeCents) : a.status === 'disposed' ? `Disposed ${fmtDay(a.disposedAt)}` : 'Voided'} />
          </div>

          {a.unchargedMonths > 0 && a.status === 'active' && (
            <Notice tone="wait">{a.unchargedMonths} completed month{a.unchargedMonths === 1 ? '' : 's'} not charged yet. The nightly run catches them up.</Notice>
          )}

          {/* Pending requests, with the CEO's buttons */}
          {pendingEvents.length > 0 && (
            <section className="space-y-3" aria-label="Requests waiting">
              <p className="text-xs font-bold uppercase tracking-wider text-white/45">Waiting for the CEO</p>
              {pendingEvents.map((e) => <RequestCard key={e.id} r={e} showSubject={false} onChanged={refresh} onNotice={(tone, text) => setNotice({ tone, text })} />)}
            </section>
          )}

          {/* Request buttons */}
          {actions.length > 0 && (
            <section className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/90">What do you need to do with it?</p>
              <p className="text-xs text-white/45 mt-0.5">
                {isCeo ? 'As CEO, what you send posts at once.' : 'Disposals, write-downs and voids go to the CEO to approve. A move takes effect at once.'}
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {actions.map((x) => (
                  <button key={x.kind} className={x.kind === 'disposal' ? btnPrimary : btnGhost} disabled={pendingEvents.length > 0 && x.kind !== 'transfer'}
                    title={pendingEvents.length > 0 && x.kind !== 'transfer' ? 'A request is already waiting on this asset' : ASSET_REQUEST_TITLE[x.kind]}
                    onClick={() => { setNotice(null); setAsking(x.kind) }}>{x.label}</button>
                ))}
              </div>
            </section>
          )}
          {isLayer && (
            <Notice tone="wait">
              This is a layer of a smallwares pool. Units are written off, moved and counted from the{' '}
              <Link href={`${FA_BASE}/pools`} className="underline font-bold">Smallwares tab</Link>.
            </Notice>
          )}

          {/* Facts */}
          <section className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/90 mb-3">Details</p>
            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3 text-sm">
              {([
                ['In service from', fmtDay(a.inServiceAt)],
                ['Bought', fmtDay(a.acquiredAt)],
                ['Life', a.usefulLifeMonths ? fmtLife(a.usefulLifeMonths) : 'Not depreciated'],
                ['Salvage value', money(a.salvageCents)],
                ['Original cost', money(a.originalCostCents)],
                ['Sales tax claimed', a.inputTaxCents ? money(a.inputTaxCents) : 'None'],
                ['Brand', a.conceptName ?? 'Shared across brands'],
                // Owner (2026-10-14): shared equipment always says where it physically is.
                ['Asset location (outlet)', a.locationName ?? (a.conceptId ? '—' : 'Not set: shared equipment needs its location. Move it to its outlet.')],
                ['Pool', a.poolLabel ? `${a.poolLabel} (${a.quantity} of ${a.originalQuantity} units)` : 'Individual item'],
                ['Supplier', a.supplierName ?? '—'],
                ['Serial number', a.serialNumber ?? '—'],
                ['Warranty until', a.warrantyUntil ? fmtDay(a.warrantyUntil) : '—'],
                ...(a.leaseEndsAt ? [['Lease ends', fmtDay(a.leaseEndsAt)]] : []),
                ...(a.status === 'disposed' ? [['Disposed', `${fmtDay(a.disposedAt)}${a.disposalKind ? ` (${a.disposalKind.replace(/_/g, ' ')})` : ''}`]] : []),
              ] as Array<[string, string]>).map(([k, v]) => (
                <div key={k}><dt className="text-[11px] font-bold uppercase tracking-wider text-white/40">{k}</dt><dd className="text-white/85 break-words">{v}</dd></div>
              ))}
            </dl>
            {a.notes && <p className="text-sm text-white/60 mt-3 break-words">Notes: {a.notes}</p>}
            {data.capex && (
              <p className="text-sm text-white/60 mt-3">
                Came from CapEx:{' '}
                <Link href={`/finance/capex?project=${data.capex.projectId}`} className="text-primary-ink font-bold hover:underline">{data.capex.projectName}: {data.capex.item}</Link>
                {data.capex.quantity > 1 && data.capex.unit ? ` (unit ${data.capex.unit} of ${data.capex.quantity})` : ''}
              </p>
            )}
            {((data.documentUrls?.length ?? 0) > 0 || (data.photoUrls?.length ?? 0) > 0) && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {[...(data.documentUrls ?? []), ...(data.photoUrls ?? [])].map((d, i) => (
                  <a key={`${d.url}-${i}`} href={d.url} target="_blank" rel="noreferrer noopener" className="text-primary-ink hover:underline">{d.label || d.url}</a>
                ))}
              </div>
            )}
            <div className="mt-4">
              <RecordFiles ownerType="fixed_asset" ownerId={a.id} tenantId={a.tenantId} canUpload={canWrite} title="Documents and photos" />
            </div>
          </section>

          {/* Schedule */}
          <section className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/90 mb-3">Depreciation schedule</p>
            <ScheduleTable posted={data.schedule.posted} upcoming={data.schedule.upcoming} />
          </section>

          {/* Tax view */}
          <section className="rounded-2xl p-4" style={card}>
            <p className="text-sm font-black text-white/90">Tax depreciation</p>
            {data.tax.note && !data.tax.toConfirm && <p className="text-xs text-white/50 mt-1">{data.tax.note}</p>}
            {data.tax.toConfirm ? (
              <p className="text-sm text-white/60 mt-2">Tax treatment to confirm. {data.tax.note}</p>
            ) : data.tax.years.length === 0 ? (
              <p className="text-sm text-white/45 mt-2">No tax depreciation for this asset.</p>
            ) : (
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                      {['Tax year', 'Rate', 'Opening', 'Added', 'Initial allowance', 'Depreciation', 'Sale proceeds', 'Closing'].map((h, i) => (
                        <th key={h} className={`px-3 py-2 font-bold whitespace-nowrap ${i > 0 ? 'text-right' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.tax.years.map((y) => (
                      <tr key={y.taxYear} className="border-t border-white/[0.05]">
                        <td className="px-3 py-2 text-white/80 whitespace-nowrap">{y.taxYear}{y.frozen && <span className="s-badge-green ml-2">Frozen</span>}</td>
                        <td className="px-3 py-2 text-right text-white/60">{pct(y.rateBp)}{y.initialAllowanceBp > 0 ? ` + ${pct(y.initialAllowanceBp)}` : ''}</td>
                        <td className="px-3 py-2 text-right text-white/70 whitespace-nowrap">{money(y.openingWdvCents)}</td>
                        <td className="px-3 py-2 text-right text-white/70 whitespace-nowrap">{money(y.additionsCents)}</td>
                        <td className="px-3 py-2 text-right text-white/70 whitespace-nowrap">{money(y.initialAllowanceCents)}</td>
                        <td className="px-3 py-2 text-right text-white/70 whitespace-nowrap">{money(y.depreciationCents)}</td>
                        <td className="px-3 py-2 text-right text-white/70 whitespace-nowrap">{money(y.disposalProceedsCents)}</td>
                        <td className="px-3 py-2 text-right font-bold text-white/90 whitespace-nowrap">{money(y.closingWdvCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* History */}
          <section className="space-y-3" aria-label="History">
            <p className="text-xs font-bold uppercase tracking-wider text-white/45">History</p>
            {history.length === 0 && <p className="text-sm text-white/45">Nothing has happened to this asset yet beyond its monthly depreciation.</p>}
            {history.map((e) => <RequestCard key={e.id} r={e} showSubject={false} onChanged={refresh} onNotice={(tone, text) => setNotice({ tone, text })} />)}
          </section>

          {/* Ledger entries */}
          {data.journal.length > 0 && (
            <section className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/90 mb-2">Ledger entries</p>
              <ul className="divide-y divide-white/[0.05] text-sm">
                {data.journal.map((j) => (
                  <li key={j.id} className="py-2 flex flex-wrap gap-x-4 gap-y-0.5">
                    <span className="text-white/50 w-28 shrink-0">{fmtDay(j.entryDate)}</span>
                    <span className="text-white/80 min-w-0 break-words flex-1">{j.description || j.reference}</span>
                    <span className="text-[11px] text-white/35 break-all">{j.reference}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {a && asking && lookups && (
        <AssetRequestModal asset={a} kind={asking} lookups={lookups} willWait={!isCeo} prefill={askPrefill} onClose={() => { setAsking(null); setAskPrefill(null) }} onDone={done} />
      )}
      {a && data && editing && lookups && (
        <EditDetails detail={data} lookups={lookups} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); setNotice({ tone: 'ok', text: 'Details saved.' }); refresh() }} />
      )}
    </FaFrame>
  )
}

// ─── Edit the descriptive fields ────────────────────────────────────────────

function EditDetails({ detail, lookups, onClose, onSaved }: {
  detail: AssetDetail; lookups: NonNullable<ReturnType<typeof useFaLookups>['data']>; onClose: () => void; onSaved: () => void
}) {
  const a = detail.asset
  const [name, setName] = useState(a.name)
  const [serial, setSerial] = useState(a.serialNumber ?? '')
  const [notes, setNotes] = useState(a.notes ?? '')
  const [warranty, setWarranty] = useState(a.warrantyUntil ?? '')
  const [supplierId, setSupplierId] = useState(a.supplierId ?? '')

  const save = useMutation({
    mutationFn: () => api.patch(`${FA_BASE}/${a.id}`, {
      name: name.trim(),
      serialNumber: serial.trim() || null,
      notes: notes.trim() || null,
      warrantyUntil: warranty || null,
      supplierId: supplierId || null,
    }, { tenantId: a.tenantId }),
    onSuccess: onSaved,
  })

  return (
    <Modal title="Edit details" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate() }} className="space-y-3">
        <p className="text-[11px] text-white/45">
          Only descriptive details can be edited. Cost, life, dates, class, brand and outlet drive posted depreciation, so they change through a request.
        </p>
        <L t="Name"><input className={inp} value={name} onChange={(e) => setName(e.target.value)} /></L>
        <div className="grid grid-cols-2 gap-3">
          <L t="Serial number"><input className={inp} value={serial} onChange={(e) => setSerial(e.target.value)} /></L>
          <L t="Warranty until"><input type="date" className={inp} value={warranty} onChange={(e) => setWarranty(e.target.value)} /></L>
        </div>
        <L t="Supplier">
          <Select className={inp} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">None</option>
            {forCompany(lookups.suppliers, a.tenantId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </L>
        <L t="Notes"><textarea className={inp} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></L>
        <ErrorLine error={save.error} />
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={save.isPending || !name.trim()} className={btnPrimary}>{save.isPending ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
