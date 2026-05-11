import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../src/lib/api'

interface Customer {
  id: string
  name: string
  email: string
  phone: string | null
  loyaltyPoints: number
}

export default function AccountScreen() {
  const router = useRouter()
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Customer>('/customers/me').catch(() => null),
  })

  async function signOut() {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out', style: 'destructive',
        onPress: async () => {
          await SecureStore.deleteItemAsync('servd_token')
          router.replace('/(tabs)')
        },
      },
    ])
  }

  if (!me) {
    return (
      <View style={s.container}>
        <View style={s.loginBox}>
          <Text style={s.logo}>servd</Text>
          <Text style={s.tagline}>Sign in to track orders & earn loyalty points</Text>
          <TouchableOpacity style={s.btn} onPress={() => router.push('/login')}>
            <Text style={s.btnText}>Sign in / Register</Text>
          </TouchableOpacity>
        </View>
      </View>
    )
  }

  return (
    <View style={s.container}>
      {/* Profile card */}
      <View style={s.profileCard}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{me.name[0]?.toUpperCase() ?? '?'}</Text>
        </View>
        <View style={s.profileInfo}>
          <Text style={s.profileName}>{me.name}</Text>
          <Text style={s.profileEmail}>{me.email}</Text>
        </View>
      </View>

      {/* Loyalty points */}
      <View style={s.loyaltyCard}>
        <Text style={s.loyaltyLabel}>Loyalty Points</Text>
        <Text style={s.loyaltyPoints}>{me.loyaltyPoints.toLocaleString()}</Text>
        <Text style={s.loyaltySubtext}>pts</Text>
      </View>

      {/* Menu items */}
      {[
        { label: 'Order History', route: '/(tabs)/orders' as const },
      ].map(item => (
        <TouchableOpacity key={item.label} style={s.menuItem} onPress={() => router.push(item.route)}>
          <Text style={s.menuItemText}>{item.label}</Text>
          <Text style={s.chevron}>›</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity style={s.signOutBtn} onPress={signOut}>
        <Text style={s.signOutText}>Sign out</Text>
      </TouchableOpacity>
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#090a0e', padding: 20 },
  loginBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  logo: { fontSize: 36, fontWeight: '900', color: '#00D4B1' },
  tagline: { fontSize: 15, color: '#888', textAlign: 'center', lineHeight: 22 },
  btn: { backgroundColor: '#00D4B1', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14, marginTop: 8 },
  btnText: { fontSize: 15, fontWeight: '800', color: '#000' },
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#0d0f15', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#1a1d24', marginBottom: 12 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#00D4B1', alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 22, fontWeight: '900', color: '#000' },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 17, fontWeight: '800', color: '#fff' },
  profileEmail: { fontSize: 13, color: '#888', marginTop: 2 },
  loyaltyCard: { backgroundColor: '#0d1a17', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: 'rgba(0,212,177,0.2)', alignItems: 'center', marginBottom: 16 },
  loyaltyLabel: { fontSize: 12, fontWeight: '700', color: '#00D4B1', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  loyaltyPoints: { fontSize: 48, fontWeight: '900', color: '#00D4B1' },
  loyaltySubtext: { fontSize: 13, color: 'rgba(0,212,177,0.6)', marginTop: -4 },
  menuItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0d0f15', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#1a1d24', marginBottom: 8 },
  menuItemText: { fontSize: 14, fontWeight: '600', color: '#ccc' },
  chevron: { fontSize: 20, color: '#555' },
  signOutBtn: { marginTop: 20, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', alignItems: 'center' },
  signOutText: { fontSize: 14, fontWeight: '700', color: '#EF4444' },
})
