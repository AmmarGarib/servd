// Shift home — open a new shift with opening float, OR shows current shift
// with a "Close shift" button. Z-report visible alongside.

import { useState } from 'react'
import { View, Text, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { theme } from '../../../src/lib/theme'
import { pkr, shortTime } from '../../../src/lib/format'
import { Panel, Pill } from '../../../src/components/Panel'
import { Button } from '../../../src/components/Button'
import { useShift } from '../../../src/store/shift'
import { CashMovementModal } from '../../../src/components/CashMovementModal'

interface CashMovementRow {
  id: string
  type: 'drop' | 'add' | 'payout' | 'payin'
  amountCents: number
  reason: string
  recordedAt: string
  recordedBy?: { name: string }
}

interface ZReport {
  shiftId: string
  openedAt: string
  closedAt?: string | null
  openingFloatCents: number
  closingFloatCents?: number | null
  ordersCount: number
  grossCents: number
  netCents: number
  taxCents: number
  tipsCents: number
  discountCents: number
  compCents: number
  voidsCount: number
  refundsCents: number
  byMethod: Array<{ method: string; count: number; amountCents: number }>
  cashMovements: {
    drops: number
    adds: number
    payouts: number
    payins: number
    list: Array<{ id: string; type: string; amountCents: number; reason: string; recordedAt: string }>
  }
  expectedCashCents: number
  varianceCents?: number | null
}

export default function ShiftHomeScreen() {
  const router = useRouter()
  const shift  = useShift()
  const [cashMovementOpen, setCashMovementOpen] = useState(false)

  const z = useQuery({
    queryKey: ['shift', 'zreport', shift.shiftId],
    queryFn:  () => api.get<ZReport>(`/pos/shifts/${shift.shiftId}/zreport`),
    enabled:  !!shift.shiftId,
    refetchInterval: 30_000,
  })

  const movements = useQuery({
    queryKey: ['cash-movements', shift.shiftId],
    queryFn:  () => api.get<{ movements: CashMovementRow[] }>(`/pos/shifts/${shift.shiftId}/cash-movements`),
    enabled:  !!shift.shiftId,
  })

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26, marginBottom: 16 }}>Shift</Text>

      {!shift.shiftId ? (
        <Panel style={{ alignItems: 'center', padding: 40, gap: 16 }}>
          <Text style={{ color: theme.text, fontWeight: '800', fontSize: 22 }}>No active shift</Text>
          <Text style={{ color: theme.textDim, textAlign: 'center' }}>
            You need to open a shift with an opening float before you can take payments at POS.
          </Text>
          <Button label="Open shift" size="xl" onPress={() => router.push('/(staff)/shift/open')} />
        </Panel>
      ) : (
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <View style={{ flex: 1, gap: 12 }}>
            <Panel title="Current shift">
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <Pill label="OPEN" tone="success" />
                <Text style={{ color: theme.textDim, fontSize: 13 }}>
                  Opened {shift.openedAt && shortTime(shift.openedAt)}
                </Text>
              </View>
              <Row label="Opening float" value={pkr(shift.openingFloatCents)} />
              {z.data && (
                <>
                  <Row label="Orders rung" value={String(z.data.ordersCount)} />
                  <Row label="Gross"       value={pkr(z.data.grossCents)} />
                  <Row label="Net"         value={pkr(z.data.netCents)} highlight />
                  <Row label="Tax"         value={pkr(z.data.taxCents)} />
                  <Row label="Tips"        value={pkr(z.data.tipsCents)} />
                  <Row label="Discounts"   value={pkr(z.data.discountCents)} />
                  <Row label="Comps"       value={pkr(z.data.compCents)} />
                  <Row label="Voids"       value={String(z.data.voidsCount)} />
                  <Row label="Refunds"     value={pkr(z.data.refundsCents)} />
                </>
              )}
              <View style={{ marginTop: 16, gap: 8 }}>
                <Button label="Cash movement (drop / add / payout)" intent="ghost" full
                  onPress={() => setCashMovementOpen(true)} />
                <Button label="Close shift" intent="danger" full size="lg"
                  onPress={() => router.push('/(staff)/shift/close')} />
              </View>
            </Panel>

            {/* Cash movements log */}
            {(movements.data?.movements?.length ?? 0) > 0 && (
              <Panel title="Cash movements">
                {movements.data!.movements.map((m) => (
                  <View key={m.id} style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
                  }}>
                    <Pill
                      label={m.type.toUpperCase()}
                      tone={
                        m.type === 'drop'   ? 'info'    :
                        m.type === 'add'    ? 'success' :
                        m.type === 'payout' ? 'danger'  : 'warn'
                      }
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.text, fontWeight: '700', fontSize: 13 }}>{m.reason}</Text>
                      <Text style={{ color: theme.textDim, fontSize: 11 }}>
                        {shortTime(m.recordedAt)}{m.recordedBy && ` · ${m.recordedBy.name}`}
                      </Text>
                    </View>
                    <Text style={{
                      color: m.type === 'add' || m.type === 'payin' ? theme.accent : theme.warn,
                      fontWeight: '900', fontSize: 14,
                    }}>
                      {m.type === 'add' || m.type === 'payin' ? '+' : '−'}{pkr(m.amountCents)}
                    </Text>
                  </View>
                ))}
              </Panel>
            )}
          </View>

          <View style={{ flex: 1, gap: 12 }}>
            {z.data && (
              <Panel title="Tender breakdown">
                {z.data.byMethod.length === 0 ? (
                  <Text style={{ color: theme.textMuted, padding: 16 }}>No payments yet.</Text>
                ) : z.data.byMethod.map(m => (
                  <View key={m.method} style={{
                    flexDirection: 'row', justifyContent: 'space-between',
                    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
                  }}>
                    <Text style={{ color: theme.text, fontWeight: '700' }}>{m.method.toUpperCase()}</Text>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: theme.accent, fontWeight: '800' }}>{pkr(m.amountCents)}</Text>
                      <Text style={{ color: theme.textDim, fontSize: 12 }}>{m.count} txn</Text>
                    </View>
                  </View>
                ))}
                <View style={{ marginTop: 16, padding: 12, backgroundColor: theme.panelAlt, borderRadius: 10 }}>
                  <Row label="Expected cash in drawer" value={pkr(z.data.expectedCashCents)} highlight />
                </View>
              </Panel>
            )}
          </View>
        </View>
      )}

      <CashMovementModal
        visible={cashMovementOpen}
        shiftId={shift.shiftId}
        onClose={() => setCashMovementOpen(false)}
      />
    </ScrollView>
  )
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text style={{ color: theme.textDim, fontSize: highlight ? 15 : 13, fontWeight: highlight ? '700' : '500' }}>{label}</Text>
      <Text style={{
        color: highlight ? theme.accent : theme.text,
        fontSize: highlight ? 18 : 14, fontWeight: '800',
      }}>{value}</Text>
    </View>
  )
}
