// POS order entry — split-screen menu grid (left) + cart panel (right).
// Pick a brand, tap items, choose channel + table, then tender to fire to KDS.

import { useState } from 'react'
import { View, Text, FlatList, Pressable, ScrollView, TextInput } from 'react-native'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { theme } from '../../../src/lib/theme'
import { pkr } from '../../../src/lib/format'
import { usePos } from '../../../src/store/pos'
import { useShift } from '../../../src/store/shift'
import { Button } from '../../../src/components/Button'
import { Panel, Pill } from '../../../src/components/Panel'

interface Concept { id: string; name: string }
interface MenuItem {
  id: string
  name: string
  priceCents: number
  category: string
  imageUrl?: string | null
  isAvailable: boolean
}

export default function PosScreen() {
  const router = useRouter()
  const pos = usePos()
  const shift = useShift()
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCat, setActiveCat] = useState<string>('all')

  // Hard gate: no shift = no POS. The backend rejects /pos/payments without a
  // shiftId anyway; we just give a more useful UI than a 400.
  if (!shift.shiftId) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Panel style={{ alignItems: 'center', padding: 48, gap: 20, maxWidth: 520 }}>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 24, textAlign: 'center' }}>
            Open a shift first
          </Text>
          <Text style={{ color: theme.textDim, textAlign: 'center', lineHeight: 22 }}>
            The till is closed. Count the opening float, open a shift, and you'll be back at POS in under a minute.
          </Text>
          <Button label="Open shift" size="xl" onPress={() => router.push('/(staff)/shift/open')} />
        </Panel>
      </View>
    )
  }

  const concepts = useQuery({
    queryKey: ['pos', 'concepts'],
    queryFn:  () => api.get<{ concepts: Concept[] }>('/concepts'),
  })

  const menu = useQuery({
    queryKey: ['pos', 'menu', pos.conceptId],
    queryFn:  () => api.get<{ items: MenuItem[] }>(`/concepts/${pos.conceptId}/menu`),
    enabled:  !!pos.conceptId,
  })

  // Default to first concept on first load.
  if (!pos.conceptId && concepts.data?.concepts[0]) {
    const c = concepts.data.concepts[0]
    pos.setConcept(c.id, c.name)
  }

  const items = menu.data?.items ?? []
  const cats  = ['all', ...new Set(items.map(i => i.category).filter(Boolean))]
  const visible = items.filter(i =>
    (activeCat === 'all' || i.category === activeCat) &&
    (!searchQuery || i.name.toLowerCase().includes(searchQuery.toLowerCase())),
  )

  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      {/* Menu grid */}
      <View style={{ flex: 2, padding: 16 }}>
        {/* Brand picker + search */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 22 }}>POS</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {concepts.data?.concepts.map(c => (
              <Pressable
                key={c.id}
                onPress={() => pos.setConcept(c.id, c.name)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 8,
                  borderRadius: 999, borderWidth: 1,
                  borderColor: pos.conceptId === c.id ? theme.accent : theme.border,
                  backgroundColor: pos.conceptId === c.id ? theme.accent : 'transparent',
                }}>
                <Text style={{
                  color: pos.conceptId === c.id ? '#0a0a0a' : theme.text,
                  fontWeight: '700', fontSize: 13,
                }}>{c.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <TextInput
          value={searchQuery} onChangeText={setSearchQuery}
          placeholder="Search items…" placeholderTextColor={theme.textMuted}
          style={{
            color: theme.text, backgroundColor: theme.panel,
            borderWidth: 1, borderColor: theme.border, borderRadius: 12,
            padding: 12, fontSize: 15, marginBottom: 12,
          }}
        />

        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
          style={{ flexGrow: 0, marginBottom: 12 }}>
          {cats.map(c => (
            <Pressable
              key={c}
              onPress={() => setActiveCat(c)}
              style={{
                paddingHorizontal: 12, paddingVertical: 6,
                borderRadius: 8, borderWidth: 1,
                borderColor: activeCat === c ? theme.accent : theme.border,
              }}>
              <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>
                {c.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <FlatList
          data={visible}
          keyExtractor={i => i.id}
          numColumns={3}
          columnWrapperStyle={{ gap: 12 }}
          contentContainerStyle={{ gap: 12, paddingBottom: 32 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => pos.add({
                menuItemId: item.id,
                name: item.name,
                unitPriceCents: item.priceCents,
              })}
              disabled={!item.isAvailable}
              style={({ pressed }) => ({
                flex: 1, minHeight: 100,
                backgroundColor: pressed ? theme.panelAlt : theme.panel,
                borderRadius: theme.radius,
                borderWidth: 1, borderColor: theme.border,
                padding: 12, justifyContent: 'space-between',
                opacity: item.isAvailable ? 1 : 0.4,
              })}>
              <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14 }} numberOfLines={2}>
                {item.name}
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <Text style={{ color: theme.accent, fontWeight: '900', fontSize: 16 }}>{pkr(item.priceCents)}</Text>
                {!item.isAvailable && <Pill label="86" tone="danger" />}
              </View>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 40 }}>
              {menu.isLoading ? 'Loading menu…' : 'No items match.'}
            </Text>
          }
        />
      </View>

      {/* Cart */}
      <View style={{
        flex: 1, backgroundColor: theme.panel,
        borderLeftWidth: 1, borderLeftColor: theme.border,
        padding: 16,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18 }}>Order</Text>
          {pos.lines.length > 0 && (
            <Pressable onPress={pos.clear}><Text style={{ color: theme.textDim, fontSize: 13 }}>Clear</Text></Pressable>
          )}
        </View>

        {/* Channel toggle */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          {(['dinein', 'takeaway'] as const).map(ch => (
            <Pressable
              key={ch} onPress={() => pos.setChannel(ch)}
              style={{
                flex: 1, paddingVertical: 10, alignItems: 'center',
                borderRadius: 10, borderWidth: 1,
                borderColor: pos.channel === ch ? theme.accent : theme.border,
                backgroundColor: pos.channel === ch ? 'rgba(34,197,94,0.12)' : 'transparent',
              }}>
              <Text style={{ color: theme.text, fontWeight: '700', fontSize: 13 }}>
                {ch === 'dinein' ? 'DINE-IN' : 'TAKEAWAY'}
              </Text>
            </Pressable>
          ))}
        </View>

        {pos.channel === 'dinein' && (
          <TextInput
            value={pos.tableId ?? ''} onChangeText={t => pos.setTable(t || null)}
            placeholder="Table #" placeholderTextColor={theme.textMuted}
            style={{
              color: theme.text, backgroundColor: theme.panelAlt,
              borderWidth: 1, borderColor: theme.border, borderRadius: 10,
              padding: 10, fontSize: 14, marginBottom: 12,
            }}
          />
        )}

        <ScrollView style={{ flex: 1 }}>
          {pos.lines.length === 0 ? (
            <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 60 }}>Empty</Text>
          ) : pos.lines.map(line => (
            <View key={line.id} style={{
              paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
            }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14, flex: 1, paddingRight: 8 }}>
                  {line.name}
                </Text>
                <Text style={{ color: theme.accent, fontWeight: '800', fontSize: 14 }}>
                  {pkr(line.unitPriceCents * line.qty)}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pressable onPress={() => pos.setQty(line.id, line.qty - 1)}
                  style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: theme.panelAlt, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: theme.text, fontWeight: '900', fontSize: 16 }}>−</Text>
                </Pressable>
                <Text style={{ color: theme.text, fontWeight: '800', minWidth: 24, textAlign: 'center' }}>{line.qty}</Text>
                <Pressable onPress={() => pos.setQty(line.id, line.qty + 1)}
                  style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: theme.panelAlt, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: theme.text, fontWeight: '900', fontSize: 16 }}>+</Text>
                </Pressable>
                <View style={{ flex: 1 }} />
                <Pressable onPress={() => pos.remove(line.id)}>
                  <Text style={{ color: theme.textDim, fontSize: 12 }}>Remove</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </ScrollView>

        <View style={{ paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.border, gap: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: theme.textDim, fontWeight: '600' }}>Subtotal</Text>
            <Text style={{ color: theme.text, fontWeight: '800' }}>{pkr(pos.subtotalCents())}</Text>
          </View>
          <Button
            label="Send to kitchen"
            size="lg"
            full
            disabled={pos.lines.length === 0 || (pos.channel === 'dinein' && !pos.tableId)}
            onPress={() => router.push('/(staff)/pos/tender')}
          />
        </View>
      </View>
    </View>
  )
}
