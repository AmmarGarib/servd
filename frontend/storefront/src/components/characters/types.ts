export type CharacterKind = 'burger' | 'fries' | 'coffee' | 'sandwich' | 'shake' | 'croissant'

export const ALL_KINDS: readonly CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']

export function isCharacterKind(v: unknown): v is CharacterKind {
  return typeof v === 'string' && (ALL_KINDS as readonly string[]).includes(v)
}

/** A face the crowd (3D) and the cast (SVG) can pull. */
export type Mood = 'neutral' | 'happy' | 'surprised' | 'sleepy' | 'proud' | 'concerned' | 'curious'

export const MOODS: readonly Mood[] = ['neutral', 'happy', 'surprised', 'sleepy', 'proud', 'concerned', 'curious']

export function isMood(v: unknown): v is Mood {
  return typeof v === 'string' && (MOODS as readonly string[]).includes(v)
}

/*
 * Dish name → the character that "is" that dish. Checked top to bottom, so a
 * "coffee cake" is coffee and a "loaded burger" is a burger. Short words that
 * hide inside other words (tea in steak, bun in bunny) only match on a word
 * start; the longer ones match anywhere, so "cheesecake" and "milkshake" land.
 */
const DISH_TABLE: ReadonlyArray<readonly [RegExp, CharacterKind]> = [
  [/burger|smash|patty|patties/i, 'burger'],
  [/fries|chips|wedges|loaded/i, 'fries'],
  [/coffee|latte|espresso|cappuccino|americano|mocha|flat\s*white|cortado|\bchai|\bteas?\b/i, 'coffee'],
  [/sandwich|toastie|panini|\bclubs?\b|\bsubs?\b|\bwraps?\b|\bmelts?\b/i, 'sandwich'],
  [/shake|smoothie|mocktail|lemonade|\bsodas?\b|juice|cooler|\bfloats?\b/i, 'shake'],
  [/croissant|pastry|pastries|muffin|cookie|cake|danish|brownie|\bbuns?\b|scone|\btarts?\b|bread/i, 'croissant'],
]

/**
 * Which character a dish belongs to. Falls back to the brand's house
 * character (stackd → sandwich, flipd → burger); `undefined` when nothing fits.
 */
export function kindForDish(name: string, brandSlug?: string | null): CharacterKind | undefined {
  const text = typeof name === 'string' ? name : ''
  if (text) {
    for (const [re, kind] of DISH_TABLE) if (re.test(text)) return kind
  }
  const slug = typeof brandSlug === 'string' ? brandSlug.toLowerCase() : ''
  if (slug === 'stackd' || slug === 'stax') return 'sandwich'
  if (slug === 'flipd') return 'burger'
  return undefined
}
