'use client'
// MapPin — interactive drop-pin UI for setting lat/lng on a location/concept.
//
// No third-party API keys. Four ways to set the pin:
//   1. Click anywhere on the map to drop a pin there
//   2. Drag the existing pin to fine-tune
//   3. "Use my location" — browser Geolocation API
//   4. Search box — OpenStreetMap Nominatim (free)
//   5. Manual lat/lng inputs — for paste-from-Google-Maps workflows
//
// Renders with Leaflet + OpenStreetMap tiles. Dynamic-imports leaflet so SSR
// doesn't break (leaflet touches `window` at import time).

import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet'

interface Coords { lat: number | null; lng: number | null }

interface Props {
  value: Coords
  onChange: (v: Coords) => void
  height?: number
  hint?: string
}

// Lahore center — sensible default for Pakistani ops
const DEFAULT_CENTER: [number, number] = [31.5204, 74.3587]

export function MapPin({ value, onChange, height = 320, hint }: Props) {
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Array<{ display_name: string; lat: string; lon: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<LeafletMarker | null>(null)
  // Always-current onChange so the click handler doesn't need re-binding
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // Init Leaflet once
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const L = (await import('leaflet')).default
      // Inject CSS once
      if (typeof document !== 'undefined' && !document.getElementById('leaflet-css')) {
        const link = document.createElement('link')
        link.id = 'leaflet-css'
        link.rel = 'stylesheet'
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
        document.head.appendChild(link)
      }
      if (cancelled || !containerRef.current || mapRef.current) return

      const initial: [number, number] =
        value.lat != null && value.lng != null ? [value.lat, value.lng] : DEFAULT_CENTER

      const map = L.map(containerRef.current, { zoomControl: true }).setView(initial, value.lat != null ? 16 : 12)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      }).addTo(map)

      // Click anywhere on the map → drop pin
      map.on('click', (e) => {
        onChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng })
      })

      mapRef.current = map
      setMapReady(true)

      // If a value was already set, place the marker now
      if (value.lat != null && value.lng != null) {
        placeOrMoveMarker(L, map, value.lat, value.lng)
      }
    })().catch((err: Error) => setError(`Map failed to load: ${err.message}`))

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync external value → marker + recenter
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    if (value.lat == null || value.lng == null) return
    ;(async () => {
      const L = (await import('leaflet')).default
      placeOrMoveMarker(L, mapRef.current!, value.lat!, value.lng!)
      mapRef.current!.setView([value.lat!, value.lng!], Math.max(mapRef.current!.getZoom(), 15))
    })()
  }, [value.lat, value.lng, mapReady])

  function placeOrMoveMarker(L: typeof import('leaflet'), map: LeafletMap, lat: number, lng: number) {
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng])
      return
    }
    // Custom HTML pin — avoids the broken default-icon-path issue with bundlers
    const icon = L.divIcon({
      className: '',
      html: `<div style="
        width: 22px; height: 22px;
        background: #00D4B1;
        border: 3px solid #000;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg) translate(-50%, -100%);
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      "></div>`,
      iconSize: [22, 22],
      iconAnchor: [0, 0],
    })
    const marker = L.marker([lat, lng], { draggable: true, icon }).addTo(map)
    marker.on('dragend', () => {
      const pos = marker.getLatLng()
      onChangeRef.current({ lat: pos.lat, lng: pos.lng })
    })
    markerRef.current = marker
  }

  // Debounced Nominatim search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (search.trim().length < 3) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true); setError(null)
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(search)}`
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } })
        if (!res.ok) throw new Error(`Search returned ${res.status}`)
        const data = (await res.json()) as Array<{ display_name: string; lat: string; lon: string }>
        setResults(data)
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
      setError("Your browser doesn't support geolocation. Use the search box or click the map instead.")
      return
    }
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setSearch(''); setResults([])
      },
      (err) => setError(`Could not get your location: ${err.message}. Allow location access in your browser.`),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  function pick(r: { display_name: string; lat: string; lon: string }) {
    onChange({ lat: parseFloat(r.lat), lng: parseFloat(r.lon) })
    setSearch(r.display_name); setResults([])
  }

  const lat = value.lat, lng = value.lng

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-center">
        <button type="button" onClick={useMyLocation}
          className="rounded-lg bg-kds-green px-3 py-2 text-xs font-bold text-black hover:opacity-90 inline-flex items-center gap-1.5">
          <span>📍</span> Use my location
        </button>
        <span className="text-[11px] text-white/35">or search:</span>
        <div className="flex-1 min-w-[200px] relative">
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="DHA Phase 5, Lahore"
            className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none" />
          {(searching || results.length > 0) && (
            <div className="absolute top-full left-0 right-0 mt-1 z-[1000] rounded-lg overflow-hidden"
              style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 12px 28px rgba(0,0,0,0.5)' }}>
              {searching && <p className="text-xs text-white/45 px-3 py-2">Searching…</p>}
              {results.map((r, i) => (
                <button key={i} type="button" onClick={() => pick(r)}
                  className="w-full text-left px-3 py-2 text-xs text-white/75 hover:bg-white/[0.05]">
                  {r.display_name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Click hint banner above map */}
      <p className="text-[11px] text-white/45 flex items-center gap-1.5">
        <span className="text-kds-green">●</span>
        Click anywhere on the map to drop a pin, then drag it to fine-tune.
      </p>

      {/* Interactive map */}
      <div className="rounded-xl overflow-hidden border border-white/[0.08] relative" style={{ height }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#1a1d24' }} />
        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-xs text-white/35">Loading map…</p>
          </div>
        )}
      </div>

      {/* Coordinate strip */}
      {lat != null && lng != null && (
        <div className="flex items-center justify-between text-[11px] text-white/55 font-mono px-1">
          <span>{lat.toFixed(5)}, {lng.toFixed(5)}</span>
          <a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`}
            target="_blank" rel="noopener noreferrer" className="hover:text-white/80">
            Open in OSM ↗
          </a>
        </div>
      )}

      {/* Manual lat/lng inputs — paste-from-Google-Maps fallback */}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-white/45 hover:text-white/70">Enter coordinates manually</summary>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <input type="number" step="any" value={lat ?? ''}
            onChange={(e) => onChange({ lat: e.target.value === '' ? null : parseFloat(e.target.value), lng })}
            placeholder="Latitude (e.g. 31.501)"
            className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm font-mono text-white/85 focus:border-kds-green focus:outline-none" />
          <input type="number" step="any" value={lng ?? ''}
            onChange={(e) => onChange({ lat, lng: e.target.value === '' ? null : parseFloat(e.target.value) })}
            placeholder="Longitude (e.g. 74.349)"
            className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm font-mono text-white/85 focus:border-kds-green focus:outline-none" />
        </div>
      </details>

      {hint && <p className="text-[11px] text-white/35">{hint}</p>}
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  )
}
