// Magic-link login flow for mobile.
//
// The backend `/auth/customer/request` issues a 32-char token + emails a
// magic link. On mobile, the user gets the email and either:
//   (a) taps the link → universal link opens the app (future enhancement)
//   (b) copies the link OR the token from the email → pastes here
//
// We accept either the bare 32-char token OR a full URL — we extract the
// token from `?token=...` if a URL is pasted. Internal-friendly, simple.

import { useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Alert, ScrollView, KeyboardAvoidingView, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import * as SecureStore from 'expo-secure-store'
import { api } from '../src/lib/api'

export default function LoginScreen() {
  const router = useRouter()
  const [stage, setStage]   = useState<'email' | 'token'>('email')
  const [email, setEmail]   = useState('')
  const [name,  setName]    = useState('')
  const [token, setToken]   = useState('')
  const [busy, setBusy]     = useState(false)

  async function sendLink() {
    if (!email.trim() || !email.includes('@')) {
      Alert.alert('Hmm', 'Enter a real email so we can send you the link.')
      return
    }
    setBusy(true)
    try {
      await api.post('/auth/customer/request', {
        email: email.trim().toLowerCase(),
        ...(name.trim() && { name: name.trim() }),
      })
      setStage('token')
    } catch (err) {
      Alert.alert('Couldn\'t send', (err as Error).message)
    } finally { setBusy(false) }
  }

  function extractToken(input: string): string {
    const trimmed = input.trim()
    if (!trimmed) return ''
    if (trimmed.includes('token=')) {
      try {
        const url = new URL(trimmed)
        return url.searchParams.get('token') ?? trimmed
      } catch { /* fallthrough */ }
      const m = /[?&]token=([^&\s]+)/.exec(trimmed)
      if (m?.[1]) return m[1]
    }
    return trimmed
  }

  async function verify() {
    const tok = extractToken(token)
    if (!tok) return
    setBusy(true)
    try {
      const res = await api.post<{ token: string; customer: { id: string; name: string } }>(
        '/auth/customer/verify',
        { token: tok },
      )
      await SecureStore.setItemAsync('servd_token', res.token)
      router.replace('/(tabs)')
    } catch (err) {
      Alert.alert('Invalid link', (err as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#0b0d12' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 28 }} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 32, fontWeight: '800', color: '#fff', marginBottom: 8 }}>servd</Text>
        <Text style={{ fontSize: 15, color: 'rgba(255,255,255,0.55)', marginBottom: 32 }}>
          {stage === 'email'
            ? 'Sign in with your email — we\'ll send you a magic link.'
            : `We sent a link to ${email}. Tap it from your inbox, or paste the link here.`}
        </Text>

        {stage === 'email' ? (
          <>
            <Field label="EMAIL">
              <TextInput
                value={email} onChangeText={setEmail}
                placeholder="you@example.com" placeholderTextColor="rgba(255,255,255,0.3)"
                autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
                style={{
                  color: '#fff', backgroundColor: 'rgba(255,255,255,0.06)',
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
                  borderRadius: 12, padding: 14, fontSize: 16,
                }}
              />
            </Field>
            <Field label="YOUR NAME (FIRST TIME ONLY)">
              <TextInput
                value={name} onChangeText={setName}
                placeholder="optional" placeholderTextColor="rgba(255,255,255,0.3)"
                style={{
                  color: '#fff', backgroundColor: 'rgba(255,255,255,0.06)',
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
                  borderRadius: 12, padding: 14, fontSize: 16,
                }}
              />
            </Field>
            <TouchableOpacity onPress={sendLink} disabled={busy}
              style={{
                backgroundColor: '#22c55e', borderRadius: 12, padding: 16,
                alignItems: 'center', opacity: busy ? 0.5 : 1, marginTop: 12,
              }}>
              {busy ? <ActivityIndicator color="#000" /> : <Text style={{ color: '#000', fontSize: 16, fontWeight: '700' }}>Send magic link</Text>}
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Field label="PASTE LINK OR TOKEN FROM EMAIL">
              <TextInput
                value={token} onChangeText={setToken}
                placeholder="https://...?token=..." placeholderTextColor="rgba(255,255,255,0.3)"
                autoCapitalize="none" autoCorrect={false}
                multiline numberOfLines={3} textAlignVertical="top"
                style={{
                  color: '#fff', backgroundColor: 'rgba(255,255,255,0.06)',
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
                  borderRadius: 12, padding: 14, fontSize: 14, minHeight: 80,
                }}
              />
            </Field>
            <TouchableOpacity onPress={verify} disabled={busy || !token.trim()}
              style={{
                backgroundColor: '#22c55e', borderRadius: 12, padding: 16,
                alignItems: 'center', opacity: busy || !token.trim() ? 0.5 : 1,
              }}>
              {busy ? <ActivityIndicator color="#000" /> : <Text style={{ color: '#000', fontSize: 16, fontWeight: '700' }}>Sign in</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setStage('email'); setToken('') }} style={{ marginTop: 16, alignItems: 'center' }}>
              <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 14 }}>Use a different email</Text>
            </TouchableOpacity>
          </>
        )}
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
