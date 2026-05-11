// PIN login screen.
//
// Multiple staff users share one tablet. Each has a 4-6 digit PIN issued from
// the admin console. The backend `/auth/pin` endpoint:
//   - validates the PIN against the active OperationsConfig location
//   - optionally enforces a geofence (lat/lng + radius from config)
//   - optionally requires a selfie URL (we presign-upload via /media/upload-url)
//   - returns { accessToken, user: { id, name, role } } and writes a ClockLog
//
// The selfie + geo capture happens INSIDE this screen so it's part of the
// punch-in atomic action. Cancel selfie = no clock in.

import { useState, useRef, useEffect } from 'react'
import { View, Text, Alert, Pressable, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as FileSystem from 'expo-file-system'
import * as Haptics from 'expo-haptics'

import { Keypad } from '../src/components/Keypad'
import { Button } from '../src/components/Button'
import { sessionStore } from '../src/store/session'
import { api, API_URL } from '../src/lib/api'
import { currentFix } from '../src/lib/geo'
import { theme } from '../src/lib/theme'

interface PinResp {
  accessToken: string
  user: { id: string; name: string; role: string; email?: string }
}

interface UploadUrlResp { url: string; key: string; publicUrl: string }

export default function LoginScreen() {
  const router = useRouter()
  const [pin, setPin] = useState('')
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
    if (pin.length < 4) return
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

      const resp = await api.post<PinResp>('/auth/pin', {
        pin,
        ...(fix && { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM }),
        ...(selfieUrl && { selfieUrl }),
      })

      await sessionStore.getState().setSession(resp.accessToken, resp.user)
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
      router.replace('/(staff)/kds')
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
      Alert.alert("Couldn't sign in", (err as Error).message)
      setPin('')
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
          Tap your PIN to sign in. The system records your location and
          a quick selfie for every clock-in.
        </Text>
      </View>

      {/* Right — keypad */}
      <View style={{ flex: 1, padding: 32, justifyContent: 'center' }}>
        <Text style={{ color: theme.textDim, fontSize: 14, letterSpacing: 1.5, fontWeight: '700', textAlign: 'center', marginBottom: 16 }}>
          ENTER PIN
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 14, marginBottom: 36 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <View key={i} style={{
              width: 22, height: 22, borderRadius: 11,
              borderWidth: 2, borderColor: theme.borderHi,
              backgroundColor: i < pin.length ? theme.accent : 'transparent',
            }} />
          ))}
        </View>

        {busy ? (
          <View style={{ alignItems: 'center', gap: 16 }}>
            <ActivityIndicator color={theme.accent} size="large" />
            <Text style={{ color: theme.textDim }}>Signing in…</Text>
          </View>
        ) : (
          <Keypad value={pin} onChange={setPin} onSubmit={submit} maxLength={6} />
        )}

        <Pressable onPress={() => Alert.alert(
          'Forgot PIN?',
          'Ask your manager to reset it in CRM → Staff or call your area lead.',
        )} style={{ marginTop: 28, alignSelf: 'center' }}>
          <Text style={{ color: theme.textMuted, fontSize: 13 }}>Forgot PIN?</Text>
        </Pressable>

        <Text style={{ color: theme.textMuted, fontSize: 11, textAlign: 'center', marginTop: 24 }}>
          API: {API_URL.replace(/^https?:\/\//, '')}
        </Text>
      </View>
    </View>
  )
}
