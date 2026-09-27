// Time clock — punch in/out with selfie + geo, tablet-native twin of the
// admin /time-clock page. The signed-in person punches their own shift; staff
// WITHOUT a login punch on this tablet with their HR employee ID and the kiosk
// PIN HR set for them. Every punch writes that day's HR attendance (present or
// late against the roster) through /time-clock on the API.

import { useRef, useState, useEffect } from 'react'
import { View, Text, Pressable, Alert, ActivityIndicator, TextInput } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as FileSystem from 'expo-file-system'

import { api } from '../../src/lib/api'
import { theme } from '../../src/lib/theme'
import { useSessionStore } from '../../src/store/session'
import { currentFix } from '../../src/lib/geo'
import { shortTime } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'
import { Button } from '../../src/components/Button'

interface ClockLog {
  id: string
  staffId: string
  staffName: string
  clockInAt: string
  clockOutAt?: string | null
  geofenceOk: boolean
  selfieUrl?: string | null
}

interface StatusResp {
  punchedIn: boolean
  shift?: ClockLog
  todayShifts: ClockLog[]
}

export default function TimeClockScreen() {
  const user = useSessionStore(s => s.user)
  const qc   = useQueryClient()
  const [cameraPerm, requestCameraPerm] = useCameraPermissions()
  const cameraRef = useRef<CameraView | null>(null)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!cameraPerm?.granted) requestCameraPerm()
  }, [cameraPerm?.granted])

  const status = useQuery({
    queryKey: ['time-clock', user?.id],
    queryFn:  () => api.get<StatusResp>('/time-clock/status'),
    enabled:  !!user,
  })

  async function captureSelfie(): Promise<string | null> {
    if (!cameraRef.current) return null
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.5, skipProcessing: true })
      if (!photo?.uri) return null
      // GET /media/upload-url is the one presigner (shared with admin); it
      // returns { uploadUrl, publicUrl }. This used to POST, which 404'd.
      const presign = await api.get<{ uploadUrl: string; publicUrl: string }>(
        `/media/upload-url?filename=clockin-${Date.now()}.jpg&contentType=image/jpeg&category=clockin`,
      )
      const up = await FileSystem.uploadAsync(presign.uploadUrl, photo.uri, {
        httpMethod: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      })
      if (up.status >= 400) return null
      return presign.publicUrl
    } catch {
      return null
    }
  }

  const punch = useMutation({
    mutationFn: async (action: 'in' | 'out') => {
      setCapturing(true)
      try {
        const [fix, selfieUrl] = await Promise.all([
          currentFix(5_000),
          cameraPerm?.granted ? captureSelfie() : Promise.resolve(null),
        ])
        return api.post(`/time-clock/punch-${action}`, {
          ...(fix && { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM }),
          ...(selfieUrl && { selfieUrl }),
        })
      } finally {
        setCapturing(false)
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['time-clock'] }),
    onError:   (err: Error) => Alert.alert('Punch failed', err.message),
  })

  // Kiosk punch for staff without a login: employee ID + PIN. In when their
  // day is not open, out when it is — the server decides.
  const [kioskCode, setKioskCode] = useState('')
  const [kioskPin, setKioskPin] = useState('')
  const kiosk = useMutation({
    mutationFn: async () => {
      setCapturing(true)
      try {
        const [fix, selfieUrl] = await Promise.all([
          currentFix(5_000),
          cameraPerm?.granted ? captureSelfie() : Promise.resolve(null),
        ])
        return await api.post<{ action: 'in' | 'out'; employee: { fullName: string }; attendance: { status: string | null; lateMinutes: number | null } | null }>('/time-clock/kiosk/punch', {
          employeeCode: kioskCode.trim(), pin: kioskPin,
          ...(fix && { lat: fix.lat, lng: fix.lng }),
          ...(selfieUrl && { selfieUrl }),
        })
      } finally {
        setCapturing(false)
      }
    },
    onSuccess: (r) => {
      setKioskCode(''); setKioskPin('')
      const late = r.attendance?.status === 'late' ? ` Marked late by ${r.attendance.lateMinutes} min.` : ''
      Alert.alert(r.action === 'in' ? 'Clocked in' : 'Clocked out', `${r.employee.fullName}${r.action === 'in' ? ', welcome.' : ', goodbye.'}${late}`)
      qc.invalidateQueries({ queryKey: ['time-clock'] })
    },
    onError: (err: Error) => { setKioskPin(''); Alert.alert('Punch failed', err.message) },
  })

  const punchedIn = status.data?.punchedIn ?? false
  const shift = status.data?.shift

  return (
    <View style={{ flex: 1, padding: 16, flexDirection: 'row', gap: 16 }}>
      <Panel style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, padding: 32 }}>
        <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 13, letterSpacing: 1.5 }}>
          {user?.name?.toUpperCase() ?? 'STAFF'} · {user?.role?.toUpperCase()}
        </Text>

        <Text style={{
          color: punchedIn ? theme.accent : theme.textMuted,
          fontWeight: '900', fontSize: 64, letterSpacing: -1,
        }}>
          {punchedIn ? 'ON SHIFT' : 'OFF'}
        </Text>

        {shift && punchedIn && (
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: theme.text, fontSize: 18 }}>
              Since {shortTime(shift.clockInAt)}
            </Text>
            {!shift.geofenceOk && <Pill label="OUTSIDE GEOFENCE" tone="warn" />}
          </View>
        )}

        {/* Hidden camera */}
        {cameraPerm?.granted && (
          <View style={{ position: 'absolute', top: -9999, left: -9999, width: 200, height: 200 }}>
            <CameraView ref={cameraRef} facing="front" style={{ width: 200, height: 200 }} />
          </View>
        )}

        {punch.isPending || capturing ? (
          <View style={{ alignItems: 'center', gap: 12 }}>
            <ActivityIndicator color={theme.accent} size="large" />
            <Text style={{ color: theme.textDim }}>{capturing ? 'Capturing selfie…' : 'Recording…'}</Text>
          </View>
        ) : punchedIn ? (
          <Button label="Punch out" intent="danger" size="xl" onPress={() => punch.mutate('out')} />
        ) : (
          <Button label="Punch in" size="xl" onPress={() => punch.mutate('in')} />
        )}
      </Panel>

      <View style={{ flex: 1, gap: 16 }}>
      <Panel title="No login? Punch with your employee ID" style={{ gap: 10, padding: 16 }}>
        <TextInput value={kioskCode} onChangeText={setKioskCode} placeholder="Employee ID (e.g. EMP-0012)" placeholderTextColor={theme.textMuted}
          autoCapitalize="characters" autoCorrect={false}
          style={{ color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 10, padding: 12, fontSize: 16 }} />
        <TextInput value={kioskPin} onChangeText={(t) => setKioskPin(t.replace(/\D/g, '').slice(0, 6))} placeholder="Kiosk PIN" placeholderTextColor={theme.textMuted}
          keyboardType="number-pad" secureTextEntry
          style={{ color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 10, padding: 12, fontSize: 16 }} />
        <Button label={kiosk.isPending ? 'Recording…' : 'Punch in / out'} onPress={() => {
          if (!kioskCode.trim() || kioskPin.length < 4) { Alert.alert('Punch', 'Type your employee ID and PIN.'); return }
          kiosk.mutate()
        }} />
      </Panel>
      <Panel title="Today's shifts" style={{ flex: 1 }}>
        {status.isLoading ? (
          <ActivityIndicator color={theme.accent} />
        ) : (status.data?.todayShifts.length ?? 0) === 0 ? (
          <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24 }}>No punches yet today.</Text>
        ) : (
          status.data!.todayShifts.map((s) => (
            <View key={s.id} style={{
              flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
              paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.border,
            }}>
              <View>
                <Text style={{ color: theme.text, fontWeight: '700', fontSize: 15 }}>{s.staffName}</Text>
                <Text style={{ color: theme.textDim, fontSize: 13 }}>
                  {shortTime(s.clockInAt)} → {s.clockOutAt ? shortTime(s.clockOutAt) : '…'}
                </Text>
              </View>
              {!s.geofenceOk && <Pill label="OUT-OF-GEO" tone="warn" />}
            </View>
          ))
        )}
      </Panel>
      </View>
    </View>
  )
}
