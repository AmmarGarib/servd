// Lightweight "open now" calculation. Until brands have configurable hours
// stored on the Concept, we use a sane default keyed off concept type. PKT
// timezone (UTC+5) — operators in Karachi/Lahore see local hours.

export interface HoursWindow { openH: number; openM: number; closeH: number; closeM: number }

const DEFAULT_BY_TYPE: Record<string, HoursWindow> = {
  restaurant: { openH: 12, openM: 0, closeH: 23, closeM: 30 },
  digital:    { openH: 11, openM: 0, closeH: 23, closeM: 0 },
  cart:       { openH: 16, openM: 0, closeH: 23, closeM: 0 },
}

function pktNow(): { hour: number; minute: number } {
  const now = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000
  const pkt = new Date(utcMs + 5 * 3600_000)
  return { hour: pkt.getUTCHours(), minute: pkt.getUTCMinutes() }
}

export function isOpenNow(conceptType: string): { open: boolean; window?: HoursWindow } {
  const window = DEFAULT_BY_TYPE[conceptType] ?? DEFAULT_BY_TYPE.digital
  if (!window) return { open: true }
  const { hour, minute } = pktNow()
  const minsNow   = hour * 60 + minute
  const minsOpen  = window.openH * 60 + window.openM
  const minsClose = window.closeH * 60 + window.closeM
  // Handle past-midnight closes
  if (minsClose < minsOpen) {
    return { open: minsNow >= minsOpen || minsNow <= minsClose, window }
  }
  return { open: minsNow >= minsOpen && minsNow <= minsClose, window }
}

export function fmtHourWindow(w: HoursWindow): string {
  const f = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  return `${f(w.openH, w.openM)}–${f(w.closeH, w.closeM)}`
}
