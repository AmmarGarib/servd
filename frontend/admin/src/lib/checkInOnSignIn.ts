// Signing in checks you in (owner, 2026-10-22). Called right after a staff
// sign-in succeeds; signing out already checks you out (AppShell).
// Not for the CEO (admin) or directors. Only people with an HR employee record
// are checked in (`hrLinked` on GET /time-clock/status). It never blocks or fails the sign-in: any problem becomes a small
// toast and the person lands where sign-in normally lands.

import { toast } from 'sonner'
import { api, ApiError } from './api'
import { clockTime, type PunchResult } from '../components/hr/MyTimeClockCard'

const SKIP_ROLES = ['admin', 'director']

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

/** Returns a page to send the person to ('/time-clock' when a selfie is needed), else null. */
export async function checkInOnSignIn(role: string | undefined): Promise<string | null> {
  if (!role || SKIP_ROLES.includes(role)) return null
  try {
    const status = await api.get<{ punchedIn: boolean; hrLinked?: boolean }>('/time-clock/status')
    if (status.punchedIn || status.hrLinked === false) return null // no HR record: not checked in
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
