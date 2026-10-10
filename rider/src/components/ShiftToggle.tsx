// The on/off-shift switch: one wide target, drawn with plain shapes (a track
// and a knob), with the state spelt out in words beside it.

import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors, theme } from '../lib/theme'

export function ShiftToggle({ onShift, busy, onPress }: {
  onShift: boolean
  busy: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="switch"
      accessibilityLabel="On shift"
      accessibilityState={{ checked: onShift, busy }}
      accessibilityHint={onShift ? 'Goes off shift and stops sharing your location' : 'Goes on shift and starts sharing your location'}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        minHeight: 76,
        paddingHorizontal: 18,
        borderRadius: theme.radiusLg,
        backgroundColor: onShift ? colors.green : colors.purpleDeep,
        borderWidth: 2,
        borderColor: onShift ? colors.green : colors.onPurpleDim,
        opacity: pressed ? 0.88 : 1,
      })}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={{ color: onShift ? colors.onGreen : colors.onPurple, fontSize: 22, fontWeight: '900' }}>
          {onShift ? 'On shift' : 'Off shift'}
        </Text>
        <Text style={{ color: onShift ? colors.onGreen : colors.onPurpleDim, fontSize: 14, fontWeight: '600', marginTop: 2 }}>
          {onShift ? 'Getting jobs. Tap to go off shift.' : 'Tap to go on shift and get jobs.'}
        </Text>
      </View>
      {busy ? (
        <View style={{ width: 72, alignItems: 'center' }}>
          <ActivityIndicator color={onShift ? colors.onGreen : colors.onPurple} />
        </View>
      ) : (
        <View style={{
          width: 72, height: 40, borderRadius: 20, padding: 4,
          backgroundColor: onShift ? colors.purple : colors.onPurpleDim,
          alignItems: onShift ? 'flex-end' : 'flex-start',
          justifyContent: 'center',
        }}>
          <View style={{
            width: 32, height: 32, borderRadius: 16,
            backgroundColor: onShift ? colors.green : colors.purpleDeep,
          }} />
        </View>
      )}
    </Pressable>
  )
}
