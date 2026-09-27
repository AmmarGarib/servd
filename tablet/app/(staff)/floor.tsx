// Floor plan view — live canvas of every table on a floor, status colors,
// imminent reservations, current open orders. Tap a table to seat, mark dirty,
// or jump to the order on it.
//
// Reads `GET /floors?conceptId` for the layout (positions / shapes) and
// `GET /floors/status?conceptId&floorId` for the live overlay (status + open
// orders + imminent reservations).
//
// The canvas is rendered at the floor's natural pixel size, scaled to fit
// the viewport. Tables are absolute-positioned with x / y / width / height.

import { useState } from 'react'
import { View, Text, Pressable, Alert, ScrollView, Modal } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { pkr, shortTime } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'
import { Button } from '../../src/components/Button'

interface Concept { id: string; name: string }

interface FloorRow {
  id: string
  conceptId: string
  name: string
  width: number
  height: number
  tables: TableRow[]
}
interface TableRow {
  id: string
  label: string
  capacity: number
  shape: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  floorSection?: string | null
  status: string
}

interface TableStatus {
  id: string
  label: string
  capacity: number
  shape: string
  status: string
  floorId: string | null
  x: number; y: number; width: number; height: number; rotation: number
  openOrders: Array<{ id: string; status: string; totalCents: number; placedAt: string; customerName?: string | null }>
  reservations: Array<{ id: string; partySize: number; startTime: string; endTime: string; status: string; guestName: string; isVip: boolean }>
}

// Canvas is rendered inside a fixed-size viewport. We pick the max size that
// fits comfortably on a 10" tablet in landscape with the side rail eating 132px.
const CANVAS_W = 1100
const CANVAS_H = 660

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  available:      { bg: 'rgba(34,197,94,0.18)',  fg: '#86efac' },
  seated:         { bg: 'rgba(245,158,11,0.18)', fg: '#fcd34d' },
  ordered:        { bg: 'rgba(245,158,11,0.28)', fg: '#fcd34d' },
  eating:         { bg: 'rgba(245,158,11,0.38)', fg: '#fcd34d' },
  check:          { bg: 'rgba(59,130,246,0.28)', fg: '#93c5fd' },
  reserved:       { bg: 'rgba(168,85,247,0.22)', fg: '#d8b4fe' },
  cleaning:       { bg: 'rgba(239,68,68,0.18)',  fg: '#fca5a5' },
  out_of_service: { bg: 'rgba(255,255,255,0.05)', fg: 'rgba(255,255,255,0.3)' },
}

export default function FloorScreen() {
  const qc = useQueryClient()
  const [conceptId, setConceptId] = useState<string | null>(null)
  const [floorId, setFloorId]     = useState<string | null>(null)
  const [picked, setPicked]       = useState<TableStatus | null>(null)

  const concepts = useQuery({
    queryKey: ['concepts'],
    // GET /concepts returns a bare array.
    queryFn:  async () => ({ concepts: await api.get<Concept[]>('/concepts') }),
  })

  if (!conceptId && concepts.data?.concepts[0]) setConceptId(concepts.data.concepts[0].id)

  const floors = useQuery({
    queryKey: ['floors', conceptId],
    queryFn:  () => api.get<FloorRow[]>(`/floors?conceptId=${conceptId}`),
    enabled:  !!conceptId,
  })

  if (!floorId && floors.data?.[0]) setFloorId(floors.data[0].id)

  const status = useQuery({
    queryKey: ['floor-status', conceptId, floorId],
    queryFn:  () => api.get<TableStatus[]>(`/floors/status?conceptId=${conceptId}&floorId=${floorId}`),
    enabled:  !!conceptId && !!floorId,
    refetchInterval: 10_000,
  })

  // Live invalidation
  useSocketEvent('order:new',          () => qc.invalidateQueries({ queryKey: ['floor-status'] }))
  useSocketEvent('order:updated',      () => qc.invalidateQueries({ queryKey: ['floor-status'] }))
  useSocketEvent('reservation:seated', () => qc.invalidateQueries({ queryKey: ['floor-status'] }))
  useSocketEvent('reservation:updated', () => qc.invalidateQueries({ queryKey: ['floor-status'] }))

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/tables/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['floor-status'] }),
    onError:   (err: Error) => Alert.alert('Hmm', err.message),
  })

  const floor = floors.data?.find(f => f.id === floorId) ?? null
  const tables = status.data ?? []

  // Scale to fit the rendered canvas inside CANVAS_W × CANVAS_H.
  const scaleX = floor ? CANVAS_W / floor.width  : 1
  const scaleY = floor ? CANVAS_H / floor.height : 1
  const scale  = Math.min(scaleX, scaleY)

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Floor</Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {/* Concept picker */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {concepts.data?.concepts.map(c => (
              <Pressable
                key={c.id}
                onPress={() => { setConceptId(c.id); setFloorId(null) }}
                style={{
                  paddingHorizontal: 12, paddingVertical: 6,
                  borderRadius: 999, borderWidth: 1,
                  borderColor: conceptId === c.id ? theme.accent : theme.border,
                  backgroundColor: conceptId === c.id ? theme.accent : 'transparent',
                }}>
                <Text style={{ color: conceptId === c.id ? '#0a0a0a' : theme.text, fontWeight: '700', fontSize: 13 }}>
                  {c.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Floor picker */}
          {(floors.data?.length ?? 0) > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {floors.data!.map(f => (
                <Pressable
                  key={f.id}
                  onPress={() => setFloorId(f.id)}
                  style={{
                    paddingHorizontal: 12, paddingVertical: 6,
                    borderRadius: 8, borderWidth: 1,
                    borderColor: floorId === f.id ? theme.info : theme.border,
                  }}>
                  <Text style={{ color: theme.text, fontWeight: '700', fontSize: 13 }}>{f.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>

      {!floor ? (
        <Panel style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: theme.textMuted, padding: 32 }}>
            {floors.isLoading ? 'Loading floors…' : 'No floor configured for this brand. Add one in admin.'}
          </Text>
        </Panel>
      ) : (
        <View style={{
          flex: 1, backgroundColor: theme.panel,
          borderRadius: theme.radius, borderWidth: 1, borderColor: theme.border,
          overflow: 'hidden',
        }}>
          {/* Canvas */}
          <View style={{
            width: floor.width * scale,
            height: floor.height * scale,
            margin: 'auto',
            position: 'relative',
            backgroundColor: 'rgba(255,255,255,0.02)',
          }}>
            {tables.map(t => {
              const palette = STATUS_COLORS[t.status] ?? STATUS_COLORS.available!
              const isRound = t.shape === 'round' || t.shape === 'square'
              const w = t.width  * scale
              const h = t.height * scale
              const x = t.x * scale
              const y = t.y * scale
              return (
                <Pressable
                  key={t.id}
                  onPress={() => setPicked(t)}
                  style={({ pressed }) => ({
                    position: 'absolute',
                    left: x, top: y,
                    width: w, height: h,
                    transform: [{ rotate: `${t.rotation}deg` }],
                    backgroundColor: palette.bg,
                    borderWidth: 2, borderColor: palette.fg,
                    borderRadius: isRound ? Math.min(w, h) / 2 : 6,
                    alignItems: 'center', justifyContent: 'center',
                    opacity: pressed ? 0.7 : 1,
                  })}>
                  <Text style={{ color: palette.fg, fontWeight: '900', fontSize: Math.max(11, Math.min(w / 6, 16)) }}>
                    {t.label}
                  </Text>
                  <Text style={{ color: palette.fg, fontSize: 9, opacity: 0.8 }}>
                    seats {t.capacity}
                  </Text>
                  {t.reservations.length > 0 && (
                    <View style={{ position: 'absolute', top: 2, right: 2 }}>
                      <Text style={{ color: '#d8b4fe', fontSize: 11 }}>📅</Text>
                    </View>
                  )}
                  {t.openOrders.length > 0 && (
                    <View style={{ position: 'absolute', bottom: 2, right: 2 }}>
                      <Text style={{ fontSize: 11 }}>🍽️</Text>
                    </View>
                  )}
                </Pressable>
              )
            })}
          </View>

          {/* Legend */}
          <View style={{
            flexDirection: 'row', flexWrap: 'wrap', gap: 12,
            padding: 12, borderTopWidth: 1, borderTopColor: theme.border,
          }}>
            {Object.entries(STATUS_COLORS).map(([k, c]) => (
              <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: c.bg, borderWidth: 1, borderColor: c.fg }} />
                <Text style={{ color: theme.textDim, fontSize: 11 }}>{k}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <TableModal
        table={picked}
        onClose={() => setPicked(null)}
        onSetStatus={(s) => { if (picked) updateStatus.mutate({ id: picked.id, status: s }) }}
      />
    </View>
  )
}

function TableModal({ table, onClose, onSetStatus }: {
  table: TableStatus | null
  onClose: () => void
  onSetStatus: (status: string) => void
}) {
  if (!table) return null
  return (
    <Modal visible={!!table} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{
        flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
        alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <Pressable onPress={() => undefined} style={{
          backgroundColor: theme.panel, borderRadius: theme.radiusLg,
          borderWidth: 1, borderColor: theme.borderHi, padding: 24,
          width: 560, maxWidth: '100%',
        }}>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>
            Table {table.label}
          </Text>
          <Text style={{ color: theme.textDim, fontSize: 13 }}>
            seats {table.capacity} · status: {table.status}
          </Text>

          {table.openOrders.length > 0 && (
            <View style={{ marginTop: 16 }}>
              <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginBottom: 6 }}>
                OPEN ORDERS
              </Text>
              {table.openOrders.map(o => (
                <View key={o.id} style={{
                  paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border,
                  flexDirection: 'row', justifyContent: 'space-between',
                }}>
                  <Text style={{ color: theme.text, fontWeight: '700' }}>
                    {o.customerName ?? 'Walk-in'} · {o.status}
                  </Text>
                  <Text style={{ color: theme.accent, fontWeight: '800' }}>{pkr(o.totalCents)}</Text>
                </View>
              ))}
            </View>
          )}

          {table.reservations.length > 0 && (
            <View style={{ marginTop: 16 }}>
              <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginBottom: 6 }}>
                IMMINENT RESERVATIONS
              </Text>
              {table.reservations.map(r => (
                <View key={r.id} style={{
                  paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: theme.text, fontWeight: '700' }}>{r.guestName}</Text>
                    {r.isVip && <Pill label="VIP" tone="warn" />}
                  </View>
                  <Text style={{ color: theme.textDim, fontSize: 12 }}>
                    {shortTime(r.startTime)} · party of {r.partySize} · {r.status}
                  </Text>
                </View>
              ))}
            </View>
          )}

          <View style={{ marginTop: 24, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(['available', 'seated', 'check', 'cleaning'] as const).map(s => (
              <Button
                key={s}
                label={s.toUpperCase()}
                intent={s === 'available' ? 'primary' : s === 'cleaning' ? 'warn' : 'ghost'}
                size="md"
                onPress={() => { onSetStatus(s); onClose() }}
              />
            ))}
            <View style={{ flex: 1 }} />
            <Button label="Close" intent="ghost" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
