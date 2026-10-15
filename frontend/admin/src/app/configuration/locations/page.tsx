'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../../lib/api'
import { MapPin } from '../../../components/ui/MapPin'
import { useViewAllTenants } from '../../../components/ui/TenantSwitcher'

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
  isActive: boolean
  tenantId: string | null
  tenant?: TenantLite | null
  concepts: ConceptLink[]
  _count: { orders: number; shifts: number }
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
  const [confirmDelete, setConfirmDelete] = useState<Location | null>(null)

  // Both reads are company-scoped server-side: single-company view returns
  // only that company's locations and brands; "All companies" returns every
  // company the operator belongs to, with `tenant` attached for labelling.
  const { data: locations = [], isLoading } = useQuery<Location[]>({
    queryKey: ['locations'],
    queryFn: () => api.get('/locations'),
  })
  const { data: concepts = [] } = useQuery<ConceptLite[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  const remove = useMutation({
    mutationFn: (loc: Location) => api.delete<void>(`/locations/${loc.id}`),
    onSuccess: () => {
      setConfirmDelete(null)
      void qc.invalidateQueries({ queryKey: ['locations'] })
    },
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-white/90">📍 Locations</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Physical places where you operate. A single location can host multiple brands (multi-concept kitchens, food-court units).
              A location's address and map pin are what customers see for every brand it runs (storefront, Maps links, JSON-LD),
              the origin delivery is measured from, and the clock-in anchor — edit them here, not on the brand. A brand's
              phone and WhatsApp stay on the brand (CEO → Brands). Accounting + reports filter by location independently of brand.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90"
          >
            + Add location
          </button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-3">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}

        {!isLoading && locations.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="text-4xl mb-3">📍</p>
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
                {loc.concepts.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {loc.concepts.map((cl) => (
                      <span key={cl.conceptId}
                        className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.18)' }}>
                        {cl.concept.name}{cl.isPrimary ? ' ★' : ''}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-white/30 mt-3">No brands linked — edit to tick the brands that run here.</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setEditing(loc)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white"
                >
                  Edit
                </button>
                <button
                  onClick={() => setConfirmDelete(loc)}
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

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={() => setConfirmDelete(null)}>
          <div
            className="w-full max-w-md rounded-2xl overflow-hidden"
            style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5">
              <h2 className="font-black text-white/90">Delete “{confirmDelete.name}”?</h2>
              <p className="text-sm text-white/55 mt-2">
                The location is removed from every picker, filter, and brand link. Past orders and shifts recorded against it are kept for reporting.
              </p>
              {(confirmDelete._count.orders > 0 || confirmDelete._count.shifts > 0) && (
                <p className="text-xs text-white/40 mt-2">
                  {confirmDelete._count.orders.toLocaleString()} orders · {confirmDelete._count.shifts} shifts stay on the books.
                </p>
              )}
              {remove.isError && (
                <p className="text-xs text-red-700 mt-3">{errorText(remove.error)}</p>
              )}
            </div>
            <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
              <button onClick={() => setConfirmDelete(null)} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
              <button
                onClick={() => remove.mutate(confirmDelete)}
                disabled={remove.isPending}
                className="rounded-xl px-5 py-2.5 text-sm font-black text-bone disabled:opacity-50"
                style={{ background: 'var(--erp-danger)' }}
              >
                {remove.isPending ? 'Deleting…' : 'Delete location'}
              </button>
            </div>
          </div>
        </div>
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <div>
            <h2 className="font-black text-white/90">{location ? 'Edit location' : 'Add location'}</h2>
            {location?.tenant && (
              <p className="text-[11px] text-white/40 mt-0.5">{location.tenant.name}</p>
            )}
          </div>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="text-xs text-white/55">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Gulberg Branch"
              className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-primary focus:outline-none" autoFocus />
          </div>
          <div>
            <label className="text-xs text-white/55">Address</label>
            <input value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder="MM Alam Road, Block H Gulberg III"
              className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-primary focus:outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/55">City</label>
              <input value={city} onChange={(e) => setCity(e.target.value)}
                placeholder="Lahore"
                className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-primary focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-white/55">Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="+92 42 1234567"
                className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-primary focus:outline-none" />
            </div>
          </div>

          <div>
            <label className="text-xs text-white/55">Pin on map</label>
            <p className="text-[10px] text-white/35 mt-0.5 mb-2">
              Drives delivery zone radius, geofenced clock-in, and the nearest-branch picker on the storefront.
            </p>
            <MapPin value={coords} onChange={setCoords} height={240} />
          </div>

          <div>
            <label className="text-xs text-white/55">Brands operated at this location</label>
            <p className="text-[10px] text-white/35 mt-0.5">
              Tick every brand that runs out of this kitchen. Multi-concept kitchens tick multiple.
              {inPortfolio && !location && ' Only brands of the company you pick for this location can be linked.'}
            </p>
            <div className="grid grid-cols-2 gap-1.5 mt-2">
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
          </div>

          {location && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-accent" />
              <span className="text-xs text-white/65">Active (uncheck to pause this location)</span>
            </label>
          )}

          {save.isError && (
            <p className="text-xs text-red-700">{errorText(save.error)}</p>
          )}
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : location ? 'Save changes' : 'Create location'}
          </button>
        </div>
      </div>
    </div>
  )
}
