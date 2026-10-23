'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError, deleteWithUndo } from '../../../lib/api'
import { MapPin } from '../../../components/ui/MapPin'
import { useViewAllTenants } from '../../../components/ui/TenantSwitcher'
import { Modal } from '../../../components/ui/Modal'
import { FormField } from '../../../components/ui/FormField'
import { useConfirm } from '../../../components/ui/ConfirmDialog'
import { useAuthStore } from '../../../store/auth'
import { NavIcon } from '../../../components/ui/NavIcon'

interface TenantLite { id: string; name: string; slug: string }
interface ConceptLite { id: string; name: string; slug: string; tenantId?: string | null; tenant?: TenantLite | null }
interface ConceptLink { conceptId: string; isPrimary: boolean; concept: ConceptLite }

interface Location {
  id: string
  slug: string
  name: string
  address: string | null
  city: string | null
  phone: string | null
  latitude: number | null
  longitude: number | null
  /** Time-clock radius (metres); null = the company's. */
  geofenceRadiusMetres?: number | null
  /** The pin + radius the CEO approved (the time clock measures from these). */
  fenceLatitude?: number | null
  fenceLongitude?: number | null
  fenceRadiusMetres?: number | null
  fencePinApprovedAt?: string | null
  fencePinRejected?: { lat: number; lng: number; radius: number | null; note?: string } | null
  isActive: boolean
  tenantId: string | null
  tenant?: TenantLite | null
  concepts: ConceptLink[]
  _count: { orders: number; shifts: number }
}

/** The time-clock pin's state (owner, 2026-10-22: each pin and radius is approved by the CEO). Same rule as the
 *  server's fencePinPending. */
function pinState(l: Location): 'none' | 'approved' | 'pending' | 'rejected' {
  if (l.latitude == null || l.longitude == null) return 'none'
  const r = l.geofenceRadiusMetres ?? null
  if (l.fenceLatitude === l.latitude && l.fenceLongitude === l.longitude && (l.fenceRadiusMetres ?? null) === r) return 'approved'
  const x = l.fencePinRejected
  if (x && x.lat === l.latitude && x.lng === l.longitude && (x.radius ?? null) === r) return 'rejected'
  return 'pending'
}

function PinLine({ loc, isCeo, onDone }: { loc: Location; isCeo: boolean; onDone: () => void }) {
  const state = pinState(loc)
  const approve = useMutation({
    mutationFn: () => api.post(`/locations/${loc.id}/fence-pin/approve`, { latitude: loc.latitude, longitude: loc.longitude, radiusMetres: loc.geofenceRadiusMetres ?? null }),
    onSuccess: onDone,
  })
  const radius = loc.geofenceRadiusMetres != null ? `${loc.geofenceRadiusMetres} m` : 'company radius'
  const text = state === 'none' ? 'Time clock: no map pin yet'
    : state === 'approved' ? `Time clock: pin approved by the CEO (${radius})`
    : state === 'rejected' ? `Time clock: the CEO rejected this pin${loc.fencePinRejected?.note ? ` — ${loc.fencePinRejected.note}` : ''}${loc.fenceLatitude != null ? '. The earlier approved pin is still used.' : ''}`
    : `Time clock: pin waiting for the CEO's approval (${radius})${loc.fenceLatitude != null ? '. The earlier approved pin is used until then.' : '. Clock-ins here go to the manager until it is approved.'}`
  const color = state === 'approved' ? 'var(--erp-success)' : state === 'none' ? undefined : 'var(--erp-warning)'
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <p className="text-xs" style={color ? { color } : undefined}>{text}</p>
      {isCeo && state === 'pending' && (
        <button type="button" disabled={approve.isPending} onClick={() => approve.mutate()}
          className="rounded-lg px-3 py-1 text-xs font-bold" style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>
          {approve.isPending ? 'Approving…' : 'Approve pin'}
        </button>
      )}
      {approve.isError && <p role="alert" className="text-xs text-red-700">{errorText(approve.error)}</p>}
    </div>
  )
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

export default function LocationsPage() {
  const qc = useQueryClient()
  const inPortfolio = useViewAllTenants()
  const [editing, setEditing] = useState<Location | null>(null)
  const [adding, setAdding] = useState(false)
  const confirm = useConfirm()
  const isCeo = useAuthStore((s) => s.isRole('admin'))

  // Both reads are company-scoped server-side: single-company view returns
  // only that company's locations and brands; "All companies" returns every
  // company the operator belongs to, with `tenant` attached for labelling.
  const { data: locations = [], isLoading, isError, error, refetch, isFetching } = useQuery<Location[]>({
    queryKey: ['locations'],
    queryFn: () => api.get('/locations'),
  })
  const { data: concepts = [] } = useQuery<ConceptLite[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  const remove = useMutation({
    mutationFn: (loc: Location) => deleteWithUndo(`/locations/${loc.id}`, { trashType: 'location', id: loc.id, onRestored: () => void qc.invalidateQueries({ queryKey: ['locations'] }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['locations'] })
    },
  })

  async function askDelete(loc: Location) {
    const busy = loc._count.orders > 0 || loc._count.shifts > 0
    const r = await confirm({
      title: `Delete “${loc.name}”?`,
      body: (
        <>
          <p>The location is removed from every picker, filter, and brand link. Past orders and shifts recorded against it are kept for reporting.</p>
          {busy && (
            <p className="text-xs text-white/40 mt-2">
              {loc._count.orders.toLocaleString()} orders · {loc._count.shifts} shifts stay on the books.
            </p>
          )}
        </>
      ),
      confirmLabel: 'Delete location', danger: true,
    })
    if (r) remove.mutate(loc)
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-white/90">Locations</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Physical places where you operate. A single location can host multiple brands (multi-concept kitchens, food-court units).
              A location's address and map pin are what customers see for every brand it runs (storefront, Maps links, JSON-LD),
              the origin delivery is measured from, and the clock-in anchor — edit them here, not on the brand. A brand's
              phone and WhatsApp stay on the brand (CEO → Brands). Accounting + reports filter by location independently of brand.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90"
          >
            + Add location
          </button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-3">
        {isLoading && <p className="text-sm text-white/40" role="status">Loading…</p>}

        {isError && (
          <div role="alert" className="rounded-2xl p-8 text-center"
            style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid var(--erp-danger)' }}>
            <p className="font-bold text-white/85">Could not load locations</p>
            <p className="text-sm text-white/45 mt-1 max-w-sm mx-auto">{errorText(error)}</p>
            <button type="button" onClick={() => void refetch()} disabled={isFetching}
              className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
              {isFetching ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}

        {remove.isError && (
          <p role="alert" className="text-xs text-red-700">{errorText(remove.error)}</p>
        )}

        {!isLoading && !isError && locations.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <span className="mb-3 inline-block text-s-muted"><NavIcon name="pin" size={32} /></span>
            <p className="font-bold text-white/85">No locations yet</p>
            <p className="text-sm text-white/45 mt-1 max-w-sm mx-auto">
              Add your first physical location. If you have a multi-concept kitchen, add the location and link multiple brands to it.
            </p>
          </div>
        )}

        {locations.map((loc) => (
          <div
            key={loc.id}
            className="rounded-2xl p-5"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-black text-white/90">{loc.name}</h3>
                  {!loc.isActive && (
                    <span className="text-[10px] font-bold text-white/30 px-1.5 py-0.5 rounded bg-white/5">PAUSED</span>
                  )}
                  {inPortfolio && loc.tenant && (
                    <span className="text-[10px] font-bold text-white/45 px-1.5 py-0.5 rounded bg-white/5 border border-white/10">
                      {loc.tenant.name}
                    </span>
                  )}
                </div>
                <p className="text-xs text-white/35 font-mono mt-0.5">{loc.slug}</p>
                {loc.address && (
                  <p className="text-sm text-white/55 mt-1">{loc.address}{loc.city ? `, ${loc.city}` : ''}</p>
                )}
                <p className="text-xs text-white/35 mt-2">
                  {loc._count.orders.toLocaleString()} orders · {loc._count.shifts} shifts
                </p>
                <PinLine loc={loc} isCeo={isCeo} onDone={() => void qc.invalidateQueries({ queryKey: ['locations'] })} />
                {loc.concepts.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {loc.concepts.map((cl) => (
                      <span key={cl.conceptId}
                        className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.18)' }}>
                        {cl.concept.name}{cl.isPrimary ? <NavIcon name="star" size={11} className="ml-1 inline fill-current" /> : null}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-white/30 mt-3">No brands linked — edit to tick the brands that run here.</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(loc)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void askDelete(loc)}
                  className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs text-red-700/70 hover:text-red-700 hover:border-red-500/40"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {(adding || editing) && (
        <LocationModal
          location={editing}
          concepts={concepts}
          inPortfolio={inPortfolio}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => {
            setAdding(false); setEditing(null)
            void qc.invalidateQueries({ queryKey: ['locations'] })
          }}
        />
      )}

    </div>
  )
}

function LocationModal({ location, concepts, inPortfolio, onClose, onSaved }: {
  location: Location | null
  concepts: ConceptLite[]
  inPortfolio: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(location?.name ?? '')
  const [address, setAddress] = useState(location?.address ?? '')
  const [city, setCity] = useState(location?.city ?? '')
  const [phone, setPhone] = useState(location?.phone ?? '')
  const [coords, setCoords] = useState<{ lat: number | null; lng: number | null }>({
    lat: location?.latitude ?? null, lng: location?.longitude ?? null,
  })
  const [isActive, setIsActive] = useState(location?.isActive ?? true)
  const [radius, setRadius] = useState(location?.geofenceRadiusMetres != null ? String(location.geofenceRadiusMetres) : '')
  const [conceptIds, setConceptIds] = useState<string[]>(
    location?.concepts.map((c) => c.conceptId) ?? [],
  )

  // A location only links brands of its own company. When editing in "All
  // companies" view the concept list spans every company, so narrow it to
  // the location's company here; the API rejects cross-company links anyway.
  const pickable = location?.tenantId
    ? concepts.filter((c) => !c.tenantId || c.tenantId === location.tenantId)
    : concepts

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        address: address.trim() || undefined,
        city: city.trim() || undefined,
        phone: phone.trim() || undefined,
        latitude: coords.lat, longitude: coords.lng,
        geofenceRadiusMetres: radius.trim() ? Math.round(Number(radius)) : null,
        isActive,
        conceptIds,
      }
      if (location) return api.patch(`/locations/${location.id}`, payload)
      return api.post('/locations', payload)
    },
    onSuccess: () => onSaved(),
  })

  function toggleConcept(id: string) {
    setConceptIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const dirty = name !== (location?.name ?? '') || address !== (location?.address ?? '') || city !== (location?.city ?? '')
    || phone !== (location?.phone ?? '') || isActive !== (location?.isActive ?? true)
    || coords.lat !== (location?.latitude ?? null) || coords.lng !== (location?.longitude ?? null)
    || radius !== (location?.geofenceRadiusMetres != null ? String(location.geofenceRadiusMetres) : '')
    || conceptIds.slice().sort().join(',') !== (location?.concepts.map((c) => c.conceptId) ?? []).sort().join(',')
  const inputCls = 'w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-primary focus:outline-none'

  return (
    <Modal wide dirty={dirty} onClose={onClose}
      title={location ? 'Edit location' : 'Add location'}
      footer={
        <div className="flex justify-between gap-3">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button type="submit" form="location-form"
            disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : location ? 'Save changes' : 'Create location'}
          </button>
        </div>
      }>
      <form id="location-form" className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (name.trim() && !save.isPending) save.mutate() }}>
        {location?.tenant && (
          <p className="text-[11px] text-white/40 -mt-1">{location.tenant.name}</p>
        )}
        <FormField label="Name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} name="location-name" autoComplete="off"
            placeholder="Gulberg Branch" className={inputCls} autoFocus />
        </FormField>
        <FormField label="Address">
          <input value={address} onChange={(e) => setAddress(e.target.value)} name="location-address" autoComplete="off"
            placeholder="MM Alam Road, Block H Gulberg III" className={inputCls} />
        </FormField>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField label="City">
            <input value={city} onChange={(e) => setCity(e.target.value)} name="location-city" autoComplete="off"
              placeholder="Lahore" className={inputCls} />
          </FormField>
          <FormField label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel"
              name="location-phone" autoComplete="off" placeholder="+92 42 1234567" className={inputCls} />
          </FormField>
        </div>

        <div>
          <span className="text-xs text-white/55">Pin on map</span>
          <p className="text-[10px] text-white/35 mt-0.5 mb-2">
            Drives delivery zone radius, geofenced clock-in, and the nearest-branch picker on the storefront.
          </p>
          <MapPin value={coords} onChange={setCoords} height={240} />
        </div>

        <FormField label="Time-clock radius (metres)">
          <input value={radius} onChange={(e) => setRadius(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric"
            name="location-radius" autoComplete="off" placeholder="Blank = the company's radius (100 m)" className={inputCls} />
        </FormField>
        <p className="text-[10px] text-white/35 -mt-2">
          Clock-ins are accepted inside this circle around the pin. A new or moved pin, or a new radius, is used only after the CEO approves it.
        </p>

        <fieldset>
          <legend className="text-xs text-white/55">Brands operated at this location</legend>
          <p className="text-[10px] text-white/35 mt-0.5">
            Tick every brand that runs out of this kitchen. Multi-concept kitchens tick multiple.
            {inPortfolio && !location && ' Only brands of the company you pick for this location can be linked.'}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-2">
            {pickable.map((c) => (
              <label key={c.id}
                className="flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors"
                style={{
                  background: conceptIds.includes(c.id) ? 'var(--erp-accent-dim)' : 'rgb(var(--fg-rgb) / 0.025)',
                  border: conceptIds.includes(c.id) ? '1px solid var(--erp-accent)' : '1px solid rgb(var(--fg-rgb) / 0.05)',
                }}>
                <input type="checkbox" checked={conceptIds.includes(c.id)} onChange={() => toggleConcept(c.id)} className="accent-accent" />
                <span className="text-xs font-bold text-white/85">
                  {c.name}
                  {inPortfolio && c.tenant && (
                    <span className="ml-1.5 text-[10px] font-semibold text-white/35">{c.tenant.name}</span>
                  )}
                </span>
              </label>
            ))}
            {pickable.length === 0 && (
              <p className="col-span-2 text-xs text-white/35">No brands in this company yet.</p>
            )}
          </div>
        </fieldset>

        {location && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-accent" />
            <span className="text-xs text-white/65">Active (uncheck to pause this location)</span>
          </label>
        )}

        {save.isError && (
          <p role="alert" className="text-xs text-red-700">{errorText(save.error)}</p>
        )}
      </form>
    </Modal>
  )
}
