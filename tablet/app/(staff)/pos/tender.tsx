// Tender screen — split-tender capable + tip capture.
//
// Flow:
//   1. Set tip (cash or percentage shortcuts; defaults 0).
//   2. Pick a tender method, enter amount tendered, "Add to payment".
//   3. Repeat steps 2 if splitting (rare for QSR, common for fine dining
//      and group meals where the group splits the cheque).
//   4. When the sum of tenders covers (subtotal + tip), the "Complete &
//      fire" button enables.
//
// Wire to backend:
//   POST /pos/orders with the cart + tipCents
//   POST /pos/payments with the tenders array
//
// After both succeed: clear cart, print receipt (best-effort), bounce back
// to POS.

import { useRef, useState } from 'react'
import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { useMutation } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { theme } from '../../../src/lib/theme'
import { pkr } from '../../../src/lib/format'
import { usePos } from '../../../src/store/pos'
import { useShift } from '../../../src/store/shift'
import { Button } from '../../../src/components/Button'
import { Keypad } from '../../../src/components/Keypad'
import { Panel, Pill } from '../../../src/components/Panel'
import { printReceipt, isPrinterReady } from '../../../src/lib/printer'

type Tender = 'cash' | 'card' | 'jazzcash' | 'easypaisa'

// Maps tender UI value to the backend's payment method enum.
const METHOD_FOR_TENDER: Record<Tender, string> = {
  cash:      'cash',
  card:      'card',
  jazzcash:  'jazzcash_wallet',
  easypaisa: 'easypaisa_wallet',
}

interface TenderEntry {
  id: string
  method: Tender
  amountCents: number
  tenderedCents: number       // cash given — only differs from amountCents for cash overpay
}

let _entryCounter = 0

export default function TenderScreen() {
  const router = useRouter()
  const pos = usePos()
  const shift = useShift()
  const subtotal = pos.subtotalCents()

  const [tipCents, setTipCents] = useState(0)
  const [tipMode, setTipMode]   = useState<'none' | 'pct' | 'amount'>('none')
  const [pickedTender, setPickedTender] = useState<Tender>('cash')
  const [amountStr, setAmountStr] = useState('')
  const [tenders, setTenders] = useState<TenderEntry[]>([])

  // Stable idempotency key for this ring-up. A double-tap or a retry reuses it,
  // so the server dedupes to ONE order instead of firing duplicate tickets. A
  // fresh tender screen (next sale) gets a new key.
  const idemKey = useRef<string>('')
  if (!idemKey.current) idemKey.current = `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  const due = subtotal + tipCents
  const paidSoFar = tenders.reduce((s, t) => s + t.amountCents, 0)
  const remaining = Math.max(0, due - paidSoFar)
  const fullyPaid = paidSoFar >= due && due > 0

  const cashGiven = (() => {
    const n = parseInt(amountStr, 10)
    return Number.isFinite(n) ? n * 100 : 0
  })()

  function setTipPct(pct: number) {
    setTipCents(Math.round(subtotal * pct / 100))
    setTipMode('pct')
  }
  function clearTip() {
    setTipCents(0)
    setTipMode('none')
  }

  function addTender() {
    // For cash: amount applied = min(cashGiven, remaining). Anything over
    // is change owed. For card/wallet: amount = remaining (exact, no
    // overpay).
    const isCash = pickedTender === 'cash'
    const applied = isCash ? Math.min(cashGiven, remaining) : remaining
    const tendered = isCash ? cashGiven : applied
    if (applied <= 0) return
    setTenders((t) => [...t, {
      id: `te_${++_entryCounter}`,
      method: pickedTender,
      amountCents: applied,
      tenderedCents: tendered,
    }])
    setAmountStr('')
  }
  function removeTender(id: string) {
    setTenders((t) => t.filter(x => x.id !== id))
  }

  // Change owed = sum of cash-tender overages.
  const changeCents = tenders
    .filter((t) => t.method === 'cash')
    .reduce((s, t) => s + Math.max(0, t.tenderedCents - t.amountCents), 0)

  const fire = useMutation({
    mutationFn: async () => {
      if (!pos.conceptId) throw new Error('Pick a brand first')
      if (!shift.shiftId) throw new Error('Open a shift before taking payments')
      if (tenders.length === 0) throw new Error('Add at least one tender')

      // 1. Create the order via the cashier route — handles tax + discount
      //    server-side and binds to the shift.
      const order = await api.post<{ id: string }>('/pos/orders', {
        conceptId: pos.conceptId,
        idempotencyKey: idemKey.current,
        tableId: pos.tableId,
        customerId: pos.customerId,
        shiftId: shift.shiftId,
        tipCents: tipCents > 0 ? tipCents : undefined,
        items: pos.lines.map(l => ({
          menuItemId: l.menuItemId,
          name: l.name,
          unitPriceCents: l.unitPriceCents,
          quantity: l.qty,
          notes: l.notes || undefined,
          modifiers: l.modifiers.map(m => ({
            name: m.name,
            priceDeltaCents: m.priceDeltaCents,
            modifierId: m.id,
          })),
        })),
      })

      // 2. Take payment in the same shift, one row per tender.
      await api.post('/pos/payments', {
        orderId: order.id,
        shiftId: shift.shiftId,
        payments: tenders.map(t => ({
          method: METHOD_FOR_TENDER[t.method],
          amountCents: t.amountCents,
          tenderedCents: t.method === 'cash' ? t.tenderedCents : undefined,
        })),
      })
      return order.id
    },
    onSuccess: async (orderId) => {
      // Best-effort receipt print — no transport registered = silent skip.
      try {
        await printReceipt(orderId)
      } catch (err) {
        Alert.alert('Printer offline', `${(err as Error).message}. Order #${orderId.slice(-6)} saved.`)
      }
      pos.clear()
      router.replace('/(staff)/pos')
    },
    onError: (err: Error) => Alert.alert("Couldn't fire order", err.message),
  })

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Pressable onPress={() => router.back()}>
        <Text style={{ color: theme.textDim, fontSize: 14, marginBottom: 8 }}>← Back to cart</Text>
      </Pressable>

      <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26, marginBottom: 16 }}>Tender</Text>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        {/* Left column — tip + tender method + amount keypad */}
        <View style={{ flex: 1, gap: 12 }}>
          {/* Tip selector */}
          <Panel title="Tip">
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              {[
                { pct: 0,  label: 'NONE' },
                { pct: 10, label: '10%' },
                { pct: 15, label: '15%' },
                { pct: 20, label: '20%' },
              ].map(({ pct, label }) => {
                const active = pct === 0 ? tipMode === 'none' : (tipMode === 'pct' && tipCents === Math.round(subtotal * pct / 100))
                return (
                  <Pressable
                    key={label}
                    onPress={() => pct === 0 ? clearTip() : setTipPct(pct)}
                    style={{
                      flex: 1, paddingVertical: 12, alignItems: 'center',
                      borderRadius: 10, borderWidth: 1,
                      borderColor: active ? theme.accent : theme.border,
                      backgroundColor: active ? 'rgba(34,197,94,0.12)' : theme.panelAlt,
                    }}>
                    <Text style={{ color: theme.text, fontWeight: '700', fontSize: 13 }}>{label}</Text>
                    {pct > 0 && (
                      <Text style={{ color: theme.textDim, fontSize: 11, marginTop: 2 }}>
                        {pkr(Math.round(subtotal * pct / 100))}
                      </Text>
                    )}
                  </Pressable>
                )
              })}
            </View>
            <Text style={{ color: theme.textMuted, fontSize: 11, textAlign: 'center' }}>
              Custom tip: enter the difference under "Amount" with method=cash
            </Text>
          </Panel>

          {/* Tender method */}
          <Panel title="Tender method">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {(['cash', 'card', 'jazzcash', 'easypaisa'] as const).map(t => (
                <Pressable
                  key={t}
                  onPress={() => setPickedTender(t)}
                  style={{
                    flex: 1, minWidth: 100,
                    paddingVertical: 14, alignItems: 'center',
                    borderRadius: 10, borderWidth: 1,
                    borderColor: pickedTender === t ? theme.accent : theme.border,
                    backgroundColor: pickedTender === t ? 'rgba(34,197,94,0.12)' : theme.panelAlt,
                  }}>
                  <Text style={{ color: theme.text, fontWeight: '700', letterSpacing: 0.5, fontSize: 13 }}>
                    {t.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Panel>

          {/* Amount keypad — relevant for cash split-tender. Card / wallet just
              applies the remaining balance. */}
          {pickedTender === 'cash' ? (
            <Panel title={`Cash for this tender (remaining ${pkr(remaining)})`}>
              <Text style={{ color: theme.accent, fontWeight: '900', fontSize: 36, textAlign: 'center', marginVertical: 12 }}>
                Rs {(parseInt(amountStr || '0', 10)).toLocaleString('en-PK')}
              </Text>
              <Keypad value={amountStr} onChange={setAmountStr} maxLength={7}
                extraKey={{ label: '00', onPress: () => setAmountStr(t => t + '00') }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: 12 }}>
                {[500, 1000, 2000, 5000].map(amt => (
                  <Pressable key={amt} onPress={() => setAmountStr(String(amt))}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.border }}>
                    <Text style={{ color: theme.text, fontWeight: '700' }}>{amt}</Text>
                  </Pressable>
                ))}
                <Pressable onPress={() => setAmountStr(String(Math.round(remaining / 100)))}
                  style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.accent }}>
                  <Text style={{ color: theme.accent, fontWeight: '700' }}>EXACT</Text>
                </Pressable>
              </View>
              <View style={{ marginTop: 16 }}>
                <Button label={`Add ${pkr(cashGiven)} cash`}
                  full
                  disabled={cashGiven <= 0 || remaining === 0}
                  onPress={addTender} />
              </View>
            </Panel>
          ) : (
            <Panel title="Apply tender">
              <Text style={{ color: theme.textDim, marginBottom: 16, textAlign: 'center' }}>
                Card / wallet tender applies the remaining balance exactly. Tap below to add.
              </Text>
              <Button
                label={`Charge ${pkr(remaining)} to ${pickedTender.toUpperCase()}`}
                full size="lg"
                disabled={remaining === 0}
                onPress={addTender}
              />
            </Panel>
          )}
        </View>

        {/* Right column — summary + completed tenders + fire button */}
        <View style={{ flex: 1, gap: 12 }}>
          <Panel title="Summary">
            <Row label="Subtotal"  value={pkr(subtotal)} />
            {tipCents > 0 && <Row label="Tip" value={pkr(tipCents)} />}
            <Row label="Due"       value={pkr(due)} highlight />
            <Row label="Paid"      value={pkr(paidSoFar)} />
            <Row label="Remaining" value={pkr(remaining)} highlight={!fullyPaid} />
            {changeCents > 0 && <Row label="Change owed" value={pkr(changeCents)} highlight />}
          </Panel>

          <Panel title={`Tenders (${tenders.length})`}>
            {tenders.length === 0 ? (
              <Text style={{ color: theme.textMuted, padding: 16, textAlign: 'center' }}>
                None added yet.
              </Text>
            ) : tenders.map(t => (
              <View key={t.id} style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
              }}>
                <View>
                  <Text style={{ color: theme.text, fontWeight: '700' }}>{t.method.toUpperCase()}</Text>
                  {t.method === 'cash' && t.tenderedCents > t.amountCents && (
                    <Text style={{ color: theme.textDim, fontSize: 11 }}>
                      tendered {pkr(t.tenderedCents)} → change {pkr(t.tenderedCents - t.amountCents)}
                    </Text>
                  )}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ color: theme.accent, fontWeight: '800', fontSize: 16 }}>{pkr(t.amountCents)}</Text>
                  <Pressable onPress={() => removeTender(t.id)}>
                    <Text style={{ color: theme.textDim, fontSize: 18 }}>×</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </Panel>

          <Button
            label={fire.isPending ? 'Firing…' : 'COMPLETE & FIRE'}
            size="xl"
            full
            busy={fire.isPending}
            disabled={!fullyPaid || pos.lines.length === 0 || fire.isPending}
            onPress={() => fire.mutate()}
          />

          {!isPrinterReady() && (
            <Text style={{ color: theme.textMuted, fontSize: 12, textAlign: 'center' }}>
              No printer paired — receipt will be saved digitally only.
            </Text>
          )}
        </View>
      </View>
    </ScrollView>
  )
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text style={{ color: theme.textDim, fontSize: highlight ? 16 : 14, fontWeight: highlight ? '700' : '500' }}>{label}</Text>
      <Text style={{
        color: highlight ? theme.accent : theme.text,
        fontSize: highlight ? 20 : 14, fontWeight: '800',
      }}>{value}</Text>
    </View>
  )
}
