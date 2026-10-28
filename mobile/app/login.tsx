// Customer sign-in for mobile: email + password (POST /auth/customer/login).
//
// A customer verifies a code ONCE, when they create their account (owner, 2026-10-28: "Customers also only use
// otp for first time login"). Accounts are created on servd.pk/signup for now; the emailed sign-in link the app
// used before is retired (the API answers 410).

import { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, ScrollView, KeyboardAvoidingView, Platform, Linking } from 'react-native'
import { useRouter } from 'expo-router'
import * as SecureStore from 'expo-secure-store'
import { api } from '../src/lib/api'

const SITE = 'https://servd.pk'

const inputStyle = {
  color: '#fff', backgroundColor: 'rgba(255,255,255,0.06)',
  borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  borderRadius: 12, padding: 14, fontSize: 16,
} as const

export default function LoginScreen() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function signIn() {
    if (!email.trim() || !email.includes('@') || !password) {
      Alert.alert('Hmm', 'Enter your email and password.')
      return
    }
    setBusy(true)
    try {
      const res = await api.post<{ token: string; customer: { id: string; name: string } }>(
        '/auth/customer/login',
        { email: email.trim().toLowerCase(), password },
      )
      await SecureStore.setItemAsync('servd_token', res.token)
      router.replace('/(tabs)')
    } catch {
      setPassword('')
      Alert.alert('Not signed in', 'Wrong email or password.')
    } finally { setBusy(false) }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#0b0d12' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 28 }} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 32, fontWeight: '800', color: '#fff', marginBottom: 8 }}>servd</Text>
        <Text style={{ fontSize: 15, color: 'rgba(255,255,255,0.55)', marginBottom: 32 }}>
          Sign in with your email and password.
        </Text>

        <Field label="EMAIL">
          <TextInput
            value={email} onChangeText={setEmail}
            placeholder="you@example.com" placeholderTextColor="rgba(255,255,255,0.3)"
            autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
            autoComplete="email" textContentType="username"
            style={inputStyle}
          />
        </Field>
        <Field label="PASSWORD">
          <TextInput
            value={password} onChangeText={setPassword}
            secureTextEntry autoCapitalize="none" autoCorrect={false}
            autoComplete="password" textContentType="password"
            returnKeyType="go" onSubmitEditing={() => void signIn()}
            style={inputStyle}
          />
        </Field>
        <TouchableOpacity onPress={() => void signIn()} disabled={busy}
          style={{
            backgroundColor: '#22c55e', borderRadius: 12, padding: 16,
            alignItems: 'center', opacity: busy ? 0.5 : 1, marginTop: 12,
          }}>
          {busy ? <ActivityIndicator color="#000" /> : <Text style={{ color: '#000', fontSize: 16, fontWeight: '700' }}>Sign in</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void Linking.openURL(`${SITE}/login`)} style={{ marginTop: 16, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 14 }}>Forgot your password?</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => void Linking.openURL(`${SITE}/signup`)} style={{ alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 14, fontWeight: '700' }}>New to servd? Create your account</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.5, color: 'rgba(255,255,255,0.45)', marginBottom: 8 }}>{label}</Text>
      {children}
    </View>
  )
}
