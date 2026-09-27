// The brand-voice layer: every living line the world says, in the voice of
// whoever is saying it.
//
// Hand-written tables, not templated English. Four registers:
//   simmer — lowercase, terse, never '!', never an emoji, never a capital S.
//   stackd — lowercase, warm café and market: the bake, the case, the wrap.
//   Flipd  — punchy diner, capitals fine, the name is always 'Flipd'.
//   servd  — friendly host of the whole place.
//
// Pure: safe on the server, the edge and the client.

import type { DayPart } from './clock'
import { moodFor } from './clock'
import type { KitchenSlug, KitchenState } from './kitchenCore'

export type VoiceBrand = 'servd' | KitchenSlug

const DAY_FULL: Record<string, string> = {
  sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday',
}

/** Split a KitchenState.opensAt ('7pm' | 'tomorrow 8am' | 'tue 7pm'). */
function whenOpens(opensAt: string | null): { when: 'today' | 'tomorrow' | 'later' | 'never'; at: string; day: string } {
  if (!opensAt) return { when: 'never', at: '', day: '' }
  const [a, b] = opensAt.split(' ')
  if (!b) return { when: 'today', at: a ?? '', day: '' }
  if (a === 'tomorrow') return { when: 'tomorrow', at: b, day: '' }
  return { when: 'later', at: b, day: DAY_FULL[a ?? ''] ?? a ?? '' }
}

/** '2:30am' → '2:30', 'midnight' stays. simmer's register drops the am/pm. */
function bare(clock: string | null): string {
  return (clock ?? '').replace(/(am|pm)$/, '')
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function mins(n: number | null): number {
  return Math.max(1, n ?? 0)
}

// ── simmer ───────────────────────────────────────────────────────────────────

function simmerLine(k: KitchenState, dayPart: DayPart): string {
  switch (k.phase) {
    case 'open':
      if (dayPart === 'late' || dayPart === 'night') return k.closesAt ? `late service · until ${bare(k.closesAt)}` : 'late service'
      return 'dinner service is on'
    case 'closing':
      return `last orders · the pass closes at ${bare(k.closesAt)}`
    case 'opening':
      return `doors in ${mins(k.opensInMin)} min`
    default: {
      const o = whenOpens(k.opensAt)
      if (o.when === 'today') return `doors at ${o.at} tonight`
      if (o.when === 'tomorrow') return `closed tonight · doors at ${o.at} tomorrow`
      if (o.when === 'later') return `closed tonight · back ${o.day}`
      return 'closed tonight'
    }
  }
}

// ── stackd ───────────────────────────────────────────────────────────────────

const STACKD_OPEN: Record<DayPart, (till: string) => string> = {
  morning: () => 'ovens are on · the bake is out',
  lunch: (t) => `sandwiches are stacking · open till ${t}`,
  afternoon: (t) => `the case is full · open till ${t}`,
  dinner: (t) => `mocktails are shaking · open till ${t}`,
  late: (t) => `the lamps are low · open till ${t}`,
  night: () => 'the lamps are low · still pouring',
}

function stackdLine(k: KitchenState, dayPart: DayPart): string {
  switch (k.phase) {
    case 'open':
      return STACKD_OPEN[dayPart](k.closesAt ?? 'late')
    case 'closing':
      return `last call at the counter · ${mins(k.closesInMin)} min left`
    case 'opening':
      return `ovens on in ${mins(k.opensInMin)} min`
    default: {
      const o = whenOpens(k.opensAt)
      if (o.when === 'today' || o.when === 'tomorrow') return `back at ${o.at} with the bake`
      if (o.when === 'later') return `back ${o.day} at ${o.at} with the bake`
      return 'the café is resting today'
    }
  }
}

// ── Flipd ────────────────────────────────────────────────────────────────────

const FLIPD_OPEN: Record<DayPart, (till: string) => string> = {
  morning: (t) => `Grill's hot early. Open till ${t}.`,
  lunch: (t) => `Lunch rush on the flat-top. Open till ${t}.`,
  afternoon: (t) => `Grill's hot. Open till ${t}.`,
  dinner: (t) => `Grill's hot. Open till ${t}.`,
  late: (t) => `Late-night smash. Open till ${t}.`,
  night: (t) => `Still flipping. Open till ${t}.`,
}

function flipdLine(k: KitchenState, dayPart: DayPart): string {
  switch (k.phase) {
    case 'open':
      return k.closesAt ? FLIPD_OPEN[dayPart](k.closesAt) : "Grill's hot. Come get one."
    case 'closing':
      return `Last flips. ${mins(k.closesInMin)} min on the grill.`
    case 'opening':
      return `Grill fires up in ${mins(k.opensInMin)} min.`
    default: {
      const o = whenOpens(k.opensAt)
      if (o.when === 'today') return `Grill fires up at ${o.at}.`
      if (o.when === 'tomorrow') return `Grill's cold. Back tomorrow at ${o.at}.`
      if (o.when === 'later') return `Grill's cold. Back ${cap(o.day)} at ${o.at}.`
      return "Grill's cold today."
    }
  }
}

/** A kitchen's status, in that kitchen's own voice. */
export function kitchenLine(k: KitchenState, dayPart: DayPart): string {
  if (k.slug === 'simmer') return simmerLine(k, dayPart)
  if (k.slug === 'stackd') return stackdLine(k, dayPart)
  return flipdLine(k, dayPart)
}

// ── servd ────────────────────────────────────────────────────────────────────

function cookingPhrase(openCount: number, dayPart: DayPart): string {
  if (openCount <= 0) {
    return dayPart === 'late' || dayPart === 'night' || dayPart === 'morning'
      ? 'the kitchens are asleep'
      : 'the kitchens are between services'
  }
  return openCount === 1 ? '1 kitchen cooking' : `${openCount} kitchens cooking`
}

/** 'servd · karachi · 9:42pm · 3 kitchens cooking'. An empty clock is left out. */
export function worldEyebrow(clock: string, openCount: number, dayPart: DayPart): string {
  const parts = ['servd', 'karachi']
  if (clock) parts.push(clock)
  parts.push(cookingPhrase(openCount, dayPart))
  return parts.join(' · ')
}

/** '2 of 3 cooking · dinner rush'. */
export function openCountLine(openCount: number, total: number, dayPart: DayPart): string {
  const label = moodFor(dayPart, openCount).label
  if (openCount <= 0) return `all ${total} asleep · ${label}`
  if (openCount >= total) return `all ${total} cooking · ${label}`
  return `${openCount} of ${total} cooking · ${label}`
}

// ── Loading ──────────────────────────────────────────────────────────────────

const SERVD_LOADING: Record<'morning' | 'day' | 'evening' | 'night', string[]> = {
  morning: [
    'pulling the first shots…',
    'proofing the dough…',
    'unlocking the kitchens…',
    'warming the pans…',
    'wiping down the pass…',
  ],
  day: [
    'firing up the kitchens…',
    'plating your page…',
    'calling the pass…',
    'setting the table…',
    'finding you a seat…',
  ],
  evening: [
    'dimming the lights…',
    'calling the dinner rush…',
    'plating your page…',
    'lighting the candles…',
    'setting the table…',
  ],
  night: [
    'waking the night cook…',
    'finding the lamp switch…',
    'tiptoeing past the fryer…',
    'lighting the late kitchen…',
    'putting the kettle on…',
  ],
}

const SIMMER_LOADING = [
  'the room is being set…',
  'lighting the candle…',
  'warming the plates…',
  'the kitchen is on…',
  'pouring the water…',
]

const STACKD_LOADING: Record<'morning' | 'rest', string[]> = {
  morning: [
    'pulling the bake…',
    'filling the pastry case…',
    'warming the ovens…',
    'folding the wrappers…',
  ],
  rest: [
    'stacking the sandwiches…',
    'filling the pastry case…',
    'shaking a mocktail…',
    'wrapping it up…',
    'stocking the chiller…',
  ],
}

const FLIPD_LOADING = [
  'Firing the flat-top…',
  'Smashing patties…',
  'Dropping the fries…',
  'Spinning a shake…',
  'Toasting the buns…',
]

/** At least four rotating loader lines for a brand at this time of day. */
export function loadingLines(brand: VoiceBrand | null, dayPart: DayPart): string[] {
  switch (brand) {
    case 'simmer': return [...SIMMER_LOADING]
    case 'stackd': return [...(dayPart === 'morning' ? STACKD_LOADING.morning : STACKD_LOADING.rest)]
    case 'flipd': return [...FLIPD_LOADING]
    default: {
      if (dayPart === 'night' || dayPart === 'late') return [...SERVD_LOADING.night]
      if (dayPart === 'morning') return [...SERVD_LOADING.morning]
      if (dayPart === 'dinner') return [...SERVD_LOADING.evening]
      return [...SERVD_LOADING.day]
    }
  }
}

// ── Empty states ─────────────────────────────────────────────────────────────

export type EmptyKind = 'no-match' | 'no-kitchens' | 'menu-offline' | 'wrong-door'
type Line = { title: string; body: string }

const EMPTY: Record<EmptyKind, Record<VoiceBrand, Line>> = {
  'no-match': {
    servd: { title: 'nothing on the pass for that', body: 'try another craving — or step into a kitchen.' },
    simmer: { title: 'not on tonight’s card', body: 'try another word · or read the whole menu' },
    stackd: { title: 'not in the case today', body: 'nothing matches that — try a sandwich, a pastry or a mocktail.' },
    flipd: { title: 'Not on the board.', body: 'Nothing matches that. Try a smash, some fries or a shake.' },
  },
  'no-kitchens': {
    servd: { title: 'the kitchens are resting', body: 'we couldn’t reach the pass just now — give it a moment and try again.' },
    simmer: { title: 'the room is quiet', body: 'we could not reach the kitchen · try again in a moment' },
    stackd: { title: 'the café is catching its breath', body: 'we couldn’t reach the counter — give it a moment and try again.' },
    flipd: { title: 'Grill’s not answering.', body: 'We couldn’t reach the kitchen. Give it a sec and try again.' },
  },
  'menu-offline': {
    servd: { title: 'this menu is taking a breather', body: 'try again in a moment, or step into another kitchen.' },
    simmer: { title: 'tonight’s card is being written', body: 'the menu is not up yet · the room is still set' },
    stackd: { title: 'the menu board is off the wall', body: 'we’re re-chalking it — the café and the case are still here.' },
    flipd: { title: 'Menu’s off the board.', body: 'We’re swapping the board. The grill’s still here — check back in a minute.' },
  },
  'wrong-door': {
    servd: { title: 'that’s not a kitchen.', body: 'these are — pick a door.' },
    simmer: { title: 'this is not a room.', body: 'the table is this way' },
    stackd: { title: 'that’s not the counter.', body: 'the café is this way — come in.' },
    flipd: { title: 'Wrong booth.', body: 'The grill’s this way. Slide in.' },
  },
}

/** Title + body for an empty or error state, in the brand's voice (servd by default). */
export function emptyLine(kind: EmptyKind, brand: VoiceBrand = 'servd'): Line {
  const line = EMPTY[kind][brand] ?? EMPTY[kind].servd
  return { title: line.title, body: line.body }
}
