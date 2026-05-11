// Settings — printer pairing, push toggle, station selector (for tablets
// pinned to a single station). Saves to AsyncStorage so each tablet keeps
// its own config across reboots.

import { useEffect, useState } from 'react'
import { View, Text, ScrollView, Pressable, Alert, Switch } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import AsyncStorage from '@react-native-async-storage/async-storage'

import { api } from '../../src/lib/api'
import { theme } from '../../src/lib/theme'
import { Panel, Pill } from '../../src/components/Panel'
import { Button } from '../../src/components/Button'
import {
  discoverDevices, getPairedPrinter, setPairedPrinter,
  isBluetoothAvailable, initBluetoothTransport,
  type PairedPrinter, type DiscoveredDevice,
} from '../../src/lib/printerTransport'
import { useSessionStore } from '../../src/store/session'
import { pushTokenStore, registerPushNotifications, setLocalAlertsEnabled, getLocalAlertsEnabled } from '../../src/lib/notifications'

interface Station { id: string; name: string; conceptName: string }

const PINNED_STATION_KEY = 'servd_pinned_station'

export default function SettingsScreen() {
  const user = useSessionStore(s => s.user)
  const [paired, setPaired] = useState<PairedPrinter | null>(null)
  const [devices, setDevices] = useState<DiscoveredDevice[]>([])
  const [scanning, setScanning] = useState(false)
  const [paperWidth, setPaperWidth] = useState<58 | 80>(80)

  const [pinnedStationId, setPinnedStationId] = useState<string | null>(null)
  const [localAlerts, setLocalAlerts] = useState(true)
  const pushToken = pushTokenStore.use(s => s.token)

  useEffect(() => {
    getPairedPrinter().then(setPaired)
    AsyncStorage.getItem(PINNED_STATION_KEY).then(setPinnedStationId)
    getLocalAlertsEnabled().then(setLocalAlerts)
  }, [])

  const stations = useQuery({
    queryKey: ['stations'],
    queryFn:  () => api.get<{ stations: Station[] }>('/stations'),
  })

  async function scan() {
    setScanning(true)
    try {
      const found = await discoverDevices()
      setDevices(found)
      if (found.length === 0 && !isBluetoothAvailable()) {
        Alert.alert(
          'Bluetooth unavailable',
          'This build of the app doesn\'t include the Bluetooth printer module. Install a Bluetooth ESC/POS package and rebuild as a custom dev client. See README.',
        )
      }
    } catch (err) {
      Alert.alert('Scan failed', (err as Error).message)
    } finally {
      setScanning(false)
    }
  }

  async function pair(d: DiscoveredDevice) {
    const p: PairedPrinter = { address: d.address, name: d.name, paperWidth }
    await setPairedPrinter(p)
    await initBluetoothTransport()
    setPaired(p)
    Alert.alert('Paired', `${d.name} is now the active receipt printer.`)
  }

  async function unpair() {
    await setPairedPrinter(null)
    setPaired(null)
  }

  async function setStation(id: string | null) {
    if (id) await AsyncStorage.setItem(PINNED_STATION_KEY, id)
    else    await AsyncStorage.removeItem(PINNED_STATION_KEY)
    setPinnedStationId(id)
  }

  async function toggleAlerts(v: boolean) {
    await setLocalAlertsEnabled(v)
    setLocalAlerts(v)
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26, marginBottom: 4 }}>Settings</Text>
      <Text style={{ color: theme.textDim, marginBottom: 24 }}>{user?.name} · {user?.role}</Text>

      <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        {/* Printer */}
        <Panel title="Receipt printer" style={{ flex: 1, minWidth: 380 }}>
          {paired ? (
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <Pill label="PAIRED" tone="success" />
                <Text style={{ color: theme.text, fontWeight: '800' }}>{paired.name}</Text>
              </View>
              <Text style={{ color: theme.textDim, fontSize: 12 }}>
                {paired.address} · {paired.paperWidth}mm paper
              </Text>
              <View style={{ marginTop: 16, flexDirection: 'row', gap: 8 }}>
                <Button label="Unpair" intent="danger" size="md" onPress={unpair} />
                <Button label="Test print" intent="ghost" size="md"
                  onPress={() => Alert.alert('Test print', 'Build a test receipt and send to the paired device. Skipped until Bluetooth module is wired.')} />
              </View>
            </View>
          ) : (
            <View>
              <Text style={{ color: theme.textMuted, marginBottom: 12 }}>
                No printer paired. Receipts save digitally but won't print.
              </Text>

              <Text style={{ color: theme.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 }}>
                PAPER WIDTH
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                {([58, 80] as const).map(w => (
                  <Pressable
                    key={w}
                    onPress={() => setPaperWidth(w)}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 6,
                      borderRadius: 8, borderWidth: 1,
                      borderColor: paperWidth === w ? theme.accent : theme.border,
                      backgroundColor: paperWidth === w ? 'rgba(34,197,94,0.12)' : 'transparent',
                    }}>
                    <Text style={{ color: theme.text, fontWeight: '700' }}>{w}mm</Text>
                  </Pressable>
                ))}
              </View>

              <Button label={scanning ? 'Scanning…' : 'Scan for printers'} full
                busy={scanning} onPress={scan} />

              {devices.length > 0 && (
                <View style={{ marginTop: 16 }}>
                  {devices.map(d => (
                    <View key={d.address} style={{
                      paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <View>
                        <Text style={{ color: theme.text, fontWeight: '700' }}>{d.name || 'Unnamed device'}</Text>
                        <Text style={{ color: theme.textDim, fontSize: 12 }}>
                          {d.address}{d.paired && ' · system-paired'}
                        </Text>
                      </View>
                      <Button label="Pair" size="md" onPress={() => pair(d)} />
                    </View>
                  ))}
                </View>
              )}

              {!isBluetoothAvailable() && (
                <Text style={{ color: theme.warn, fontSize: 12, marginTop: 12, lineHeight: 18 }}>
                  Bluetooth module not in this build. Receipts save digitally only.
                  See README to add `react-native-bluetooth-escpos-printer` and rebuild as a custom dev client.
                </Text>
              )}
            </View>
          )}
        </Panel>

        {/* Pinned station */}
        <Panel title="Pinned station" style={{ flex: 1, minWidth: 380 }}>
          <Text style={{ color: theme.textDim, marginBottom: 12, fontSize: 13 }}>
            Pin this tablet to a station so KDS opens directly to its lane.
            Leave unset for general-purpose use (expediter view).
          </Text>

          {(stations.data?.stations.length ?? 0) === 0 ? (
            <Text style={{ color: theme.textMuted }}>No stations configured.</Text>
          ) : (
            <View style={{ gap: 8 }}>
              <Pressable
                onPress={() => setStation(null)}
                style={{
                  padding: 12, borderRadius: 10, borderWidth: 1,
                  borderColor: !pinnedStationId ? theme.accent : theme.border,
                  backgroundColor: !pinnedStationId ? 'rgba(34,197,94,0.12)' : 'transparent',
                }}>
                <Text style={{ color: theme.text, fontWeight: '700' }}>Expediter (all stations)</Text>
              </Pressable>
              {stations.data!.stations.map(s => (
                <Pressable
                  key={s.id}
                  onPress={() => setStation(s.id)}
                  style={{
                    padding: 12, borderRadius: 10, borderWidth: 1,
                    borderColor: pinnedStationId === s.id ? theme.accent : theme.border,
                    backgroundColor: pinnedStationId === s.id ? 'rgba(34,197,94,0.12)' : 'transparent',
                  }}>
                  <Text style={{ color: theme.text, fontWeight: '700' }}>{s.name}</Text>
                  <Text style={{ color: theme.textDim, fontSize: 12 }}>{s.conceptName}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </Panel>

        {/* Notifications */}
        <Panel title="Notifications" style={{ flex: 1, minWidth: 380 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={{ color: theme.text, fontWeight: '700' }}>New-order chime</Text>
              <Text style={{ color: theme.textDim, fontSize: 12 }}>
                Local notification + haptic when a new order arrives while the app is backgrounded.
              </Text>
            </View>
            <Switch value={localAlerts} onValueChange={toggleAlerts} />
          </View>

          <View style={{ marginTop: 16, padding: 12, backgroundColor: theme.panelAlt, borderRadius: 10 }}>
            <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 11, letterSpacing: 0.8, marginBottom: 4 }}>
              EXPO PUSH TOKEN
            </Text>
            {pushToken ? (
              <Text style={{ color: theme.text, fontSize: 12 }} numberOfLines={2}>{pushToken}</Text>
            ) : (
              <Pressable onPress={registerPushNotifications}>
                <Text style={{ color: theme.accent, fontWeight: '700' }}>Tap to enable push notifications</Text>
              </Pressable>
            )}
          </View>
        </Panel>
      </View>
    </ScrollView>
  )
}
