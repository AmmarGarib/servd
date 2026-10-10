// Live location while on shift.
//
// Two ways to share, picked by what the rider allowed:
//
//  - BACKGROUND (preferred): Location.startLocationUpdatesAsync with the
//    TaskManager task below. Keeps going with the phone locked in a pocket —
//    Android runs it as a foreground service with a persistent notification,
//    iOS uses UIBackgroundModes: location (blue pill in the status bar).
//  - FOREGROUND fallback: Location.watchPositionAsync, only while the app is
//    open. Used when "Allow all the time" / "Always" was refused, or the
//    platform cannot run the task (Expo Go on iOS).
//
// Each fix is POSTed to /rider/location, tagged with the job the rider is
// carrying (stage picked_up / arrived) — read from the session store, which
// the task hydrates from SecureStore when Android starts it in a fresh JS
// context after the app was swiped away.
//
// Sharing stops when the SERVER says the rider is off shift, not only when the
// rider flips the switch: a manager can set them offline in admin, or they can
// go off shift on servd.pk/rider. The app's own shift check (useMe in the
// layout) pauses in the background, and the Android service outlives a
// swipe-away, so the task checks for itself — on every fix's answer
// (`onShift: false` / 409 OFF_SHIFT) and, as a fallback, with GET /rider/me
// every couple of minutes.
//
// The task MUST be defined at module scope before the app renders, so this
// file is imported from the entry point (index.ts), not from a screen.

import * as Location from 'expo-location'
import * as TaskManager from 'expo-task-manager'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

import { api, ApiError, friendlyError } from './api'
import { sessionStore } from '../store/session'
import { colors } from './theme'
import { isOnShift, type Rider } from './types'

export const LOCATION_TASK = 'servd-rider-location'

// The server accepts ~1 fix a second; one every 10 s is plenty for dispatch
// and the customer's map, and kinder to the rider's battery and data. iOS
// ignores timeInterval, so the gap is also enforced here.
const MIN_POST_GAP_MS = 9_000

// How often the task re-reads the rider's status itself (GET /rider/me), in
// case the server's answer to a fix does not say.
const SHIFT_CHECK_MS = 2 * 60_000

const TASK_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.High,
  distanceInterval: 25,
  timeInterval: 10_000,
  activityType: Location.ActivityType.AutomotiveNavigation,
  pausesUpdatesAutomatically: false,
  showsBackgroundLocationIndicator: true,
  foregroundService: {
    notificationTitle: 'servd rider — on shift, sharing location',
    notificationBody: 'The kitchen can see where you are. Go off shift in the app to stop.',
    notificationColor: colors.purple,
    killServiceOnDestroy: false,
  },
}

const WATCH_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.High,
  distanceInterval: 25,
  timeInterval: 10_000,
}

// ─── State the UI reads ─────────────────────────────────────────────────────

export type TrackingMode = 'off' | 'background' | 'foreground' | 'denied'

interface TrackingState {
  mode: TrackingMode
  lastSentAt: number | null
  lastError: string | null
  /** When sharing last stopped because the server said "off shift" — the
   *  signed-in layout re-reads /rider/me when this changes. */
  offShiftAt: number | null
}

export const trackingStore = createStore<TrackingState>(() => ({
  mode: 'off',
  lastSentAt: null,
  lastError: null,
  offShiftAt: null,
}))

export function useTracking<T>(selector: (s: TrackingState) => T): T {
  return useStore(trackingStore, selector)
}

// ─── Sending a fix ──────────────────────────────────────────────────────────

let lastSentAt = 0
let sending = false

function fixBody(loc: Location.LocationObject, orderId: string | null) {
  const c = loc.coords
  const body: Record<string, number | string> = { lat: c.latitude, lng: c.longitude }
  // Server bounds: heading 0–359, accuracy 0–10 000 m, speed ≥ 0. Platforms
  // report -1 for "unknown", so anything out of range is left off.
  if (typeof c.heading === 'number' && c.heading >= 0) body.heading = Math.floor(c.heading) % 360
  if (typeof c.accuracy === 'number' && c.accuracy >= 0 && c.accuracy <= 10_000) body.accuracy = c.accuracy
  if (typeof c.speed === 'number' && c.speed >= 0) body.speedMps = c.speed
  if (orderId) body.orderId = orderId
  return body
}

/** The server's answer to a fix: `{ onShift: false }` = the rider is offline
 *  there and the fix was not stored. */
type FixAnswer = { ok?: boolean; onShift?: boolean } | undefined

function offShiftAnswer(res: FixAnswer): boolean {
  return !!res && typeof res === 'object' && res.onShift === false
}

function offShiftError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'OFF_SHIFT'
}

/**
 * The server has the rider off shift (a manager set them offline, or they
 * went off shift on the web): stop sharing and remember the new status, so
 * the app shows "Off shift" and nothing restarts sharing until the rider goes
 * on shift again themselves.
 */
async function serverSaysOffShift(rider?: Rider): Promise<void> {
  await stopTracking()
  const s = sessionStore.getState()
  const next = rider ?? (s.rider ? { ...s.rider, status: 'offline' } : null)
  if (next && (rider || isOnShift(s.rider?.status))) await s.setRider(next)
  trackingStore.setState({ mode: 'off', lastError: null, offShiftAt: Date.now() })
}

let lastShiftCheckAt = 0

/** Fallback shift check from inside the task. True when sharing was stopped. */
async function checkShift(now: number): Promise<boolean> {
  if (now - lastShiftCheckAt < SHIFT_CHECK_MS) return false
  lastShiftCheckAt = now
  try {
    const d = await api.get<{ rider?: Rider }>('/rider/me')
    if (d?.rider && !isOnShift(d.rider.status)) {
      await serverSaysOffShift(d.rider)
      return true
    }
    if (d?.rider) await sessionStore.getState().setRider(d.rider)
  } catch {
    // Offline / server trouble: keep sharing; the fix itself may still land,
    // and the next check tries again.
  }
  return false
}

export async function sendFix(loc: Location.LocationObject): Promise<void> {
  const now = Date.now()
  if (sending || now - lastSentAt < MIN_POST_GAP_MS) return
  sending = true
  try {
    await sessionStore.getState().hydrate()
    const s = sessionStore.getState()
    if (!s.token && !s.refreshToken) {
      // Signed out while the task was running — nothing to send it as.
      await stopTracking()
      return
    }
    if (await checkShift(now)) return
    let res: FixAnswer
    try {
      res = await api.post<FixAnswer>('/rider/location', fixBody(loc, s.activeOrderId))
    } catch (err) {
      // The job was delivered / taken off this rider since we last looked.
      // Send the fix untagged and forget the stale order id.
      if (err instanceof ApiError && err.status === 422 && s.activeOrderId) {
        await sessionStore.getState().setActiveOrderId(null)
        res = await api.post<FixAnswer>('/rider/location', fixBody(loc, null))
      } else {
        throw err
      }
    }
    if (offShiftAnswer(res)) {
      await serverSaysOffShift()
      return
    }
    lastSentAt = now
    trackingStore.setState({ lastSentAt: now, lastError: null })
  } catch (err) {
    if (offShiftError(err)) {
      await serverSaysOffShift()
      return
    }
    if (err instanceof ApiError && err.status === 401) {
      await stopTracking()
    }
    trackingStore.setState({ lastError: friendlyError(err) })
  } finally {
    sending = false
  }
}

// ─── The background task ────────────────────────────────────────────────────

TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    trackingStore.setState({ lastError: error.message })
    return
  }
  const locs = data?.locations
  if (!locs || locs.length === 0) return
  // Updates can arrive batched; only the newest one matters.
  const latest = locs.reduce((a, b) => (b.timestamp > a.timestamp ? b : a))
  await sendFix(latest)
})

// ─── Foreground fallback ────────────────────────────────────────────────────

let watchSub: Location.LocationSubscription | null = null

async function startForegroundWatch(): Promise<void> {
  if (watchSub) return
  watchSub = await Location.watchPositionAsync(WATCH_OPTIONS, (loc) => { void sendFix(loc) })
}

function stopForegroundWatch(): void {
  watchSub?.remove()
  watchSub = null
}

// ─── Permissions ────────────────────────────────────────────────────────────

export interface PermissionState {
  foreground: Location.PermissionStatus
  foregroundCanAsk: boolean
  background: Location.PermissionStatus
  backgroundCanAsk: boolean
}

export async function permissionState(): Promise<PermissionState> {
  const [fg, bg] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync().catch(() => null),
  ])
  return {
    foreground: fg.status,
    foregroundCanAsk: fg.canAskAgain,
    background: bg?.status ?? Location.PermissionStatus.DENIED,
    backgroundCanAsk: bg?.canAskAgain ?? false,
  }
}

// ─── Start / stop ───────────────────────────────────────────────────────────

/**
 * Start sharing. Idempotent — safe to call on every app resume.
 *  askForeground: show the system prompt if "while using" is not granted yet.
 *  askBackground: show the "Always / Allow all the time" prompt. Only pass
 *    true right after the in-app disclosure (Play policy: a prominent
 *    disclosure must come before the background-location request).
 */
export function startTracking(opts: { askForeground: boolean; askBackground: boolean }): Promise<TrackingMode> {
  return serial(() => doStart(opts))
}

export function stopTracking(): Promise<void> {
  return serial(doStop)
}

// Start and stop run one at a time, in order. The shift switch, the layout's
// shift sync and the app-resume check can all fire together; without this two
// starts could each see "not running" and both start, or a stop could land in
// the middle of a start.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

async function doStart(opts: { askForeground: boolean; askBackground: boolean }): Promise<TrackingMode> {
  try {
    let fg = await Location.getForegroundPermissionsAsync()
    if (fg.status !== 'granted' && opts.askForeground && fg.canAskAgain) {
      fg = await Location.requestForegroundPermissionsAsync()
    }
    if (fg.status !== 'granted') {
      await doStop()
      trackingStore.setState({ mode: 'denied' })
      return 'denied'
    }

    let bg = await Location.getBackgroundPermissionsAsync().catch(() => null)
    if (bg && bg.status !== 'granted' && opts.askBackground && bg.canAskAgain) {
      bg = await Location.requestBackgroundPermissionsAsync().catch(() => bg)
    }

    if (bg?.status === 'granted' && await TaskManager.isAvailableAsync()) {
      try {
        const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)
        if (!running) await Location.startLocationUpdatesAsync(LOCATION_TASK, TASK_OPTIONS)
        stopForegroundWatch()
        trackingStore.setState({ mode: 'background', lastError: null })
        return 'background'
      } catch (err) {
        // e.g. Expo Go on iOS, or Android refusing to start the service —
        // fall back to sharing while the app is open.
        trackingStore.setState({ lastError: (err as Error).message })
      }
    }

    await startForegroundWatch()
    trackingStore.setState({ mode: 'foreground' })
    return 'foreground'
  } catch (err) {
    trackingStore.setState({ mode: 'denied', lastError: (err as Error).message })
    return 'denied'
  }
}

async function doStop(): Promise<void> {
  stopForegroundWatch()
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK)
    }
  } catch {
    // Not running / task unknown — nothing to stop.
  }
  trackingStore.setState({ mode: 'off' })
}

/** Best-effort current position for a job step ({ lat, lng } on the event). */
export async function quickFix(): Promise<{ lat: number; lng: number } | null> {
  try {
    const perm = await Location.getForegroundPermissionsAsync()
    if (perm.status !== 'granted') return null
    const last = await Location.getLastKnownPositionAsync({ maxAge: 2 * 60_000, requiredAccuracy: 200 })
    if (last) return { lat: last.coords.latitude, lng: last.coords.longitude }
    const now = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ])
    return now ? { lat: now.coords.latitude, lng: now.coords.longitude } : null
  } catch {
    return null
  }
}

// Signing out (or a refresh the server refused) clears the session — stop
// sharing the moment that happens, wherever it happened.
sessionStore.subscribe((s, prev) => {
  if ((prev.token || prev.refreshToken) && !s.token && !s.refreshToken) {
    void stopTracking()
  }
})
