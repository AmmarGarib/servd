export type CharacterKind = 'burger' | 'fries' | 'coffee' | 'sandwich' | 'shake' | 'croissant'

export const ALL_KINDS: readonly CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']

export function isCharacterKind(v: unknown): v is CharacterKind {
  return typeof v === 'string' && (ALL_KINDS as readonly string[]).includes(v)
}
