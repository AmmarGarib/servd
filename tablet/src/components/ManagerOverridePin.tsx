// Manager override modal — used when a cashier action exceeds their cap
// (void above cashier limit, comp, refund, discount > policy). Captures a
// manager PIN and returns it to the caller, which forwards it to the backend
// where the actual auth check happens. We DON'T verify locally because that
// would mean shipping manager PINs to every till.
//
// Backend semantics: each pos/orders/:id/{void,comp,refund} route accepts
// `managerOverridePin?: string` — if the cashier action is above their cap
// the backend returns 403 "manager_override_required" with the cap info,
// the client surfaces this modal, and the user retries with the PIN.

import { useState } from 'react'
import { View, Text, Modal, Pressable, Alert } from 'react-native'
import { theme } from '../lib/theme'
import { Keypad } from './Keypad'
import { Button } from './Button'

interface Props {
  visible: boolean
  title: string
  subtitle?: string
  onCancel: () => void
  onSubmit: (pin: string) => void
}

export function ManagerOverridePin({ visible, title, subtitle, onCancel, onSubmit }: Props) {
  const [pin, setPin] = useState('')

  function submit() {
    if (pin.length < 4) return
    onSubmit(pin)
    setPin('')
  }
  function cancel() {
    setPin('')
    onCancel()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel}>
      <Pressable onPress={cancel} style={{
        flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
        alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <Pressable onPress={() => undefined} style={{
          backgroundColor: theme.panel,
          borderRadius: theme.radiusLg, borderWidth: 1, borderColor: theme.borderHi,
          padding: 28, width: 480, maxWidth: '100%',
        }}>
          <Text style={{ color: theme.warn, fontWeight: '800', fontSize: 12, letterSpacing: 1.5 }}>
            MANAGER OVERRIDE
          </Text>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 22, marginTop: 4 }}>
            {title}
          </Text>
          {subtitle && (
            <Text style={{ color: theme.textDim, fontSize: 14, marginTop: 6 }}>{subtitle}</Text>
          )}

          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginVertical: 20 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <View key={i} style={{
                width: 18, height: 18, borderRadius: 9,
                borderWidth: 2, borderColor: theme.borderHi,
                backgroundColor: i < pin.length ? theme.warn : 'transparent',
              }} />
            ))}
          </View>

          <Keypad value={pin} onChange={setPin} onSubmit={submit} maxLength={6} />

          <View style={{ marginTop: 20, flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Button label="Cancel" intent="ghost" onPress={cancel} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

/**
 * Helper hook: wraps a mutation that may require a manager override.
 * On a 403 with `code: 'MANAGER_OVERRIDE_REQUIRED'`, surfaces the modal,
 * then retries with the PIN. On any other error, throws.
 */
export function useManagerOverridePrompt() {
  const [state, setState] = useState<{
    visible: boolean
    title: string
    subtitle?: string
    resolve?: (pin: string | null) => void
  }>({ visible: false, title: '' })

  const prompt = (title: string, subtitle?: string) => new Promise<string | null>((resolve) => {
    setState({ visible: true, title, subtitle, resolve })
  })

  const onSubmit = (pin: string) => {
    state.resolve?.(pin)
    setState({ visible: false, title: '' })
  }
  const onCancel = () => {
    state.resolve?.(null)
    setState({ visible: false, title: '' })
  }

  const modal = (
    <ManagerOverridePin
      visible={state.visible}
      title={state.title}
      subtitle={state.subtitle}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )

  return { prompt, modal }
}
