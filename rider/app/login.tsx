// Rider sign-in: mobile number + password (owner, 2026-10-28: riders have full accounts).
//
// The WhatsApp code is ONLY for the first sign-in and a forgotten password: it comes with a new password, sets it
// and signs in. A manager adds the rider in admin -> Riders first. The server answers an unknown number exactly
// like a known one (202 { sent: true }), so this screen never says "number not found".

import { useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'

import { Button } from '../src/components/Button'
import { Banner, Label } from '../src/components/Card'
import { api, ApiError, API_URL, friendlyError } from '../src/lib/api'
import { formatPhone, isPkMobile, normalisePhone } from '../src/lib/format'
import { colors, theme } from '../src/lib/theme'
import type { AuthResponse } from '../src/lib/types'
import { sessionStore } from '../src/store/session'

const RESEND_AFTER_S = 30
const CODE_LENGTH = 6

/** The API's own rule (backend riderAuth/routes.ts newPasswordSchema). */
function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Use at least 8 characters.'
  if (!/[a-zA-Z]/.test(pw)) return 'Add at least one letter.'
  if (!/[0-9]/.test(pw)) return 'Add at least one number.'
  return null
}

export default function LoginScreen() {
  const insets = useSafeAreaInsets()
  const [stage, setStage] = useState<'signin' | 'code'>('signin')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const codeRef = useRef<TextInput | null>(null)

  // Tick once a second while the resend timer runs.
  useEffect(() => {
    if (stage !== 'code') return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [stage])

  const normalised = normalisePhone(phone)
  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1_000))

  async function signedIn(res: AuthResponse) {
    if (!res?.accessToken || !res.refreshToken || !res.rider) {
      throw new Error('servd sent an unexpected answer. Try again.')
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
    // The auth gate in app/_layout.tsx moves us to the jobs list.
    await sessionStore.getState().setSession(res.accessToken, res.refreshToken, res.rider)
  }

  function phoneOk(): boolean {
    if (isPkMobile(normalised)) return true
    setError('Enter your mobile number, like 0300 1234567.')
    return false
  }

  async function signIn() {
    if (busy) return
    setError(null)
    setNotice(null)
    if (!phoneOk()) return
    if (!password) { setError('Enter your password.'); return }
    setBusy(true)
    try {
      await signedIn(await api.post<AuthResponse>('/rider-auth/login', { phone: normalised, password }))
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
      setPassword('')
      setError(err instanceof ApiError && err.code === 'INVALID_CREDENTIALS'
        ? 'Wrong number or password. First time here, or forgot it? Get a code below to set your password.'
        : friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function requestCode(isResend: boolean) {
    setError(null)
    setNotice(null)
    if (!phoneOk()) return
    setBusy(true)
    try {
      await api.post('/rider-auth/otp/request', { phone: normalised })
      setStage('code')
      setCode('')
      setNewPassword('')
      setConfirm('')
      setResendAt(Date.now() + RESEND_AFTER_S * 1_000)
      setNow(Date.now())
      if (isResend) setNotice('A new code is on its way. Use the newest message.')
      setTimeout(() => codeRef.current?.focus(), 250)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function setAndSignIn() {
    if (busy) return
    setError(null)
    setNotice(null)
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) {
      setError(`Enter all ${CODE_LENGTH} digits of the code.`)
      return
    }
    const problem = passwordProblem(newPassword)
    if (problem) { setError(problem); return }
    if (newPassword !== confirm) { setError('The two passwords do not match.'); return }
    setBusy(true)
    try {
      await signedIn(await api.post<AuthResponse>('/rider-auth/otp/verify', { phone: normalised, code, newPassword }))
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
      if (err instanceof ApiError && err.code === 'INVALID_CODE') {
        setCode('')
        setError('That code is wrong or has expired. Check the newest WhatsApp message, or send a new code.')
        setTimeout(() => codeRef.current?.focus(), 100)
      } else {
        setError(friendlyError(err))
      }
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
            {stage === 'signin' ? 'Sign in with your mobile number and password.' : 'Set your password with the code we sent on WhatsApp.'}
          </Text>
        </View>

        <View style={{ padding: theme.padLg, gap: 18, flex: 1 }}>
          {error ? <Banner tone="danger" title="Not signed in" body={error} /> : null}
          {notice ? <Banner tone="success" title="Code sent" body={notice} /> : null}

          {stage === 'signin' ? (
            <>
              <View>
                <Label>YOUR MOBILE NUMBER</Label>
                <TextInput
                  value={phone}
                  onChangeText={(v) => { setPhone(v); if (error) setError(null) }}
                  placeholder="0300 1234567"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  textContentType="username"
                  autoCorrect={false}
                  editable={!busy}
                  accessibilityLabel="Your mobile number"
                  style={inputStyle(22)}
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
              <Button
                label="First time, or forgot your password? Get a code"
                intent="ghost"
                disabled={busy}
                onPress={() => void requestCode(false)}
              />
              <Text style={{ color: colors.textDim, fontSize: 15, lineHeight: 21 }}>
                Your manager has to add you in servd (Riders) first. Then get a code with that number and choose your password.
              </Text>
            </>
          ) : (
            <>
              <Text style={{ color: colors.ink, fontSize: 17, lineHeight: 24 }}>
                If <Text style={{ fontWeight: '900' }}>{formatPhone(normalised)}</Text> is on the rider list,
                a {CODE_LENGTH}-digit code is on its way on WhatsApp.
              </Text>
              <View>
                <Label>CODE</Label>
                <TextInput
                  ref={codeRef}
                  value={code}
                  onChangeText={(v) => { setCode(v.replace(/\D/g, '').slice(0, CODE_LENGTH)); if (error) setError(null) }}
                  placeholder={'0'.repeat(CODE_LENGTH)}
                  placeholderTextColor={colors.borderHi}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete={Platform.OS === 'android' ? 'sms-otp' : 'one-time-code'}
                  maxLength={CODE_LENGTH}
                  editable={!busy}
                  autoFocus
                  accessibilityLabel={`${CODE_LENGTH}-digit code`}
                  style={{ ...inputStyle(34), letterSpacing: 14, textAlign: 'center', fontWeight: '900' }}
                />
              </View>
              <View>
                <Label>NEW PASSWORD</Label>
                <TextInput
                  value={newPassword}
                  onChangeText={(v) => { setNewPassword(v); if (error) setError(null) }}
                  secureTextEntry
                  autoComplete="password-new"
                  textContentType="newPassword"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  accessibilityLabel="New password"
                  style={inputStyle(20)}
                />
                <Text style={{ color: colors.textDim, fontSize: 14, marginTop: 6 }}>At least 8 characters, with a letter and a number.</Text>
              </View>
              <View>
                <Label>TYPE IT AGAIN</Label>
                <TextInput
                  value={confirm}
                  onChangeText={(v) => { setConfirm(v); if (error) setError(null) }}
                  secureTextEntry
                  autoComplete="password-new"
                  textContentType="newPassword"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  returnKeyType="go"
                  onSubmitEditing={() => void setAndSignIn()}
                  accessibilityLabel="Type the new password again"
                  style={inputStyle(20)}
                />
              </View>
              <Button
                label="Set password and sign in"
                size="lg"
                busy={busy}
                disabled={code.length !== CODE_LENGTH || !newPassword || !confirm}
                onPress={() => void setAndSignIn()}
              />
              <Button
                label={resendIn > 0 ? `Send a new code in ${resendIn} s` : 'Send a new code'}
                intent="ghost"
                disabled={resendIn > 0 || busy}
                onPress={() => void requestCode(true)}
              />
              <Pressable
                onPress={() => { setStage('signin'); setCode(''); setError(null); setNotice(null) }}
                hitSlop={12}
                accessibilityRole="button"
                style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: colors.purple, fontSize: 16, fontWeight: '800', textDecorationLine: 'underline' }}>
                  Back to sign in
                </Text>
              </Pressable>
            </>
          )}

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
