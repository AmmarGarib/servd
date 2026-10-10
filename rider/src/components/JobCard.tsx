// One job in the list: stage, brand + order number, where from -> where to,
// and the cash to collect. The whole card is the tap target.

import { Pressable, Text, View } from 'react-native'

import { StageBadge } from './Card'
import { formatBrandName } from '../lib/brand'
import { elapsed, pkr } from '../lib/format'
import { colors, theme } from '../lib/theme'
import type { Job } from '../lib/types'

export function JobCard({ job, onPress }: { job: Job; onPress: () => void }) {
  const offered = job.stage === 'offered'
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${formatBrandName(job.brand?.name)} order ${job.orderNumber}, ${job.stage.replace('_', ' ')}`}
      style={({ pressed }) => ({
        backgroundColor: colors.card,
        borderRadius: theme.radiusLg,
        borderWidth: offered ? 3 : 1,
        borderColor: offered ? colors.purple : colors.border,
        padding: theme.pad,
        gap: 10,
        opacity: pressed ? 0.85 : 1,
      })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <StageBadge stage={job.stage} />
        <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '600' }}>
          {elapsed(job.assignedAt)}
        </Text>
      </View>

      <View>
        <Text style={{ color: colors.ink, fontSize: 21, fontWeight: '900' }} numberOfLines={1}>
          {formatBrandName(job.brand?.name)} <Text style={{ color: colors.textDim, fontWeight: '700' }}>#{job.orderNumber}</Text>
        </Text>
        {job.company?.name ? (
          <Text style={{ color: colors.textDim, fontSize: 14, fontWeight: '600', marginTop: 2 }} numberOfLines={1}>
            {job.company.name}
          </Text>
        ) : null}
      </View>

      <Stop label="FROM" text={job.pickup?.name || job.pickup?.address || 'Kitchen'} />
      <Stop label="TO" text={job.dropoff?.address || job.dropoff?.name || 'Customer — see job'} />

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <Text style={{ color: colors.textDim, fontSize: 15, fontWeight: '600' }}>
          {job.itemCount} {job.itemCount === 1 ? 'item' : 'items'}
        </Text>
        {job.cashToCollectCents > 0 ? (
          <View style={{ backgroundColor: colors.warnBg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5 }}>
            <Text style={{ color: colors.warn, fontWeight: '900', fontSize: 15 }}>
              Collect {pkr(job.cashToCollectCents)}
            </Text>
          </View>
        ) : (
          <Text style={{ color: colors.greenText, fontWeight: '800', fontSize: 15 }}>Prepaid</Text>
        )}
      </View>
    </Pressable>
  )
}

function Stop({ label, text }: { label: string; text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '900', letterSpacing: 1.2, width: 42, paddingTop: 3 }}>
        {label}
      </Text>
      <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600', flex: 1 }} numberOfLines={2}>
        {text}
      </Text>
    </View>
  )
}
