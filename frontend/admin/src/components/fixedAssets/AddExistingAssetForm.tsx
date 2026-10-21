'use client'
// "Add existing asset" (owner, 2026-10-21: "give an option to add asset also,
// so we can add previously bought / Transferred from related party assets").
// POST /accounting/fixed-assets/existing raises a request the CEO approves
// (the CEO's own applies at once); nothing is booked before that. The asset
// comes on at today's value and is depreciated over its remaining life.
// Documents go to the request (record-files owner `fixed_asset`) and move to
// the asset when the CEO approves.
//
// Classes, lives, outlets and brands come from GET /accounting/fixed-assets/lookups.

import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { MoneyInput } from '../ui/MoneyInput'
import { NumberField } from '../ui/NumberField'
import { Select } from '@/components/ui/Select'
import { PendingFilesPicker } from '../files/PendingFilesPicker'
import { uploadRecordFiles, type PickedFile } from '../files/recordFiles'
import { FA_BASE, L, Modal, ErrorLine, Notice, inp, btnPrimary, btnGhost, money, todayIso, forCompany, type FaLookups, type FaRequest } from './shared'

type Origin = 'pre_servd' | 'garibsons' | 'servd_company' | 'owners'

/** Each option with where it books, in one plain line. */
const ORIGINS: Array<{ key: Origin; label: string; books: string; group: 'pre' | 'related'; ready: boolean }> = [
  { key: 'pre_servd', group: 'pre', ready: true, label: 'Bought before servd',
    books: 'Already owned by the business. Booked against Owner’s capital (3010).' },
  { key: 'garibsons', group: 'related', ready: true, label: 'Garibsons paid for it',
    books: 'We owe Garibsons for it. Booked to Due to Garibsons (2210), the same account petty-cash top-ups use.' },
  { key: 'servd_company', group: 'related', ready: false, label: 'Another servd company gave it',
    books: 'Not available yet: how the giving company books it out is waiting for the owner’s answer.' },
  { key: 'owners', group: 'related', ready: true, label: 'The owners contributed it',
    books: 'The owners put it into the business. Booked against Owner’s capital (3010).' },
]

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

  const cls = classes.find((c) => c.id === classId) ?? null
  const classLife = cls?.depreciable ? (cls.defaultLifeMonths ?? 12) : 0

  const send = useMutation({
    mutationFn: async () => {
      const related = origin !== 'pre_servd'
      const r = await api.post<{ event: FaRequest; applied: boolean }>(`${FA_BASE}/existing`, {
        source: related ? 'related_party' : 'pre_servd',
        ...(related ? { counterparty: origin } : {}),
        classId,
        name: name.trim(),
        ...(serial.trim() ? { serial: serial.trim() } : {}),
        conceptId: conceptId || null,
        locationId: locationId || null,
        valueCents: value,
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
      const what = `${name.trim()} (${money(value)})`
      const tail = r.filesFailed ? ` The documents did not upload (${r.filesFailed}) — attach them from the Requests tab.` : ''
      if (r.applied) onDone(`${what} is on the register.${tail}`, 'ok')
      else onDone(`${what} is waiting for the CEO. Nothing is booked until the CEO approves it.${tail}`, 'wait')
    },
  })

  const chosen = ORIGINS.find((o) => o.key === origin)!
  const problems: string[] = []
  if (!chosen.ready) problems.push(chosen.books)
  if (!cls) problems.push('Pick the class.')
  if (!name.trim()) problems.push('Say what the asset is.')
  if (!conceptId && !locationId) problems.push('Shared equipment needs its outlet: pick a brand or an outlet.')
  if (value <= 0) problems.push('Enter today’s value.')
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

  const dirty = !send.isPending && (!!name.trim() || value > 0 || !!reason.trim() || files.length > 0)

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
                      checked={on} disabled={!o.ready} onChange={() => setOrigin(o.key)} />
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-white/90">{o.label}</span>
                      <span className="block text-xs text-white/50 mt-0.5">{o.books}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          ))}
        </fieldset>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <L t="Class">
            <Select className={inp} value={classId} onChange={(e) => { setClassId(e.target.value); setLife(null) }}>
              <option value="">Pick a class</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </L>
          <L t="What is it"><input className={inp} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Rational combi oven" /></L>
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
          <L t="Today's value (PKR)" hint="What it is worth now (its book value), not what it first cost.">
            <MoneyInput value={value} onChange={setValue} className={inp} />
          </L>
          <L t="In service from" hint="The day it starts on this company's books. Depreciation starts that month. It cannot be in a closed month.">
            <input type="date" className={inp} value={inService} max={todayIso()} onChange={(e) => setInService(e.target.value)} />
          </L>
          <L t="Remaining life (months)" hint={cls ? (cls.depreciable ? `Defaults to the class life, ${classLife} months.` : 'This class is not depreciated.') : undefined}>
            <NumberField min={1} max={Math.max(1, classLife * 2)} className={inp} value={life} disabled={!cls?.depreciable}
              onValueChange={setLife} placeholder={classLife ? String(classLife) : ''} />
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
