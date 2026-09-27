/**
 * @deprecated Use `lib/world/kitchenCore` (computeOpen / kitchenState) — the
 * one rule set for "is this kitchen open?", which handles windows that cross
 * midnight and the live per-brand hours. This file keeps its exports only for
 * callers not yet moved (BrowseCard); do not add new ones.
 */

// Lightweight "open now" calculation. Until brands have configurable hours
// stored on the Concept, we use a sane default keyed off concept type. PKT
// timezone (UTC+5) — operators in Karachi/Lahore see local hours.

import { karachiNow } from './world/clock'

export interface HoursWindow { openH: number; openM: number; closeH: number; closeM: number }

const DEFAULT_BY_TYPE: Record<string, HoursWindow> = {
  restaurant: { openH: 12, openM: 0, closeH: 23, closeM: 30 },
  digital:    { openH: 11, openM: 0, closeH: 23, closeM: 0 },
  cart:       { openH: 16, openM: 0, closeH: 23, closeM: 0 },
}

// Karachi wall-clock time. The old version added getTimezoneOffset() and then
// read UTC fields, which double-counted the host's offset everywhere but UTC.
function pktNow(): { hour: number; minute: number } {
  const { hour, minute } = karachiNow()
  return { hour, minute }
}

/** @deprecated Use `kitchenState` from `lib/world/kitchenCore`. */
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
