'use client'
import { useEffect, useRef, useState } from 'react'
import { Camera, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useAuthStore } from '../../store/auth'

const API_URL = typeof window !== 'undefined'
  ? (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001')
  : 'http://localhost:3001'

interface Props {
  itemId: string
  itemName: string
  isUrdu: boolean
  onClose: () => void
}

/**
 * After bump, optionally capture a plating photo via webcam, upload to R2,
 * and attach the URL to the OrderItem. Auto-dismisses if the user skips.
 */
export function PhotoBumpModal({ itemId, itemName, isUrdu, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [snapped, setSnapped] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Acquire camera on mount
  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices?.getUserMedia({ video: { width: 640, height: 480 }, audio: false })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return }
        setStream(s)
        if (videoRef.current) {
          videoRef.current.srcObject = s
          videoRef.current.play().catch(() => null)
        }
      })
      .catch(() => setError(isUrdu ? 'کیمرا دستیاب نہیں' : 'Camera not available — skip'))
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-dismiss after 12s if user takes no action
  useEffect(() => {
    const t = setTimeout(() => onClose(), 12_000)
    return () => clearTimeout(t)
  }, [onClose])

  function snap() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    setSnapped(canvas.toDataURL('image/jpeg', 0.85))
    stream?.getTracks().forEach((t) => t.stop())
  }

  async function upload() {
    if (!snapped) return
    setUploading(true)
    setError(null)
    try {
      const blob = await (await fetch(snapped)).blob()
      const filename = `bump-${itemId}-${Date.now()}.jpg`
      const token = useAuthStore.getState().token   // F43

      const presignRes = await fetch(
        `${API_URL}/api/v1/media/upload-url?filename=${encodeURIComponent(filename)}&contentType=image/jpeg&category=kds`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      )
      if (!presignRes.ok) throw new Error('Failed to get upload URL')
      const { uploadUrl, publicUrl } = await presignRes.json() as { uploadUrl: string; publicUrl: string }

      await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' } })

      // Attach URL to the order item
      await fetch(`${API_URL}/api/v1/order-items/${itemId}/bump-photo`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ url: publicUrl }),
      })
      onClose()
    } catch {
      setError(isUrdu ? 'اپ لوڈ ناکام' : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const modal = (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/85 p-4" onClick={onClose}>
      <div
        className="relative w-full max-w-md rounded-2xl bg-kds-card border border-kds-border overflow-hidden shadow-2xl"
        dir={isUrdu ? 'rtl' : 'ltr'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 flex items-center justify-between border-b border-kds-border">
          <p className="font-bold text-kds-text">
            <Camera size={16} aria-hidden="true" className="inline-block align-[-3px] mr-1.5" />{isUrdu ? 'پلیٹنگ کی تصویر' : 'Plating photo'} — {itemName}
          </p>
          <button onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center text-kds-subtext hover:text-kds-text"><X size={20} aria-hidden="true" /></button>
        </div>

        <div className="aspect-video bg-black relative">
          {!snapped ? (
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
          ) : (
            <img src={snapped} alt="captured" className="w-full h-full object-cover" />
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-kds-amber text-sm">
              {error}
            </div>
          )}
        </div>
        <canvas ref={canvasRef} className="hidden" />

        <div className="p-3 flex items-center gap-2 justify-end">
          <button
            onClick={onClose}
            className="min-h-11 rounded-lg border border-kds-border text-kds-subtext px-4 py-1.5 text-sm font-bold hover:text-kds-text"
          >
            {isUrdu ? 'چھوڑیں' : 'Skip'}
          </button>
          {!snapped && !error && (
            <button
              onClick={snap}
              className="min-h-11 inline-flex items-center gap-1.5 rounded-lg bg-kds-green text-primary-on px-4 py-1.5 text-sm font-black"
            >
              <Camera size={16} aria-hidden="true" />{isUrdu ? 'تصویر لیں' : 'Capture'}
            </button>
          )}
          {snapped && (
            <button
              onClick={upload}
              disabled={uploading}
              className="min-h-11 rounded-lg bg-kds-green text-primary-on px-4 py-1.5 text-sm font-black disabled:opacity-50"
            >
              {uploading ? (isUrdu ? 'اپلوڈ…' : 'Uploading…') : (isUrdu ? 'محفوظ' : 'Save')}
            </button>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
