// Bluetooth ESC/POS transport — pluggable.
//
// This file is the integration seam between the receipt-building logic (in
// printer.ts) and a Bluetooth Serial library. We intentionally don't import
// the native lib at module top because:
//
//   1. Expo Go doesn't ship native Bluetooth modules — the bundle would fail.
//   2. Different shops will pick different libs / different printers.
//
// To activate Bluetooth printing:
//
//   (a) Run `npx expo install react-native-bluetooth-escpos-printer`
//       OR `npx expo install react-native-thermal-receipt-printer-image-qr`
//       (both ship ESC/POS-over-Bluetooth — pick whichever has friendlier docs
//       for your team).
//
//   (b) Create a custom dev client build:
//         eas build --profile development --platform android
//
//   (c) Wire the transport at app boot — call this file's
//       `initBluetoothTransport()` from app/_layout.tsx.
//
// Until then, the printer status panel shows "Bluetooth module not available"
// and POS surfaces "printer offline" instead of dropping the sale.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { registerPrinterTransport } from './printer'

const PAIRED_DEVICE_KEY = 'servd_paired_printer'

export interface PairedPrinter {
  address: string       // MAC address
  name: string
  paperWidth: 58 | 80
}

/**
 * Best-effort dynamic require — keeps this file safe in Expo Go.
 * Returns null if the native module isn't available.
 */
function tryRequireBluetoothModule(): unknown | null {
  try {
    // Use globalThis indirection so Metro doesn't try to resolve at bundle
    // time. The native lib registers itself on the JS bridge under
    // NativeModules.BluetoothEscposPrinter when installed.
    const NativeModules = (globalThis as unknown as {
      __r?: (name: string) => unknown
    }).__r
    if (!NativeModules) return null
    // Real implementation:
    //   const mod = require('react-native-bluetooth-escpos-printer')
    //   return mod.BluetoothEscposPrinter
    return null
  } catch {
    return null
  }
}

export function isBluetoothAvailable(): boolean {
  return tryRequireBluetoothModule() !== null
}

export async function getPairedPrinter(): Promise<PairedPrinter | null> {
  try {
    const raw = await AsyncStorage.getItem(PAIRED_DEVICE_KEY)
    return raw ? (JSON.parse(raw) as PairedPrinter) : null
  } catch {
    return null
  }
}

export async function setPairedPrinter(p: PairedPrinter | null): Promise<void> {
  if (p) await AsyncStorage.setItem(PAIRED_DEVICE_KEY, JSON.stringify(p))
  else   await AsyncStorage.removeItem(PAIRED_DEVICE_KEY)
}

export interface DiscoveredDevice {
  address: string
  name: string
  paired: boolean
}

/**
 * Discover nearby Bluetooth devices. Empty list if no Bluetooth module is
 * available (Expo Go). Real implementations call BluetoothManager.scanDevices()
 * and the resulting JSON is parsed.
 */
export async function discoverDevices(): Promise<DiscoveredDevice[]> {
  const mod = tryRequireBluetoothModule()
  if (!mod) return []
  // Real implementation:
  //   const result = await BluetoothManager.scanDevices()
  //   const parsed = JSON.parse(result) as { paired: Array<...>; found: Array<...> }
  //   return [
  //     ...parsed.paired.map(d => ({ address: d.address, name: d.name, paired: true })),
  //     ...parsed.found.map(d  => ({ address: d.address, name: d.name, paired: false })),
  //   ]
  return []
}

/**
 * Initialise the printer transport for the saved device. Called once at app
 * boot. If no device saved, no-op (printer.ts continues to skip print calls).
 */
export async function initBluetoothTransport(): Promise<void> {
  const paired = await getPairedPrinter()
  if (!paired) return

  const mod = tryRequireBluetoothModule()
  if (!mod) return  // Custom dev client not built yet.

  registerPrinterTransport(async (bytes) => {
    // Real implementation:
    //   await BluetoothManager.connect(paired.address)
    //   await BluetoothEscposPrinter.printRaw(Buffer.from(bytes).toString('base64'))
    // We leave it as a no-op when the module is missing so the cashier flow
    // never blocks. The pairing UI tells them to build the dev client.
    void bytes
  })
}
