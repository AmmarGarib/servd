export function fmt(cents: number) {
  return `PKR ${(cents / 100).toFixed(0)}`
}

export function isLight(hex: string): boolean {
  const c = hex.replace('#', '')
  if (c.length !== 6) return false
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 128
}

export function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '').padEnd(6, '0')
  return [
    parseInt(s.slice(0, 2), 16) || 58,
    parseInt(s.slice(2, 4), 16) || 14,
    parseInt(s.slice(4, 6), 16) || 105,
  ]
}

export function deriveColors(primary: string | null) {
  const [r, g, b] = hexToRgb(primary ?? '#6a0dad')
  return {
    mid:   primary ?? '#6a0dad',
    dark:  `rgb(${Math.max(0, r - 90)}, ${Math.max(0, g - 90)}, ${Math.max(0, b - 90)})`,
    light: `rgb(${Math.min(255, r + 50)}, ${Math.min(255, g + 50)}, ${Math.min(255, b + 50)})`,
  }
}

export function typeLabel(t: string) {
  return t === 'digital' ? 'Delivery' : t === 'cart' ? 'Walk-up' : 'Dine-in'
}
