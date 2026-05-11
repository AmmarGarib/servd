// Close shift — cashier counts the drawer, enters the figure, we compute
// variance against the backend's expectedCashCents (opening float + cash
// payments − refunds − comps). Negative variance = shortage; positive =
// overage. Both get flagged on the Z-report.

import { useState } from 'react'
import { View, Text, Alert, Pressable, TextInput } from 'react-native'
import { useRouter } from 'expo-router'
import { useQuery, useMutation } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { theme } from '../../../src/lib/theme'
import { pkr } from '../../../src/lib/format'
import { Panel, Pill } from '../../../src/components/Panel'
import { Button } from '../../../src/components/Button'
import { Keypad } from '../../../src/components/Keypad'
import { useShift } from '../../../src/store/shift'

interface ZReport {
  expectedCashCents: number
  netCents: number
  ordersCount: number
}

export default function CloseShiftScreen() {
  const router = useRouter()
  const shift = useShift()
  const setShift = useShift(s => s.set)
  const [countStr, setCountStr] = useState('')
  const [notes, setNotes] = useState('')

  const z = useQuery({
    queryKey: ['shift', 'zreport', shift.shiftId],
    queryFn:  () => api.get<ZReport>(`/pos/shifts/${shift.shiftId}/zreport`),
    enabled:  !!shift.shiftId,
  })

  const close = useMutation({
    mutationFn: () => {
      const cents = (parseInt(countStr || '0', 10) || 0) * 100
      return api.post(`/pos/shifts/${shift.shiftId}/close`, {
        closingFloatCents: cents,
        notes: notes.trim() || undefined,
      })
    },
    onSuccess: () => {
      setShift(null)
      router.replace('/(staff)/shift')
    },
    onError: (err: Error) => Alert.alert('Couldn\'t close shift', err.message),
  })

  if (!shift.shiftId) {
    router.replace('/(staff)/shift')
    return null
  }

  const counted = (parseInt(countStr || '0', 10) || 0) * 100
  const expected = z.data?.expectedCashCents ?? 0
  const variance = counted - expected
  const matched = countStr !== '' && variance === 0

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Pressable onPress={() => router.back()}>
        <Text style={{ color: theme.textDim, fontSize: 14, marginBottom: 8 }}>← Back</Text>
      </Pressable>
      <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26, marginBottom: 16 }}>Close shift</Text>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Panel title="Drawer count (Rs)" style={{ flex: 1 }}>
          <Text style={{
            color: matched ? theme.accent : variance !== 0 && countStr ? theme.warn : theme.text,
            fontWeight: '900', fontSize: 56, textAlign: 'center', marginVertical: 16,
          }}>
            Rs {(parseInt(countStr || '0', 10)).toLocaleString('en-PK')}
          </Text>
          <Keypad
            value={countStr}
            onChange={setCountStr}
            maxLength={7}
            extraKey={{ label: '00', onPress: () => setCountStr(t => t + '00') }}
          />
          <TextInput
            value={notes} onChangeText={setNotes}
            placeholder="Notes (e.g. why the variance?)" placeholderTextColor={theme.textMuted}
            multiline numberOfLines={2}
            style={{
              marginTop: 16,
              color: theme.text, backgroundColor: theme.panelAlt,
              borderWidth: 1, borderColor: theme.border, borderRadius: 10,
              padding: 12, fontSize: 14, minHeight: 60,
            }}
          />
        </Panel>

        <Panel title="Variance" style={{ flex: 1 }}>
          <Row label="Expected"   value={pkr(expected)} />
          <Row label="Counted"    value={pkr(counted)} />
          <View style={{ height: 1, backgroundColor: theme.border, marginVertical: 8 }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ color: theme.text, fontSize: 18, fontWeight: '800' }}>Variance</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{
                color: matched ? theme.accent : variance < 0 ? theme.danger : theme.warn,
                fontSize: 28, fontWeight: '900',
              }}>
                {variance >= 0 ? '+' : ''}{pkr(variance)}
              </Text>
              {matched && <Pill label="MATCHED" tone="success" />}
              {!matched && countStr && <Pill label={variance < 0 ? 'SHORT' : 'OVER'} tone={variance < 0 ? 'danger' : 'warn'} />}
            </View>
          </View>

          <Button
            label="Close shift"
            intent="danger" full size="xl"
            busy={close.isPending}
            disabled={!countStr}
            onPress={() => {
              if (variance !== 0) {
                Alert.alert(
                  `Variance of ${pkr(Math.abs(variance))}`,
                  'A variance will be logged with your notes. Continue?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Close anyway', style: 'destructive', onPress: () => close.mutate() },
                  ],
                )
              } else {
                close.mutate()
              }
            }}
          />
        </Panel>
      </View>
    </View>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text style={{ color: theme.textDim, fontSize: 14 }}>{label}</Text>
      <Text style={{ color: theme.text, fontSize: 16, fontWeight: '800' }}>{value}</Text>
    </View>
  )
}
