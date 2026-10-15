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

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

type Mode = 'me' | 'kiosk'
type Stage = 'idle' | 'working' | 'success' | 'error'

interface PresignedUpload { uploadUrl: string; publicUrl: string }
interface Status { punchedIn: boolean; shift?: { clockInAt: string; clockOutAt: string | null; geofenceOk: boolean }; missedClockOut?: { since: string } | null }
interface PunchResult {
  alreadyClockedIn?: boolean
  notClockedIn?: boolean
  /** A clock-in left open from an earlier day: flagged for HR, no hours. */
  missedClockOut?: { since: string; note: string }
  location?: string | null
  /** Where the punch was taken; outOfArea = outside every work location (recorded and flagged, never refused). */
  where?: { location?: string | null; outOfArea?: boolean; matched?: boolean | null; distanceM?: number | null; flagged?: boolean } | null
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

/** The line under a punch: where it was taken. Outside is allowed but flagged. */
const whereLine = (r: PunchResult) => {
  const w = r.where
  if (!w) return ''
  if (w.outOfArea) return ' Outside your work location — recorded and flagged for HR.'
  if (w.matched) return ` At ${w.location ?? r.location ?? 'your work location'} \u2713`
  return ''
}

const TZ = 'Asia/Karachi'
const clockTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
const clockStamp = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ })

/** Plain words for why the camera did not start. */
function cameraProblem(err: unknown): string {
  const name = (err as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera is blocked. Allow the camera for this site in the browser settings, then press Retry.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it, then press Retry.'
  return 'The camera did not start. Press Retry.'
}
function locationProblem(err: GeolocationPositionError | null): string {
  if (!err) return 'Location is not available on this device.'
  if (err.code === err.PERMISSION_DENIED) return 'Location is blocked. Allow location for this site in the browser settings, then press Retry.'
  if (err.code === err.TIMEOUT) return 'Finding your location took too long. Press Retry.'
  return 'Your location could not be found. Press Retry.'
}

export default function TimeClockPage() {
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const idRef = useRef<HTMLInputElement>(null)
  const pinRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coordsRef = useRef<{ lat: number; lng: number } | null>(null)
  const idLabelId = useId()

  const [mode, setMode] = useState<Mode>('me')
  const [code, setCode] = useState('')
  const [pin, setPin] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [feedback, setFeedback] = useState('')
  const [step, setStep] = useState('')
  const [flagged, setFlagged] = useState(false)
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [asked, setAsked] = useState(false)
  const [mediaNote, setMediaNote] = useState('')

  const status = useQuery({ queryKey: ['time-clock-status'], queryFn: () => api.get<Status>('/time-clock/status'), enabled: mode === 'me' })

  // Camera and location are asked for on the first punch, not on page load.
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); if (resetTimer.current) clearTimeout(resetTimer.current) }, [])

  const startCamera = useCallback(async (): Promise<string> => {
    if (streamRef.current?.active) return ''
    if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot use the camera.'
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      streamRef.current = stream
      const v = videoRef.current
      if (v) {
        v.srcObject = stream
        // Give the first frame a moment so the selfie is not black.
        for (let i = 0; i < 25 && !v.videoWidth; i++) await new Promise((r) => setTimeout(r, 100))
      }
      return ''
    } catch (err) { return cameraProblem(err) }
  }, [])

  const findPlace = useCallback((): Promise<string> => new Promise((resolve) => {
    if (coordsRef.current) return resolve('')
    if (!('geolocation' in navigator)) return resolve(locationProblem(null))
    navigator.geolocation.getCurrentPosition(
      (pos) => { const c = { lat: pos.coords.latitude, lng: pos.coords.longitude }; coordsRef.current = c; setCoords(c); resolve('') },
      (err) => resolve(locationProblem(err)),
      { enableHighAccuracy: true, timeout: 6000 },
    )
  }), [])

  /** Ask for what this punch needs. A refusal never blocks the punch (the server decides if a selfie is required); it is shown with Retry. */
  const ensureMedia = useCallback(async (camera: boolean) => {
    setAsked(true)
    const [cam, loc] = await Promise.all([camera ? startCamera() : Promise.resolve(''), findPlace()])
    const note = [cam, loc].filter(Boolean).join(' ')
    setMediaNote(note)
    return note
  }, [startCamera, findPlace])

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
    setStep('Taking selfie…')
    const blob = await snapSelfie()
    if (!blob) return undefined
    try {
      setStep('Sending selfie…')
      const { uploadUrl, publicUrl } = await api.get<PresignedUpload>(`/media/upload-url?filename=clockin-${Date.now()}.jpg&contentType=image/jpeg&category=clockin`)
      const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob })
      return res.ok ? publicUrl : undefined
    } catch {
      return undefined // the server refuses the punch if its rules need a selfie
    }
  }

  async function run(fn: () => Promise<string>) {
    if (inFlight.current) return // a second tap before React re-renders must not punch twice
    inFlight.current = true
    if (resetTimer.current) { clearTimeout(resetTimer.current); resetTimer.current = null }
    setStage('working'); setFeedback(''); setFlagged(false); setStep('Recording…')
    try {
      const msg = await fn()
      setFlagged(msg.includes('flagged for HR'))
      setFeedback(msg)
      setStage('success')
      void qc.invalidateQueries({ queryKey: ['time-clock-status'] })
      // Only a success clears itself; an error stays until the next input.
      resetTimer.current = setTimeout(() => { setStage('idle'); setFeedback(''); setFlagged(false) }, 6000)
    } catch (err) {
      setFeedback((err as Error).message || 'Something went wrong. Try again.')
      setStage('error')
    } finally {
      inFlight.current = false
      setStep('')
    }
  }

  const where = () => ({ ...(coordsRef.current && { lat: coordsRef.current.lat, lng: coordsRef.current.lng }) })

  const punchMe = (dir: 'in' | 'out') => run(async () => {
    setStep(dir === 'in' ? 'Starting camera and location…' : 'Finding your location…')
    await ensureMedia(dir === 'in')
    const selfie = dir === 'in' ? await selfieUrl() : undefined
    setStep('Recording…')
    const r = await api.post<PunchResult>(`/time-clock/punch-${dir}`, { ...where(), ...(dir === 'in' && { selfieUrl: selfie }) })
    if (r.alreadyClockedIn) return 'You are already clocked in.'
    const missed = r.missedClockOut ? ` ${r.missedClockOut.note}` : ''
    if (r.notClockedIn) return `You were not clocked in.${missed}`
    return dir === 'in'
      ? `Clocked in, ${user?.name ?? ''}.${whereLine(r)}${attendanceLine(r)}${missed}`
      : `Clocked out. Have a good night.${whereLine(r)}`
  })

  const canPunch = code.trim().length > 0 && pin.length >= 4
  const punchKiosk = () => {
    if (!canPunch || inFlight.current) return
    return run(async () => {
      try {
        setStep('Starting camera and location…')
        await ensureMedia(true)
        const selfie = await selfieUrl()
        setStep('Recording…')
        const r = await api.post<PunchResult>('/time-clock/kiosk/punch', { employeeCode: code.trim(), pin, ...where(), selfieUrl: selfie })
        setPin(''); setCode('')
        return r.action === 'in'
          ? `Welcome, ${r.employee?.fullName}. You are clocked in.${whereLine(r)}${attendanceLine(r)}`
          : `Goodbye, ${r.employee?.fullName}. You are clocked out.${whereLine(r)}`
      } catch (err) {
        setPin('') // a wrong PIN is typed again from the start; the ID stays
        throw err
      }
    })
  }

  // The next input clears an error that was left on screen.
  const clearError = () => { if (stage === 'error') { setStage('idle'); setFeedback('') } }

  // A physical keyboard drives the PIN pad: digits append, Backspace removes
  // one, Escape clears, Enter submits. Typing in the ID box stays in the ID box.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    if (mode !== 'kiosk' || e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target as HTMLElement | null
    const inId = t === idRef.current
    if (inId) {
      if (e.key === 'Enter') { e.preventDefault(); pinRef.current?.focus() }
      return
    }
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
    if (stage === 'working') return
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); clearError(); setPin((p) => (p.length < 6 ? p + e.key : p)) }
    else if (e.key === 'Backspace') { e.preventDefault(); clearError(); setPin((p) => p.slice(0, -1)) }
    else if (e.key === 'Escape' || e.key === 'Delete') { e.preventDefault(); clearError(); setPin('') }
    else if (e.key === 'Enter' && t?.tagName !== 'BUTTON') { e.preventDefault(); void punchKiosk() }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const switchMode = (m: Mode) => {
    setMode(m); setFeedback(''); setStage('idle'); setPin('')
    if (m === 'kiosk' && !window.matchMedia?.('(pointer: coarse)').matches) setTimeout(() => idRef.current?.focus(), 0)
  }

  const punchedIn = status.data?.punchedIn ?? false

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-md p-6">
        <div role="group" aria-label="Who is punching" className="flex gap-1 mb-4 justify-center">
          {(['me', 'kiosk'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => switchMode(m)}
              className="rounded-full px-4 min-h-11 text-xs font-bold"
              style={mode === m ? { background: 'var(--erp-accent-dim)', color: 'var(--text)', border: '1px solid var(--erp-accent)' } : { color: 'rgb(var(--fg-rgb) / 0.5)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }}>
              {m === 'me' ? 'Me' : 'Staff without a login'}
            </button>
          ))}
        </div>

        <div className="aspect-[4/3] max-h-[35vh] w-full rounded-2xl overflow-hidden mb-4 relative" style={{ background: 'var(--surface)', border: '1px solid var(--elevated)' }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          <canvas ref={canvasRef} className="hidden" />
          {!asked && <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-white/50">The camera and your location are asked for when you clock in.</p>}
          {asked && (
            <div className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
              style={{ background: coords ? 'rgb(var(--erp-accent-rgb) / 0.22)' : 'color-mix(in srgb, var(--erp-danger) 18%, transparent)', color: coords ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
              {coords ? 'located' : mediaNote ? 'no location' : 'locating…'}
            </div>
          )}
        </div>

        <h1 className="text-2xl font-black text-white text-center mb-1">Time clock</h1>
        <p className="text-xs text-white/50 text-center mb-6">
          {mode === 'me'
            ? 'Your punch writes your attendance for today. Selfie and location are kept with it.'
            : 'Type your employee ID, then the kiosk PIN HR gave you. Punching again clocks you out.'}
        </p>

        {mode === 'me' && stage !== 'working' && (
          <div className="space-y-3">
            <p className={`text-center text-sm ${punchedIn ? 'text-success' : 'text-white/70'}`}>
              {status.isLoading ? '…' : punchedIn ? `On shift since ${clockTime(status.data!.shift!.clockInAt)}` : 'Not clocked in'}
              {!punchedIn && status.data?.missedClockOut && (
                <span className="block text-xs text-white/50 mt-1">
                  Your clock-in of {clockStamp(status.data.missedClockOut.since)} was never clocked out — HR will correct that day.
                </span>
              )}
            </p>
            {punchedIn
              ? <button type="button" onClick={() => void punchMe('out')} className="w-full rounded-2xl py-4 text-lg font-black" style={{ background: 'color-mix(in srgb, var(--erp-danger) 15%, transparent)', color: 'var(--erp-danger)', border: '1px solid color-mix(in srgb, var(--erp-danger) 35%, transparent)' }}>Clock out</button>
              : <button type="button" onClick={() => void punchMe('in')} className="w-full rounded-2xl py-4 text-lg font-black" style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>Clock in</button>}
          </div>
        )}

        {mode === 'kiosk' && stage !== 'working' && (
          <>
            <label id={idLabelId} htmlFor={`${idLabelId}-in`} className="block text-xs font-bold text-white/60 mb-1">Employee ID</label>
            <input ref={idRef} id={`${idLabelId}-in`} type="text" value={code} onChange={(e) => { clearError(); setCode(e.target.value) }} placeholder="e.g. EMP-0012"
              autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="next"
              className="w-full mb-3 rounded-xl px-4 py-3 text-center text-white outline-none"
              style={{ background: 'rgb(var(--fg-rgb) / 0.05)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }} />
            <div ref={pinRef} tabIndex={0} role="group" aria-label={`PIN, ${pin.length} digits entered. Type 4 to 6 digits, then press Enter.`} className="text-center mb-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span aria-hidden="true" className="text-4xl font-black text-white tracking-[0.35em]" style={{ fontFamily: 'monospace' }}>
                {Array.from({ length: 6 }, (_, i) => (i < pin.length ? '●' : '○')).join('')}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <PinKey key={d} digit={d} onClick={() => { clearError(); setPin((p) => (p.length < 6 ? p + d : p)) }} />)}
              <PinKey digit="←" label="Delete last digit" onClick={() => { clearError(); setPin((p) => p.slice(0, -1)) }} />
              <PinKey digit="0" onClick={() => { clearError(); setPin((p) => (p.length < 6 ? p + '0' : p)) }} />
              <PinKey digit="✓" label="Clock in or out" highlight disabled={!canPunch} onClick={() => void punchKiosk()} />
            </div>
            {!canPunch && <p className="text-xs text-white/50 text-center mb-4">{code.trim() ? 'Enter your PIN (4 to 6 digits).' : 'Enter your employee ID, then your PIN.'}</p>}
          </>
        )}

        <div role="status" aria-live="polite">
          {stage === 'working' && <p className="text-center py-6 text-sm text-white/85 animate-pulse">{step || 'Recording…'}</p>}
          {feedback && (
            <div className="rounded-xl px-4 py-4 text-center mt-2"
              style={stage === 'error' || flagged ? { background: 'color-mix(in srgb, var(--erp-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' } : { background: 'var(--erp-accent-dim)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.6)' }}>
              <p className="text-sm font-bold" style={{ color: stage === 'error' || flagged ? 'var(--erp-danger)' : 'var(--erp-success)' }}>{feedback}</p>
            </div>
          )}
          {mediaNote && stage !== 'working' && (
            <div className="rounded-xl px-4 py-3 text-center mt-2 text-xs text-white/70" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.12)' }}>
              <p>{mediaNote}</p>
              <button type="button" className="mt-2 rounded-lg px-4 min-h-11 font-bold text-white/85 border border-white/15" onClick={() => void ensureMedia(true)}>Retry</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PinKey({ digit, onClick, highlight, label, disabled }: { digit: string; onClick: () => void; highlight?: boolean; label?: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} disabled={disabled} className="aspect-square rounded-2xl text-2xl font-black active:scale-95 transition-transform disabled:opacity-40"
      style={highlight ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' } : { background: 'rgb(var(--fg-rgb) / 0.06)', color: 'var(--text)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }}>
      <span aria-hidden={label ? true : undefined}>{digit}</span>
    </button>
  )
}
