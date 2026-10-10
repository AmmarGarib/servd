// Live location for servd.pk/rider while the rider is on shift AND this page
// is open (docs/rider-app.md). The web cannot share location with the phone
// locked or the tab in the background — that is what the native app in
// rider/ is for — so the screens say so plainly (LocationBanner).
//
// navigator.geolocation.watchPosition feeds the latest fix; it is POSTed to
// /rider/location at most once every 10 s, tagged with the job the rider is
// carrying (lib/riderSession activeOrderId). A rider standing still gets no
// new fixes from watchPosition on some phones, so a heartbeat asks for a
// fresh one when the last is getting old.
//
// Module state, not component state: the shell (RiderShell) starts and stops
// it, and it keeps running across the jobs list and job detail screens.
//
// When the server answers a fix with "off shift" (`onShift: false`, or 409
// OFF_SHIFT — a manager set the rider offline, or they went off shift in the
// app), the saved status flips to offline and the shell stops sharing at once,
// without waiting for its next GET /rider/me.

import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { RiderApiError, friendlyError, riderApi, type Pos, type RiderFix } from '../../../lib/riderApi'
import { useRiderSession } from '../../../lib/riderSession'

/** The server accepts about one fix a second; one every 10 s is plenty. */
const MIN_POST_GAP_MS = 10_000
/** Ask for a fresh fix when the newest one is older than this. */
const STALE_FIX_MS = 30_000
/** Never send (or attach to a step) a fix older than this. */
const MAX_FIX_AGE_MS = 2 * 60_000
const HEARTBEAT_MS = 10_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type TrackingMode =
  | 'off'          // not on shift (or signed out)
  | 'starting'     // waiting for the first fix / the permission prompt
  | 'on'           // fixes arriving
  | 'denied'       // the rider (or the browser) refused location
  | 'unavailable'  // no geolocation here (old browser, or not https)

export interface TrackingState {
  mode: TrackingMode
  lastFixAt: number | null
  lastSentAt: number | null
  accuracyM: number | null
  lastError: string | null
}

export const trackingStore = createStore<TrackingState>(() => ({
  mode: 'off',
  lastFixAt: null,
  lastSentAt: null,
  accuracyM: null,
  lastError: null,
}))

export function useTracking<T>(selector: (s: TrackingState) => T): T {
  return useStore(trackingStore, selector)
}

let watchId: number | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let latest: GeolocationPosition | null = null
let lastPostAt = 0
let posting = false
let refreshing = false

const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 }

function geolocationAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext !== false && 'geolocation' in navigator
}

/**
 * Start sharing. Idempotent. Call it straight from the "Go on shift" tap as
 * well as from the shell, so the browser's permission prompt comes from the
 * rider's own gesture the first time.
 */
export function startTracking(): void {
  if (watchId !== null) return
  if (!geolocationAvailable()) {
    trackingStore.setState({
      mode: 'unavailable',
      lastError: 'This browser cannot share your location. Open servd.pk/rider in Chrome or Safari.',
    })
    return
  }
  trackingStore.setState({ mode: 'starting', lastError: null })
  watchId = navigator.geolocation.watchPosition(onFix, onGeoError, GEO_OPTIONS)
  if (!heartbeat) heartbeat = setInterval(tick, HEARTBEAT_MS)
}

/** Stop sharing (off shift, signed out, or the rider left the page). */
export function stopTracking(): void {
  if (watchId !== null && geolocationAvailable()) navigator.geolocation.clearWatch(watchId)
  watchId = null
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  latest = null
  trackingStore.setState({ mode: 'off', accuracyM: null, lastError: null })
}

function onFix(pos: GeolocationPosition): void {
  if (watchId === null) return // a late callback after stopTracking
  latest = pos
  trackingStore.setState({
    mode: 'on',
    lastFixAt: pos.timestamp || Date.now(),
    accuracyM: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
  })
  void maybeSend()
}

function onGeoError(err: GeolocationPositionError): void {
  if (err.code === err.PERMISSION_DENIED) {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId)
    watchId = null
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    trackingStore.setState({
      mode: 'denied',
      lastError: 'Location is blocked for this site. Allow location for servd.pk in your browser settings, then tap Try again.',
    })
    return
  }
  // POSITION_UNAVAILABLE / TIMEOUT: no signal right now. watchPosition keeps
  // trying by itself; just say so.
  trackingStore.setState({
    lastError: err.code === err.TIMEOUT
      ? 'Waiting for a GPS signal…'
      : 'Your phone cannot find its location right now. Check that location (GPS) is switched on.',
  })
}

function tick(): void {
  if (watchId === null) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const age = latest ? Date.now() - latest.timestamp : Infinity
  if (age > STALE_FIX_MS && !refreshing) {
    refreshing = true
    navigator.geolocation.getCurrentPosition(
      (pos) => { refreshing = false; onFix(pos) },
      () => { refreshing = false },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    )
    return
  }
  void maybeSend()
}

function fixBody(pos: GeolocationPosition, orderId: string | null): RiderFix {
  const c = pos.coords
  const body: RiderFix = { lat: c.latitude, lng: c.longitude }
  // Server bounds: heading 0–359, accuracy 0–10 000 m, speed ≥ 0. Browsers
  // report null / NaN for "unknown", so anything out of range is left off.
  if (typeof c.heading === 'number' && Number.isFinite(c.heading) && c.heading >= 0) {
    body.heading = Math.floor(c.heading) % 360
  }
  if (Number.isFinite(c.accuracy) && c.accuracy >= 0 && c.accuracy <= 10_000) body.accuracy = c.accuracy
  if (typeof c.speed === 'number' && Number.isFinite(c.speed) && c.speed >= 0) body.speedMps = c.speed
  if (orderId && UUID_RE.test(orderId)) body.orderId = orderId
  return body
}

async function maybeSend(): Promise<void> {
  const pos = latest
  if (!pos || posting) return
  const now = Date.now()
  if (now - lastPostAt < MIN_POST_GAP_MS) return
  if (now - pos.timestamp > MAX_FIX_AGE_MS) return
  // A fix from an IP lookup (desktop, no GPS) is no use to dispatch, and the
  // API refuses accuracy over 10 km.
  if (Number.isFinite(pos.coords.accuracy) && pos.coords.accuracy > 10_000) {
    trackingStore.setState({ lastError: 'Your location is too rough to share. Switch on GPS / precise location.' })
    return
  }
  const session = useRiderSession.getState()
  if (!session.accessToken) return
  posting = true
  lastPostAt = now
  try {
    let res: unknown
    try {
      res = await riderApi.location(fixBody(pos, session.activeOrderId))
    } catch (err) {
      // The job was delivered / taken off this rider since we last looked:
      // forget the stale order and send the fix untagged.
      if (err instanceof RiderApiError && err.status === 422 && session.activeOrderId) {
        useRiderSession.getState().setActiveOrderId(null)
        res = await riderApi.location(fixBody(pos, null))
      } else {
        throw err
      }
    }
    if (res && typeof res === 'object' && (res as { onShift?: unknown }).onShift === false) {
      serverSaysOffShift()
      return
    }
    trackingStore.setState({ lastSentAt: Date.now(), lastError: null })
  } catch (err) {
    if (err instanceof RiderApiError && err.code === 'OFF_SHIFT') {
      serverSaysOffShift()
      return
    }
    if (err instanceof RiderApiError && err.code === 'SESSION_ENDED') {
      stopTracking()
      return
    }
    trackingStore.setState({ lastError: friendlyError(err) })
  } finally {
    posting = false
  }
}

/** The server has this rider off shift: stop, and save the status so the
 *  shell (which starts sharing from it) does not start it again. */
function serverSaysOffShift(): void {
  stopTracking()
  const { rider, setRider } = useRiderSession.getState()
  if (rider && rider.status !== 'offline') setRider({ ...rider, status: 'offline' })
}

/** The rider's position for a job step (accept, picked up, …): the latest fix
 *  when it is recent, nothing otherwise. Never waits for the GPS. */
export function currentPos(): Pos {
  if (!latest || Date.now() - latest.timestamp > MAX_FIX_AGE_MS) return {}
  return { lat: latest.coords.latitude, lng: latest.coords.longitude }
}
