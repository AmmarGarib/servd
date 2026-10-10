// Jobs — the home screen. Shift switch at the top, then the jobs assigned to
// this rider (oldest first, as the server sends them). Polls every 15 s while
// on shift; pull down to refresh any time.

import { useEffect, useRef } from 'react'
import { FlatList, RefreshControl, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'

import { Banner } from '../../../src/components/Card'
import { JobCard } from '../../../src/components/JobCard'
import { LocationStatus } from '../../../src/components/LocationStatus'
import { ShiftToggle } from '../../../src/components/ShiftToggle'
import { friendlyError } from '../../../src/lib/api'
import { useJobs, useMe } from '../../../src/lib/queries'
import { useShift } from '../../../src/lib/shift'
import { colors, theme } from '../../../src/lib/theme'
import type { Job } from '../../../src/lib/types'
import { useSessionStore } from '../../../src/store/session'

export default function JobsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const me = useMe()
  const cachedRider = useSessionStore(s => s.rider)
  const rider = me.data?.rider ?? cachedRider
  const jobs = useJobs()
  const shift = useShift()

  // A buzz when a new offer lands while the app is open.
  const seenOffers = useRef<Set<string> | null>(null)
  useEffect(() => {
    const list = jobs.data?.jobs
    if (!list) return
    const offered = list.filter(j => j.stage === 'offered').map(j => j.orderId)
    if (seenOffers.current && offered.some(id => !seenOffers.current!.has(id))) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined)
    }
    seenOffers.current = new Set(offered)
  }, [jobs.data])

  const list: Job[] = jobs.data?.jobs ?? []
  const firstName = (rider?.name ?? '').split(/\s+/)[0] || 'Rider'

  function open(job: Job) {
    router.push({ pathname: '/job/[orderId]', params: { orderId: job.orderId } })
  }

  const header = (
    <View style={{ gap: 14, marginBottom: 14 }}>
      <View style={{
        backgroundColor: colors.purple,
        paddingTop: insets.top + 16,
        paddingHorizontal: theme.pad,
        paddingBottom: 18,
        gap: 14,
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
      }}>
        <View>
          <Text style={{ color: colors.onPurple, fontSize: 26, fontWeight: '900' }} numberOfLines={1}>
            Hi {firstName}
          </Text>
          {rider?.companyName ? (
            <Text style={{ color: colors.onPurpleDim, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
              {rider.companyName} fleet
            </Text>
          ) : null}
        </View>
        <ShiftToggle onShift={shift.onShift} busy={shift.busy} onPress={() => void shift.toggle()} />
      </View>

      <View style={{ paddingHorizontal: theme.pad, gap: 14 }}>
        {shift.error ? (
          <Banner tone="danger" title="Shift not changed" body={shift.error} actionLabel="OK" onAction={shift.clearError} />
        ) : null}
        <LocationStatus onShift={shift.onShift} />
        {jobs.error ? (
          <Banner
            tone="danger"
            title="Could not load your jobs"
            body={friendlyError(jobs.error)}
            actionLabel="Try again"
            onAction={() => void jobs.refetch()}
          />
        ) : null}
        {list.length > 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '900', letterSpacing: 1.4 }}>
            YOUR JOBS ({list.length})
          </Text>
        ) : null}
      </View>
    </View>
  )

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingBottom: 32, gap: 12 }}
      data={list}
      keyExtractor={(j) => j.orderId}
      renderItem={({ item }) => (
        <View style={{ paddingHorizontal: theme.pad }}>
          <JobCard job={item} onPress={() => open(item)} />
        </View>
      )}
      ListHeaderComponent={header}
      ListEmptyComponent={jobs.isLoading ? (
        <Text style={{ color: colors.textDim, fontSize: 16, textAlign: 'center', marginTop: 24 }}>Loading jobs…</Text>
      ) : jobs.error ? null : (
        <EmptyState onShift={shift.onShift} />
      )}
      refreshControl={
        <RefreshControl
          refreshing={jobs.isRefetching && !jobs.isLoading}
          onRefresh={() => { void jobs.refetch(); void me.refetch() }}
          tintColor={colors.purple}
          colors={[colors.purple]}
          progressViewOffset={insets.top}
        />
      }
    />
  )
}

function EmptyState({ onShift }: { onShift: boolean }) {
  return (
    <View style={{
      alignItems: 'center', gap: 10, marginTop: 24, marginHorizontal: theme.pad, padding: theme.padLg,
      borderRadius: theme.radiusLg, borderWidth: 2, borderStyle: 'dashed', borderColor: colors.borderHi,
    }}>
      <Text style={{ color: colors.ink, fontSize: 20, fontWeight: '900', textAlign: 'center' }}>
        {onShift ? 'No jobs right now' : 'You are off shift'}
      </Text>
      <Text style={{ color: colors.textDim, fontSize: 16, textAlign: 'center', lineHeight: 22 }}>
        {onShift
          ? 'New jobs show up here by themselves. Keep the app open and your phone with you.'
          : 'Go on shift to start getting jobs. Your location is shared only while you are on shift.'}
      </Text>
    </View>
  )
}
