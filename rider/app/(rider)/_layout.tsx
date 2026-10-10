// Signed-in area: the tabs (Jobs, Profile) plus the job detail screen pushed
// on top. This layout also keeps three things in step with the server for as
// long as the rider is signed in:
//
//  1. Location sharing follows the shift: on shift -> sharing, off -> stopped
//     (also when a manager sets the rider offline from admin — the location
//     task notices that by itself even with the app closed, and this layout
//     re-reads the rider's status when it does).
//  2. The job being carried (stage picked_up / arrived) is saved for the
//     location task, which tags every fix with it.
//  3. Coming back to the app re-checks both, and upgrades foreground-only
//     sharing to background if "Always" was granted in Settings meanwhile.

import { useEffect } from 'react'
import { AppState } from 'react-native'
import { Stack } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { theme } from '../../src/lib/theme'
import { qk, useJobs, useMe, useOnShift } from '../../src/lib/queries'
import { startTracking, stopTracking, useTracking } from '../../src/lib/location'
import { sessionStore } from '../../src/store/session'
import { carryingJob, isOnShift } from '../../src/lib/types'

export default function RiderLayout() {
  const qc = useQueryClient()
  const me = useMe()
  const jobs = useJobs()
  const onShift = useOnShift()
  const known = !!me.data

  // 1. Location follows the shift (only once the server has told us).
  useEffect(() => {
    if (!known) return
    if (onShift) void startTracking({ askForeground: false, askBackground: false })
    else void stopTracking()
  }, [known, onShift])

  // 1b. The location task found the rider off shift on the server and stopped
  //     sharing: refresh the status so the screens say "Off shift" too.
  const offShiftAt = useTracking((s) => s.offShiftAt)
  useEffect(() => {
    if (offShiftAt) void qc.invalidateQueries({ queryKey: qk.me })
  }, [offShiftAt, qc])

  // 2. The job being carried, for the location task.
  const carryingId = jobs.data ? (carryingJob(jobs.data.jobs)?.orderId ?? null) : undefined
  useEffect(() => {
    if (carryingId === undefined) return
    void sessionStore.getState().setActiveOrderId(carryingId)
  }, [carryingId])

  // 3. Back in the foreground: re-check sharing (the refetch of me / jobs is
  //    React Query's focus refetch, wired to AppState in app/_layout.tsx).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // The saved profile too: the location task marks it offline when the
      // server took the rider off shift while the app was in the background,
      // before the refetch of /rider/me has landed.
      if (state === 'active' && onShift && isOnShift(sessionStore.getState().rider?.status)) {
        void startTracking({ askForeground: false, askBackground: false })
      }
    })
    return () => sub.remove()
  }, [onShift])

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.bg },
      }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="job/[orderId]"
        options={{
          headerShown: true,
          title: 'Job',
          headerStyle: { backgroundColor: theme.purple },
          headerTintColor: theme.onPurple,
          headerTitleStyle: { fontWeight: '800' },
          headerBackTitle: 'Jobs',
        }}
      />
    </Stack>
  )
}
