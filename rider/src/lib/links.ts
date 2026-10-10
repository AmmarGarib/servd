// Hand-offs to the phone's own apps: Google Maps for directions, the dialler
// for calls. Riders already know Google Maps; servd does not try to be a
// navigation app.

import { Alert, Linking } from 'react-native'
import type { JobPlace } from './types'

/** Google Maps directions to a place — coordinates when we have them,
 *  otherwise the address text. Null when there is nothing to navigate to. */
export function directionsUrl(place: Pick<JobPlace, 'lat' | 'lng' | 'address'>): string | null {
  const hasCoords =
    typeof place.lat === 'number' && typeof place.lng === 'number' &&
    Number.isFinite(place.lat) && Number.isFinite(place.lng)
  if (hasCoords) return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`
  const address = (place.address ?? '').trim()
  if (!address) return null
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`
}

export async function openDirections(place: Pick<JobPlace, 'lat' | 'lng' | 'address'>): Promise<void> {
  const url = directionsUrl(place)
  if (!url) {
    Alert.alert('No address', 'There is no address or map pin for this stop. Call them for directions.')
    return
  }
  try {
    await Linking.openURL(url)
  } catch {
    Alert.alert('Could not open maps', 'Install Google Maps, or call for directions.')
  }
}

export async function callNumber(phone: string | null | undefined): Promise<void> {
  const digits = (phone ?? '').replace(/[^\d+]/g, '')
  if (!digits) {
    Alert.alert('No phone number', 'There is no number on this job.')
    return
  }
  const tel = digits.startsWith('+') || !digits.startsWith('92') ? digits : `+${digits}`
  try {
    await Linking.openURL(`tel:${tel}`)
  } catch {
    Alert.alert('Could not start the call', `Dial ${tel} yourself.`)
  }
}
