'use client'

// The signed-in person's punch — the ONE "Me" punch flow (decision 32).
// Used by the Time clock page (variant "full", today's wording) and at the top
// of every workspace home (variant "card", a compact row: "Check in" /
// "Check out"). Calls GET /time-clock/status and POST /time-clock/punch-in|out;
// the server decides the geofence, the selfie rule and the late mark.
// In the card variant nothing is rendered while loading or when the login has no
// time clock (403 / 404), so it never blocks or clutters the page.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LogIn, LogOut, MapPin } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

type Stage = 'idle' | 'working' | 'success' | 'error'

interface PresignedUpload { uploadUrl: string; publicUrl: string }
interface Status { punchedIn: boolean; shift?: { clockInAt: string; clockOutAt: string | null; geofenceOk: boolean }; missedClockOut?: { since: string } | null }
export interface PunchResult {
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

export const attendanceLine = (r: PunchResult) => {
  const a = r.attendance
  if (!a) return r.hrLinked === false ? ' (no HR record — attendance is not kept for this login)' : ''
  if (a.status === 'late') return ` Marked late by ${a.lateMinutes} min.`
  return ''
}

/** The line under a punch: where it was taken. Outside is allowed but flagged. */
export const whereLine = (r: PunchResult) => {
  const w = r.where
  if (!w) return ''
  if (w.outOfArea) return ' Outside your work location — recorded and flagged for HR.'
  if (w.matched) return ` At ${w.location ?? r.location ?? 'your work location'}.`
  return ''
}

export const TZ = 'Asia/Karachi'
export const clockTime = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ })
const clockStamp = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ })

/** Plain words for why the camera did not start. */
export function cameraProblem(err: unknown): string {
  const name = (err as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera is blocked. Allow the camera for this site in the browser settings, then press Retry.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it, then press Retry.'
  return 'The camera did not start. Press Retry.'
}
export function locationProblem(err: GeolocationPositionError | null): string {
  if (!err) return 'Location is not available on this device.'
  if (err.code === err.PERMISSION_DENIED) return 'Location is blocked. Allow location for this site in the browser settings, then press Retry.'
  if (err.code === err.TIMEOUT) return 'Finding your location took too long. Press Retry.'
  return 'Your location could not be found. Press Retry.'
}

interface Props {
  variant?: 'card' | 'full'
  /** full variant: shown between the camera box and the punch controls. */
  heading?: React.ReactNode
  /** Tells the page which branch the punch matched (shown in the time clock header). */
  onBranch?: (name: string) => void
}

export default function MyTimeClockCard({ variant = 'card', heading, onBranch }: Props) {
  const full = variant === 'full'
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const inFlight = useRef(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coordsRef = useRef<{ lat: number; lng: number } | null>(null)

  const [stage, setStage] = useState<Stage>('idle')
  const [feedback, setFeedback] = useState('')
  const [step, setStep] = useState('')
  const [flagged, setFlagged] = useState(false)
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [asked, setAsked] = useState(false)
  const [mediaNote, setMediaNote] = useState('')

  const status = useQuery({
    queryKey: ['time-clock-status'],
    queryFn: () => api.get<Status>('/time-clock/status'),
    // 403 / 404 = no time clock for this login: do not retry, show nothing.
    retry: (n, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 404)) && n < 1,
  })

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
    const branch = r.where?.location ?? r.location
    if (branch) onBranch?.(branch)
    if (!full) { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null } // card: camera off once the punch is recorded
    if (full) {
      if (r.alreadyClockedIn) return 'You are already clocked in.'
      const missed = r.missedClockOut ? ` ${r.missedClockOut.note}` : ''
      if (r.notClockedIn) return `You were not clocked in.${missed}`
      return dir === 'in'
        ? `Clocked in, ${user?.name ?? ''}.${whereLine(r)}${attendanceLine(r)}${missed}`
        : `Clocked out. Have a good night.${whereLine(r)}`
    }
    if (r.alreadyClockedIn) return 'You are already checked in.'
    const missed = r.missedClockOut ? ` ${r.missedClockOut.note}` : ''
    if (r.notClockedIn) return `You were not checked in.${missed}`
    return dir === 'in'
      ? `You checked in at ${clockTime(new Date().toISOString())}.${whereLine(r)}${attendanceLine(r)}${missed}`
      : `You checked out at ${clockTime(new Date().toISOString())}.${whereLine(r)}`
  })

  const punchedIn = status.data?.punchedIn ?? false

  // Card: nothing while loading, nothing when this login has no time clock.
  if (!full && (status.isLoading || status.isError || !status.data)) return null

  const inLabel = full ? 'Clock in' : 'Check in'
  const outLabel = full ? 'Clock out' : 'Check out'
  const bad = stage === 'error' || flagged
  const feedbackBox = feedback && (
    <div className="rounded-xl px-4 py-3 text-center mt-2"
      style={bad ? { background: 'color-mix(in srgb, var(--erp-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' } : { background: 'var(--erp-accent-dim)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.6)' }}>
      <p className="text-sm font-bold" style={{ color: bad ? 'var(--erp-danger)' : 'var(--erp-success)' }}>{feedback}</p>
    </div>
  )
  const noteBox = mediaNote && stage !== 'working' && (
    <div className="rounded-xl px-4 py-3 text-center mt-2 text-xs text-white/70" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.12)' }}>
      <p>{mediaNote}</p>
      <button type="button" className="mt-2 rounded-lg px-4 min-h-11 font-bold text-white/85 border border-white/15" onClick={() => void ensureMedia(true)}>Retry</button>
    </div>
  )
  const locatedBadge = asked && (
    <div className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
      style={{ background: coords ? 'rgb(var(--erp-accent-rgb) / 0.22)' : 'color-mix(in srgb, var(--erp-danger) 18%, transparent)', color: coords ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
      <MapPin size={10} aria-hidden="true" className="mr-1 inline-block align-[-1px]" />{coords ? 'located' : mediaNote ? 'no location' : 'locating…'}
    </div>
  )

  if (full) {
    return (
      <>
        <div className="aspect-[4/3] max-h-[35vh] w-full rounded-2xl overflow-hidden mb-4 relative" style={{ background: 'var(--surface)', border: '1px solid var(--elevated)' }}>
          <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
          <canvas ref={canvasRef} className="hidden" />
          {!asked && <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-white/50">The camera and your location are asked for when you clock in.</p>}
          {locatedBadge}
        </div>
        {heading}
        {stage !== 'working' && (
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
              ? <button type="button" onClick={() => void punchMe('out')} className="w-full rounded-2xl py-4 text-lg font-black" style={{ background: 'color-mix(in srgb, var(--erp-danger) 15%, transparent)', color: 'var(--erp-danger)', border: '1px solid color-mix(in srgb, var(--erp-danger) 35%, transparent)' }}><span className="inline-flex items-center justify-center gap-2"><LogOut size={22} aria-hidden="true" />{outLabel}</span></button>
              : <button type="button" onClick={() => void punchMe('in')} className="w-full rounded-2xl py-4 text-lg font-black" style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}><span className="inline-flex items-center justify-center gap-2"><LogIn size={22} aria-hidden="true" />{inLabel}</span></button>}
          </div>
        )}
        <div role="status" aria-live="polite">
          {stage === 'working' && <p className="text-center py-6 text-sm text-white/85 animate-pulse">{step || 'Recording…'}</p>}
          {feedbackBox}
          {noteBox}
        </div>
      </>
    )
  }

  // Compact card for the workspace home.
  const missed = !punchedIn && status.data?.missedClockOut
  return (
    <section aria-label="Check in and check out" className="mb-5 rounded-2xl px-4 py-3" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-black ${punchedIn ? 'text-success' : 'text-white/85'}`}>
            {punchedIn ? `Checked in at ${clockTime(status.data!.shift!.clockInAt)}` : 'Not checked in'}
          </p>
          {missed && status.data?.missedClockOut && (
            <p className="text-xs text-white/50 mt-0.5">Your check-in of {clockStamp(status.data.missedClockOut.since)} was never checked out. HR will correct that day.</p>
          )}
        </div>
        {stage === 'working'
          ? <p className="text-sm text-white/85 animate-pulse" role="status">{step || 'Recording…'}</p>
          : punchedIn
            ? <button type="button" onClick={() => void punchMe('out')} className="rounded-xl px-4 min-h-11 text-sm font-black" style={{ background: 'color-mix(in srgb, var(--erp-danger) 15%, transparent)', color: 'var(--erp-danger)', border: '1px solid color-mix(in srgb, var(--erp-danger) 35%, transparent)' }}><span className="inline-flex items-center gap-2"><LogOut size={18} aria-hidden="true" />{outLabel}</span></button>
            : <button type="button" onClick={() => void punchMe('in')} className="rounded-xl px-4 min-h-11 text-sm font-black" style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}><span className="inline-flex items-center gap-2"><LogIn size={18} aria-hidden="true" />{inLabel}</span></button>}
      </div>
      {/* The camera opens here only once a check-in asks for it. */}
      <div className={asked && (stage === 'working' || !punchedIn) ? 'mt-3 aspect-[4/3] max-h-48 w-full max-w-xs rounded-xl overflow-hidden relative' : 'hidden'}
        style={{ background: 'var(--surface)', border: '1px solid var(--elevated)' }}>
        <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
        {locatedBadge}
      </div>
      <canvas ref={canvasRef} className="hidden" />
      <div role="status" aria-live="polite">
        {feedbackBox}
        {noteBox}
      </div>
    </section>
  )
}
