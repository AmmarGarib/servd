// Mobile post-order review screen. Mirrors the storefront /orders/[id]/review
// flow — 5-star overall, optional sub-ratings, optional tags, optional comment.
// Submitting within 24h of completion auto-credits 50 loyalty points
// (handled server-side).

import { useState } from 'react'
import { View, Text, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Alert } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { api } from '../../../../src/lib/api'

const POSITIVE_TAGS = ['Food was great', 'Quick service', 'Generous portions', 'Friendly staff', 'Good value', 'Loved the flavours'] as const
const IMPROVEMENT_TAGS = ['Took too long', 'Cold when it arrived', 'Item missing', 'Wrong item', 'Portion too small', 'Quality off'] as const

export default function MobileReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()

  const [rating, setRating] = useState(0)
  const [foodRating, setFoodRating]       = useState(0)
  const [serviceRating, setServiceRating] = useState(0)
  const [valueRating, setValueRating]     = useState(0)
  const [speedRating, setSpeedRating]     = useState(0)
  const [tags, setTags] = useState<string[]>([])
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  const isLow = rating > 0 && rating <= 3
  const palette = isLow ? IMPROVEMENT_TAGS : POSITIVE_TAGS

  function toggleTag(t: string) {
    setTags((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])
  }

  async function submit() {
    if (rating < 1) return
    setBusy(true)
    try {
      const cat: Record<string, number> = {}
      if (foodRating) cat.food = foodRating
      if (serviceRating) cat.service = serviceRating
      if (valueRating) cat.value = valueRating
      if (speedRating) cat.speed = speedRating
      const result = await api.post<{ bonusPointsAwarded?: number }>('/reviews', {
        orderId: id,
        rating,
        comment: comment.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        categoryRatings: Object.keys(cat).length > 0 ? cat : undefined,
      })
      Alert.alert(
        rating >= 4 ? 'Thanks!' : 'We hear you.',
        result.bonusPointsAwarded ? `+${result.bonusPointsAwarded} loyalty points credited.` : 'Thanks for the feedback.',
        [{ text: 'OK', onPress: () => router.replace('/(tabs)/orders') }],
      )
    } catch (err) {
      Alert.alert('Couldn\'t submit', (err as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#0b0d12' }} contentContainerStyle={{ padding: 18, paddingBottom: 50 }}>
      <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', marginBottom: 4 }}>How was your meal?</Text>
      <Text style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 24, fontSize: 13 }}>
        30 seconds · review within 24h for <Text style={{ color: '#22c55e', fontWeight: '700' }}>+50 loyalty points</Text>
      </Text>

      <Section label="OVERALL">
        <Stars value={rating} onChange={setRating} large />
      </Section>

      {rating > 0 && (
        <>
          <Section label="ANYTHING SPECIFIC? (OPTIONAL)">
            <SubRow label="Food"    value={foodRating}    onChange={setFoodRating} />
            <SubRow label="Service" value={serviceRating} onChange={setServiceRating} />
            <SubRow label="Value"   value={valueRating}   onChange={setValueRating} />
            <SubRow label="Speed"   value={speedRating}   onChange={setSpeedRating} />
          </Section>

          <Section label={isLow ? 'WHAT WENT WRONG?' : 'WHAT STOOD OUT?'}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {palette.map((t) => {
                const active = tags.includes(t)
                return (
                  <TouchableOpacity key={t} onPress={() => toggleTag(t)}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
                      backgroundColor: active ? '#22c55e' : 'rgba(255,255,255,0.04)',
                      borderWidth: 1.5,
                      borderColor: active ? '#22c55e' : 'rgba(255,255,255,0.15)',
                    }}>
                    <Text style={{ color: active ? '#000' : '#fff', fontSize: 12, fontWeight: '700' }}>{t}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </Section>

          <Section label="ANYTHING ELSE? (OPTIONAL)">
            <TextInput
              value={comment} onChangeText={setComment}
              multiline numberOfLines={3} textAlignVertical="top"
              placeholder={isLow ? 'Tell us what we should fix…' : 'Tell us what made it special…'}
              placeholderTextColor="rgba(255,255,255,0.3)"
              style={{
                backgroundColor: 'rgba(255,255,255,0.04)', color: '#fff',
                borderRadius: 12, padding: 14, minHeight: 80, fontSize: 14,
              }}
            />
          </Section>

          <TouchableOpacity onPress={submit} disabled={busy}
            style={{ backgroundColor: '#22c55e', borderRadius: 14, padding: 16, alignItems: 'center', opacity: busy ? 0.5 : 1 }}>
            {busy ? <ActivityIndicator color="#000" /> : <Text style={{ color: '#000', fontWeight: '800' }}>Submit review</Text>}
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 24 }}>
      <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 10 }}>{label}</Text>
      {children}
    </View>
  )
}
function Stars({ value, onChange, large }: { value: number; onChange: (n: number) => void; large?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', gap: large ? 8 : 4 }}>
      {[1,2,3,4,5].map((n) => (
        <TouchableOpacity key={n} onPress={() => onChange(n)}>
          <Text style={{ fontSize: large ? 40 : 22, color: n <= value ? '#fbbf24' : 'rgba(255,255,255,0.18)' }}>★</Text>
        </TouchableOpacity>
      ))}
    </View>
  )
}
function SubRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
      <Text style={{ color: '#fff', fontSize: 14 }}>{label}</Text>
      <Stars value={value} onChange={onChange} />
    </View>
  )
}
