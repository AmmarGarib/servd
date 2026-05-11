// Inventory counting with live camera barcode scan. Pick a session ("end-of-
// shift cooler count" etc.), scan each item, the count field auto-focuses, hit
// enter, repeat. Session saves an InventoryCount + per-line StockAdjustment.
//
// Camera barcode reading uses expo-camera's `onBarcodeScanned` — UPC/EAN/Code128
// supported out of the box, no extra deps. We dedupe consecutive scans of the
// same barcode within 2s to handle physical "beep beep" double-fires.

import { useRef, useState, useEffect } from 'react'
import { View, Text, TextInput, ScrollView, Pressable, Alert } from 'react-native'
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera'
import * as Haptics from 'expo-haptics'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
import { theme } from '../../src/lib/theme'
import { Panel, Pill } from '../../src/components/Panel'
import { Button } from '../../src/components/Button'

interface Ingredient {
  id: string
  name: string
  sku?: string | null
  barcode?: string | null
  unit: string
  onHand: number
}

interface CountLine {
  ingredientId: string
  name: string
  unit: string
  expected: number
  counted: number
  variance: number
}

export default function InventoryScreen() {
  const qc = useQueryClient()
  const [cameraPerm, requestCameraPerm] = useCameraPermissions()
  const [scannerActive, setScannerActive] = useState(false)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const focusedRef = useRef<TextInput | null>(null)

  useEffect(() => {
    if (!cameraPerm?.granted) requestCameraPerm()
  }, [cameraPerm?.granted])

  const ingredients = useQuery({
    queryKey: ['inventory', 'ingredients'],
    queryFn:  () => api.get<{ ingredients: Ingredient[] }>('/inventory/ingredients'),
  })

  const submit = useMutation({
    mutationFn: () => api.post('/inventory/counts', {
      lines: Object.entries(counts).map(([id, counted]) => ({ ingredientId: id, counted })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inventory'] })
      setCounts({})
      Alert.alert('Saved', 'Stock adjustments recorded.')
    },
    onError: (err: Error) => Alert.alert('Hmm', err.message),
  })

  function handleBarcode(result: BarcodeScanningResult) {
    const code = result.data
    const now = Date.now()
    if (lastScanRef.current.code === code && now - lastScanRef.current.at < 2_000) return
    lastScanRef.current = { code, at: now }

    const match = ingredients.data?.ingredients.find(i =>
      i.barcode === code || i.sku === code
    )
    if (!match) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined)
      Alert.alert('Unknown barcode', `No ingredient matches "${code}". Add it in inventory settings or count by name.`)
      return
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
    // Bump the count for this ingredient by 1 (or set focus to its input).
    setCounts(c => ({ ...c, [match.id]: (c[match.id] ?? match.onHand) + 1 }))
  }

  const filtered = (ingredients.data?.ingredients ?? []).filter(i =>
    !searchQuery || i.name.toLowerCase().includes(searchQuery.toLowerCase()) || i.sku?.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const summary: CountLine[] = Object.entries(counts).map(([id, counted]) => {
    const ing = ingredients.data?.ingredients.find(i => i.id === id)!
    const expected = ing.onHand
    return { ingredientId: id, name: ing.name, unit: ing.unit, expected, counted, variance: counted - expected }
  })

  return (
    <View style={{ flex: 1, padding: 16, flexDirection: 'row', gap: 16 }}>
      {/* Scanner + ingredient list */}
      <View style={{ flex: 2, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Inventory count</Text>
          <Button
            label={scannerActive ? 'Stop scan' : 'Scan barcode'}
            intent={scannerActive ? 'danger' : 'primary'}
            onPress={() => setScannerActive(s => !s)}
          />
        </View>

        {scannerActive && cameraPerm?.granted && (
          <View style={{ height: 220, borderRadius: theme.radius, overflow: 'hidden', borderWidth: 1, borderColor: theme.border }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'] }}
              onBarcodeScanned={handleBarcode}
            />
            <View style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <View style={{ width: '60%', height: 80, borderWidth: 2, borderColor: theme.accent, borderRadius: 12 }} />
              <Text style={{ color: theme.text, marginTop: 12, fontWeight: '700' }}>
                Point at barcode
              </Text>
            </View>
          </View>
        )}

        <TextInput
          value={searchQuery} onChangeText={setSearchQuery}
          placeholder="Search ingredients…" placeholderTextColor={theme.textMuted}
          style={{
            color: theme.text, backgroundColor: theme.panel,
            borderWidth: 1, borderColor: theme.border, borderRadius: 12,
            padding: 12, fontSize: 14,
          }}
        />

        <ScrollView style={{ flex: 1 }}>
          {filtered.map(ing => {
            const counted = counts[ing.id] ?? null
            return (
              <View key={ing.id} style={{
                flexDirection: 'row', alignItems: 'center', gap: 12,
                paddingVertical: 12, paddingHorizontal: 14,
                borderBottomWidth: 1, borderBottomColor: theme.border,
              }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: '700', fontSize: 15 }}>{ing.name}</Text>
                  <Text style={{ color: theme.textDim, fontSize: 12 }}>
                    On hand: {ing.onHand} {ing.unit}
                    {ing.sku && ` · SKU ${ing.sku}`}
                  </Text>
                </View>
                <TextInput
                  value={counted !== null ? String(counted) : ''}
                  onChangeText={v => {
                    const n = parseInt(v, 10)
                    setCounts(c => {
                      const next = { ...c }
                      if (v === '') delete next[ing.id]
                      else if (Number.isFinite(n)) next[ing.id] = n
                      return next
                    })
                  }}
                  placeholder={`${ing.onHand}`}
                  placeholderTextColor={theme.textMuted}
                  keyboardType="number-pad"
                  style={{
                    color: theme.text, backgroundColor: theme.panelAlt,
                    borderWidth: 1, borderColor: theme.border, borderRadius: 8,
                    paddingHorizontal: 12, paddingVertical: 8,
                    width: 100, textAlign: 'right', fontSize: 16, fontWeight: '700',
                  }}
                />
              </View>
            )
          })}
        </ScrollView>
      </View>

      {/* Variance summary */}
      <View style={{ flex: 1, gap: 12 }}>
        <Panel title={`Counted (${summary.length})`} style={{ flex: 1 }}>
          <ScrollView>
            {summary.length === 0 ? (
              <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 32 }}>
                Scan or tap a quantity to start counting.
              </Text>
            ) : summary.map(line => (
              <View key={line.ingredientId} style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
              }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: '600', fontSize: 14 }}>{line.name}</Text>
                  <Text style={{ color: theme.textDim, fontSize: 12 }}>
                    {line.expected} → {line.counted} {line.unit}
                  </Text>
                </View>
                <Pill
                  label={line.variance === 0 ? '✓' : line.variance > 0 ? `+${line.variance}` : `${line.variance}`}
                  tone={line.variance === 0 ? 'success' : Math.abs(line.variance) >= 5 ? 'danger' : 'warn'}
                />
              </View>
            ))}
          </ScrollView>
        </Panel>

        <Button
          label={submit.isPending ? 'Saving…' : `Save ${summary.length} adjustments`}
          full size="lg"
          busy={submit.isPending}
          disabled={summary.length === 0}
          onPress={() => submit.mutate()}
        />
      </View>
    </View>
  )
}
