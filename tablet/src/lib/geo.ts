// Geolocation helper — wraps expo-location with a sane timeout default and
// graceful fallback. The tablet may be wall-mounted indoors with weak GPS, so
// we accept low-accuracy fixes and surface the accuracy radius to the caller.

import * as Location from 'expo-location'

export interface GeoFix {
  lat: number
  lng: number
  accuracyM: number | null
}

export async function currentFix(timeoutMs = 8_000): Promise<GeoFix | null> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync()
    if (perm.status !== 'granted') return null
    const pos = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
    if (!pos) return null
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracyM: pos.coords.accuracy ?? null,
    }
  } catch {
    return null
  }
}
