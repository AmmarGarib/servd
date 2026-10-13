'use client'
// The signed-voucher photo: compressed in the browser before it goes up, and
// read back with the session attached (the API serves it only to a login that
// can see the voucher, so a plain <img src> would not authenticate).

import { api, ApiError } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { CV_BASE } from './data'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/** Long edge of the uploaded photo, and the JPEG quality (owner spec, 2026-10-13). */
const MAX_EDGE = 1600
const QUALITY = 0.8
/** Keep the JSON body well under the API's request limit; above this, step down. */
const TARGET_BYTES = 700 * 1024

export interface PreparedPhoto {
  /** base64 of the JPEG, without the `data:` prefix. */
  base64: string
  mime: 'image/jpeg'
  bytes: number
  width: number
  height: number
  /** For the preview (revoke when done). */
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
    r.onerror = () => reject(new Error('This browser could not prepare the photo. Try another device.'))
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
 * GET /trustops/cash-vouchers/:id/photo with the session → a blob URL for an
 * <img>. The caller revokes it. A lapsed session is refreshed through the
 * normal client (any api.get refreshes on 401) and the read tried once more.
 */
export async function fetchPhotoUrl(id: string, retry = true): Promise<string> {
  const token = useAuthStore.getState().token
  const portfolio = typeof window !== 'undefined' && localStorage.getItem('servd_view_all_tenants') === '1'
  const res = await fetch(`${API_URL}/api/v1${CV_BASE}/${id}/photo`, {
    credentials: 'include',
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(portfolio && { 'x-servd-portfolio': '1' }),
    },
  })
  if (res.status === 401 && retry) {
    await api.get('/permissions/me')       // refreshes the session (or signs out)
    return fetchPhotoUrl(id, false)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? 'The photo could not be loaded.')
  }
  return URL.createObjectURL(await res.blob())
}

export function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}
