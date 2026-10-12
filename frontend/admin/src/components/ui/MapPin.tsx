'use client'
// MapPin — interactive drop-pin UI for setting lat/lng on a location/concept.
//
// Ways to set the pin, in the order operators actually use them:
//   1. PASTE A GOOGLE MAPS LINK — the share link from the Maps app
//      (maps.app.goo.gl/…). Resolved server-side (short links redirect, and
//      the browser can't follow them across origins) and the pin lands on the
//      exact Google place. No API key needed. This is the primary path.
//   2. Click anywhere on the map to drop a pin there
//   3. Drag the existing pin to fine-tune
//   4. "Use my location" — browser Geolocation API
//   5. Search box — OpenStreetMap Nominatim (free)
//   6. Manual lat/lng inputs
//
// Tiles: when NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is set at build time the map is
// Google Maps (Maps JavaScript API, draggable marker). Without a key it falls
// back to Leaflet + OpenStreetMap — same behaviour, different tiles. The key
// is a public build-time value (baked into the bundle), so it must be
// restricted to the admin origin in Google Cloud.

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet'
import { api } from '../../lib/api'

interface Coords { lat: number | null; lng: number | null }

interface Props {
  value: Coords
  onChange: (v: Coords) => void
  height?: number
  hint?: string
}

// Lahore centre — sensible default for Pakistani ops
const DEFAULT_CENTER: [number, number] = [31.5204, 74.3587]
const GOOGLE_KEY = process.env['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'] ?? ''

// Minimal typing for the Maps JS API — enough for a map + one draggable
// marker without pulling in @types/google.maps.
/* eslint-disable @typescript-eslint/no-explicit-any */
type GMap = any
type GMarker = any
declare global { interface Window { google?: any; __servdGmapsLoading?: Promise<void> } }
/* eslint-enable @typescript-eslint/no-explicit-any */

function loadGoogleMaps(key: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.google?.maps) return Promise.resolve()
  if (window.__servdGmapsLoading) return window.__servdGmapsLoading
  window.__servdGmapsLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async`
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Google Maps script failed to load — check the API key and its referrer restrictions'))
    document.head.appendChild(s)
  })
  return window.__servdGmapsLoading
}

export function MapPin({ value, onChange, height = 320, hint }: Props) {
  const useGoogle = GOOGLE_KEY.length > 0

  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Array<{ display_name: string; lat: string; lon: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  // Paste-a-link state
  const [mapsLink, setMapsLink] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolvedName, setResolvedName] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<LeafletMarker | null>(null)
  const gmapRef = useRef<GMap>(null)
  const gmarkerRef = useRef<GMarker>(null)
  // Always-current onChange so handlers don't need re-binding
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // ── Init map once (Google when keyed, else Leaflet) ───────────────────────
  useEffect(() => {
    let cancelled = false
    const initial: [number, number] =
      value.lat != null && value.lng != null ? [value.lat, value.lng] : DEFAULT_CENTER
    const initialZoom = value.lat != null ? 16 : 12

    ;(async () => {
      if (!containerRef.current) return
      if (useGoogle) {
        await loadGoogleMaps(GOOGLE_KEY)
        if (cancelled || !containerRef.current || gmapRef.current) return
        const g = window.google!.maps
        const map = new g.Map(containerRef.current, {
          center: { lat: initial[0], lng: initial[1] },
          zoom: initialZoom,
          mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
          clickableIcons: false,
        })
        map.addListener('click', (e: { latLng: { lat: () => number; lng: () => number } }) => {
          onChangeRef.current({ lat: e.latLng.lat(), lng: e.latLng.lng() })
        })
        gmapRef.current = map
        setMapReady(true)
        if (value.lat != null && value.lng != null) placeGoogleMarker(value.lat, value.lng)
        return
      }

      const L = (await import('leaflet')).default
      if (typeof document !== 'undefined' && !document.getElementById('leaflet-css')) {
        const link = document.createElement('link')
        link.id = 'leaflet-css'; link.rel = 'stylesheet'
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
        document.head.appendChild(link)
      }
      if (cancelled || !containerRef.current || mapRef.current) return
      const map = L.map(containerRef.current, { zoomControl: true }).setView(initial, initialZoom)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
      map.on('click', (e) => { onChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng }) })
      mapRef.current = map
      setMapReady(true)
      if (value.lat != null && value.lng != null) placeOrMoveLeafletMarker(L, map, value.lat, value.lng)
    })().catch((err: Error) => setError(`Map failed to load: ${err.message}`))

    return () => {
      cancelled = true
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; markerRef.current = null }
      gmapRef.current = null; gmarkerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Sync external value → marker + recentre ───────────────────────────────
  useEffect(() => {
    if (!mapReady) return
    if (value.lat == null || value.lng == null) return
    if (useGoogle) {
      if (!gmapRef.current) return
      placeGoogleMarker(value.lat, value.lng)
      gmapRef.current.panTo({ lat: value.lat, lng: value.lng })
      if (gmapRef.current.getZoom() < 15) gmapRef.current.setZoom(16)
      return
    }
    if (!mapRef.current) return
    ;(async () => {
      const L = (await import('leaflet')).default
      placeOrMoveLeafletMarker(L, mapRef.current!, value.lat!, value.lng!)
      mapRef.current!.setView([value.lat!, value.lng!], Math.max(mapRef.current!.getZoom(), 15))
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.lat, value.lng, mapReady])

  function placeGoogleMarker(lat: number, lng: number) {
    const g = window.google?.maps
    if (!g || !gmapRef.current) return
    if (gmarkerRef.current) { gmarkerRef.current.setPosition({ lat, lng }); return }
    const marker = new g.Marker({ position: { lat, lng }, map: gmapRef.current, draggable: true })
    marker.addListener('dragend', () => {
      const p = marker.getPosition()
      onChangeRef.current({ lat: p.lat(), lng: p.lng() })
    })
    gmarkerRef.current = marker
  }

  function placeOrMoveLeafletMarker(L: typeof import('leaflet'), map: LeafletMap, lat: number, lng: number) {
    if (markerRef.current) { markerRef.current.setLatLng([lat, lng]); return }
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;background:var(--erp-primary);border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg) translate(-50%,-100%);box-shadow:0 4px 12px rgba(0,0,0,0.5);"></div>`,
      iconSize: [22, 22], iconAnchor: [0, 0],
    })
    const marker = L.marker([lat, lng], { draggable: true, icon }).addTo(map)
    marker.on('dragend', () => { const pos = marker.getLatLng(); onChangeRef.current({ lat: pos.lat, lng: pos.lng }) })
    markerRef.current = marker
  }

  // ── Paste a Google Maps link → server resolves → pin ──────────────────────
  async function resolveMapsLink(raw: string) {
    const url = raw.trim()
    if (!url) return
    setResolving(true); setError(null); setResolvedName(null)
    try {
      const r = await api.get<{ lat: number; lng: number; name: string | null }>(
        `/concepts/resolve-maps-link?url=${encodeURIComponent(url)}`,
      )
      onChange({ lat: r.lat, lng: r.lng })
      setResolvedName(r.name)
      setSearch(''); setResults([])
    } catch (err) {
      setError((err as Error).message || 'Could not resolve that link')
    } finally {
      setResolving(false)
    }
  }

  // ── Debounced Nominatim search (fallback) ─────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (search.trim().length < 3) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true); setError(null)
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(search)}`
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } })
        if (!res.ok) throw new Error(`Search returned ${res.status}`)
        setResults((await res.json()) as Array<{ display_name: string; lat: string; lon: string }>)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setSearching(false)
      }
    }, 400)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setError("Your browser doesn't support geolocation. Paste a Maps link or click the map instead.")
      return
    }
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => { onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setSearch(''); setResults([]) },
      (err) => setError(`Could not get your location: ${err.message}. Allow location access in your browser.`),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  function pick(r: { display_name: string; lat: string; lon: string }) {
    onChange({ lat: parseFloat(r.lat), lng: parseFloat(r.lon) })
    setSearch(r.display_name); setResults([])
  }

  const lat = value.lat, lng = value.lng
  const inputCls = 'w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none'

  return (
    <div className="space-y-2">
      {/* Primary: paste a Google Maps share link */}
      <div>
        <label className="text-[11px] text-white/55 font-bold uppercase tracking-wider">Google Maps link</label>
        <div className="flex gap-2 mt-1">
          <input
            value={mapsLink}
            onChange={(e) => setMapsLink(e.target.value)}
            onPaste={(e) => {
              const t = e.clipboardData.getData('text')
              if (/goo\.gl|google\.com\/maps/i.test(t)) { e.preventDefault(); setMapsLink(t); void resolveMapsLink(t) }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void resolveMapsLink(mapsLink) } }}
            placeholder="Paste a maps.app.goo.gl link — Share → Copy link in Google Maps"
            className={inputCls}
          />
          <button type="button" onClick={() => void resolveMapsLink(mapsLink)} disabled={resolving || !mapsLink.trim()}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-on hover:opacity-90 disabled:opacity-40 whitespace-nowrap">
            {resolving ? 'Finding…' : 'Drop pin'}
          </button>
        </div>
        {resolvedName && (
          <p className="text-[11px] mt-1" style={{ color: 'var(--erp-primary-ink)' }}>Pinned to “{resolvedName}” from the link.</p>
        )}
      </div>

      {/* Secondary: geolocate / search */}
      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" onClick={useMyLocation}
          className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs font-bold text-white/80 hover:bg-white/[0.1] inline-flex items-center gap-1.5">
          <span>📍</span> Use my location
        </button>
        <span className="text-[11px] text-white/35">or search:</span>
        <div className="flex-1 min-w-[200px] relative">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ittehad Commercial, DHA Phase 6" className={inputCls} />
          {(searching || results.length > 0) && (
            <div className="absolute top-full left-0 right-0 mt-1 z-[1000] rounded-lg overflow-hidden"
              style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.1)', boxShadow: '0 12px 28px rgb(var(--ink-rgb) / 0.18)' }}>
              {searching && <p className="text-xs text-white/45 px-3 py-2">Searching…</p>}
              {results.map((r, i) => (
                <button key={i} type="button" onClick={() => pick(r)} className="w-full text-left px-3 py-2 text-xs text-white/75 hover:bg-white/[0.05]">
                  {r.display_name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="text-[11px] text-white/45 flex items-center gap-1.5">
        <span className="text-primary-ink">●</span>
        Click anywhere on the map to drop a pin, then drag it to fine-tune.
        {!useGoogle && <span className="text-white/30">· Showing OpenStreetMap tiles — add a Google Maps API key to switch to Google.</span>}
      </p>

      <div className="rounded-xl overflow-hidden border border-white/[0.08] relative" style={{ height }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--elevated)' }} />
        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-xs text-white/35">Loading map…</p>
          </div>
        )}
      </div>

      {lat != null && lng != null && (
        <div className="flex items-center justify-between text-[11px] text-white/55 font-mono px-1">
          <span>{lat.toFixed(5)}, {lng.toFixed(5)}</span>
          <a href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noopener noreferrer" className="hover:text-white/80">
            Check in Google Maps ↗
          </a>
        </div>
      )}

      <details className="text-[11px]">
        <summary className="cursor-pointer text-white/45 hover:text-white/70">Enter coordinates manually</summary>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <input type="number" step="any" value={lat ?? ''}
            onChange={(e) => onChange({ lat: e.target.value === '' ? null : parseFloat(e.target.value), lng })}
            placeholder="Latitude (e.g. 24.8015)" className={`${inputCls} font-mono`} />
          <input type="number" step="any" value={lng ?? ''}
            onChange={(e) => onChange({ lat, lng: e.target.value === '' ? null : parseFloat(e.target.value) })}
            placeholder="Longitude (e.g. 67.0736)" className={`${inputCls} font-mono`} />
        </div>
      </details>

      {hint && <p className="text-[11px] text-white/35">{hint}</p>}
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  )
}
