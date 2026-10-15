// Plain-text facts about a brand that the About table and /llms-full.txt both
// print, built from the live Concept row — one wording for both.

import type { ServiceHourSlot } from '../../lib/concept'

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Week order Monday first, the way Karachi reads a timetable.
const WEEK = [1, 2, 3, 4, 5, 6, 0]

function clock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "Mon–Sun 12:00–23:30" / "Mon–Thu 12:00–23:00; Fri–Sat 12:00–00:00".
 *  '' when the brand has no hours on file (never invented). */
export function hoursSummary(slots: ServiceHourSlot[] | undefined | null): string {
  if (!slots?.length) return ''
  const perDay = new Map<number, string>()
  for (const d of WEEK) {
    const own = slots.filter((s) => s.dayOfWeek === d).sort((a, b) => a.openMin - b.openMin)
    if (own.length) perDay.set(d, own.map((s) => `${clock(s.openMin)}–${clock(s.closeMin)}`).join(', '))
  }
  const runs: Array<{ from: number; to: number; text: string }> = []
  WEEK.forEach((d, i) => {
    const text = perDay.get(d)
    if (!text) return
    const last = runs[runs.length - 1]
    if (last && last.text === text && last.to === i - 1) last.to = i
    else runs.push({ from: i, to: i, text })
  })
  return runs
    .map((r) => `${r.from === r.to ? DAY[WEEK[r.from]!] : `${DAY[WEEK[r.from]!]}–${DAY[WEEK[r.to]!]}`} ${r.text}`)
    .join('; ')
}

const PRICE_WORDS: Record<string, string> = { '$': 'Budget', '$$': 'Mid-range', '$$$': 'Upscale', '$$$$': 'Fine dining' }

/** "$$$ (Upscale)" — the symbols alone mean little to a language model. */
export function priceWords(priceRange: string): string {
  const w = PRICE_WORDS[priceRange]
  return w ? `${priceRange} (${w})` : priceRange
}
