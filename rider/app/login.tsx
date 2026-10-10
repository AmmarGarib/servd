// Rider sign-in: phone number -> 6-digit code on WhatsApp.
//
// A manager adds the rider in admin -> Riders first. The server answers an
// unknown number exactly like a known one (202 { sent: true }), so this screen
// never says "number not found" — it says "if this number is on the rider
// list, a code is on its way", and points at the manager when nothing comes.

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

export default function LoginScreen() {
  const insets = useSafeAreaInsets()
  const [stage, setStage] = useState<'phone' | 'code'>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
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

  async function requestCode(isResend: boolean) {
    setError(null)
    setNotice(null)
    if (!isPkMobile(normalised)) {
      setError('Enter your mobile number, like 0300 1234567.')
      return
    }
    setBusy(true)
    try {
      await api.post('/rider-auth/otp/request', { phone: normalised })
      setStage('code')
      setCode('')
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

  async function verify(value: string) {
    if (busy) return
    setError(null)
    setNotice(null)
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(value)) {
      setError(`Enter all ${CODE_LENGTH} digits of the code.`)
      return
    }
    setBusy(true)
    try {
      const res = await api.post<AuthResponse>('/rider-auth/otp/verify', { phone: normalised, code: value })
      if (!res?.accessToken || !res.refreshToken || !res.rider) {
        throw new Error('servd sent an unexpected answer. Try again.')
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      // The auth gate in app/_layout.tsx moves us to the jobs list.
      await sessionStore.getState().setSession(res.accessToken, res.refreshToken, res.rider)
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
      setCode('')
      if (err instanceof ApiError && (err.status === 401 || err.code === 'INVALID_CODE')) {
        setError('That code is wrong or has expired. Check the newest WhatsApp message, or send a new code.')
      } else {
        setError(friendlyError(err))
      }
      setTimeout(() => codeRef.current?.focus(), 100)
    } finally {
      setBusy(false)
    }
  }

  function onCodeChange(v: string) {
    const digits = v.replace(/\D/g, '').slice(0, CODE_LENGTH)
    setCode(digits)
    if (error) setError(null)
    if (digits.length === CODE_LENGTH) void verify(digits)
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
            Sign in with your phone number. We send a code on WhatsApp.
          </Text>
        </View>

        <View style={{ padding: theme.padLg, gap: 18, flex: 1 }}>
          {error ? <Banner tone="danger" title="Not signed in" body={error} /> : null}
          {notice ? <Banner tone="success" title="Code sent" body={notice} /> : null}

          {stage === 'phone' ? (
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
                  textContentType="telephoneNumber"
                  autoCorrect={false}
                  editable={!busy}
                  returnKeyType="send"
                  onSubmitEditing={() => void requestCode(false)}
                  accessibilityLabel="Your mobile number"
                  style={inputStyle(22)}
                />
              </View>
              <Button
                label="Send code on WhatsApp"
                size="lg"
                busy={busy}
                onPress={() => void requestCode(false)}
              />
              <Text style={{ color: colors.textDim, fontSize: 15, lineHeight: 21 }}>
                Your manager has to add you in servd (Riders) before you can sign in.
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
                  onChangeText={onCodeChange}
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
              <Button
                label="Sign in"
                size="lg"
                busy={busy}
                disabled={code.length !== CODE_LENGTH}
                onPress={() => void verify(code)}
              />
              <Button
                label={resendIn > 0 ? `Send a new code in ${resendIn} s` : 'Send a new code'}
                intent="ghost"
                disabled={resendIn > 0 || busy}
                onPress={() => void requestCode(true)}
              />
              <Pressable
                onPress={() => { setStage('phone'); setCode(''); setError(null); setNotice(null) }}
                hitSlop={12}
                accessibilityRole="button"
                style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: colors.purple, fontSize: 16, fontWeight: '800', textDecorationLine: 'underline' }}>
                  Use a different number
                </Text>
              </Pressable>
              <Text style={{ color: colors.textDim, fontSize: 15, lineHeight: 21 }}>
                No code after a minute? Check the number, then ask your manager to check you are added in Riders
                with this number.
              </Text>
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
