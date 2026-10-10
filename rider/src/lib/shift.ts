// Going on / off shift. Going on shift is the rider's own action (the server
// no longer flips an offline rider to available on a location fix), and it is
// what starts location sharing; going off stops it.

import { useState } from 'react'
import { Alert } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'

import { api, ApiError, friendlyError } from './api'
import { permissionState, startTracking, stopTracking } from './location'
import { qk, useOnShift } from './queries'
import type { Rider } from './types'
import { sessionStore } from '../store/session'

// Google Play requires a prominent, in-app disclosure BEFORE the system
// background-location prompt; Apple wants the purpose clear too. Resolves
// true when the rider chooses to continue to the system prompt.
function backgroundDisclosure(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Share your location on shift',
      'servd rider shares your location with the kitchen while you are on shift — also when the app is closed '
      + 'or the phone is locked — so jobs can be sent to you and customers can follow their order. '
      + 'It stops when you go off shift.\n\nOn the next screen choose "Allow all the time" (Android) or "Always" (iPhone).',
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    )
  })
}

function confirm(title: string, body: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: ok, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) })
  })
}

export const ACTIVE_JOBS_MESSAGE =
  'You are carrying a job. Deliver it — or call the kitchen to take it off you — before going off shift.'

export function useShift() {
  const qc = useQueryClient()
  const onShift = useOnShift()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function applyResponse(res: unknown) {
    const rider = (res as { rider?: Rider } | undefined)?.rider
    if (rider) {
      qc.setQueryData(qk.me, { rider })
      // The saved profile too: the location task and the app-resume check
      // read the status from it.
      await sessionStore.getState().setRider(rider)
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.me }),
      qc.invalidateQueries({ queryKey: qk.jobs }),
    ])
  }

  async function goOn() {
    setBusy(true)
    setError(null)
    try {
      const perm = await permissionState().catch(() => null)
      let askBackground = false
      if (perm && perm.background !== 'granted' && perm.backgroundCanAsk) {
        askBackground = await backgroundDisclosure()
      }
      const res = await api.post('/rider/shift', { online: true })
      await startTracking({ askForeground: true, askBackground })
      await applyResponse(res)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function goOff() {
    const ok = await confirm(
      'Go off shift?',
      'You will stop getting jobs and your location stops being shared.',
      'Go off shift',
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/rider/shift', { online: false })
      await stopTracking()
      await applyResponse(res)
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'ACTIVE_JOBS' || err.status === 409)) {
        setError(ACTIVE_JOBS_MESSAGE)
      } else {
        setError(friendlyError(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return {
    onShift,
    busy,
    error,
    clearError: () => setError(null),
    toggle: () => (onShift ? goOff() : goOn()),
  }
}
