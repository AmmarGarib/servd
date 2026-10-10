// Small formatters and hand-offs for servd.pk/rider — the web twins of the
// Expo app's rider/src/lib/format.ts and links.ts.

import type { JobPlace, JobStage } from '../../../lib/riderApi'

/** Same rule as the backend's normalisePhone (backend/src/modules/auth/otp.ts). */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('92')) return digits
  if (digits.startsWith('0')) return '92' + digits.slice(1)
  if (digits.length === 10) return '92' + digits
  return digits
}

/** A Pakistani mobile in normalised form: 92 3xx xxxxxxx. */
export function isPkMobile(normalised: string): boolean {
  return /^923\d{9}$/.test(normalised)
}

/** 923001234567 → +92 300 1234567 (anything else is shown as given). */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const n = normalisePhone(raw)
  if (/^92\d{10}$/.test(n)) return `+92 ${n.slice(2, 5)} ${n.slice(5)}`
  return raw
}

/** A tel: link for a stored number (92… digits get their +). Null when empty. */
export function telHref(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^\d+]/g, '')
  if (!digits) return null
  const tel = digits.startsWith('+') || !digits.startsWith('92') ? digits : `+${digits}`
  return `tel:${tel}`
}

/** Google Maps directions to a stop — the pin when there is one, otherwise the
 *  address text. Null when there is nothing to navigate to. */
export function directionsUrl(place: Pick<JobPlace, 'lat' | 'lng' | 'address'> | null | undefined): string | null {
  if (!place) return null
  if (typeof place.lat === 'number' && typeof place.lng === 'number'
    && Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
    return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`
  }
  const address = (place.address ?? '').trim()
  if (!address) return null
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`
}

export function pkr(cents: number): string {
  const rs = Math.round((cents ?? 0) / 100)
  return `Rs ${rs.toLocaleString('en-PK')}`
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** "just now", "12 s ago", "3 min ago". */
export function agoShort(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ago`
}

const VEHICLES: Record<string, string> = {
  bike: 'Motorbike',
  car: 'Car',
  bicycle: 'Bicycle',
  foot: 'On foot',
}

export function vehicleLabel(v: string | null | undefined): string {
  return (v && VEHICLES[v]) || (v ?? '')
}

export const STAGE_LABEL: Record<JobStage, string> = {
  offered: 'New job',
  accepted: 'Go to the kitchen',
  picked_up: 'On the way',
  arrived: 'At the door',
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  received: 'Received',
  confirmed: 'Confirmed',
  preparing: 'Being prepared',
  ready: 'Ready for pick-up',
  completed: 'Completed',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  refunded: 'Refunded',
}
