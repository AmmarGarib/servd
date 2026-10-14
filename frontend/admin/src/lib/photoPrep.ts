'use client'
// Evidence photos (petty-cash receipts, cash-request receipts, the signed
// cash-voucher photo): compressed in the browser before they go up, and read
// back with the session attached — the API serves an evidence file only to a
// login that may see it, so a plain <img src> would not authenticate.
//
// The one copy of these helpers (moved here from finance/cash-vouchers/photo.ts,
// which re-exports them for the voucher pages).

import { api, ApiError } from './api'
import { useAuthStore } from '../store/auth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/** Long edge of the uploaded photo, and the JPEG quality (owner spec, 2026-10-13). */
const MAX_EDGE = 1600
const QUALITY = 0.8
/** Keep the JSON body well under the API's request limit; above this, step down. */
const TARGET_BYTES = 700 * 1024
/** The API's largest decoded evidence file (lib/evidenceFile.ts). */
export const EVIDENCE_MAX_BYTES = 3 * 1024 * 1024

export interface PreparedPhoto {
  /** base64 of the file, without the `data:` prefix. */
  base64: string
  mime: 'image/jpeg' | 'application/pdf'
  bytes: number
  width: number
  height: number
  /** For the preview (revoke when done). Empty for a PDF. */
  previewUrl: string
}

function loadImage(file: File): Promise<{ img: HTMLImageElement; src: string }> {
  const src = URL.createObjectURL(file)
  return new Promise((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve({ img: el, src })
    el.onerror = () => { URL.revokeObjectURL(src); reject(new Error('That photo could not be read. Take it again, or pick a JPEG or PNG.')) }
    el.src = src
  })
}

function encode(img: HTMLImageElement, maxEdge: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser could not prepare the photo. Try another device.')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve({ blob: b, width: canvas.width, height: canvas.height })
      else reject(new Error('This browser could not prepare the photo. Try another device.'))
    }, 'image/jpeg', quality)
  })
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result ?? '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(new Error('This browser could not prepare the file. Try another device.'))
    r.readAsDataURL(blob)
  })
}

/**
 * Re-encode a camera / gallery photo as a JPEG, at most 1600 px on its long
 * side at quality 0.8. Phones may hand over HEIC or a 12 MP image; a very
 * detailed shot that is still large steps down (quality, then 1280 px) so the
 * upload stays small.
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (file.type && !file.type.startsWith('image/')) throw new Error('Pick a photo (an image file).')
  const { img, src } = await loadImage(file)
  try {
    const steps: Array<[number, number]> = [[MAX_EDGE, QUALITY], [MAX_EDGE, 0.7], [1280, 0.7], [1280, 0.6]]
    let out = await encode(img, steps[0]![0], steps[0]![1])
    for (const [edge, q] of steps.slice(1)) {
      if (out.blob.size <= TARGET_BYTES) break
      out = await encode(img, edge, q)
    }
    return {
      base64: await toBase64(out.blob),
      mime: 'image/jpeg',
      bytes: out.blob.size,
      width: out.width,
      height: out.height,
      previewUrl: URL.createObjectURL(out.blob),
    }
  } finally {
    URL.revokeObjectURL(src)
  }
}

/**
 * A receipt: a photo is compressed (preparePhoto); a PDF goes up as it is,
 * when it is no larger than the API takes (3 MB).
 */
export async function prepareReceiptFile(file: File): Promise<PreparedPhoto> {
  if (file.type === 'application/pdf') {
    if (file.size > EVIDENCE_MAX_BYTES) throw new Error('That PDF is larger than 3 MB — scan it at a lower resolution, or take a photo instead.')
    return { base64: await toBase64(file), mime: 'application/pdf', bytes: file.size, width: 0, height: 0, previewUrl: '' }
  }
  return preparePhoto(file)
}

/**
 * GET an evidence file (an API path under /api/v1, e.g.
 * '/trustops/petty-cash/receipts/<id>') with the session → a blob URL for an
 * <img> or a link. The caller revokes it. A lapsed session is refreshed
 * through the normal client and the read tried once more.
 */
export async function fetchEvidenceUrl(path: string, retry = true): Promise<string> {
  const token = useAuthStore.getState().token
  const portfolio = typeof window !== 'undefined' && localStorage.getItem('servd_view_all_tenants') === '1'
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    credentials: 'include',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(portfolio && { 'x-servd-portfolio': '1' }),
    },
  })
  if (res.status === 401 && retry) {
    await api.get('/permissions/me')       // refreshes the session (or signs out)
    return fetchEvidenceUrl(path, false)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? 'The file could not be loaded.')
  }
  return URL.createObjectURL(await res.blob())
}

export function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}
