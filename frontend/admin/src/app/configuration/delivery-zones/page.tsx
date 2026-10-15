'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, deleteWithUndo } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { NumberField } from '@/components/ui/NumberField'
import { FormField } from '@/components/ui/FormField'
import { useConfirm } from '@/components/ui/ConfirmDialog'

// The zone fee is the price BEFORE sales tax: checkout adds GST on top at the
// order's tender rate (backend lib/pricing.ts) — the page never works it out.
const GST_HELP = 'GST is added at checkout at the brand\'s rate: 15 % cash, 8 % card or Raast.'

function rupeesOf(cents: number): number { return cents / 100 }
function paisaOf(rupees: number | null): number {
  return rupees != null && Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : 0
}

interface Zone {
  id: string
  conceptId: string | null
  name: string
  radiusKmMin: number | null
  radiusKmMax: number | null
  feeCents: number
  freeAboveCents: number | null
  minOrderCents: number
  estimatedMinutes: number | null
  isActive: boolean
}
interface Concept { id: string; name: string }

export default function DeliveryZonesPage() {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [editing, setEditing] = useState<Zone | null>(null)
  const [adding, setAdding] = useState(false)

  const { data: zones = [], isLoading, isError, error, refetch } = useQuery<Zone[]>({ queryKey: ['delivery-zones'], queryFn: () => api.get('/setup/delivery-zones') })
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })

  const del = useMutation({
    mutationFn: (id: string) => deleteWithUndo(`/setup/delivery-zones/${id}`, { trashType: 'delivery_zone', id, onRestored: () => void qc.invalidateQueries({ queryKey: ['delivery-zones'] }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-zones'] }),
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex flex-wrap items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">Delivery zones</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Radius-based delivery rings, measured from the brand's kitchen (its Location's map pin). Each zone has its own
              fee, minimum order, and free-delivery threshold. These bands are the only thing that decides delivery: an
              address beyond a brand's last zone is refused at checkout, and a brand with no active zone takes pickup only.
            </p>
            <p className="text-xs text-white/45 mt-2 max-w-2xl">{GST_HELP}</p>
          </div>
          <button type="button" onClick={() => setAdding(true)} className="shrink-0 rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New zone</button>
        </div>
      </header>

      <div className="px-4 sm:px-7 py-6 max-w-4xl mx-auto space-y-2">
        {isError && (
          <div role="alert" className="rounded-2xl p-8 text-center" style={{ border: '1px solid var(--erp-danger)' }}>
            <p className="font-bold text-white/85">Could not load delivery zones</p>
            <p className="text-sm text-white/45 mt-1">{(error as Error).message}</p>
            <button type="button" onClick={() => void refetch()} className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">Retry</button>
          </div>
        )}
        {!isLoading && !isError && zones.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">No delivery zones yet</p>
            <p className="text-sm text-white/45 mt-1">Add your first zone to start charging delivery fees correctly.</p>
          </div>
        )}
        {zones.map((z) => {
          const concept = concepts.find((c) => c.id === z.conceptId)
          return (
            <div key={z.id} className="rounded-2xl p-5"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-black text-white/90">{z.name}</h3>
                    {!z.isActive && <span className="text-[10px] font-bold text-white/30 px-1.5 py-0.5 rounded bg-white/5">PAUSED</span>}
                    {concept && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)' }}>{concept.name}</span>}
                  </div>
                  <div className="text-sm text-white/55 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    <span>{z.radiusKmMin ?? 0}–{z.radiusKmMax ?? 'any'} km</span>
                    <span>Fee {fmtPkrWhole(z.feeCents)} before GST</span>
                    <span>Min order {fmtPkrWhole(z.minOrderCents)}</span>
                    {z.freeAboveCents != null && <span>Free above {fmtPkrWhole(z.freeAboveCents)}</span>}
                    {z.estimatedMinutes != null && <span>About {z.estimatedMinutes} min</span>}
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button type="button" onClick={() => setEditing(z)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                  <button type="button" onClick={async () => { if (await confirm({ title: `Delete zone "${z.name}"?`, confirmLabel: 'Delete', danger: true })) del.mutate(z.id) }}
                    className="rounded-lg border border-red-500/20 text-red-700/70 px-3 py-1.5 text-xs hover:text-red-700">Delete</button>
                </div>
              </div>
              {del.isError && del.variables === z.id && <p className="text-xs text-red-700 mt-2">{(del.error as Error).message}</p>}
            </div>
          )
        })}
      </div>

      {(adding || editing) && (
        <ZoneModal zone={editing} concepts={concepts} onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['delivery-zones'] }) }} />
      )}
    </div>
  )
}

function ZoneModal({ zone, concepts, onClose, onSaved }: { zone: Zone | null; concepts: Concept[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(zone?.name ?? '')
  const [conceptId, setConceptId] = useState(zone?.conceptId ?? '')
  // Numbers stay empty-able while typing (null = empty); they are checked on save.
  const [radiusKmMin, setRadiusKmMin] = useState<number | null>(zone?.radiusKmMin ?? 0)
  const [radiusKmMax, setRadiusKmMax] = useState<number | null>(zone ? zone.radiusKmMax : 5)
  // Money is typed in rupees and sent in paisa.
  const [feeRs, setFeeRs] = useState<number | null>(rupeesOf(zone?.feeCents ?? 0))
  const [freeAboveRs, setFreeAboveRs] = useState<number | null>(zone?.freeAboveCents ? rupeesOf(zone.freeAboveCents) : null)
  const [minOrderRs, setMinOrderRs] = useState<number | null>(rupeesOf(zone?.minOrderCents ?? 0))
  const [estimatedMinutes, setEstimatedMinutes] = useState<number | null>(zone ? zone.estimatedMinutes : 30)
  const [isActive, setIsActive] = useState(zone?.isActive ?? true)
  const [touched, setTouched] = useState(false)

  const from = radiusKmMin ?? 0
  const rangeError = radiusKmMax == null
    ? 'Enter where this zone ends (km).'
    : from >= radiusKmMax ? 'From must be less than To.' : undefined
  const minutesError = estimatedMinutes != null && estimatedMinutes < 1 ? 'Minutes must be at least 1.' : undefined

  const dirty = name !== (zone?.name ?? '') || conceptId !== (zone?.conceptId ?? '') || from !== (zone?.radiusKmMin ?? 0)
    || radiusKmMax !== (zone ? zone.radiusKmMax : 5) || paisaOf(feeRs) !== (zone?.feeCents ?? 0)
    || paisaOf(freeAboveRs) !== (zone?.freeAboveCents ?? 0) || paisaOf(minOrderRs) !== (zone?.minOrderCents ?? 0)
    || estimatedMinutes !== (zone ? zone.estimatedMinutes : 30) || isActive !== (zone?.isActive ?? true)

  const save = useMutation({
    mutationFn: () => {
      const freeAboveCents = paisaOf(freeAboveRs)
      const payload = {
        name: name.trim(),
        conceptId: conceptId || null,
        radiusKmMin: from,
        radiusKmMax,
        feeCents: paisaOf(feeRs),
        freeAboveCents: freeAboveCents > 0 ? freeAboveCents : null,
        minOrderCents: paisaOf(minOrderRs),
        estimatedMinutes,
        isActive,
      }
      if (zone) return api.patch(`/setup/delivery-zones/${zone.id}`, payload)
      return api.post('/setup/delivery-zones', payload)
    },
    onSuccess: () => onSaved(),
  })

  function submit() {
    setTouched(true)
    if (!name.trim() || rangeError || minutesError || save.isPending) return
    save.mutate()
  }

  return (
    <Modal title={zone ? 'Edit zone' : 'New delivery zone'} onClose={onClose} wide dirty={dirty}
      footer={
        <div className="flex justify-between gap-3">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button type="submit" form="zone-form" disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : zone ? 'Save changes' : 'Create zone'}
          </button>
        </div>
      }>
      <form id="zone-form" className="space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
        <FormField label="Zone name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} name="zone-name" autoComplete="off" placeholder="DHA Phase 5" className={fieldCls} autoFocus />
        </FormField>
        <FormField label="Concept">
          <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
            <option value="">All brands</option>
            {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="From (km)" error={touched ? rangeError : undefined}>
            <NumberField decimals={1} min={0} value={radiusKmMin} onValueChange={setRadiusKmMin} className={fieldCls} />
          </FormField>
          <FormField label="To (km)">
            <NumberField decimals={1} min={0} value={radiusKmMax} onValueChange={setRadiusKmMax} className={fieldCls} />
          </FormField>
        </div>
        {!touched && rangeError && radiusKmMax != null && (
          <p role="alert" className="text-[11px] -mt-2" style={{ color: 'var(--erp-danger)' }}>{rangeError}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Fee (before GST), PKR">
            <NumberField decimals={2} min={0} value={feeRs} onValueChange={setFeeRs} className={fieldCls} />
          </FormField>
          <FormField label="Min order, PKR">
            <NumberField decimals={2} min={0} value={minOrderRs} onValueChange={setMinOrderRs} className={fieldCls} />
          </FormField>
        </div>
        <p className="text-[11px] text-white/45 -mt-2">{GST_HELP}</p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Free above, PKR">
            <NumberField decimals={2} min={0} value={freeAboveRs} onValueChange={setFreeAboveRs} placeholder="Empty = always charge" className={fieldCls} />
          </FormField>
          <FormField label="Est. minutes" error={touched ? minutesError : undefined}>
            <NumberField min={1} value={estimatedMinutes} onValueChange={setEstimatedMinutes} className={fieldCls} />
          </FormField>
        </div>
        {zone && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-accent" />
            <span className="text-xs text-white/65">Active</span>
          </label>
        )}
        {save.isError && <p role="alert" className="text-xs text-red-700">{(save.error as Error).message}</p>}
      </form>
    </Modal>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
