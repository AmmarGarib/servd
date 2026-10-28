// Rider sign-in: an @gsfoods.pk email + password, same as staff (owner, 2026-10-28: "Riders same as staff —
// Gsfoods email + password"). The manager adds the rider in admin -> Riders and issues the password there.
// No WhatsApp code; a forgotten password is a new one from the manager.

import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'

import { Button } from '../src/components/Button'
import { Banner, Label } from '../src/components/Card'
import { api, ApiError, API_URL, friendlyError } from '../src/lib/api'
import { colors, theme } from '../src/lib/theme'
import type { AuthResponse } from '../src/lib/types'
import { sessionStore } from '../src/store/session'

export default function LoginScreen() {
  const insets = useSafeAreaInsets()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    if (busy) return
    setError(null)
    const em = email.trim().toLowerCase()
    if (!/^[^\s@]+@gsfoods\.pk$/.test(em)) { setError('Use your @gsfoods.pk email.'); return }
    if (!password) { setError('Enter your password.'); return }
    setBusy(true)
    try {
      const res = await api.post<AuthResponse>('/rider-auth/login', { email: em, password })
      if (!res?.accessToken || !res.refreshToken || !res.rider) {
        throw new Error('servd sent an unexpected answer. Try again.')
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      // The auth gate in app/_layout.tsx moves us to the jobs list.
      await sessionStore.getState().setSession(res.accessToken, res.refreshToken, res.rider)
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
      setPassword('')
      setError(err instanceof ApiError && err.code === 'INVALID_CREDENTIALS'
        ? 'Wrong email or password. Forgot it? Ask your manager for a new password.'
        : friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled">
        {/* Purple band with the wordmark */}
        <View style={{
          backgroundColor: colors.purple,
          paddingTop: insets.top + 36,
          paddingBottom: 32,
          paddingHorizontal: theme.padLg,
          borderBottomLeftRadius: 28,
          borderBottomRightRadius: 28,
        }}>
          <Text style={{ color: colors.onPurple, fontSize: 48, fontWeight: '900', letterSpacing: -1.5 }}>
            servd
          </Text>
          <Text style={{ color: colors.green, fontSize: 22, fontWeight: '800', marginTop: -4 }}>
            rider
          </Text>
          <Text style={{ color: colors.onPurple, fontSize: 16, marginTop: 14, lineHeight: 22, opacity: 0.9 }}>
            Sign in with your @gsfoods.pk email and password.
          </Text>
        </View>

        <View style={{ padding: theme.padLg, gap: 18, flex: 1 }}>
          {error ? <Banner tone="danger" title="Not signed in" body={error} /> : null}
          <View>
            <Label>EMAIL</Label>
            <TextInput
              value={email}
              onChangeText={(v) => { setEmail(v); if (error) setError(null) }}
              placeholder="name@gsfoods.pk"
              placeholderTextColor={colors.textMuted}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="username"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              accessibilityLabel="Your email"
              style={inputStyle(20)}
            />
          </View>
          <View>
            <Label>PASSWORD</Label>
            <TextInput
              value={password}
              onChangeText={(v) => { setPassword(v); if (error) setError(null) }}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              returnKeyType="go"
              onSubmitEditing={() => void signIn()}
              accessibilityLabel="Password"
              style={inputStyle(20)}
            />
          </View>
          <Button label="Sign in" size="lg" busy={busy} onPress={() => void signIn()} />
          <Text style={{ color: colors.textDim, fontSize: 15, lineHeight: 21 }}>
            New rider, or forgot your password? Your manager adds you in servd (Riders) and gives you your password.
          </Text>

          <View style={{ flex: 1 }} />
          <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingBottom: insets.bottom + 8 }}>
            {API_URL.replace(/^https?:\/\//, '')}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function inputStyle(fontSize: number) {
  return {
    backgroundColor: colors.card,
    color: colors.ink,
    borderColor: colors.borderHi,
    borderWidth: 2,
    borderRadius: theme.radius,
    paddingVertical: 16,
    paddingHorizontal: 18,
    fontSize,
    fontWeight: '700' as const,
    minHeight: 64,
  }
}
