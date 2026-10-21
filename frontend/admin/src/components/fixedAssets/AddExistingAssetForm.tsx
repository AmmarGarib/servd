'use client'
// "Add existing asset" (owner, 2026-10-21: "give an option to add asset also,
// so we can add previously bought / Transferred from related party assets").
// POST /accounting/fixed-assets/existing raises a request the CEO approves
// (the CEO's own applies at once); nothing is booked before that. The asset
// comes on at today's value and is depreciated over its remaining life.
// Documents go to the request (record-files owner `fixed_asset`) and move to
// the asset when the CEO approves.
//
// Another servd company (owner, 2026-10-21: "Book value, no gain or loss"):
// finance picks the GIVING company's asset (GET /existing/giver-assets); its
// book value on the transfer date is the value (read-only), its remaining
// months the default life, its salvage carries over.
//
// Classes, lives, outlets and brands come from GET /accounting/fixed-assets/lookups.

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { MoneyInput } from '../ui/MoneyInput'
import { NumberField } from '../ui/NumberField'
import { Select } from '@/components/ui/Select'
import { PendingFilesPicker } from '../files/PendingFilesPicker'
import { uploadRecordFiles, type PickedFile } from '../files/recordFiles'
import { FA_BASE, L, Modal, ErrorLine, Notice, errorWords, inp, btnPrimary, btnGhost, money, todayIso, forCompany, type FaLookups, type FaRequest } from './shared'

type Origin = 'pre_servd' | 'garibsons' | 'servd_company' | 'owners'

/** Each option with where it books, in one plain line. */
const ORIGINS: Array<{ key: Origin; label: string; books: string; group: 'pre' | 'related'; ready: boolean }> = [
  { key: 'pre_servd', group: 'pre', ready: true, label: 'Bought before servd',
    books: 'Already owned by the business. Booked against Owner’s capital (3010).' },
  { key: 'garibsons', group: 'related', ready: true, label: 'Garibsons paid for it',
    books: 'We owe Garibsons for it. Booked to Due to Garibsons (2210), the same account petty-cash top-ups use.' },
  { key: 'servd_company', group: 'related', ready: true, label: 'Another servd company gave it',
    books: 'It moves off that company\u2019s register at its book value, with no gain or loss. This company then owes that company the book value (shown under Inter-company).' },
  { key: 'owners', group: 'related', ready: true, label: 'The owners contributed it',
    books: 'The owners put it into the business. Booked against Owner’s capital (3010).' },
]

interface GiverAsset {
  assetId: string; assetTag: string | null; name: string; serialNumber: string | null; classKey: string
  costCents: number; accumulatedCents: number; nbvCents: number; salvageCents: number; remainingLifeMonths: number
}

export function AddExistingAssetForm({ lookups, onClose, onDone }: {
  lookups: FaLookups
  onClose: () => void
  onDone: (text: string, tone: 'ok' | 'wait') => void
}) {
  const companies = lookups.companies
  const [tenantId, setTenantId] = useState(lookups.activeTenantId ?? companies[0]?.id ?? '')
  const classes = useMemo(() => forCompany(lookups.classes, tenantId).filter((c) => c.isActive && !c.pooled), [lookups, tenantId])
  const brands = forCompany(lookups.brands, tenantId)
  const outlets = forCompany(lookups.locations, tenantId)

  const [origin, setOrigin] = useState<Origin>('pre_servd')
  const [classId, setClassId] = useState('')
  const [name, setName] = useState('')
  const [serial, setSerial] = useState('')
  const [conceptId, setConceptId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [value, setValue] = useState(0)
  const [inService, setInService] = useState(todayIso())
  const [life, setLife] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [files, setFiles] = useState<PickedFile[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const related = (lookups.relatedCompanies ?? []).filter((c) => c.id !== tenantId)
  const [giverTenantId, setGiverTenantId] = useState('')
  const [giverAssetId, setGiverAssetId] = useState('')
  const fromCompany = origin === 'servd_company'

  // The giving company's in-use assets with their book value on the transfer date.
  const givers = useQuery<{ assets: GiverAsset[] }>({
    queryKey: ['fa-giver-assets', tenantId, giverTenantId, inService],
    queryFn: () => api.get<{ assets: GiverAsset[] }>(`${FA_BASE}/existing/giver-assets?giverTenantId=${encodeURIComponent(giverTenantId)}&date=${inService}`),
    enabled: fromCompany && !!giverTenantId && !!inService,
  })
  const giverError = givers.error ? errorWords(givers.error) : null
  const giver = (givers.data?.assets ?? []).find((a) => a.assetId === giverAssetId) ?? null

  const cls = fromCompany
    ? (giver ? classes.find((c) => c.key === giver.classKey) ?? null : null)
    : classes.find((c) => c.id === classId) ?? null
  const classLife = cls?.depreciable ? (cls.defaultLifeMonths ?? 12) : 0

  const send = useMutation({
    mutationFn: async () => {
      const related = origin !== 'pre_servd'
      const r = await api.post<{ event: FaRequest; applied: boolean }>(`${FA_BASE}/existing`, {
        source: related ? 'related_party' : 'pre_servd',
        ...(related ? { counterparty: origin } : {}),
        ...(fromCompany
          ? { counterpartyTenantId: giverTenantId, giverAssetId, ...(name.trim() ? { name: name.trim() } : {}) }
          : { classId, name: name.trim(), valueCents: value }),
        ...(serial.trim() ? { serial: serial.trim() } : {}),
        conceptId: conceptId || null,
        locationId: locationId || null,
        inServiceDate: inService,
        ...(cls?.depreciable && life ? { remainingLifeMonths: life } : {}),
        reason: reason.trim(),
      }, { tenantId })
      // Documents: on the request while it waits, on the asset once applied (the CEO's own).
      const owner = r.applied ? r.event.assetId : r.event.id
      let filesFailed: string | null = null
      if (files.length && owner) {
        try { await uploadRecordFiles('fixed_asset', owner, files, { tenantId }) } catch (e) { filesFailed = (e as Error).message }
      }
      return { ...r, filesFailed }
    },
    onSuccess: (r) => {
      const what = `${name.trim() || giver?.name || 'The asset'} (${money(fromCompany ? giver?.nbvCents ?? 0 : value)})`
      const tail = r.filesFailed ? ` The documents did not upload (${r.filesFailed}) — attach them from the Requests tab.` : ''
      if (r.applied) onDone(`${what} is on the register.${tail}`, 'ok')
      else onDone(`${what} is waiting for the CEO. Nothing is booked until the CEO approves it.${tail}`, 'wait')
    },
  })

  const chosen = ORIGINS.find((o) => o.key === origin)!
  const problems: string[] = []
  if (!chosen.ready) problems.push(chosen.books)
  if (fromCompany) {
    if (!giverTenantId) problems.push('Pick the company it came from.')
    else if (!giver) problems.push('Pick the asset from that company\u2019s register.')
    else if (!cls) problems.push('This company has that asset class switched off.')
  } else {
    if (!cls) problems.push('Pick the class.')
    if (!name.trim()) problems.push('Say what the asset is.')
    if (value <= 0) problems.push('Enter today\u2019s value.')
  }
  if (!conceptId && !locationId) problems.push('Shared equipment needs its outlet: pick a brand or an outlet.')
  if (!inService || inService > todayIso()) problems.push('Pick the in-service date (not in the future).')
  if (cls?.depreciable && life !== null && (life < 1 || life > classLife * 2)) problems.push(`Remaining life must be 1 to ${classLife * 2} months.`)
  if (reason.trim().length < 10) problems.push('Give a reason (at least 10 characters).')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (send.isPending) return
    if (problems[0]) { setProblem(problems[0]); return }
    setProblem(null)
    send.mutate()
  }

  const dirty = !send.isPending && (!!name.trim() || value > 0 || !!reason.trim() || files.length > 0 || !!giverAssetId)
  const lifeDefault = fromCompany ? (giver?.remainingLifeMonths ?? null) : (classLife || null)

  return (
    <Modal title="Add existing asset" onClose={onClose} wide dirty={dirty}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-xs text-white/55">
          For equipment the business already has that did not come through CapEx. It goes on the register at today&rsquo;s value
          and is depreciated over the life it has left. The CEO approves it first; nothing is booked until then.
        </p>

        {companies.length > 1 && (
          <L t="Company">
            <Select className={inp} value={tenantId} onChange={(e) => { setTenantId(e.target.value); setClassId(''); setConceptId(''); setLocationId('') }}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </L>
        )}

        <fieldset className="space-y-2">
          <legend className="text-[11px] font-bold text-white/50 mb-1">Where did it come from?</legend>
          {(['pre', 'related'] as const).map((g) => (
            <div key={g} className="space-y-2">
              {g === 'related' && <p className="text-xs font-bold text-white/70 pt-1">From a related party</p>}
              {ORIGINS.filter((o) => o.group === g).map((o) => {
                const on = origin === o.key
                return (
                  <label key={o.key} className={`flex items-start gap-3 rounded-xl p-3 cursor-pointer ${g === 'related' ? 'sm:ml-4' : ''}`}
                    style={{
                      border: `1px solid ${on ? 'var(--erp-primary)' : 'rgb(var(--fg-rgb) / 0.1)'}`,
                      background: on ? 'rgb(var(--erp-primary-rgb) / 0.06)' : 'transparent',
                      opacity: o.ready ? 1 : 0.6,
                    }}>
                    <input type="radio" name="origin" className="mt-1" style={{ accentColor: 'var(--erp-accent)' }}
                      checked={on} disabled={!o.ready || (o.key === 'servd_company' && related.length === 0)} onChange={() => { setOrigin(o.key); setLife(null) }} />
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-white/90">{o.label}</span>
                      <span className="block text-xs text-white/50 mt-0.5">
                        {o.key === 'servd_company' && related.length === 0 ? 'You belong to no other servd company.' : o.books}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          ))}
        </fieldset>

        {fromCompany && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <L t="Company it came from">
              <Select className={inp} value={giverTenantId} onChange={(e) => { setGiverTenantId(e.target.value); setGiverAssetId(''); setLife(null) }}>
                <option value="">Pick a company</option>
                {related.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </L>
            <L t="Asset on its register" hint={giverTenantId && givers.data && givers.data.assets.length === 0
              ? 'Nothing in use there. Add it to that company\u2019s register first (Add existing asset), then transfer it.' : undefined}>
              <Select className={inp} value={giverAssetId} disabled={!giverTenantId || givers.isLoading}
                onChange={(e) => { setGiverAssetId(e.target.value); setLife(null) }}>
                <option value="">{givers.isLoading ? 'Loading…' : 'Pick the asset'}</option>
                {(givers.data?.assets ?? []).map((a) => (
                  <option key={a.assetId} value={a.assetId}>{a.assetTag ? `${a.assetTag} ` : ''}{a.name} — book value {money(a.nbvCents)}</option>
                ))}
              </Select>
            </L>
            {giverError && <p className="sm:col-span-2 text-xs text-s-red" role="alert">{giverError}</p>}
            {giver && (
              <div className="sm:col-span-2 rounded-xl p-3 text-sm" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
                <p className="text-white/85">
                  Book value on {inService}: <span className="font-black">{money(giver.nbvCents)}</span>
                  <span className="text-white/50"> (cost {money(giver.costCents)} less depreciation {money(giver.accumulatedCents)})</span>
                </p>
                <p className="text-xs text-white/50 mt-1">
                  This is the value; it is not typed. Depreciation up to the month before is charged at that company first, so the figure on approval may differ slightly if a month closes meanwhile.
                  {giver.salvageCents > 0 ? ` Salvage ${money(giver.salvageCents)} carries over.` : ''}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {!fromCompany && (
            <L t="Class">
              <Select className={inp} value={classId} onChange={(e) => { setClassId(e.target.value); setLife(null) }}>
                <option value="">Pick a class</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select>
            </L>
          )}
          <L t={fromCompany ? 'Name here (optional)' : 'What is it'}>
            <input className={inp} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={fromCompany ? (giver?.name ?? 'Same as at the giving company') : 'Rational combi oven'} />
          </L>
          <L t="Serial number (optional)"><input className={inp} value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={120} /></L>
          <L t="Brand">
            <Select className={inp} value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
              <option value="">Shared across brands</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </L>
          <L t="Outlet" hint={conceptId ? undefined : 'Shared equipment needs its outlet.'}>
            <Select className={inp} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">{conceptId ? 'No outlet' : 'Pick an outlet'}</option>
              {outlets.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </L>
          {!fromCompany && (
            <L t="Today's value (PKR)" hint="What it is worth now (its book value), not what it first cost.">
              <MoneyInput value={value} onChange={setValue} className={inp} />
            </L>
          )}
          <L t={fromCompany ? 'Transfer date' : 'In service from'} hint={fromCompany
            ? 'The day it moves. Both companies\u2019 books must be open that month.'
            : 'The day it starts on this company\u2019s books. Depreciation starts that month. It cannot be in a closed month.'}>
            <input type="date" className={inp} value={inService} max={todayIso()} onChange={(e) => setInService(e.target.value)} />
          </L>
          <L t="Remaining life (months)" hint={cls ? (cls.depreciable
            ? (fromCompany ? `Defaults to the months it has left at the giving company${lifeDefault ? `, ${lifeDefault}` : ''}.` : `Defaults to the class life, ${classLife} months.`)
            : 'This class is not depreciated.') : undefined}>
            <NumberField min={1} max={Math.max(1, classLife * 2)} className={inp} value={life} disabled={!cls?.depreciable}
              onValueChange={setLife} placeholder={lifeDefault ? String(lifeDefault) : ''} />
          </L>
        </div>

        <L t="Reason">
          <textarea className={inp} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000}
            placeholder="Oven bought in 2024 before servd went live; valued by the supplier at today's price" />
        </L>

        <PendingFilesPicker ownerType="fixed_asset" value={files} onChange={setFiles}
          label="Purchase or transfer documents" hint="The invoice, a valuation or the transfer letter. They stay with the asset." />

        {problem && <Notice tone="bad">{problem}</Notice>}
        <ErrorLine error={send.error} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btnPrimary} disabled={send.isPending}>{send.isPending ? 'Sending…' : 'Send to the CEO'}</button>
          <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
