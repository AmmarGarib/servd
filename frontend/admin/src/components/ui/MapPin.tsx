'use client'
// MapPin — sets a location's lat/lng from a GOOGLE MAPS LINK only (owner, 2026-10-27: "remove the openstreet map
// thing. Its confusing … make it work only thru google maps link"). No map, no search, no "use my location".
//
// In Google Maps: drop the pin on the place → Share → Copy link → paste here. A short link (maps.app.goo.gl/…) is
// resolved server-side (GET /concepts/resolve-maps-link — the browser cannot follow it across origins); a full
// google.com/maps link that already carries the coordinates is read on the spot.

import { useState } from 'react'
import { api } from '../../lib/api'

interface Coords { lat: number | null; lng: number | null }

interface Props {
  value: Coords
  onChange: (v: Coords) => void
  /** Kept for callers; there is no map any more. */
  height?: number
  hint?: string
}

const inRange = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180

/** Coordinates written in a full Google Maps link (the place pin first, then the map centre, then ?q=lat,lng). */
function coordsInLink(raw: string): { lat: number; lng: number } | null {
  let href: string
  try { href = decodeURIComponent(raw) } catch { href = raw }
  for (const re of [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/]) {
    const m = href.match(re)
    if (m) { const lat = +m[1]!, lng = +m[2]!; if (inRange(lat, lng)) return { lat, lng } }
  }
  return null
}

const DROP_PIN_HELP = 'In Google Maps, long-press the exact spot to drop a pin, then Share → Copy link and paste it here. Or tap the numbers shown at the top (e.g. 24.833002, 67.063442) to copy them and paste those here.'

/** The first link in pasted text (WhatsApp / Maps share text often has words around it). */
const linkIn = (text: string) => text.match(/https?:\/\/\S+/)?.[0] ?? text.trim()

export function MapPin({ value, onChange, hint }: Props) {
  const [mapsLink, setMapsLink] = useState('')
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolvedName, setResolvedName] = useState<string | null>(null)

  async function resolveMapsLink(raw: string) {
    setError(null); setResolvedName(null)
    // Coordinates copied from Google Maps (long-press the spot, tap the numbers at the top): "24.833002, 67.063442".
    const ll = raw.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/)
    if (ll) {
      const lat = +ll[1]!, lng = +ll[2]!
      if (inRange(lat, lng)) { onChange({ lat, lng }); return }
    }
    const url = linkIn(raw)
    if (!url) return
    if (!/^https:\/\/(maps\.app\.goo\.gl|goo\.gl|([a-z]+\.)?google\.[a-z.]+)\//i.test(url)) {
      setError(DROP_PIN_HELP)
      return
    }
    const local = coordsInLink(url)
    if (local) { onChange(local); return }
    setResolving(true)
    try {
      const r = await api.get<{ lat: number; lng: number; name: string | null }>(`/concepts/resolve-maps-link?url=${encodeURIComponent(url)}`)
      onChange({ lat: r.lat, lng: r.lng })
      setResolvedName(r.name)
    } catch (err) {
      const code = (err as { code?: string }).code
      setError(code === 'NO_COORDS' ? `That link is to a named place, which carries no exact spot. ${DROP_PIN_HELP}` : ((err as Error).message || 'Could not read that link'))
    } finally {
      setResolving(false)
    }
  }

  const lat = value.lat, lng = value.lng
  const inputCls = 'w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none'

  return (
    <div className="space-y-2">
      <div>
        <label className="text-[11px] text-white/55 font-bold uppercase tracking-wider" htmlFor="maps-link">Google Maps link</label>
        <div className="flex flex-wrap sm:flex-nowrap gap-2 mt-1">
          <input
            id="maps-link"
            value={mapsLink}
            onChange={(e) => setMapsLink(e.target.value)}
            onPaste={(e) => {
              const t = e.clipboardData.getData('text')
              if (/goo\.gl|google\.[a-z.]+\/maps/i.test(t) || /^\s*-?\d{1,2}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?\s*$/.test(t)) { e.preventDefault(); setMapsLink(t.trim()); void resolveMapsLink(t) }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void resolveMapsLink(mapsLink) } }}
            placeholder="Google Maps link, or 24.833002, 67.063442"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button type="button" onClick={() => void resolveMapsLink(mapsLink)} disabled={resolving || !mapsLink.trim()}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-on hover:opacity-90 disabled:opacity-40 whitespace-nowrap">
            {resolving ? 'Reading…' : 'Use this link'}
          </button>
        </div>
        <p className="text-[11px] text-white/45 mt-1">In Google Maps, long-press the exact spot to drop a pin → Share → Copy link, then paste it here. Or paste the pin’s numbers (e.g. 24.833002, 67.063442).</p>
      </div>

      {lat != null && lng != null ? (
        <div className="rounded-lg px-3 py-2 text-[12px] flex flex-wrap items-center justify-between gap-2" style={{ background: 'color-mix(in srgb, var(--erp-success) 10%, transparent)' }}>
          <span className="text-white/80">
            <span className="font-bold text-success">Pin set</span>{resolvedName ? ` — ${resolvedName}` : ''}
            <span className="font-mono text-white/55"> · {lat.toFixed(5)}, {lng.toFixed(5)}</span>
          </span>
          <a href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noopener noreferrer" className="font-bold text-primary-ink hover:underline">
            Check in Google Maps ↗
          </a>
        </div>
      ) : (
        <p className="text-[11px] text-white/45">No pin yet.</p>
      )}

      {hint && <p className="text-[11px] text-white/35">{hint}</p>}
      {error && <p className="text-[11px] text-red-700">{error}</p>}
    </div>
  )
}
