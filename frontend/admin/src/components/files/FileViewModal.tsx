'use client'
// One file shown in the browser: a photo as an image, a PDF in a frame. The
// bytes come from an authenticated fetch (api.fetchBlob) — never a public URL.
// The shared viewer of record files (<RecordFiles>); the caller passes the
// API path and the stored type, and the object URL is revoked on close.
// Photos zoom in / out, rotate and pan (owner, 2026-11-17: "give option for zoom in zoom out for attachments");
// a PDF uses the browser's own viewer, which has its own zoom.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { Modal } from '../ui/Modal'

export const isViewable = (mime: string) => mime === 'application/pdf' || mime.startsWith('image/')

const ZOOMS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5]

export function FileViewModal({ path, mime, name, onClose }: { path: string; mime: string; name: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let made: string | null = null
    let live = true
    api.fetchBlob(path)
      .then((blob) => {
        made = URL.createObjectURL(new Blob([blob], { type: mime }))
        if (live) setUrl(made); else URL.revokeObjectURL(made)
      })
      .catch((e: Error) => { if (live) setError(e.message || 'The file could not be loaded.') })
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [path, mime])

  return (
    <Modal title={name} onClose={onClose} wide>
      {error ? (
        <p role="alert" className="text-sm" style={{ color: 'var(--erp-danger)' }}>{error}</p>
      ) : !url ? (
        <p className="text-sm text-white/50">Loading…</p>
      ) : mime === 'application/pdf' ? (
        <iframe src={url} title={name} className="w-full rounded-lg" style={{ height: '75vh', border: '1px solid var(--border)' }} />
      ) : (
        <ZoomableImage url={url} name={name} />
      )}
    </Modal>
  )
}

function ZoomableImage({ url, name }: { url: string; name: string }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [turn, setTurn] = useState(0) // quarter turns
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const sideways = turn % 2 === 1
  const nw = natural?.w ?? 0, nh = natural?.h ?? 0
  const fit = natural && box.w && box.h ? Math.min(1, box.w / (sideways ? nh : nw), box.h / (sideways ? nw : nh)) : 1
  const w = nw * fit * zoom, h = nh * fit * zoom
  const frameW = sideways ? h : w, frameH = sideways ? w : h

  // Keep the view centred on the same spot when the zoom changes.
  const setZoomKeepCentre = useCallback((next: number) => {
    const el = boxRef.current
    const z = Math.min(ZOOMS[ZOOMS.length - 1]!, Math.max(1, next))
    if (!el) { setZoom(z); return }
    const cx = (el.scrollLeft + el.clientWidth / 2) / Math.max(1, el.scrollWidth)
    const cy = (el.scrollTop + el.clientHeight / 2) / Math.max(1, el.scrollHeight)
    setZoom(z)
    requestAnimationFrame(() => {
      el.scrollLeft = cx * el.scrollWidth - el.clientWidth / 2
      el.scrollTop = cy * el.scrollHeight - el.clientHeight / 2
    })
  }, [])
  const step = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 1e-6)
    const at = i < 0 ? ZOOMS.length - 1 : i
    setZoomKeepCentre(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + dir))]!)
  }

  // Ctrl / ⌘ + wheel (and a trackpad pinch) zooms; a plain wheel scrolls.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoomKeepCentre(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom, setZoomKeepCentre])

  const btn = 'rounded-lg border border-s-border px-2.5 py-1.5 text-xs font-bold text-s-text hover:bg-white/[0.04] disabled:opacity-40'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => step(-1)} disabled={zoom <= 1} aria-label="Zoom out">−</button>
        <span className="min-w-[3.5rem] text-center text-xs tabular-nums text-s-muted" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" className={btn} onClick={() => step(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} aria-label="Zoom in">+</button>
        <button type="button" className={btn} onClick={() => setZoomKeepCentre(1)} disabled={zoom === 1}>Fit</button>
        <button type="button" className={btn} onClick={() => setTurn((t) => (t + 1) % 4)}>Rotate</button>
        <span className="hidden sm:inline text-[11px] text-s-muted">Drag to move · Ctrl + scroll to zoom · double-click to zoom in</span>
      </div>
      <div ref={boxRef}
        className="relative h-[70vh] w-full overflow-auto rounded-lg"
        style={{ background: 'rgb(var(--ink-rgb) / 0.04)', cursor: zoom > 1 ? 'grab' : 'zoom-in', touchAction: zoom > 1 ? 'none' : 'auto' }}
        onDoubleClick={() => (zoom >= ZOOMS[ZOOMS.length - 1]! ? setZoomKeepCentre(1) : step(1))}
        onPointerDown={(e) => {
          const el = boxRef.current
          if (!el || zoom <= 1) return
          drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
          el.setPointerCapture(e.pointerId)
          el.style.cursor = 'grabbing'
        }}
        onPointerMove={(e) => {
          const el = boxRef.current, d = drag.current
          if (!el || !d) return
          el.scrollLeft = d.left - (e.clientX - d.x)
          el.scrollTop = d.top - (e.clientY - d.y)
        }}
        onPointerUp={(e) => {
          const el = boxRef.current
          drag.current = null
          if (el) { el.releasePointerCapture(e.pointerId); el.style.cursor = zoom > 1 ? 'grab' : 'zoom-in' }
        }}>
        <div className="relative" style={{
          width: natural ? frameW : '100%', height: natural ? frameH : '100%',
          margin: natural ? `${Math.max(0, (box.h - frameH) / 2)}px ${Math.max(0, (box.w - frameW) / 2)}px` : undefined,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={name} draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className="absolute select-none rounded-lg"
            style={natural ? {
              width: w, height: h, maxWidth: 'none', left: (frameW - w) / 2, top: (frameH - h) / 2,
              transform: `rotate(${turn * 90}deg)`,
            } : { maxWidth: '100%', maxHeight: '100%', position: 'static' }} />
        </div>
      </div>
    </div>
  )
}
