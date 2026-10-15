'use client'
// Fixed assets — the register of what the business owns and its depreciation.
//
// Equipment reaches this register ONLY through CapEx (Project tracker, or
// Buy equipment = Quick buy); there is no Add form. Depreciation is charged
// automatically every night for completed months — there is no switch, only a
// "charge now" that catches up through the last completed month. Disposals,
// write-downs and voids are requests the CEO approves (see an asset's page and
// the Requests tab). Every class, life and permission comes from GET
// /accounting/fixed-assets/lookups.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { canOpenPath } from '../../../lib/moduleCatalog'
import {
  FA_BASE, FaFrame, Stat, Notice, AssetStatusBadge, card, inp, btnPrimary, btnGhost, money, fmtDay, fmtMonth, errorWords, useFaLookups,
  type FaAsset,
} from '../../../components/fixedAssets/shared'
import { Select } from '@/components/ui/Select'

interface CompanyTotals { tenantId: string; companyName: string; assets: number; costCents: number; accumulatedCents: number; nbvCents: number; monthlyCents: number }
interface LastRun {
  tenantId: string; companyName: string; throughPeriod: string; triggeredBy: string
  startedAt: string; finishedAt: string | null; chargedCount: number; chargedCents: number; lateCount: number; failedCount: number; error: string | null
}
interface Register {
  asOf: string
  portfolio: boolean
  assets: FaAsset[]
  totals: CompanyTotals | null
  totalsByCompany: CompanyTotals[]
  lastRuns: LastRun[]
  lastCompletedPeriod: string
  currentPeriod: string
  depreciation: 'automatic'
}
interface ChargeResult { companyName: string; throughPeriod: string; chargedCount: number; chargedCents: number; lateCount: number; failedCount: number }

const STATUS_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'active', label: 'In use' },
  { key: 'disposed', label: 'Disposed' },
  { key: 'voided', label: 'Voided' },
  { key: 'all', label: 'All' },
]

export default function FixedAssetsPage() {
  const qc = useQueryClient()
  const { data: lookups } = useFaLookups()
  const { data: me } = usePermissions()
  const canBuy = !!me && canOpenPath('/finance/capex', me.role, me.modules ?? [])

  const [status, setStatus] = useState('active')
  const [classKey, setClassKey] = useState('')
  const [conceptId, setConceptId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [asOf, setAsOf] = useState('')
  const [owedOnly, setOwedOnly] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'wait' | 'bad'; text: string } | null>(null)

  const qs = useMemo(() => {
    const p = new URLSearchParams()
    p.set('status', status)
    if (classKey) p.set('classKey', classKey)
    if (conceptId) p.set('conceptId', conceptId)
    if (locationId) p.set('locationId', locationId)
    if (asOf) p.set('asOf', asOf)
    if (owedOnly) p.set('uncharged', '1')
    return p.toString()
  }, [status, classKey, conceptId, locationId, asOf, owedOnly])

  const { data, isLoading, error } = useQuery<Register>({
    queryKey: ['fa-register', qs],
    queryFn: () => api.get<Register>(`${FA_BASE}?${qs}`),
  })

  const charge = useMutation({
    mutationFn: (run: { tenantId: string; through: string }) =>
      api.post<ChargeResult>(`${FA_BASE}/depreciate`, { throughPeriod: run.through }, { tenantId: run.tenantId }),
    onSuccess: (r) => {
      const bits = [
        r.chargedCount > 0 ? `Charged ${money(r.chargedCents)} across ${r.chargedCount} asset-month${r.chargedCount === 1 ? '' : 's'}` : 'Nothing was owed',
        r.lateCount > 0 ? `${r.lateCount} posted late into the open month` : '',
        r.failedCount > 0 ? `${r.failedCount} could not be charged (flagged in Exceptions)` : '',
      ].filter(Boolean)
      setNotice({ tone: r.failedCount > 0 ? 'bad' : 'ok', text: `${r.companyName}: ${bits.join('. ')}.` })
      void qc.invalidateQueries({ queryKey: ['fa-register'] })
    },
    onError: (e) => setNotice({ tone: 'bad', text: errorWords(e) }),
  })

  const classOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const c of lookups?.classes ?? []) if (!seen.has(c.key)) seen.set(c.key, c.label)
    return [...seen.entries()]
  }, [lookups])
  const brandOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const b of lookups?.brands ?? []) seen.set(b.id, b.name)
    return [...seen.entries()]
  }, [lookups])
  const outletOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const l of lookups?.locations ?? []) seen.set(l.id, l.name)
    return [...seen.entries()]
  }, [lookups])

  const canWrite = !!lookups?.capabilities.canWrite
  const multi = !!data && data.totalsByCompany.length > 1
  const owedAssets = (data?.assets ?? []).filter((a) => a.status === 'active' && a.unchargedMonths > 0)
  const owedByCompany = (tenantId: string) => owedAssets.filter((a) => a.tenantId === tenantId).length
  const pendingTotal = (data?.assets ?? []).reduce((s, a) => s + a.pendingRequestCount, 0)

  const totals: CompanyTotals | null = data
    ? data.totals ?? (data.totalsByCompany.length > 0 ? {
      tenantId: '', companyName: 'All companies',
      assets: data.totalsByCompany.reduce((s, t) => s + t.assets, 0),
      costCents: data.totalsByCompany.reduce((s, t) => s + t.costCents, 0),
      accumulatedCents: data.totalsByCompany.reduce((s, t) => s + t.accumulatedCents, 0),
      nbvCents: data.totalsByCompany.reduce((s, t) => s + t.nbvCents, 0),
      monthlyCents: data.totalsByCompany.reduce((s, t) => s + t.monthlyCents, 0),
    } : null)
    : null

  return (
    <FaFrame
      title="Register"
      subtitle="Equipment and fit-out the company owns. It comes onto the register through CapEx, and depreciation is charged for you every night."
      actions={
        <>
          {canBuy && <Link href="/finance/capex?quickBuy=1" className={btnPrimary}>Buy equipment</Link>}
          <button className={btnGhost} onClick={() => { void api.download(`${FA_BASE}?${qs}&format=csv`, `fixed-assets-${asOf || data?.asOf || 'today'}.csv`).catch((e) => setNotice({ tone: 'bad', text: errorWords(e) })) }}>
            Download CSV
          </button>
        </>
      }
    >
      {notice && <Notice tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Notice>}

      {pendingTotal > 0 && (
        <Notice tone="wait">
          {pendingTotal} request{pendingTotal === 1 ? ' is' : 's are'} waiting for the CEO.{' '}
          <Link href={`${FA_BASE}/requests`} className="underline font-bold">Open the Requests tab</Link>
        </Notice>
      )}

      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Cost" value={money(totals.costCents)} sub={`${totals.assets} item${totals.assets === 1 ? '' : 's'}${asOf ? ` as of ${fmtDay(asOf)}` : ''}`} />
          <Stat label="Depreciated" value={money(totals.accumulatedCents)} />
          <Stat label="Book value" value={money(totals.nbvCents)} />
          <Stat label="Monthly charge" value={money(totals.monthlyCents)} sub="what the next run charges" />
        </div>
      )}

      {multi && data && (
        <div className="rounded-2xl overflow-x-auto" style={card}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                {['Company', 'Items', 'Cost', 'Depreciated', 'Book value', 'Per month'].map((h, i) => <th key={h} className={`px-4 py-3 font-bold ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.totalsByCompany.map((t) => (
                <tr key={t.tenantId} className="border-t border-white/[0.05]">
                  <td className="px-4 py-3 font-bold text-white/90">{t.companyName}</td>
                  <td className="px-4 py-3 text-right text-white/70">{t.assets}</td>
                  <td className="px-4 py-3 text-right text-white/80 whitespace-nowrap">{money(t.costCents)}</td>
                  <td className="px-4 py-3 text-right text-white/60 whitespace-nowrap">{money(t.accumulatedCents)}</td>
                  <td className="px-4 py-3 text-right font-bold text-white/90 whitespace-nowrap">{money(t.nbvCents)}</td>
                  <td className="px-4 py-3 text-right text-white/60 whitespace-nowrap">{money(t.monthlyCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Last run: depreciation is automatic; "charge now" only catches up through the last completed month. */}
      {data && (
        <section className="rounded-2xl p-4 space-y-3" style={card} aria-label="Depreciation runs">
          <div>
            <p className="text-sm font-black text-white/90">Depreciation is charged automatically</p>
            <p className="text-xs text-white/45 mt-0.5">
              Every night, for each month that has ended. There is no switch. The last completed month is {fmtMonth(data.lastCompletedPeriod)}.
            </p>
          </div>
          {data.totalsByCompany.length === 0 && <p className="text-sm text-white/50">No company in view.</p>}
          {data.totalsByCompany.map((t) => {
            const run = data.lastRuns.find((r) => r.tenantId === t.tenantId)
            const owed = owedByCompany(t.tenantId)
            const failed = !!run && (run.failedCount > 0 || !!run.error)
            return (
              <div key={t.tenantId} className="rounded-xl p-3 flex flex-wrap items-center justify-between gap-3"
                style={{ border: `1px solid ${failed ? 'color-mix(in srgb, var(--erp-danger) 40%, transparent)' : 'rgb(var(--fg-rgb) / 0.07)'}` }}>
                <div className="min-w-0 text-sm">
                  {multi && <p className="font-bold text-white/90">{t.companyName}</p>}
                  {run ? (
                    <p className="text-white/65">
                      Last run {fmtDay(run.startedAt)} ({run.triggeredBy === 'worker' ? 'automatic' : 'charged by hand'}), through {fmtMonth(run.throughPeriod)}:{' '}
                      {money(run.chargedCents)} across {run.chargedCount} asset-month{run.chargedCount === 1 ? '' : 's'}
                      {run.lateCount > 0 ? `, ${run.lateCount} posted late` : ''}
                    </p>
                  ) : (
                    <p className="text-white/50">No run yet. The first one happens tonight.</p>
                  )}
                  {failed && (
                    <p className="text-s-red text-xs mt-1">
                      {run!.failedCount > 0 ? `${run!.failedCount} asset${run!.failedCount === 1 ? '' : 's'} could not be charged. ` : ''}
                      {run!.error ?? 'See Exceptions for the reason.'}
                    </p>
                  )}
                  <p className={`text-xs mt-1 ${owed > 0 ? 'text-s-amber' : 'text-success'}`}>
                    {owed > 0 ? `${owed} asset${owed === 1 ? '' : 's'} with months still to charge` : 'Up to date'}
                  </p>
                </div>
                {canWrite && (
                  <button className={btnPrimary} disabled={charge.isPending}
                    onClick={() => { setNotice(null); charge.mutate({ tenantId: t.tenantId, through: data.lastCompletedPeriod }) }}>
                    {charge.isPending && charge.variables?.tenantId === t.tenantId ? 'Charging…' : `Charge now through ${fmtMonth(data.lastCompletedPeriod)}`}
                  </button>
                )}
              </div>
            )
          })}
        </section>
      )}

      {/* Filters */}
      <div className="rounded-2xl p-4 grid grid-cols-2 md:grid-cols-6 gap-3 items-end" style={card}>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Show</span>
          <Select className={inp} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </Select></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Class</span>
          <Select className={inp} value={classKey} onChange={(e) => setClassKey(e.target.value)}>
            <option value="">All classes</option>
            {classOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Brand</span>
          <Select className={inp} value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
            <option value="">All brands</option>
            {brandOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Outlet</span>
          <Select className={inp} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All outlets</option>
            {outletOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Values as of</span>
          <input type="date" className={inp} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <label className="flex items-center gap-2 text-sm text-white/70 pb-2">
          <input type="checkbox" checked={owedOnly} onChange={(e) => setOwedOnly(e.target.checked)} style={{ accentColor: 'var(--erp-accent)' }} />
          Months still to charge
        </label>
      </div>

      {error && <Notice tone="bad">{errorWords(error)}</Notice>}
      {isLoading && <p className="text-sm text-white/40">Loading the register…</p>}

      {data && data.assets.length === 0 && !isLoading && (
        <div className="rounded-2xl p-10 text-center" style={card}>
          <p className="font-bold text-white/85">Nothing on the register{status !== 'all' ? ' with these filters' : ''}</p>
          <p className="text-sm text-white/45 mt-1 max-w-md mx-auto">
            Equipment is added through CapEx: prepare a delivered item in the Project tracker, or use Buy equipment for a purchase made today.
          </p>
        </div>
      )}

      {data && data.assets.length > 0 && (
        <>
          {/* Phone: one card per asset */}
          <div className="md:hidden space-y-2">
            {data.assets.map((a) => (
              <Link key={a.id} href={`${FA_BASE}/${a.id}`} className="block rounded-2xl p-4" style={{ ...card, opacity: a.status === 'active' ? 1 : 0.7 }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-white/90 break-words">{a.name}</p>
                    <p className="text-[11px] text-white/45">{[a.assetTag, a.classLabel, multi ? a.companyName : null].filter(Boolean).join(' · ')}</p>
                  </div>
                  <AssetStatusBadge status={a.status} />
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                  <div><p className="text-white/40">Cost</p><p className="font-mono text-white/85">{money(a.costCents)}</p></div>
                  <div><p className="text-white/40">Depreciated</p><p className="font-mono text-white/65">{money(a.accumulatedCents)}</p></div>
                  <div><p className="text-white/40">Book value</p><p className="font-mono font-bold text-white/90">{money(a.nbvCents)}</p></div>
                </div>
                <p className="text-[11px] text-white/45 mt-2">
                  {a.conceptName ?? 'Shared'} · {a.locationName
                    ? <>at {a.locationName}</>
                    : <span style={{ color: a.conceptId ? undefined : 'var(--erp-warning)' }}>{a.conceptId ? 'no outlet' : 'location not set'}</span>}
                  {a.unchargedMonths > 0 && <span className="text-s-amber"> · {a.unchargedMonths} month{a.unchargedMonths === 1 ? '' : 's'} to charge</span>}
                  {a.pendingRequestCount > 0 && <span className="text-s-amber"> · request waiting</span>}
                </p>
              </Link>
            ))}
          </div>

          {/* Wider screens: the table */}
          <div className="hidden md:block rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                  {[
                    { h: 'Asset' }, ...(multi ? [{ h: 'Company' }] : []), { h: 'Class' }, { h: 'Brand' }, { h: 'Location' }, { h: 'In service' },
                    { h: 'Cost', r: true }, { h: 'Depreciated', r: true }, { h: 'Book value', r: true }, { h: 'Per month', r: true },
                    { h: 'Charged to' }, { h: 'Status' },
                  ].map((c) => (
                    <th key={c.h} className={`px-4 py-3 font-bold whitespace-nowrap ${c.r ? 'text-right' : ''}`}>{c.h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.assets.map((a) => (
                  <tr key={a.id} className="border-t border-white/[0.05]" style={{ opacity: a.status === 'active' ? 1 : 0.6 }}>
                    <td className="px-4 py-3">
                      <Link href={`${FA_BASE}/${a.id}`} className="font-bold text-primary-ink hover:underline">{a.name}</Link>
                      <p className="text-[11px] text-white/40">{[a.assetTag, a.kind === 'pool_layer' ? `${a.quantity} units, smallwares` : null].filter(Boolean).join(' · ') || '—'}</p>
                    </td>
                    {multi && <td className="px-4 py-3 text-white/60">{a.companyName}</td>}
                    <td className="px-4 py-3 text-white/60">{a.classLabel}</td>
                    <td className="px-4 py-3 text-white/60">{a.conceptName ?? 'Shared'}</td>
                    <td className="px-4 py-3 text-white/60">
                      {a.locationName ?? (a.conceptId ? '—' : <span style={{ color: 'var(--erp-warning)' }} title="Shared equipment needs its location: move it to its outlet">Not set</span>)}
                    </td>
                    <td className="px-4 py-3 text-white/60 whitespace-nowrap">{fmtDay(a.inServiceAt)}</td>
                    <td className="px-4 py-3 text-right text-white/80 whitespace-nowrap">{money(a.costCents)}</td>
                    <td className="px-4 py-3 text-right text-white/60 whitespace-nowrap">{money(a.accumulatedCents)}</td>
                    <td className="px-4 py-3 text-right font-bold text-white/90 whitespace-nowrap">{money(a.nbvCents)}</td>
                    <td className="px-4 py-3 text-right text-white/60 whitespace-nowrap">{a.status === 'active' ? money(a.nextChargeCents) : '—'}</td>
                    <td className="px-4 py-3 text-white/60 whitespace-nowrap">
                      {a.lastChargedPeriod ? fmtMonth(a.lastChargedPeriod) : 'not yet'}
                      {a.unchargedMonths > 0 && <span className="text-s-amber text-[11px]"> · {a.unchargedMonths} owed</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <AssetStatusBadge status={a.status} />
                      {a.pendingRequestCount > 0 && <span className="s-badge-amber ml-1">Request waiting</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </FaFrame>
  )
}
