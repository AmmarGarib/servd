'use client'
// One file shown in the browser: a photo as an image, a PDF in a frame. The
// bytes come from an authenticated fetch (api.fetchBlob) — never a public URL.
// The shared viewer of record files (<RecordFiles>); the caller passes the
// API path and the stored type, and the object URL is revoked on close.

import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { Modal } from '../ui/Modal'

export const isViewable = (mime: string) => mime === 'application/pdf' || mime.startsWith('image/')

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
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} className="mx-auto max-h-[75vh] max-w-full rounded-lg object-contain" />
      )}
    </Modal>
  )
}
