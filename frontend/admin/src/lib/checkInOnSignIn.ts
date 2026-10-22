// Signing in checks you in (owner, 2026-10-22), only on a registered office
// network (HR settings; owner: "only when someone open servd on Office wifi"). Called right after a staff
// sign-in succeeds; signing out already checks you out (AppShell).
// Not for the CEO (admin) or directors. Only people with an HR employee record
// are checked in (`hrLinked` on GET /time-clock/status). It never blocks or fails the sign-in: any problem becomes a small
// toast and the person lands where sign-in normally lands.

import { toast } from 'sonner'
import { api, ApiError } from './api'
import { clockTime, type PunchResult } from '../components/hr/MyTimeClockCard'

const SKIP_ROLES = ['admin', 'director']
/** Not on a registered office network: nothing done (and the day is not used up). */
const OFF_NETWORK = 'off-network'
let inFlight: Promise<string | null> | null = null

function findPlace(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null), // refused or slow: check in without a location
      { enableHighAccuracy: true, timeout: 8000 },
    )
  })
}

/** Staff who stay signed in never pass the sign-in page, so the shell runs the
 *  same check once a Karachi day per login (owner, 2026-10-22: Days Worked
 *  stayed 0 because nobody signed in again after the release). */
export async function checkInOncePerDay(userId: string | undefined, role: string | undefined): Promise<string | null> {
  if (!userId || !role || SKIP_ROLES.includes(role)) return null
  const day = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10) // PKT
  const key = `servd_checkin_day:${userId}`
  try { if (localStorage.getItem(key) === day) return null } catch { /* storage off: the server check still stops repeats */ }
  if (inFlight) return inFlight // one check at a time per tab (the server also refuses a second 'in')
  inFlight = tryCheckIn(role, true).finally(() => { inFlight = null })
  const r = await inFlight
  // Away from the office the day is not used up: the shell asks again later
  // (on return to the tab), so arriving at the office still checks them in.
  if (r !== OFF_NETWORK) { try { localStorage.setItem(key, day) } catch { /* ignore */ } }
  return r === OFF_NETWORK ? null : r
}

/** Returns a page to send the person to ('/time-clock' when a selfie is needed), else null. */
export async function checkInOnSignIn(role: string | undefined): Promise<string | null> {
  const r = await tryCheckIn(role, false)
  return r === OFF_NETWORK ? null : r
}

async function tryCheckIn(role: string | undefined, firstOfDay: boolean): Promise<string | null> {
  if (!role || SKIP_ROLES.includes(role)) return null
  try {
    const status = await api.get<{ punchedIn: boolean; hrLinked?: boolean; shift?: unknown; onOfficeNetwork?: boolean }>('/time-clock/status')
    if (status.punchedIn || status.hrLinked === false) return null // no HR record: not checked in
    // Only on the office network (owner, 2026-10-22: "only when someone open servd on Office wifi").
    if (status.onOfficeNetwork !== true) return OFF_NETWORK
    // Already signed in (no fresh sign-in): only the day's first check-in, so a
    // person who checked out today is never checked back in by opening a page.
    if (firstOfDay && status.shift) return null
    const place = await findPlace()
    const r = await api.post<PunchResult>('/time-clock/punch-in', place ?? {})
    if (r.hrLinked === false || r.alreadyClockedIn) return null // no HR record: no attendance kept, say nothing
    toast.success(`Checked in at ${clockTime(new Date().toISOString())}`)
    return null
  } catch (err) {
    if (err instanceof ApiError && err.code === 'SELFIE_REQUIRED') {
      toast.message('Signed in. Take a selfie to check in.')
      return '/time-clock'
    }
    // No time clock for this login (403 / 404) is not worth a message.
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return null
    toast.message(`Signed in. Check in from your home screen: ${err instanceof Error ? err.message : 'something went wrong'}`)
    return null
  }
}
