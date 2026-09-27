// The twelve stickers hidden around the storefront. The ids are a contract
// (REVIEW.md section 5): other packages call collect('<id>') with them, and
// the persisted store keys found stickers by them. Never rename one.
//
// Hints are shown in the sticker book while a sticker is still locked: cryptic
// enough to be a hunt, fair enough that someone reading them can find it.

export type StickerId =
  | 'crowd-poke'
  | 'crowd-toss'
  | 'doodle-pop'
  | 'deck-flip'
  | 'gate-13'
  | 'pass-swing'
  | 'lucky-pull'
  | 'peel'
  | 'grand-tour'
  | 'first-toss'
  | 'wait-game'
  | 'claw-prize'

export interface StickerDef {
  id: StickerId
  name: string
  hint: string
  color: string
}

/** Party palette the stickers are printed in. */
export const STICKER_COLORS = {
  butter: '#FFD447',
  tomato: '#FF5A3C',
  plum: '#4E2A4F',
  cream: '#FFF4D6',
  sky: '#9BD3DD',
  mustard: '#FED561',
} as const

export const STICKERS: readonly StickerDef[] = [
  { id: 'crowd-poke', name: 'first poke',     hint: "they don't mind a poke",                color: STICKER_COLORS.butter },
  { id: 'crowd-toss', name: 'airtime',        hint: 'pick one up. let go fast.',             color: STICKER_COLORS.tomato },
  { id: 'doodle-pop', name: 'doodle popper',  hint: 'the scribbles are ticklish. five of them.', color: STICKER_COLORS.mustard },
  { id: 'deck-flip',  name: 'card sharp',     hint: 'some cards have a back',                color: STICKER_COLORS.sky },
  { id: 'gate-13',    name: 'gate 13',        hint: "the board has a gate it doesn't list",  color: STICKER_COLORS.plum },
  { id: 'pass-swing', name: 'lanyard loop',   hint: 'a pass on a string wants a real swing', color: STICKER_COLORS.cream },
  { id: 'lucky-pull', name: 'feeling lucky',  hint: "can't pick a kitchen? there's a lever", color: STICKER_COLORS.butter },
  { id: 'peel',       name: 'peeled',         hint: 'every seal lifts at the corner',        color: STICKER_COLORS.tomato },
  { id: 'grand-tour', name: 'grand tour',     hint: 'three kitchens, one passport',          color: STICKER_COLORS.plum },
  { id: 'first-toss', name: 'first toss',     hint: 'the basket catches what you add',       color: STICKER_COLORS.sky },
  { id: 'wait-game',  name: 'while you wait', hint: 'the wait goes faster with a game',      color: STICKER_COLORS.mustard },
  { id: 'claw-prize', name: 'claw champ',     hint: 'the bottom of every page has a prize',  color: STICKER_COLORS.cream },
] as const

export const STICKER_COUNT = STICKERS.length

const BY_ID = new Map<StickerId, StickerDef>(STICKERS.map((s) => [s.id, s]))

export function isStickerId(value: unknown): value is StickerId {
  return typeof value === 'string' && BY_ID.has(value as StickerId)
}

export function getSticker(id: StickerId): StickerDef {
  // Every StickerId is in the table, so this lookup cannot miss.
  return BY_ID.get(id) ?? STICKERS[0]!
}
