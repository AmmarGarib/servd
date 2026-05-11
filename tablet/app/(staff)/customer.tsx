// Customer lookup — phone or email search → full context: strikes / bans,
// loyalty tier + points, last orders, last reservations, lifetime spend.
// Used by hosts ("are they on the naughty list?") and cashiers (apply loyalty,
// see preferences).

import { useState } from 'react'
import { View, Text, TextInput, ScrollView, ActivityIndicator } from 'react-native'
import { useQuery } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
import { theme } from '../../src/lib/theme'
import { Panel, Pill } from '../../src/components/Panel'
import { pkr, shortDate, shortTime } from '../../src/lib/format'

interface CustomerContext {
  customer: {
    id: string
    name: string
    email?: string | null
    phone?: string | null
    createdAt: string
    isBanned: boolean
    strikeCount: number
    bannedAt?: string | null
    loyaltyTier?: string | null
    loyaltyPoints?: number
    lifetimeSpendCents?: number
    noShowCount?: number
    complaintCount?: number
    avgReviewRating?: number | null
    lastVisitAt?: string | null
  }
  recentOrders: Array<{
    id: string
    number: string
    placedAt: string
    totalCents: number
    status: string
    conceptName: string
  }>
  recentReservations: Array<{
    id: string
    startTime: string
    partySize: number
    status: string
    conceptName: string
  }>
  recentStrikes: Array<{
    id: string
    kind: string
    severity: number
    reason?: string | null
    recordedAt: string
    reversedAt?: string | null
  }>
}

export default function CustomerScreen() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')

  const q = useQuery({
    queryKey: ['customer-lookup', submitted],
    queryFn:  () => api.get<CustomerContext>(`/crm/customer-context?q=${encodeURIComponent(submitted)}`),
    enabled:  submitted.length >= 3,
  })

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26, marginBottom: 16 }}>Customer lookup</Text>

      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
        <TextInput
          value={query} onChangeText={setQuery}
          onSubmitEditing={() => setSubmitted(query.trim())}
          placeholder="Phone or email" placeholderTextColor={theme.textMuted}
          autoCapitalize="none" autoCorrect={false}
          style={{
            flex: 1, color: theme.text, backgroundColor: theme.panel,
            borderWidth: 1, borderColor: theme.border, borderRadius: 12,
            padding: 14, fontSize: 16,
          }}
        />
      </View>

      {!submitted ? (
        <Panel><Text style={{ color: theme.textMuted, textAlign: 'center', padding: 32 }}>
          Search by phone (e.g. 03001234567) or email.
        </Text></Panel>
      ) : q.isLoading ? (
        <ActivityIndicator color={theme.accent} size="large" />
      ) : q.isError ? (
        <Panel><Text style={{ color: theme.danger, textAlign: 'center', padding: 24 }}>
          No customer found for "{submitted}".
        </Text></Panel>
      ) : q.data && (
        <View style={{ gap: 16 }}>
          {/* Header card */}
          <Panel>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontWeight: '900', fontSize: 24 }}>{q.data.customer.name}</Text>
                <Text style={{ color: theme.textDim, fontSize: 14 }}>
                  {q.data.customer.phone}{q.data.customer.email && ` · ${q.data.customer.email}`}
                </Text>
                <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
                  Customer since {shortDate(q.data.customer.createdAt)}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, maxWidth: '40%', justifyContent: 'flex-end' }}>
                {q.data.customer.isBanned && <Pill label="🚫 BANNED" tone="danger" />}
                {q.data.customer.strikeCount > 0 && !q.data.customer.isBanned && (
                  <Pill label={`⚠ ${q.data.customer.strikeCount}/3 strikes`} tone="warn" />
                )}
                {q.data.customer.loyaltyTier && (
                  <Pill label={q.data.customer.loyaltyTier.toUpperCase()} tone="success" />
                )}
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
              <Stat label="Lifetime"   value={pkr(q.data.customer.lifetimeSpendCents ?? 0)} />
              <Stat label="Loyalty"    value={`${q.data.customer.loyaltyPoints ?? 0} pts`} />
              <Stat label="No-shows"   value={String(q.data.customer.noShowCount ?? 0)} />
              <Stat label="Complaints" value={String(q.data.customer.complaintCount ?? 0)} />
              <Stat label="Avg review" value={q.data.customer.avgReviewRating != null ? `${q.data.customer.avgReviewRating.toFixed(1)}★` : '—'} />
              <Stat label="Last visit" value={q.data.customer.lastVisitAt ? shortDate(q.data.customer.lastVisitAt) : '—'} />
            </View>
          </Panel>

          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Panel title="Recent orders" style={{ flex: 1 }}>
              {q.data.recentOrders.length === 0 ? (
                <Text style={{ color: theme.textMuted, padding: 12 }}>No orders yet.</Text>
              ) : q.data.recentOrders.map(o => (
                <View key={o.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: theme.text, fontWeight: '700' }}>#{o.number}</Text>
                    <Text style={{ color: theme.accent, fontWeight: '700' }}>{pkr(o.totalCents)}</Text>
                  </View>
                  <Text style={{ color: theme.textDim, fontSize: 12 }}>
                    {o.conceptName} · {shortDate(o.placedAt)} {shortTime(o.placedAt)} · {o.status}
                  </Text>
                </View>
              ))}
            </Panel>

            <Panel title="Recent reservations" style={{ flex: 1 }}>
              {q.data.recentReservations.length === 0 ? (
                <Text style={{ color: theme.textMuted, padding: 12 }}>No reservations yet.</Text>
              ) : q.data.recentReservations.map(r => (
                <View key={r.id} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: theme.text, fontWeight: '700' }}>{shortDate(r.startTime)} · {shortTime(r.startTime)}</Text>
                    <Pill label={r.status.toUpperCase()} tone={r.status === 'completed' ? 'success' : r.status === 'no-show' ? 'danger' : 'neutral'} />
                  </View>
                  <Text style={{ color: theme.textDim, fontSize: 12 }}>
                    {r.conceptName} · party of {r.partySize}
                  </Text>
                </View>
              ))}
            </Panel>
          </View>

          {q.data.recentStrikes.length > 0 && (
            <Panel title="Strike history">
              {q.data.recentStrikes.map(s => (
                <View key={s.id} style={{
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
                  opacity: s.reversedAt ? 0.5 : 1,
                }}>
                  <Pill label={s.kind.toUpperCase()} tone="warn" />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.text, fontWeight: '700', fontSize: 13 }}>
                      {s.reason ?? 'No reason recorded'}
                    </Text>
                    <Text style={{ color: theme.textDim, fontSize: 11 }}>
                      {shortDate(s.recordedAt)} · severity {s.severity}
                      {s.reversedAt && ' · FORGIVEN'}
                    </Text>
                  </View>
                </View>
              ))}
            </Panel>
          )}
        </View>
      )}
    </ScrollView>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ minWidth: 90, paddingVertical: 6, paddingRight: 16 }}>
      <Text style={{ color: theme.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 }}>{label.toUpperCase()}</Text>
      <Text style={{ color: theme.text, fontSize: 16, fontWeight: '800' }}>{value}</Text>
    </View>
  )
}
