// Mobile reservation booking. Mirrors the storefront /reserve/[slug] flow:
// pick party + date → fetch availability → pick slot → enter contact details
// → submit. Uses operator-controlled dayparts from the API response.

import { useState, useEffect, useMemo } from 'react'
import { View, Text, TouchableOpacity, ScrollView, TextInput, Alert, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { api } from '../../src/lib/api'

interface Slot      { time: string; available: boolean; tablesAvailable?: number }
interface Daypart   { label: string; startHour: number; endHour: number }
interface Availability {
  concept: { id: string; name: string; slug: string }
  date: string
  partySize: number
  dayparts?: Daypart[]
  slots: Slot[]
}

const DEFAULT_DAYPARTS: Daypart[] = [
  { label: 'Lunch', startHour: 0, endHour: 12 },
  { label: 'Afternoon', startHour: 12, endHour: 16 },
  { label: 'Dinner', startHour: 16, endHour: 22 },
  { label: 'Late', startHour: 22, endHour: 24 },
]

function todayPktIso() {
  const pkt = new Date(Date.now() + 5 * 3600_000)
  return pkt.toISOString().slice(0, 10)
}

export default function MobileReserveScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const router = useRouter()
  const [partySize, setPartySize] = useState(2)
  const [date, setDate]           = useState(todayPktIso())
  const [data, setData]           = useState<Availability | null>(null)
  const [loading, setLoading]     = useState(false)
  const [disabled, setDisabled]   = useState(false)

  const [selected, setSelected] = useState<string | null>(null)
  const [name,  setName]  = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setLoading(true)
    setDisabled(false)
    setSelected(null)
    api.get<Availability>(`/reservations/availability?conceptSlug=${slug}&date=${date}&partySize=${partySize}`)
      .then((d) => setData(d))
      .catch((err) => {
        const msg = (err as Error).message
        if (msg.toLowerCase().includes('not accepting')) setDisabled(true)
        else setData(null)
      })
      .finally(() => setLoading(false))
  }, [slug, date, partySize])

  const grouped = useMemo(() => {
    if (!data) return []
    const dayparts = data.dayparts && data.dayparts.length > 0 ? data.dayparts : DEFAULT_DAYPARTS
    const groups = dayparts.map((d) => ({ label: d.label, slots: [] as Slot[] }))
    for (const s of data.slots) {
      const h = new Date(s.time).getHours()
      const idx = dayparts.findIndex((d) => h >= d.startHour && h < d.endHour)
      if (idx === -1) continue
      groups[idx]!.slots.push(s)
    }
    return groups.filter((g) => g.slots.length > 0)
  }, [data])

  async function submit() {
    if (!selected || !name.trim() || !phone.trim()) return
    setSubmitting(true)
    try {
      await api.post('/reservations/public', {
        conceptSlug: slug,
        partySize,
        startTime: selected,
        guestName: name.trim(),
        guestPhone: phone.trim(),
        guestEmail: email.trim() || null,
        notes: notes.trim() || null,
      })
      Alert.alert('Booked!', 'Check your phone — we sent a confirmation link.', [
        { text: 'OK', onPress: () => router.back() },
      ])
    } catch (err) {
      Alert.alert('Hmm', (err as Error).message)
    } finally { setSubmitting(false) }
  }

  if (disabled) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0b0d12', justifyContent: 'center', padding: 28 }}>
        <Text style={{ color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 8 }}>Not taking bookings.</Text>
        <Text style={{ color: 'rgba(255,255,255,0.6)' }}>This brand isn&rsquo;t accepting reservations online right now.</Text>
      </View>
    )
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#0b0d12' }} contentContainerStyle={{ padding: 18, paddingBottom: 50 }}>
      <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', marginBottom: 4 }}>Book a table</Text>
      <Text style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 24 }}>{data?.concept.name ?? slug}</Text>

      <Section label="PARTY SIZE">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[1,2,3,4,5,6,8,10].map((n) => (
            <TouchableOpacity key={n} onPress={() => setPartySize(n)}
              style={{
                paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999,
                borderWidth: 1.5,
                borderColor: partySize === n ? '#22c55e' : 'rgba(255,255,255,0.15)',
                backgroundColor: partySize === n ? '#22c55e' : 'transparent',
              }}>
              <Text style={{ color: partySize === n ? '#000' : '#fff', fontWeight: '700' }}>{n}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>

      <Section label="DATE">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {Array.from({ length: 7 }).map((_, i) => {
            const d = new Date(Date.now() + i * 86_400_000 + 5 * 3600_000)
            const iso = d.toISOString().slice(0, 10)
            const lbl = i === 0 ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
            return (
              <TouchableOpacity key={iso} onPress={() => setDate(iso)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor: date === iso ? '#22c55e' : 'rgba(255,255,255,0.15)',
                  backgroundColor: date === iso ? '#22c55e' : 'transparent',
                }}>
                <Text style={{ color: date === iso ? '#000' : '#fff', fontWeight: '700', fontSize: 12 }}>{lbl}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </Section>

      <Section label="PICK A TIME">
        {loading && <ActivityIndicator color="#22c55e" style={{ marginVertical: 24 }} />}
        {!loading && grouped.length === 0 && data && (
          <Text style={{ color: 'rgba(255,255,255,0.5)' }}>No times available for this party + date — try a different day.</Text>
        )}
        {grouped.map((g) => (
          <View key={g.label} style={{ marginBottom: 16 }}>
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 }}>{g.label.toUpperCase()}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {g.slots.map((s) => {
                const time = new Date(s.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
                const isOn = selected === s.time
                return (
                  <TouchableOpacity key={s.time} onPress={() => s.available && setSelected(s.time)}
                    style={{
                      paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12,
                      borderWidth: 1.5,
                      borderColor: isOn ? '#22c55e' : 'rgba(255,255,255,0.15)',
                      backgroundColor: isOn ? '#22c55e' : 'transparent',
                      opacity: s.available ? 1 : 0.3,
                    }}>
                    <Text style={{ color: isOn ? '#000' : '#fff', fontWeight: '700', fontSize: 13 }}>{time}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>
        ))}
      </Section>

      {selected && (
        <Section label="YOUR DETAILS">
          <Input value={name}  onChangeText={setName}  placeholder="Full name" />
          <Input value={phone} onChangeText={setPhone} placeholder="Phone (e.g. 03001234567)" keyboardType="phone-pad" />
          <Input value={email} onChangeText={setEmail} placeholder="Email (optional)" keyboardType="email-address" autoCapitalize="none" />
          <Input value={notes} onChangeText={setNotes} placeholder="Allergies, occasion, requests…" multiline />
          <TouchableOpacity onPress={submit} disabled={submitting || !name.trim() || !phone.trim()}
            style={{
              backgroundColor: '#22c55e', borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 8,
              opacity: submitting || !name.trim() || !phone.trim() ? 0.5 : 1,
            }}>
            {submitting ? <ActivityIndicator color="#000" /> :
              <Text style={{ color: '#000', fontWeight: '800' }}>Confirm booking</Text>}
          </TouchableOpacity>
        </Section>
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
function Input(props: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      {...props}
      placeholderTextColor="rgba(255,255,255,0.3)"
      style={[{
        backgroundColor: 'rgba(255,255,255,0.04)', color: '#fff',
        borderRadius: 12, padding: 14, fontSize: 14, marginBottom: 8,
      }, props.style]}
    />
  )
}
