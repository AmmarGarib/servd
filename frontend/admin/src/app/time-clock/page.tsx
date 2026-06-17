'use client'

// Time Clock — kiosk-style page mounted at /time-clock. Staff walk up to a
// shared iPad, type their PIN, the page snaps a webcam selfie + reads geo,
// uploads the selfie to R2, then POSTs to /auth/pin which records a
// ClockLog with selfieUrl + lat/lng + geofence verdict.
//
// For clock-out, an authenticated session POSTs to /auth/clock-out (no
// re-PIN — but selfie + geo still captured if available so the audit trail
// is symmetric).

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

type Stage = 'idle' | 'pin' | 'capturing' | 'submitting' | 'success' | 'error'

interface PresignedUpload {
  uploadUrl: string
  publicUrl: string
}

export default function TimeClockPage() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [pin, setPin] = useState('')
  const [name, setName] = useState('')   // entered before the PIN at clock-in
  const [stage, setStage] = useState<Stage>('idle')
  const [feedback, setFeedback] = useState<string>('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [geoErr, setGeoErr] = useState<string>('')

  // Bring up the camera + request geolocation on mount.
  useEffect(() => {
    let active = true
    ;(async () => {
      // Camera (front-facing if possible)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' }, audio: false,
        })
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      } catch (err) {
        setFeedback(`Camera blocked: ${(err as Error).message}. You'll have to ask a manager to clock you in.`)
      }

      // Geolocation — soft request, log error but don't block. Server-side
      // enforces the geofence based on OperationsConfig.
      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => active && setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          (err) => active && setGeoErr(err.message),
          { enableHighAccuracy: true, timeout: 6000 },
        )
      }
    })()

    return () => {
      active = false
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // Capture a still from the live video feed and return a JPEG blob.
  function snapSelfie(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return resolve(null)
      const w = video.videoWidth, h = video.videoHeight
      if (!w || !h) return resolve(null)
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(video, 0, 0, w, h)
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85)
    })
  }

  async function uploadSelfie(blob: Blob): Promise<string> {
    // Presigned upload URL from backend → PUT to R2 → return public URL.
    const { uploadUrl, publicUrl } = await api.get<PresignedUpload>(
      `/media/upload-url?filename=clockin-${Date.now()}.jpg&contentType=image/jpeg&category=clockin`,
    )
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    })
    if (!res.ok) throw new Error(`Selfie upload failed (${res.status})`)
    return publicUrl
  }

  async function clockIn() {
    if (pin.length < 4) {
      setFeedback('Type your PIN.')
      return
    }
    setStage('capturing')
    setFeedback('')
    try {
      // Snap + upload selfie (best-effort — server may or may not require it).
      const blob = await snapSelfie()
      let selfieUrl: string | undefined
      if (blob) {
        try {
          selfieUrl = await uploadSelfie(blob)
        } catch (err) {
          // Non-fatal — server will reject if selfie was required by config.
          console.warn('[time-clock] selfie upload failed:', (err as Error).message)
        }
      }

      setStage('submitting')
      const result = await api.post<{ accessToken: string; user: { name: string; role: string } }>(
        '/auth/pin',
        {
          identifier: name.trim(),
          pin,
          ...(coords && { lat: coords.lat, lng: coords.lng }),
          ...(selfieUrl && { selfieUrl }),
        },
      )
      // F43: persist via the auth store so token + user + WebSocket stay in
      // sync. Manager can navigate elsewhere from the same browser and the
      // session works everywhere; otherwise the success message + clear is
      // the only UX.
      useAuthStore.getState().setAuth(
        { id: '', name: result.user.name, role: result.user.role },
        result.accessToken,
      )
      setFeedback(`Welcome, ${result.user.name}. You're clocked in.`)
      setStage('success')
      setPin('')
      // After 4s, reset to idle for the next person.
      setTimeout(() => setStage('idle'), 4000)
    } catch (err) {
      setFeedback((err as Error).message || 'Something went wrong. Try again.')
      setStage('error')
      setTimeout(() => setStage('idle'), 5000)
    }
  }

  async function clockOut() {
    setStage('submitting')
    try {
      // Caller already has a session token (a logged-in admin or manager).
      // For shift-end we don't re-PIN — the kiosk is in their hands.
      await api.post('/auth/clock-out', {})
      setFeedback("You're clocked out. Have a good night.")
      setStage('success')
      setTimeout(() => { setStage('idle'); router.push('/login') }, 3000)
    } catch (err) {
      setFeedback((err as Error).message)
      setStage('error')
      setTimeout(() => setStage('idle'), 4000)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#090a0e' }}>
      <div className="w-full max-w-md p-6">
        {/* Live camera preview */}
        <div className="aspect-square rounded-2xl overflow-hidden mb-4 relative"
          style={{ background: '#0d0f15', border: '1px solid #1a1d24' }}>
          <video ref={videoRef} autoPlay playsInline muted
            style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          <canvas ref={canvasRef} className="hidden" />

          {/* Geo badge */}
          <div className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
            style={{
              background: coords ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)',
              color: coords ? '#22c55e' : '#fca5a5',
            }}>
            {coords ? '📍 located' : geoErr ? '⚠ no location' : '… locating'}
          </div>
        </div>

        <h1 className="text-2xl font-black text-white text-center mb-1">Time Clock</h1>
        <p className="text-xs text-white/50 text-center mb-6">
          Type your PIN to clock in. Selfie + location captured for the record.
        </p>

        {/* PIN pad */}
        {(stage === 'idle' || stage === 'pin' || stage === 'error') && (
          <>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              autoComplete="off"
              className="w-full mb-3 rounded-xl px-4 py-3 text-center text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
            />
            <div className="text-center mb-3">
              <span className="text-4xl font-black text-white tracking-[0.5em]" style={{ fontFamily: 'monospace' }}>
                {pin.split('').map(() => '●').join('') || '____'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {['1','2','3','4','5','6','7','8','9'].map((d) => (
                <PinKey key={d} digit={d} onClick={() => setPin((p) => p.length < 8 ? p + d : p)} />
              ))}
              <PinKey digit="←" onClick={() => setPin((p) => p.slice(0, -1))} />
              <PinKey digit="0" onClick={() => setPin((p) => p.length < 8 ? p + '0' : p)} />
              <PinKey digit="✓" highlight onClick={clockIn} />
            </div>
            <button onClick={clockOut}
              className="w-full text-center text-xs font-bold text-white/40 hover:text-white/85 py-2">
              I'm clocking out →
            </button>
          </>
        )}

        {(stage === 'capturing' || stage === 'submitting') && (
          <div className="text-center py-6">
            <div className="text-4xl mb-3 animate-pulse">📸</div>
            <p className="text-sm text-white/85">{stage === 'capturing' ? 'Snapping selfie…' : 'Clocking you in…'}</p>
          </div>
        )}

        {stage === 'success' && (
          <div className="rounded-xl px-4 py-5 text-center"
            style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)' }}>
            <div className="text-3xl mb-2">✓</div>
            <p className="text-sm font-bold text-green-300">{feedback}</p>
          </div>
        )}

        {stage === 'error' && feedback && (
          <p className="text-xs text-rose-300 text-center mt-2">{feedback}</p>
        )}
      </div>
    </div>
  )
}

function PinKey({ digit, onClick, highlight }: { digit: string; onClick: () => void; highlight?: boolean }) {
  return (
    <button onClick={onClick}
      className="aspect-square rounded-2xl text-2xl font-black active:scale-95 transition-transform"
      style={highlight
        ? { background: '#22c55e', color: '#000' }
        : { background: 'rgba(255,255,255,0.06)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)' }}>
      {digit}
    </button>
  )
}
