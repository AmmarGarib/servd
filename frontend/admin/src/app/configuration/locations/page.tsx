'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { MapPin } from '../../../components/ui/MapPin'

interface ConceptLite { id: string; name: string; slug: string }
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
  concepts: ConceptLink[]
  _count: { orders: number; shifts: number }
}

export default function LocationsPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Location | null>(null)
  const [adding, setAdding] = useState(false)

  const { data: locations = [], isLoading } = useQuery<Location[]>({
    queryKey: ['locations'],
    queryFn: () => api.get('/locations'),
  })
  const { data: concepts = [] } = useQuery<ConceptLite[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-white/90">📍 Locations</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Physical places where you operate. A single location can host multiple brands (multi-concept kitchens, food-court units). Accounting + reports filter by location independently of brand.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90"
          >
            + Add location
          </button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-3">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}

        {!isLoading && locations.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
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
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-black text-white/90">{loc.name}</h3>
                  {!loc.isActive && (
                    <span className="text-[10px] font-bold text-white/30 px-1.5 py-0.5 rounded bg-white/5">PAUSED</span>
                  )}
                </div>
                <p className="text-xs text-white/35 font-mono mt-0.5">{loc.slug}</p>
                {loc.address && (
                  <p className="text-sm text-white/55 mt-1">{loc.address}{loc.city ? `, ${loc.city}` : ''}</p>
                )}
                <p className="text-xs text-white/35 mt-2">
                  {loc._count.orders.toLocaleString()} orders · {loc._count.shifts} shifts
                </p>
                {loc.concepts.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {loc.concepts.map((cl) => (
                      <span key={cl.conceptId}
                        className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(0,212,177,0.1)', color: '#00D4B1', border: '1px solid rgba(0,212,177,0.18)' }}>
                        {cl.concept.name}{cl.isPrimary ? ' ★' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => setEditing(loc)}
                className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white"
              >
                Edit
              </button>
            </div>
          </div>
        ))}
      </div>

      {(adding || editing) && (
        <LocationModal
          location={editing}
          concepts={concepts}
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

function LocationModal({ location, concepts, onClose, onSaved }: {
  location: Location | null
  concepts: ConceptLite[]
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{location ? 'Edit location' : 'Add location'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="text-xs text-white/55">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Gulberg Branch"
              className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-kds-green focus:outline-none" autoFocus />
          </div>
          <div>
            <label className="text-xs text-white/55">Address</label>
            <input value={address} onChange={(e) => setAddress(e.target.value)}
              placeholder="MM Alam Road, Block H Gulberg III"
              className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-kds-green focus:outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/55">City</label>
              <input value={city} onChange={(e) => setCity(e.target.value)}
                placeholder="Lahore"
                className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-kds-green focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-white/55">Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="+92 42 1234567"
                className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-kds-green focus:outline-none" />
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
            </p>
            <div className="grid grid-cols-2 gap-1.5 mt-2">
              {concepts.map((c) => (
                <label key={c.id}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition-colors"
                  style={{
                    background: conceptIds.includes(c.id) ? 'rgba(0,212,177,0.08)' : 'rgba(255,255,255,0.025)',
                    border: conceptIds.includes(c.id) ? '1px solid rgba(0,212,177,0.35)' : '1px solid rgba(255,255,255,0.05)',
                  }}>
                  <input type="checkbox" checked={conceptIds.includes(c.id)} onChange={() => toggleConcept(c.id)} className="accent-kds-green" />
                  <span className="text-xs font-bold text-white/85">{c.name}</span>
                </label>
              ))}
            </div>
          </div>

          {location && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-kds-green" />
              <span className="text-xs text-white/65">Active (uncheck to pause this location)</span>
            </label>
          )}
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : location ? 'Save changes' : 'Create location'}
          </button>
        </div>
      </div>
    </div>
  )
}
