// Mid-shift cash movement modal — drop / add / payout / payin.
//
// Triggered from the shift home screen "Cash drop" button (or via Cash add
// secondary). Records the movement against the active shift and updates the
// Z-report's expectedCashCents.

import { useState } from 'react'
import { View, Text, Modal, Pressable, TextInput, Alert } from 'react-native'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import { theme } from '../lib/theme'
import { pkr } from '../lib/format'
import { Button } from './Button'
import { Keypad } from './Keypad'
import { Pill } from './Panel'

type MovementType = 'drop' | 'add' | 'payout' | 'payin'

const TYPE_META: Record<MovementType, { label: string; subtitle: string; tone: 'info' | 'warn' | 'success' | 'danger' }> = {
  drop:   { label: 'Cash drop',  subtitle: 'Removing cash to safe — DECREASES expected drawer',   tone: 'info' },
  add:    { label: 'Cash add',   subtitle: 'Bringing bills in — INCREASES expected drawer',       tone: 'success' },
  payout: { label: 'Pay-out',    subtitle: 'Paying a vendor from drawer — DECREASES expected',    tone: 'danger' },
  payin:  { label: 'Pay-in',     subtitle: 'Vendor refund / petty cash in — INCREASES expected',  tone: 'warn' },
}

export function CashMovementModal({ visible, shiftId, onClose }: {
  visible: boolean
  shiftId: string | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [type, setType] = useState<MovementType>('drop')
  const [amountStr, setAmountStr] = useState('')
  const [reason, setReason] = useState('')

  const meta = TYPE_META[type]
  const cents = (parseInt(amountStr || '0', 10) || 0) * 100

  const submit = useMutation({
    mutationFn: () => {
      if (!shiftId) throw new Error('No active shift')
      return api.post(`/pos/shifts/${shiftId}/cash-movements`, {
        type,
        amountCents: cents,
        reason: reason.trim(),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shift'] })
      qc.invalidateQueries({ queryKey: ['cash-movements'] })
      setAmountStr(''); setReason(''); setType('drop')
      onClose()
    },
    onError: (err: Error) => Alert.alert('Hmm', err.message),
  })

  function close() {
    setAmountStr(''); setReason(''); setType('drop')
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable onPress={close} style={{
        flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
        alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <Pressable onPress={() => undefined} style={{
          backgroundColor: theme.panel, borderRadius: theme.radiusLg,
          borderWidth: 1, borderColor: theme.borderHi,
          padding: 24, width: 720, maxWidth: '100%',
        }}>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 22, marginBottom: 4 }}>
            Cash movement
          </Text>
          <Text style={{ color: theme.textDim, fontSize: 13, marginBottom: 16 }}>
            All cash leaving / entering the drawer outside of a sale.
          </Text>

          {/* Type picker */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {(Object.keys(TYPE_META) as MovementType[]).map(t => {
              const m = TYPE_META[t]
              return (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  style={{
                    flex: 1, minWidth: 140, paddingVertical: 12, paddingHorizontal: 14,
                    borderRadius: 10, borderWidth: 1,
                    borderColor: type === t ? theme.accent : theme.border,
                    backgroundColor: type === t ? 'rgba(34,197,94,0.12)' : theme.panelAlt,
                  }}>
                  <Text style={{ color: theme.text, fontWeight: '800' }}>{m.label}</Text>
                </Pressable>
              )
            })}
          </View>

          <View style={{ marginBottom: 16, padding: 12, backgroundColor: theme.panelAlt, borderRadius: 10 }}>
            <Pill label={meta.label} tone={meta.tone} />
            <Text style={{ color: theme.textDim, fontSize: 13, marginTop: 6 }}>{meta.subtitle}</Text>
          </View>

          <View style={{ flexDirection: 'row', gap: 16 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 0.8, marginBottom: 8 }}>
                AMOUNT (Rs)
              </Text>
              <Text style={{ color: theme.accent, fontWeight: '900', fontSize: 40, textAlign: 'center', marginBottom: 12 }}>
                Rs {(parseInt(amountStr || '0', 10)).toLocaleString('en-PK')}
              </Text>
              <Keypad value={amountStr} onChange={setAmountStr} maxLength={7}
                extraKey={{ label: '00', onPress: () => setAmountStr(t => t + '00') }} />
            </View>

            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 0.8, marginBottom: 8 }}>
                REASON
              </Text>
              <TextInput
                value={reason} onChangeText={setReason}
                placeholder={
                  type === 'drop'   ? 'e.g. moved to safe at 7pm' :
                  type === 'add'    ? 'e.g. small change from manager' :
                  type === 'payout' ? 'e.g. paid pepsi delivery boy' :
                                      'e.g. supplier refund'
                }
                placeholderTextColor={theme.textMuted}
                multiline numberOfLines={4}
                style={{
                  color: theme.text, backgroundColor: theme.panelAlt,
                  borderWidth: 1, borderColor: theme.border, borderRadius: 10,
                  padding: 12, fontSize: 14, minHeight: 120, textAlignVertical: 'top',
                }}
              />
              <View style={{ marginTop: 24 }}>
                <Button
                  label={`Record ${pkr(cents)} ${meta.label.toLowerCase()}`}
                  full size="lg"
                  busy={submit.isPending}
                  disabled={cents <= 0 || !reason.trim()}
                  onPress={() => submit.mutate()}
                />
              </View>
            </View>
          </View>

          <View style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Button label="Cancel" intent="ghost" onPress={close} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
