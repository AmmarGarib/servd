// Tiny shared formatters. Keeping these in one place because they show up on
// every screen and consistency matters (PKR formatting in particular — never
// use Intl.NumberFormat 'PKR' currency style because RN's hermes locale data is
// limited; we render with a manual prefix.).

export function pkr(cents: number): string {
  const rs = Math.round(cents / 100)
  return `Rs ${rs.toLocaleString('en-PK')}`
}

export function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Math.max(0, Math.floor(ms / 60000))
}

export function elapsed(iso: string): string {
  const m = minutesSince(iso) ?? 0
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return `${h}h ${rem}m`
}

export function shortTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export function shortDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]!.toUpperCase())
    .join('')
}
