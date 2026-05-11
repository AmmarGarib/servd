// Time clock — punch in/out with selfie + geo. Mirrors the existing
// /time-clock web kiosk but tablet-native. The signed-in staff user can
// punch their own shift; managers can switch user via the END SHIFT button
// in the side rail.

import { useRef, useState, useEffect } from 'react'
import { View, Text, Pressable, Alert, ActivityIndicator } from 'react-native'
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
      const presign = await api.post<{ url: string; publicUrl: string }>('/media/upload-url', {
        contentType: 'image/jpeg', purpose: 'clockin-selfie',
      })
      const up = await FileSystem.uploadAsync(presign.url, photo.uri, {
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
  )
}
