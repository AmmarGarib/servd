// KDS ticket card. Designed to be readable across a kitchen — large item
// names, station tags, and an elapsed-time badge that goes red after the
// concept's target prep time.

import { View, Text, Pressable } from 'react-native'
import { theme } from '../lib/theme'
import { elapsed, minutesSince, shortTime } from '../lib/format'
import { Pill } from './Panel'

export type TicketStatus = 'new' | 'fired' | 'ready' | 'served'

export interface TicketItem {
  id: string
  name: string
  qty: number
  notes?: string | null
  modifiers?: string[]
  station?: string | null
  status: TicketStatus
}

export interface Ticket {
  id: string
  number: string
  conceptName: string
  source: string
  table?: string | null
  customerName?: string | null
  placedAt: string
  targetMinutes?: number | null
  status: TicketStatus
  items: TicketItem[]
}

export function OrderTicket({
  ticket, onAdvance, onBump, onItemAdvance, compact = false,
}: {
  ticket: Ticket
  onAdvance: () => void
  onBump: () => void
  onItemAdvance?: (itemId: string) => void
  compact?: boolean
}) {
  const mins = minutesSince(ticket.placedAt) ?? 0
  const target = ticket.targetMinutes ?? 12
  const late = mins > target
  const warn = !late && mins > target * 0.7

  const headerBg =
    ticket.status === 'ready' ? theme.ready :
    ticket.status === 'fired' ? theme.fired :
    late ? theme.late : theme.newOrder

  return (
    <View style={{
      backgroundColor: theme.panel,
      borderRadius: theme.radius,
      borderWidth: 1, borderColor: late ? theme.danger : theme.border,
      overflow: 'hidden',
      width: compact ? 280 : 320,
    }}>
      {/* Header */}
      <View style={{
        backgroundColor: headerBg,
        padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <View>
          <Text style={{ color: '#0a0a0a', fontWeight: '900', fontSize: 22, letterSpacing: -0.5 }}>
            #{ticket.number}
          </Text>
          <Text style={{ color: 'rgba(0,0,0,0.65)', fontWeight: '700', fontSize: 11, letterSpacing: 0.8 }}>
            {ticket.conceptName.toUpperCase()} · {ticket.source.toUpperCase()}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ color: '#0a0a0a', fontWeight: '900', fontSize: 26 }}>{elapsed(ticket.placedAt)}</Text>
          <Text style={{ color: 'rgba(0,0,0,0.65)', fontWeight: '700', fontSize: 11 }}>
            placed {shortTime(ticket.placedAt)}
          </Text>
        </View>
      </View>

      {/* Meta strip */}
      <View style={{
        flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8,
        borderBottomWidth: 1, borderBottomColor: theme.border, flexWrap: 'wrap',
      }}>
        {ticket.table && <Pill label={`T${ticket.table}`} tone="info" />}
        {ticket.customerName && <Pill label={ticket.customerName} />}
        {warn && <Pill label="HUSTLE" tone="warn" />}
        {late && <Pill label="LATE" tone="danger" />}
      </View>

      {/* Items */}
      <View style={{ padding: 12, gap: 10, minHeight: 100 }}>
        {ticket.items.map((it) => (
          <Pressable
            key={it.id}
            onPress={() => onItemAdvance?.(it.id)}
            style={({ pressed }) => ({
              backgroundColor: pressed ? 'rgba(255,255,255,0.04)' : 'transparent',
              opacity: it.status === 'ready' || it.status === 'served' ? 0.55 : 1,
            })}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18 }}>{it.qty}×</Text>
              <View style={{ flex: 1 }}>
                <Text style={{
                  color: theme.text, fontWeight: '700', fontSize: 16,
                  textDecorationLine: it.status === 'ready' || it.status === 'served' ? 'line-through' : 'none',
                }}>{it.name}</Text>
                {it.modifiers?.map((m, idx) => (
                  <Text key={idx} style={{ color: theme.textDim, fontSize: 12, marginTop: 2 }}>+ {m}</Text>
                ))}
                {it.notes && (
                  <Text style={{ color: theme.warn, fontSize: 12, marginTop: 2, fontStyle: 'italic' }}>{it.notes}</Text>
                )}
              </View>
              {it.station && <Pill label={it.station} />}
            </View>
          </Pressable>
        ))}
      </View>

      {/* Actions */}
      <View style={{
        flexDirection: 'row', borderTopWidth: 1, borderTopColor: theme.border,
      }}>
        <Pressable onPress={onAdvance}
          style={{ flex: 1, paddingVertical: 14, alignItems: 'center', backgroundColor: theme.panelAlt }}>
          <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14, letterSpacing: 0.5 }}>
            {ticket.status === 'new' ? 'FIRE' : ticket.status === 'fired' ? 'READY' : 'SERVED'}
          </Text>
        </Pressable>
        <Pressable onPress={onBump}
          style={{ flex: 1, paddingVertical: 14, alignItems: 'center', backgroundColor: theme.accent }}>
          <Text style={{ color: '#0a0a0a', fontWeight: '900', fontSize: 14, letterSpacing: 0.5 }}>BUMP</Text>
        </Pressable>
      </View>
    </View>
  )
}
