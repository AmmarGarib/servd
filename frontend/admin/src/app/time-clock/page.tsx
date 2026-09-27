'use client'

// Time clock — the one punch screen in the admin (decision 32).
//
//   Me      the signed-in person clocks in or out. The punch is checked
//           against the company's geofence (any of its branches) and selfie
//           rule, logged, and written to their HR attendance for the day.
//   Kiosk   staff WITHOUT a login punch on this device with their HR employee
//           ID and the kiosk PIN HR set for them. In if their day is not open,
//           out if it is.
//
// There is no name field and no fake PIN any more: the old page asked for a
// PIN it never sent and clocked in whoever was signed in on the iPad.

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

type Mode = 'me' | 'kiosk'
type Stage = 'idle' | 'working' | 'success' | 'error'

interface PresignedUpload { uploadUrl: string; publicUrl: string }
interface Status { punchedIn: boolean; shift?: { clockInAt: string; clockOutAt: string | null; geofenceOk: boolean } }
interface PunchResult {
  alreadyClockedIn?: boolean
  notClockedIn?: boolean
  location?: string | null
  hrLinked?: boolean
  attendance?: { status: string | null; lateMinutes: number | null } | null
  action?: 'in' | 'out'
  employee?: { fullName: string }
}

const attendanceLine = (r: PunchResult) => {
  const a = r.attendance
  if (!a) return r.hrLinked === false ? ' (no HR record — attendance is not kept for this login)' : ''
  if (a.status === 'late') return ` Marked late by ${a.lateMinutes} min.`
  return ''
}

export default function TimeClockPage() {
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [mode, setMode] = useState<Mode>('me')
  const [code, setCode] = useState('')
  const [pin, setPin] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [feedback, setFeedback] = useState('')
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [geoErr, setGeoErr] = useState('')

  const status = useQuery({ queryKey: ['time-clock-status'], queryFn: () => api.get<Status>('/time-clock/status'), enabled: mode === 'me' })

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      } catch (err) {
        setFeedback(`Camera blocked: ${(err as Error).message}. If a selfie is required, ask a manager.`)
      }
      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => active && setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          (err) => active && setGeoErr(err.message),
          { enableHighAccuracy: true, timeout: 6000 },
        )
      }
    })()
    return () => { active = false; streamRef.current?.getTracks().forEach((t) => t.stop()) }
  }, [])

  function snapSelfie(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const video = videoRef.current, canvas = canvasRef.current
      if (!video || !canvas || !video.videoWidth || !video.videoHeight) return resolve(null)
      canvas.width = video.videoWidth; canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85)
    })
  }

  async function selfieUrl(): Promise<string | undefined> {
    const blob = await snapSelfie()
    if (!blob) return undefined
    try {
      const { uploadUrl, publicUrl } = await api.get<PresignedUpload>(`/media/upload-url?filename=clockin-${Date.now()}.jpg&contentType=image/jpeg&category=clockin`)
      const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob })
      return res.ok ? publicUrl : undefined
    } catch {
      return undefined // the server refuses the punch if its rules need a selfie
    }
  }

  async function run(fn: () => Promise<string>) {
    setStage('working'); setFeedback('')
    try {
      setFeedback(await fn())
      setStage('success')
      void qc.invalidateQueries({ queryKey: ['time-clock-status'] })
    } catch (err) {
      setFeedback((err as Error).message || 'Something went wrong. Try again.')
      setStage('error')
    }
    setTimeout(() => { setStage('idle') }, 5000)
  }

  const where = () => ({ ...(coords && { lat: coords.lat, lng: coords.lng }) })

  const punchMe = (dir: 'in' | 'out') => run(async () => {
    const r = await api.post<PunchResult>(`/time-clock/punch-${dir}`, { ...where(), ...(dir === 'in' && { selfieUrl: await selfieUrl() }) })
    if (r.alreadyClockedIn) return 'You are already clocked in.'
    if (r.notClockedIn) return 'You were not clocked in.'
    return dir === 'in'
      ? `Clocked in${r.location ? ` at ${r.location}` : ''}, ${user?.name ?? ''}.${attendanceLine(r)}`
      : 'Clocked out. Have a good night.'
  })

  const punchKiosk = () => run(async () => {
    const r = await api.post<PunchResult>('/time-clock/kiosk/punch', { employeeCode: code.trim(), pin, ...where(), selfieUrl: await selfieUrl() })
    setPin(''); setCode('')
    return r.action === 'in'
      ? `Welcome, ${r.employee?.fullName}. You are clocked in.${attendanceLine(r)}`
      : `Goodbye, ${r.employee?.fullName}. You are clocked out.`
  })

  const punchedIn = status.data?.punchedIn ?? false

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#090a0e' }}>
      <div className="w-full max-w-md p-6">
        <div className="flex gap-1 mb-4 justify-center">
          {(['me', 'kiosk'] as const).map((m) => (
            <button key={m} onClick={() => { setMode(m); setFeedback(''); setStage('idle') }}
              className="rounded-full px-4 py-1.5 text-xs font-bold"
              style={mode === m ? { background: '#22c55e', color: '#000' } : { color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.1)' }}>
              {m === 'me' ? 'Me' : 'Staff without a login'}
            </button>
          ))}
        </div>

        <div className="aspect-square rounded-2xl overflow-hidden mb-4 relative" style={{ background: '#0d0f15', border: '1px solid #1a1d24' }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          <canvas ref={canvasRef} className="hidden" />
          <div className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
            style={{ background: coords ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)', color: coords ? '#22c55e' : '#fca5a5' }}>
            {coords ? 'located' : geoErr ? 'no location' : 'locating…'}
          </div>
        </div>

        <h1 className="text-2xl font-black text-white text-center mb-1">Time clock</h1>
        <p className="text-xs text-white/50 text-center mb-6">
          {mode === 'me'
            ? 'Your punch writes your attendance for today. Selfie and location are kept with it.'
            : 'Type your employee ID and the kiosk PIN HR gave you. Punching again clocks you out.'}
        </p>

        {mode === 'me' && stage !== 'working' && (
          <div className="space-y-3">
            <p className="text-center text-sm text-white/70">
              {status.isLoading ? '…' : punchedIn ? `On shift since ${new Date(status.data!.shift!.clockInAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Not clocked in'}
            </p>
            {punchedIn
              ? <button onClick={() => punchMe('out')} className="w-full rounded-2xl py-4 text-lg font-black" style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.35)' }}>Clock out</button>
              : <button onClick={() => punchMe('in')} className="w-full rounded-2xl py-4 text-lg font-black" style={{ background: '#22c55e', color: '#000' }}>Clock in</button>}
          </div>
        )}

        {mode === 'kiosk' && stage !== 'working' && (
          <>
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Employee ID (e.g. EMP-0012)" autoComplete="off"
              className="w-full mb-3 rounded-xl px-4 py-3 text-center text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} />
            <div className="text-center mb-3">
              <span className="text-4xl font-black text-white tracking-[0.5em]" style={{ fontFamily: 'monospace' }}>{pin.split('').map(() => '●').join('') || '____'}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <PinKey key={d} digit={d} onClick={() => setPin((p) => (p.length < 6 ? p + d : p))} />)}
              <PinKey digit="←" onClick={() => setPin((p) => p.slice(0, -1))} />
              <PinKey digit="0" onClick={() => setPin((p) => (p.length < 6 ? p + '0' : p))} />
              <PinKey digit="✓" highlight onClick={() => { if (code.trim() && pin.length >= 4) void punchKiosk(); else setFeedback('Type your employee ID and PIN.') }} />
            </div>
          </>
        )}

        {stage === 'working' && <p className="text-center py-6 text-sm text-white/85 animate-pulse">Recording…</p>}
        {feedback && (
          <div className="rounded-xl px-4 py-4 text-center mt-2"
            style={stage === 'error' ? { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' } : { background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)' }}>
            <p className="text-sm font-bold" style={{ color: stage === 'error' ? '#fca5a5' : '#86efac' }}>{feedback}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function PinKey({ digit, onClick, highlight }: { digit: string; onClick: () => void; highlight?: boolean }) {
  return (
    <button onClick={onClick} className="aspect-square rounded-2xl text-2xl font-black active:scale-95 transition-transform"
      style={highlight ? { background: '#22c55e', color: '#000' } : { background: 'rgba(255,255,255,0.06)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)' }}>
      {digit}
    </button>
  )
}
