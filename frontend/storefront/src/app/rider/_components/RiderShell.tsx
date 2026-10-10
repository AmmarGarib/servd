'use client'
// The frame around every servd.pk/rider screen (docs/rider-app.md):
//
//  - Renders only after mount. The session lives in localStorage, so the
//    server cannot know who is signed in; rendering on the client only avoids
//    a hydration mismatch and a flash of the wrong screen. (These pages are
//    noindex — there is nothing to server-render for.)
//  - Routes by session: signed out → /rider (sign in); signed in on /rider →
//    /rider/jobs. Follows sign-in, sign-out and token rotation in other tabs.
//  - Keeps the rider's status fresh (GET /rider/me every 15 s) and, while they
//    are on shift, shares their location (_lib/tracking) and keeps the screen
//    awake — on the web, location only flows while this page is open and on
//    screen, so a screen that dims and locks would silently stop it.
//  - Its own top bar. The servd header, footer and search stand down on
//    /rider (StorefrontNav / StorefrontFooter).

import { useEffect, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { isOnShift, riderApi } from '../../../lib/riderApi'
import { syncRiderSessionAcrossTabs, useRiderSession } from '../../../lib/riderSession'
import { startTracking, stopTracking } from '../_lib/tracking'
import { usePoll } from '../_lib/usePoll'
import { Spinner } from './ui'

const SIGN_IN_PATH = '/rider'
const HOME_PATH = '/rider/jobs'

type WakeLockSentinelLike = { release: () => Promise<void>; released?: boolean }
type WakeLockLike = { request: (type: 'screen') => Promise<WakeLockSentinelLike> }

function useScreenAwake(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock
    if (!wakeLock) return
    let sentinel: WakeLockSentinelLike | null = null
    let alive = true
    const acquire = async () => {
      if (!alive || document.visibilityState !== 'visible') return
      if (sentinel && !sentinel.released) return
      try {
        const s = await wakeLock.request('screen')
        if (!alive) { void s.release().catch(() => undefined); return }
        sentinel = s
      } catch { /* low battery mode, or the browser said no — nothing to do */ }
    }
    // The browser drops the lock whenever the page is hidden; take it again
    // when the rider comes back.
    const onVisible = () => { void acquire() }
    void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      if (sentinel) void sentinel.release().catch(() => undefined)
      sentinel = null
    }
  }, [active])
}

export function RiderShell({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname() ?? SIGN_IN_PATH
  const [mounted, setMounted] = useState(false)
  const accessToken = useRiderSession((s) => s.accessToken)
  const refreshToken = useRiderSession((s) => s.refreshToken)
  const rider = useRiderSession((s) => s.rider)
  const signedIn = !!(accessToken || refreshToken)
  const onShift = signedIn && isOnShift(rider?.status)
  const onSignIn = pathname === SIGN_IN_PATH || pathname === `${SIGN_IN_PATH}/`

  useEffect(() => {
    setMounted(true)
    return syncRiderSessionAcrossTabs()
  }, [])

  // Route by session.
  useEffect(() => {
    if (!mounted) return
    if (!signedIn && !onSignIn) router.replace(SIGN_IN_PATH)
    else if (signedIn && onSignIn) router.replace(HOME_PATH)
  }, [mounted, signedIn, onSignIn, router])

  // The rider's status (on / off shift, busy) — a manager can change it too.
  usePoll(async () => {
    try {
      const { rider: fresh } = await riderApi.me()
      if (fresh) useRiderSession.getState().setRider(fresh)
    } catch { /* offline: keep the last known status; a 401 clears the session */ }
  }, 15_000, mounted && signedIn)

  // Location while on shift; stops when the rider goes off shift, signs out
  // or leaves /rider.
  useEffect(() => {
    if (!mounted) return
    if (onShift) startTracking()
    else stopTracking()
  }, [mounted, onShift])
  useEffect(() => () => stopTracking(), [])

  useScreenAwake(mounted && onShift)

  const routing = mounted && ((!signedIn && !onSignIn) || (signedIn && onSignIn))

  return (
    <div className="flex min-h-dvh flex-col" style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}>
      <header
        className="sticky top-0 z-40 flex items-center gap-3 px-4 pb-3"
        style={{
          background: 'var(--servd-purple)',
          color: 'var(--servd-on-purple)',
          paddingTop: 'max(12px, env(safe-area-inset-top))',
        }}
      >
        <span className="text-[22px] font-extrabold leading-none tracking-tight" style={{ fontFamily: 'var(--font-wordmark)' }}>
          servd
        </span>
        <span
          className="rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.16em]"
          style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}
        >
          rider
        </span>
        {mounted && signedIn && rider ? (
          <span className="ml-auto flex min-w-0 items-center gap-2 text-[14px] font-bold">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                background: onShift ? 'var(--servd-green)' : 'transparent',
                border: onShift ? 'none' : '2px solid var(--servd-on-purple)',
              }}
            />
            <span className="truncate">{onShift ? 'On shift' : 'Off shift'}</span>
          </span>
        ) : null}
      </header>

      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col">
        {!mounted || routing ? (
          <div className="flex flex-1 items-center justify-center py-24" style={{ color: 'var(--servd-purple)' }}>
            <Spinner size={32} />
            <span className="sr-only">Loading</span>
          </div>
        ) : children}
      </div>
    </div>
  )
}
