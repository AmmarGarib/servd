'use client'
// What the rider needs to know about location on the web version: it only
// updates while this page is open and on screen, and the app is the way to
// share it with the phone locked. Plus the live state (sharing / waiting /
// blocked) and a retry when the browser refused.

import { useEffect, useState } from 'react'
import { agoShort } from '../_lib/format'
import { startTracking, useTracking } from '../_lib/tracking'
import { Banner, Button, PinIcon } from './ui'

/** Re-render every few seconds so "sent 12 s ago" stays true. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

export function LocationBanner() {
  const mode = useTracking((s) => s.mode)
  const lastSentAt = useTracking((s) => s.lastSentAt)
  const lastError = useTracking((s) => s.lastError)
  const accuracyM = useTracking((s) => s.accuracyM)
  const now = useNow(5_000)

  if (mode === 'denied' || mode === 'unavailable') {
    return (
      <Banner
        tone="danger"
        title="Your location is not being shared"
        action={mode === 'denied'
          ? <Button intent="secondary" size="md" onClick={startTracking}>Try again</Button>
          : null}
      >
        {lastError ?? 'Allow location for servd.pk in your browser settings.'}{' '}
        The kitchen cannot see where you are, and new jobs may go to other riders.
      </Banner>
    )
  }

  const sharing = mode === 'on' && lastSentAt != null && now - lastSentAt < 60_000
  const status =
    mode === 'starting' ? 'Finding your location…'
      : sharing ? `Location shared ${agoShort(lastSentAt, now)}${accuracyM != null ? ` · within ${accuracyM} m` : ''}`
        : lastError ?? 'Waiting to send your location…'

  return (
    <Banner tone="strong" title={<span className="flex items-center gap-2"><PinIcon size={18} /> Keep this page open</span>}>
      <p>
        Your location only updates while this page is open and on screen. If you switch apps or lock the phone, it stops.
        Install the servd rider app to share it with the phone locked — ask your manager for it.
      </p>
      <p className="mt-2 font-bold" aria-live="polite">{status}</p>
    </Banner>
  )
}
