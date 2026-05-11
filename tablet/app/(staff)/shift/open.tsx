// Open shift with opening float (the cash the till starts with). Backend
// stores this on Shift.openingFloatCents and we use it later for the
// expected-cash variance calculation at close.

import { useState } from 'react'
import { View, Text, Alert, Pressable } from 'react-native'
import { useRouter } from 'expo-router'
import { useMutation } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { theme } from '../../../src/lib/theme'
import { Panel } from '../../../src/components/Panel'
import { Button } from '../../../src/components/Button'
import { Keypad } from '../../../src/components/Keypad'
import { useShift } from '../../../src/store/shift'

export default function OpenShiftScreen() {
  const router = useRouter()
  const setShift = useShift(s => s.set)
  const [floatStr, setFloatStr] = useState('')

  const open = useMutation({
    mutationFn: async () => {
      const cents = (parseInt(floatStr || '0', 10) || 0) * 100
      return api.post<{ id: string; openedAt: string; openingFloatCents: number }>(
        '/pos/shifts/open',
        { openingFloatCents: cents },
      )
    },
    onSuccess: (s) => {
      setShift({ shiftId: s.id, openedAt: s.openedAt, openingFloatCents: s.openingFloatCents })
      router.replace('/(staff)/shift')
    },
    onError: (err: Error) => Alert.alert('Hmm', err.message),
  })

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Pressable onPress={() => router.back()}>
        <Text style={{ color: theme.textDim, fontSize: 14, marginBottom: 8 }}>← Back</Text>
      </Pressable>
      <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26, marginBottom: 16 }}>Open shift</Text>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Panel title="Opening float (Rs)" style={{ flex: 1 }}>
          <Text style={{ color: theme.accent, fontWeight: '900', fontSize: 56, textAlign: 'center', marginVertical: 16 }}>
            Rs {(parseInt(floatStr || '0', 10)).toLocaleString('en-PK')}
          </Text>
          <Keypad
            value={floatStr}
            onChange={setFloatStr}
            maxLength={7}
            extraKey={{ label: '00', onPress: () => setFloatStr(t => t + '00') }}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: 16 }}>
            {[500, 1000, 2000, 5000].map(amt => (
              <Pressable key={amt} onPress={() => setFloatStr(String(amt))}
                style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '700' }}>{amt}</Text>
              </Pressable>
            ))}
          </View>
        </Panel>

        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Text style={{ color: theme.textDim, fontSize: 14, marginBottom: 20, textAlign: 'center' }}>
            Count the cash physically in the drawer and enter the total. This becomes the baseline for tonight's variance.
          </Text>
          <Button
            label="Start shift"
            full size="xl"
            busy={open.isPending}
            disabled={!floatStr}
            onPress={() => open.mutate()}
          />
        </View>
      </View>
    </View>
  )
}
