export type CharacterKind = 'burger' | 'fries' | 'coffee' | 'sandwich' | 'shake' | 'croissant'

export const ALL_KINDS: readonly CharacterKind[] = ['fries', 'burger', 'coffee', 'sandwich', 'shake', 'croissant']

export function isCharacterKind(v: unknown): v is CharacterKind {
  return typeof v === 'string' && (ALL_KINDS as readonly string[]).includes(v)
}

/** The default left-to-right cast, shared by the 3D crowd and its SVG poster. */
export const DEFAULT_CAST: readonly CharacterKind[] = ALL_KINDS

/**
 * How many of `n` cast members a stage of this aspect ratio shows, centred.
 * The 3D engine and the SVG poster both use it, so the cross-fade lines up.
 */
export function visibleSlice<T>(cast: readonly T[], aspect: number): T[] {
  if (!Number.isFinite(aspect) || aspect <= 0) return cast.slice()
  const n = Math.min(cast.length, aspect < 0.95 ? 3 : aspect < 1.35 ? 4 : cast.length)
  const start = Math.max(0, Math.floor((cast.length - n) / 2))
  return cast.slice(start, start + n)
}
