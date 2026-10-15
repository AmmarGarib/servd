'use client'
// POS connector → POS IDs tab (spec §10, D9). THE one editor of the brand
// POS ids: they stay in Concept.fbrPosId / srbPosId (the ledger still routes
// Sindh tax on srbPosId) and are written through
// PUT /connectors/fiscal/brand-pos-ids. Outlet overrides (an outlet — or one
// brand at an outlet — registered separately) live in the fiscal connector's
// settings.outlets and are saved through PUT /connectors/fiscal.

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import {
  AUTHORITIES, authorityLabel, connectorsApi, connectorErrorText,
  type Authority, type ConnectorsOverview, type FiscalOutlet, type FiscalSettings,
} from '../../lib/connectorsApi'
import { Card, ErrorLine, OkLine } from './ui'

interface LocationLite { id: string; name: string; tenantId?: string | null }

const digits = (v: string) => v.replace(/[^0-9]/g, '')
/** Concept.fbrPosId / srbPosId are Postgres INT columns: 1 … 2 147 483 647. */
const POS_ID_MAX = 2_147_483_647
/** '' (no id) or a whole number the column can hold. */
export const posIdOk = (v: string) => v === '' || (/^[0-9]+$/.test(v) && Number(v) >= 1 && Number(v) <= POS_ID_MAX)

export function useCompanyLocations(activeTenantId: string | null) {
  const q = useQuery<LocationLite[]>({ queryKey: ['locations'], queryFn: () => api.get<LocationLite[]>('/locations') })
  // In portfolio view /locations spans companies — keep the active company's.
  const rows = (q.data ?? []).filter((l) => !activeTenantId || !l.tenantId || l.tenantId === activeTenantId)
  return { ...q, data: rows }
}

export function PosIdsTable({ data, canEdit, activeTenantId }: { data: ConnectorsOverview; canEdit: boolean; activeTenantId: string | null }) {
  return (
    <div className="space-y-4">
      <BrandIds data={data} canEdit={canEdit} />
      <OutletOverrides data={data} canEdit={canEdit} activeTenantId={activeTenantId} />
    </div>
  )
}

function BrandIds({ data, canEdit }: { data: ConnectorsOverview; canEdit: boolean }) {
  const qc = useQueryClient()
  const serverKey = JSON.stringify(data.brandPosIds)
  const [rows, setRows] = useState(() => data.brandPosIds.map((b) => ({ ...b, fbr: b.fbrPosId ? String(b.fbrPosId) : '', srb: b.srbPosId ? String(b.srbPosId) : '' })))
  useEffect(() => {
    setRows(data.brandPosIds.map((b) => ({ ...b, fbr: b.fbrPosId ? String(b.fbrPosId) : '', srb: b.srbPosId ? String(b.srbPosId) : '' })))
  }, [serverKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const badRows = rows.filter((r) => !posIdOk(r.fbr) || !posIdOk(r.srb))
  const dirty = rows.filter((r) => (r.fbr ? Number(r.fbr) : null) !== r.fbrPosId || (r.srb ? Number(r.srb) : null) !== r.srbPosId)
  const m = useMutation({
    mutationFn: () => connectorsApi.saveBrandPosIds(dirty.map((r) => ({
      conceptId: r.conceptId,
      fbrPosId: r.fbr ? Number(r.fbr) : null,
      srbPosId: r.srb ? Number(r.srb) : null,
    }))),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connectors'] }),
  })

  return (
    <Card title="Brand POS IDs"
      subtitle="The POS registration each brand files under. A Sindh brand needs its SRB POS ID — the ledger also uses it to book Sindh sales tax.">
      {rows.length === 0 && <p className="text-xs text-s-muted">This company has no brands yet.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="s-table">
            <thead><tr><th>Brand</th><th>Province</th><th>FBR POS ID</th><th>SRB POS ID</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.conceptId}>
                  <td className="font-semibold">{r.name}</td>
                  <td className="text-xs">{r.province ?? <span className="text-s-amber">Not set</span>}</td>
                  <td>
                    <input aria-label={`FBR POS ID for ${r.name}`} aria-invalid={!posIdOk(r.fbr)} className={`s-input w-[130px] font-mono text-xs ${posIdOk(r.fbr) ? '' : 'border-s-red'}`} inputMode="numeric" disabled={!canEdit}
                      value={r.fbr} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, fbr: digits(e.target.value) } : x)))} placeholder="—" />
                    {!posIdOk(r.fbr) && <p role="alert" className="mt-1 text-[11px] text-s-red">1 to {POS_ID_MAX.toLocaleString('en-US')}</p>}
                  </td>
                  <td>
                    <input aria-label={`SRB POS ID for ${r.name}`} aria-invalid={!posIdOk(r.srb)} className={`s-input w-[130px] font-mono text-xs ${posIdOk(r.srb) ? '' : 'border-s-red'}`} inputMode="numeric" disabled={!canEdit}
                      value={r.srb} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, srb: digits(e.target.value) } : x)))} placeholder="—" />
                    {!posIdOk(r.srb) && <p role="alert" className="mt-1 text-[11px] text-s-red">1 to {POS_ID_MAX.toLocaleString('en-US')}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-s-muted">The province is set on the brand (CEO → Brands → Tax registration).</p>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="s-btn-primary" disabled={dirty.length === 0 || badRows.length > 0 || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? 'Saving…' : `Save${dirty.length ? ` (${dirty.length})` : ''}`}
          </button>
          {badRows.length > 0 && <span className="text-xs text-s-red">Fix the POS ID of {badRows.map((r) => r.name).join(', ')} — a POS ID is a whole number from 1 to {POS_ID_MAX.toLocaleString('en-US')}.</span>}
          {m.isSuccess && dirty.length === 0 && <OkLine>Saved.</OkLine>}
          <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
        </div>
      )}
    </Card>
  )
}

type OutletRow = { locationId: string; conceptId: string; authority: Authority; posId: string; storeId: string }

function OutletOverrides({ data, canEdit, activeTenantId }: { data: ConnectorsOverview; canEdit: boolean; activeTenantId: string | null }) {
  const qc = useQueryClient()
  const locations = useCompanyLocations(activeTenantId)
  const fromServer = (o: FiscalOutlet[]): OutletRow[] =>
    o.map((x) => ({ locationId: x.locationId, conceptId: x.conceptId ?? '', authority: x.authority, posId: x.posId, storeId: x.storeId ?? '' }))
  const server = data.fiscal.settings.outlets ?? []
  const serverKey = JSON.stringify(server)
  const [rows, setRows] = useState<OutletRow[]>(() => fromServer(server))
  useEffect(() => { setRows(fromServer(server)) }, [serverKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const outlets: FiscalOutlet[] = useMemo(() => rows.map((r) => ({
    locationId: r.locationId,
    conceptId: r.conceptId || null,
    authority: r.authority,
    posId: r.posId.trim(),
    ...(r.storeId.trim() && { storeId: r.storeId.trim() }),
  })), [rows])
  const dirty = JSON.stringify(outlets) !== JSON.stringify(server.map((o) => ({ locationId: o.locationId, conceptId: o.conceptId ?? null, authority: o.authority, posId: o.posId, ...(o.storeId && { storeId: o.storeId }) })))
  const invalid = rows.some((r) => !r.locationId || !r.posId.trim())

  const m = useMutation({
    mutationFn: () => connectorsApi.save<FiscalSettings>('fiscal', { settings: { outlets } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connectors'] }),
  })
  const set = (i: number, patch: Partial<OutletRow>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  return (
    <Card title="Outlet overrides"
      subtitle="Only where an outlet is registered on its own. An override for one brand at an outlet wins over one for all brands there, which wins over the brand's own POS ID.">
      {rows.length === 0 && <p className="text-xs text-s-muted">No overrides — every outlet files under its brand&rsquo;s POS ID.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="s-table">
            <thead><tr><th>Outlet</th><th>Brand</th><th>Authority</th><th>POS ID</th><th>Store ID</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <select aria-label="Outlet" className="s-select min-w-[150px] text-xs" disabled={!canEdit} value={r.locationId} onChange={(e) => set(i, { locationId: e.target.value })}>
                      <option value="">Pick an outlet…</option>
                      {locations.data.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label="Brand" className="s-select min-w-[130px] text-xs" disabled={!canEdit} value={r.conceptId} onChange={(e) => set(i, { conceptId: e.target.value })}>
                      <option value="">All brands</option>
                      {data.brandPosIds.map((b) => <option key={b.conceptId} value={b.conceptId}>{b.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label="Authority" className="s-select w-[90px] text-xs" disabled={!canEdit} value={r.authority} onChange={(e) => set(i, { authority: e.target.value as Authority })}>
                      {AUTHORITIES.map((a) => <option key={a} value={a}>{authorityLabel(a)}</option>)}
                    </select>
                  </td>
                  <td><input aria-label="POS ID" className="s-input w-[120px] font-mono text-xs" disabled={!canEdit} value={r.posId} maxLength={64} onChange={(e) => set(i, { posId: e.target.value })} /></td>
                  <td><input aria-label="Store ID" className="s-input w-[110px] font-mono text-xs" disabled={!canEdit} value={r.storeId} maxLength={64} onChange={(e) => set(i, { storeId: e.target.value })} placeholder="optional" /></td>
                  <td>{canEdit && <button className="s-btn-ghost px-2 py-1 text-xs" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="s-btn-secondary" onClick={() => setRows([...rows, { locationId: '', conceptId: '', authority: 'srb', posId: '', storeId: '' }])}>Add override</button>
          <button className="s-btn-primary" disabled={!dirty || invalid || m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Saving…' : 'Save overrides'}</button>
          {invalid && <span className="text-xs text-s-muted">Each override needs an outlet and a POS ID.</span>}
          <ErrorLine>{m.error ? connectorErrorText(m.error) : null}</ErrorLine>
        </div>
      )}
    </Card>
  )
}
