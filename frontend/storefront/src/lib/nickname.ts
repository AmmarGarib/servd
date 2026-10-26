// The servd name (nickname) rules, mirrored from the API (backend
// src/lib/nickname.ts) for instant feedback. The server is the judge: taken
// and reserved names are only known there.

export const NICKNAME_MAX = 20

/** null when the shape is fine; otherwise what to fix. */
export function nicknameShapeProblem(raw: string): string | null {
  const v = raw.trim()
  if (v.length < 3 || v.length > NICKNAME_MAX) return `Use 3 to ${NICKNAME_MAX} characters.`
  if (!/^[A-Za-z0-9._]+$/.test(v)) return 'Use letters, numbers, dots and underscores only.'
  if (!/^[A-Za-z0-9]/.test(v) || v.endsWith('.') || v.includes('..')) return 'Start with a letter or number, and no dot at the end or two dots in a row.'
  return null
}
