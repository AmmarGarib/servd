'use client'
// DeliveryPin — the customer sets the exact drop point for a delivery.
//
// The server prices delivery by zone and sends the rider to coordinates, so it
// refuses a delivery order without them (lib/pricing.ts deliveryFeeFor →
// DELIVERY_LOCATION_REQUIRED). This is how the web storefront supplies them:
//   1. "Use my current location" (browser geolocation), or
//   2. tap the map to drop the pin, then
//   3. drag the pin to fine-tune.
//
// Leaflet + OpenStreetMap tiles. Leaflet is imported ON DEMAND inside the
// mount effect, so it lands in its own async chunk and never ships in the
// menu/home bundles; its stylesheet is the handful of rules below, injected
// once, instead of a third-party CSS link. The marker is a divIcon (inline
// SVG in servd purple + green) because Leaflet's default marker PNGs break
// under bundlers. OSM attribution stays on the map — it is a licence term.
//
// The admin's location picker (frontend/admin/src/components/ui/MapPin.tsx)
// is the operator version; this one is deliberately simpler.

import { useEffect, useId, useRef, useState } from 'react'
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet'

export interface LatLng { lat: number; lng: number }

interface Props {
  /** The pin, or null when none is set yet. */
  value: LatLng | null
  onChange: (v: LatLng) => void
  /** Where to open the map when there is no pin — the kitchen, when known. */
  center?: LatLng | null
  /** Accessible name for the map. */
  label?: string
  /** A message to show by the map (missing pin, outside the delivery area…). */
  message?: string | null
  height?: number
}

// Karachi — where GS Foods' kitchens are.
const KARACHI: LatLng = { lat: 24.8607, lng: 67.0011 }
const OPEN_ZOOM = 13
const PIN_ZOOM = 16

const PIN_SVG =
  '<svg width="30" height="40" viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M15 1C7.3 1 1 7.2 1 14.9 1 25.3 15 39 15 39s14-13.7 14-24.1C29 7.2 22.7 1 15 1z" ' +
  'fill="var(--servd-purple, #5a2156)" stroke="var(--servd-on-purple, #f3e7cd)" stroke-width="2"/>' +
  '<circle cx="15" cy="15" r="5.5" fill="var(--servd-green, #87c540)"/>' +
  '</svg>'

// The subset of leaflet.css (1.9.4) this map uses: panes, tiles, the marker,
// the zoom buttons and the attribution. Scoped by Leaflet's own class names.
const LEAFLET_CSS = `
.leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas,.leaflet-zoom-box,.leaflet-image-layer,.leaflet-layer{position:absolute;left:0;top:0}
.leaflet-container{overflow:hidden;-webkit-tap-highlight-color:transparent;font-size:12px;line-height:1.5;outline-offset:1px}
.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow{-webkit-user-select:none;user-select:none;-webkit-user-drag:none}
.leaflet-tile::selection{background:transparent}
.leaflet-safari .leaflet-tile{image-rendering:-webkit-optimize-contrast}
.leaflet-safari .leaflet-tile-container{width:1600px;height:1600px;-webkit-transform-origin:0 0}
.leaflet-marker-icon,.leaflet-marker-shadow{display:block}
.leaflet-container .leaflet-marker-pane img,.leaflet-container .leaflet-tile-pane img,.leaflet-container .leaflet-tile{max-width:none!important;max-height:none!important;width:auto;padding:0}
.leaflet-container img.leaflet-tile{mix-blend-mode:plus-lighter}
.leaflet-container.leaflet-touch-zoom{touch-action:pan-x pan-y}
.leaflet-container.leaflet-touch-drag{touch-action:none;touch-action:pinch-zoom}
.leaflet-container.leaflet-touch-drag.leaflet-touch-zoom{touch-action:none}
.leaflet-tile{filter:inherit;visibility:hidden}
.leaflet-tile-loaded{visibility:inherit}
.leaflet-zoom-box{width:0;height:0;box-sizing:border-box;z-index:800}
.leaflet-pane{z-index:400}
.leaflet-tile-pane{z-index:200}
.leaflet-overlay-pane{z-index:400}
.leaflet-shadow-pane{z-index:500}
.leaflet-marker-pane{z-index:600}
.leaflet-tooltip-pane{z-index:650}
.leaflet-popup-pane{z-index:700}
.leaflet-control{position:relative;z-index:800;pointer-events:auto;float:left;clear:both;cursor:auto}
.leaflet-top,.leaflet-bottom{position:absolute;z-index:1000;pointer-events:none}
.leaflet-top{top:0}.leaflet-right{right:0}.leaflet-bottom{bottom:0}.leaflet-left{left:0}
.leaflet-right .leaflet-control{float:right}
.leaflet-top .leaflet-control{margin-top:10px}
.leaflet-bottom .leaflet-control{margin-bottom:0}
.leaflet-left .leaflet-control{margin-left:10px}
.leaflet-right .leaflet-control{margin-right:0}
.leaflet-zoom-animated{transform-origin:0 0}
svg.leaflet-zoom-animated{will-change:transform}
.leaflet-zoom-anim .leaflet-zoom-animated{transition:transform .25s cubic-bezier(0,0,.25,1)}
.leaflet-zoom-anim .leaflet-tile,.leaflet-pan-anim .leaflet-tile{transition:none}
.leaflet-zoom-anim .leaflet-zoom-hide{visibility:hidden}
.leaflet-interactive{cursor:pointer}
.leaflet-grab{cursor:grab}
.leaflet-dragging .leaflet-grab,.leaflet-dragging .leaflet-marker-draggable{cursor:grabbing}
.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-image-layer,.leaflet-tile-container{pointer-events:none}
.leaflet-marker-icon.leaflet-interactive{pointer-events:auto}
.leaflet-bar{border-radius:8px;border:1px solid rgba(61,31,59,0.18);overflow:hidden}
.leaflet-bar a{display:block;width:32px;height:32px;line-height:32px;text-align:center;text-decoration:none;background:#fff;color:#3d1f3b;font:bold 18px/32px system-ui,sans-serif;border-bottom:1px solid rgba(61,31,59,0.12)}
.leaflet-bar a:last-child{border-bottom:none}
.leaflet-bar a.leaflet-disabled{cursor:default;color:#bbb}
.leaflet-control-attribution{background:rgba(255,255,255,0.85);margin:0;padding:0 5px;color:#333;line-height:1.4;font-size:10px}
.leaflet-control-attribution a{color:#0078a8;text-decoration:none}
.leaflet-control-attribution a:hover,.leaflet-control-attribution a:focus{text-decoration:underline}
.servd-delivery-pin{background:none;border:none}
.servd-delivery-pin:focus-visible{outline:2px solid var(--servd-green-dark,#4f7a1c);outline-offset:2px;border-radius:50%}
`

function ensureLeafletCss() {
  if (typeof document === 'undefined' || document.getElementById('servd-leaflet-css')) return
  const style = document.createElement('style')
  style.id = 'servd-leaflet-css'
  style.textContent = LEAFLET_CSS
  document.head.appendChild(style)
}

type LeafletNs = typeof import('leaflet')
async function loadLeaflet(): Promise<LeafletNs> {
  // Leaflet ships CommonJS; the bundler's interop puts it on `default`.
  const mod = await import('leaflet')
  return (mod as unknown as { default?: LeafletNs }).default ?? mod
}

function geoErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location access is turned off for this site. Allow it in your browser settings, or tap the map where you are.'
    case err.POSITION_UNAVAILABLE:
      return "We couldn't find your location right now. Tap the map where you are instead."
    case err.TIMEOUT:
      return 'Finding your location took too long. Try again, or tap the map where you are.'
    default:
      return "We couldn't get your location. Tap the map where you are instead."
  }
}

export default function DeliveryPin({
  value, onChange, center, label = 'Delivery location', message, height = 220,
}: Props) {
  const uid = useId()
  const hintId = `${uid}-hint`
  const statusId = `${uid}-status`

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<LeafletMarker | null>(null)
  const leafletRef = useRef<LeafletNs | null>(null)
  // Always-current handler, so map listeners bound once never go stale.
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  // Set when the next pin should also fly the map to it (geolocation).
  const recentreRef = useRef(false)
  // Once the customer moves the map we stop re-centring it on the kitchen.
  const touchedRef = useRef(false)

  const [mapReady, setMapReady] = useState(false)
  const [mapFailed, setMapFailed] = useState(false)
  const [locating, setLocating] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)

  // ── Mount: load Leaflet, build the map once ───────────────────────────────
  useEffect(() => {
    let cancelled = false
    let onKey: ((e: KeyboardEvent) => void) | null = null
    ;(async () => {
      const L = await loadLeaflet()
      ensureLeafletCss()
      if (cancelled || !containerRef.current || mapRef.current) return
      leafletRef.current = L
      const start = value ?? center ?? KARACHI
      const map = L.map(containerRef.current, {
        zoomControl: true,
        scrollWheelZoom: false, // never trap the page scroll on desktop
        attributionControl: true,
      }).setView([start.lat, start.lng], value ? PIN_ZOOM : OPEN_ZOOM)
      map.attributionControl.setPrefix(false)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      }).addTo(map)
      map.on('click', (e) => {
        touchedRef.current = true
        onChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng })
      })
      map.on('dragstart zoomstart', () => { touchedRef.current = true })
      // Keyboard: arrows pan, +/- zoom (Leaflet), Enter drops the pin at the
      // centre of the map.
      onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Enter' || e.target !== map.getContainer()) return
        e.preventDefault()
        const c = map.getCenter()
        touchedRef.current = true
        onChangeRef.current({ lat: c.lat, lng: c.lng })
      }
      map.getContainer().addEventListener('keydown', onKey)
      mapRef.current = map
      setMapReady(true)
    })().catch(() => { if (!cancelled) setMapFailed(true) })

    const container = containerRef.current
    return () => {
      cancelled = true
      if (onKey && container) container.removeEventListener('keydown', onKey)
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null }
      markerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Pin value → marker ────────────────────────────────────────────────────
  const pinLat = value?.lat ?? null
  const pinLng = value?.lng ?? null
  useEffect(() => {
    const L = leafletRef.current
    const map = mapRef.current
    if (!mapReady || !L || !map) return
    const value = pinLat != null && pinLng != null ? { lat: pinLat, lng: pinLng } : null
    if (!value) {
      if (markerRef.current) { markerRef.current.remove(); markerRef.current = null }
      return
    }
    if (markerRef.current) {
      markerRef.current.setLatLng([value.lat, value.lng])
    } else {
      const icon = L.divIcon({
        className: 'servd-delivery-pin',
        html: PIN_SVG,
        iconSize: [30, 40],
        iconAnchor: [15, 39], // the tip of the pin sits on the point
      })
      const marker = L.marker([value.lat, value.lng], {
        icon, draggable: true, keyboard: true, autoPan: true,
        title: 'Your delivery pin. Drag it to adjust.',
      }).addTo(map)
      marker.on('dragend', () => {
        const p = marker.getLatLng()
        touchedRef.current = true
        onChangeRef.current({ lat: p.lat, lng: p.lng })
      })
      markerRef.current = marker
    }
    if (recentreRef.current) {
      recentreRef.current = false
      map.setView([value.lat, value.lng], Math.max(map.getZoom(), PIN_ZOOM))
    } else if (!map.getBounds().contains([value.lat, value.lng])) {
      map.panTo([value.lat, value.lng])
    }
  }, [pinLat, pinLng, mapReady])

  // ── Kitchen coordinates arrive after mount → open there instead ──────────
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !center || value || touchedRef.current) return
    map.setView([center.lat, center.lng], OPEN_ZOOM)
    // Only the kitchen's coordinates matter here, not the object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.lat, center?.lng, mapReady])

  function locateMe() {
    setGeoError(null)
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setGeoError("This browser can't share your location. Tap the map where you are instead.")
      return
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setGeoError('Your location is only available on a secure (https) page. Tap the map where you are instead.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        recentreRef.current = true
        touchedRef.current = true
        onChangeRef.current({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      (err) => {
        setLocating(false)
        setGeoError(geoErrorMessage(err))
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    )
  }

  const mapsHref = value
    ? `https://www.google.com/maps/search/?api=1&query=${value.lat.toFixed(6)},${value.lng.toFixed(6)}`
    : null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p id={hintId} className="text-[11px] leading-snug flex-1 min-w-[10rem]" style={{ color: 'var(--servd-mute)' }}>
          Tap the map where we should deliver, then drag the pin to fine-tune.
        </p>
        <button
          type="button"
          onClick={locateMe}
          disabled={locating}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-opacity disabled:opacity-60"
          style={{ background: 'transparent', color: 'var(--servd-green-dark)', border: '1.5px solid var(--servd-green-dark)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="7" />
            <circle cx="12" cy="12" r="2.5" fill="currentColor" />
            <line x1="12" y1="1" x2="12" y2="4" />
            <line x1="12" y1="20" x2="12" y2="23" />
            <line x1="1" y1="12" x2="4" y2="12" />
            <line x1="20" y1="12" x2="23" y2="12" />
          </svg>
          {locating ? 'Finding you…' : 'Use my current location'}
        </button>
      </div>

      {/* `isolate` keeps Leaflet's pane z-indexes (400–1000) inside the map,
          so they never paint over the page's fixed header or order bar. */}
      <div className="relative isolate w-full overflow-hidden rounded-lg"
        style={{ height, border: '1px solid var(--servd-line)', background: 'var(--servd-surface)' }}>
        <div
          ref={containerRef}
          role="application"
          aria-label={`${label} map. Tap or click to drop your delivery pin. With a keyboard, use the arrow keys to move the map and press Enter to drop the pin at its centre.`}
          aria-describedby={hintId}
          style={{ width: '100%', height: '100%' }}
        />
        {!mapReady && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-4 text-center">
            <p className="text-xs" style={{ color: 'var(--servd-mute)' }}>
              {mapFailed ? "The map didn't load. Check your connection, or use your current location." : 'Loading map…'}
            </p>
          </div>
        )}
      </div>

      <div id={statusId} aria-live="polite" className="space-y-1">
        {value && mapsHref && (
          <p className="text-xs font-semibold flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--servd-green-dark)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {/* With a message showing (e.g. outside the delivery area) the
                pin is set but we can't promise to deliver to it. */}
            <span>{message ? 'Pin set.' : <>Pin set — we&rsquo;ll deliver here.</>}</span>
            <a href={mapsHref} target="_blank" rel="noopener noreferrer"
              className="underline underline-offset-2 font-semibold" style={{ color: 'var(--servd-ink)' }}>
              Open in Google Maps
            </a>
          </p>
        )}
        {geoError && (
          <p role="alert" className="text-xs font-semibold" style={{ color: 'var(--servd-danger)' }}>
            {geoError}
          </p>
        )}
        {message && (
          <p role="alert" className="text-xs font-semibold" style={{ color: 'var(--servd-danger)' }}>
            {message}
          </p>
        )}
      </div>
    </div>
  )
}
