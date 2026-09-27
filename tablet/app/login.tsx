// Staff login screen — email + password.
//
// This was a PIN pad, because one tablet was shared by a whole shift. Every
// staff member now has their own device, so it signs in the same way the rest
// of servd does and a four-digit code no longer mints a session that reaches
// the P&L.
//
// Clocking in is no longer welded to signing in. It used to be a side effect
// of the PIN call; it is now POST /auth/clock-in, taken after sign-in, and it
// still carries the geofence fix and the anti-buddy-punching selfie — the
// server enforces both in enforceClockInPolicy. Cancel the selfie and the
// clock-in is refused, but you stay signed in.

import { useState, useRef, useEffect } from 'react'
import { View, Text, Alert, Pressable, ActivityIndicator, TextInput } from 'react-native'
import { useRouter } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as FileSystem from 'expo-file-system'
import * as Haptics from 'expo-haptics'

import { Button } from '../src/components/Button'
import { sessionStore } from '../src/store/session'
import { api, API_URL } from '../src/lib/api'
import { currentFix } from '../src/lib/geo'
import { theme } from '../src/lib/theme'

interface LoginResp {
  accessToken: string
  refreshToken?: string
  twoFactorRequired?: boolean
  user: { id: string; name: string; role: string; email?: string }
}

interface UploadUrlResp { url: string; key: string; publicUrl: string }

export default function LoginScreen() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [cameraPerm, requestCameraPerm] = useCameraPermissions()
  const cameraRef = useRef<CameraView | null>(null)
  const [showSelfie, setShowSelfie] = useState(false)

  useEffect(() => {
    if (!cameraPerm?.granted) requestCameraPerm()
  }, [cameraPerm?.granted])

  async function uploadSelfie(): Promise<string | null> {
    if (!cameraRef.current) return null
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.5, skipProcessing: true })
      if (!photo?.uri) return null

      // 1. ask backend for a presigned upload URL
      const presign = await api.post<UploadUrlResp>('/media/upload-url', {
        contentType: 'image/jpeg',
        purpose: 'clockin-selfie',
      })

      // 2. PUT the file directly to R2 — FileSystem.uploadAsync streams it
      const upload = await FileSystem.uploadAsync(presign.url, photo.uri, {
        httpMethod: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      })
      if (upload.status >= 400) throw new Error(`Upload failed (${upload.status})`)

      return presign.publicUrl
    } catch (err) {
      console.warn('Selfie upload failed:', err)
      return null  // Backend treats null as "selfie skipped" — staff still logs in if config allows
    }
  }

  async function submit() {
    if (!email.trim()) { Alert.alert('Enter your email', 'Sign in with your @gsfoods.pk email address.'); return }
    if (password.length < 8) return
    setBusy(true)
    try {
      // Capture geo first (cheap, parallel safe) — backend may require it.
      const fixPromise = currentFix(5_000)

      // Selfie if backend / config wants it. We always try; backend ignores
      // selfieUrl if config has selfieRequiredAtClockIn=false.
      let selfieUrl: string | null = null
      if (cameraPerm?.granted) {
        setShowSelfie(true)
        // Give the camera ~250ms to actually start streaming.
        await new Promise(r => setTimeout(r, 350))
        selfieUrl = await uploadSelfie()
        setShowSelfie(false)
      }

      const fix = await fixPromise

      const resp = await api.post<LoginResp>('/auth/login', {
        email: email.trim().toLowerCase(),
        password,
      })

      if (resp.twoFactorRequired) {
        // The tablet has no OTP screen. Rather than half-authenticate someone
        // and strand them, say so plainly — 2FA accounts sign in on the web.
        throw new Error('This account uses two-factor sign-in. Use the admin site on a browser.')
      }

      await sessionStore.getState().setSession(resp.accessToken, resp.user, resp.refreshToken ?? null)

      // Clock in as a separate, authenticated action. A failure here must not
      // undo the sign-in: being unable to clock in is a problem to fix at the
      // counter, not a reason to bounce someone back to the login screen.
      try {
        await api.post('/auth/clock-in', {
          ...(fix && { lat: fix.lat, lng: fix.lng }),
          ...(selfieUrl && { selfieUrl }),
        })
      } catch (clockErr) {
        Alert.alert('Signed in, but not clocked in', (clockErr as Error).message)
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      router.replace('/(staff)/kds')
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
      Alert.alert("Couldn't sign in", (err as Error).message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, flexDirection: 'row' }}>
      {/* Left — brand panel */}
      <View style={{
        flex: 1, backgroundColor: theme.panel,
        padding: 48, justifyContent: 'space-between',
        borderRightWidth: 1, borderRightColor: theme.border,
      }}>
        <View>
          <Text style={{ fontSize: 56, fontWeight: '900', color: theme.text, letterSpacing: -1 }}>servd</Text>
          <Text style={{ fontSize: 18, color: theme.textDim, marginTop: 8 }}>Staff terminal</Text>
        </View>

        {/* Hidden camera (mounts off-screen so capture is instant). Only renders
            after permission granted so the preview LED is honest. */}
        {showSelfie && cameraPerm?.granted && (
          <View style={{ position: 'absolute', top: -9999, left: -9999, width: 200, height: 200 }}>
            <CameraView ref={cameraRef} facing="front" style={{ width: 200, height: 200 }} />
          </View>
        )}

        <Text style={{ color: theme.textMuted, fontSize: 14 }}>
          Sign in with your email and password. The system records your
          location and a quick selfie for every clock-in.
        </Text>
      </View>

      {/* Right — sign in */}
      <View style={{ flex: 1, padding: 32, justifyContent: 'center' }}>
        <Text style={{ color: theme.textDim, fontSize: 14, letterSpacing: 1.5, fontWeight: '700', textAlign: 'center', marginBottom: 12 }}>
          EMAIL
        </Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@gsfoods.pk"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          editable={!busy}
          style={{
            backgroundColor: theme.panelAlt, color: theme.text,
            borderRadius: 10, borderWidth: 1, borderColor: theme.border,
            paddingVertical: 14, paddingHorizontal: 16, fontSize: 17,
            textAlign: 'center', marginBottom: 20,
          }}
        />
        <Text style={{ color: theme.textDim, fontSize: 14, letterSpacing: 1.5, fontWeight: '700', textAlign: 'center', marginBottom: 12 }}>
          PASSWORD
        </Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          placeholderTextColor={theme.textMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          editable={!busy}
          onSubmitEditing={() => { if (!busy) void submit() }}
          returnKeyType="go"
          style={{
            backgroundColor: theme.panelAlt, color: theme.text,
            borderRadius: 10, borderWidth: 1, borderColor: theme.border,
            paddingVertical: 14, paddingHorizontal: 16, fontSize: 17,
            textAlign: 'center', marginBottom: 28,
          }}
        />

        {busy ? (
          <View style={{ alignItems: 'center', gap: 16 }}>
            <ActivityIndicator color={theme.accent} size="large" />
            <Text style={{ color: theme.textDim }}>Signing in…</Text>
          </View>
        ) : (
          <Button title="Sign in & clock in" onPress={() => void submit()} />
        )}

        <Pressable onPress={() => Alert.alert(
          'Forgot your password?',
          'Ask the CEO to issue a new one from Workforce. You can change it yourself from the admin site once you are in.',
        )} style={{ marginTop: 28, alignSelf: 'center' }}>
          <Text style={{ color: theme.textMuted, fontSize: 13 }}>Forgot your password?</Text>
        </Pressable>

        <Text style={{ color: theme.textMuted, fontSize: 11, textAlign: 'center', marginTop: 24 }}>
          API: {API_URL.replace(/^https?:\/\//, '')}
        </Text>
      </View>
    </View>
  )
}
