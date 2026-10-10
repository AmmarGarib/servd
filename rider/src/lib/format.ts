// Shared formatters (adapted from tablet/src/lib/format.ts). PKR is rendered
// with a manual prefix — Hermes' locale data is too thin for Intl 'PKR'
// currency style.

export function pkr(cents: number): string {
  const rs = Math.round((cents ?? 0) / 100)
  return `Rs ${rs.toLocaleString('en-PK')}`
}

export function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Math.max(0, Math.floor(ms / 60000))
}

export function elapsed(iso: string | null | undefined): string {
  const m = minutesSince(iso)
  if (m === null) return ''
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min ago`
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function initials(name: string | null | undefined): string {
  return (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]!.toUpperCase())
    .join('') || '?'
}

/** Same rule as the backend's normalisePhone (backend/src/modules/auth/otp.ts):
 *  digits only, a leading 0 becomes 92, a bare 10-digit number gets 92. */
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

/** 923001234567 -> +92 300 1234567 (anything else is shown as given). */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const n = normalisePhone(raw)
  if (/^92\d{10}$/.test(n)) return `+92 ${n.slice(2, 5)} ${n.slice(5)}`
  return raw
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
