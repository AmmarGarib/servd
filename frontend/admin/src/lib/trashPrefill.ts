// Tolerant readers for a "Recover as copy" prefill payload (see lib/trash.ts
// useTrashPrefill). The server builds the payload from the original with the
// reset rules applied; a form takes only the fields it knows and ignores the
// rest, so a missing or renamed field never breaks the form.

export type Prefill = Record<string, unknown>

/** The payload may arrive bare or wrapped as { payload | prefill | data }. */
export function unwrapPrefill(raw: unknown): Prefill | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Prefill
  for (const k of ['payload', 'prefill', 'data']) {
    const v = o[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Prefill
  }
  return o
}

/** First non-empty string among the keys. */
export function pStr(p: Prefill | null, ...keys: string[]): string | undefined {
  if (!p) return undefined
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'string' && v.trim()) return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return undefined
}

/** First finite number among the keys. */
export function pNum(p: Prefill | null, ...keys: string[]): number | undefined {
  if (!p) return undefined
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  }
  return undefined
}

export function pBool(p: Prefill | null, ...keys: string[]): boolean | undefined {
  if (!p) return undefined
  for (const k of keys) if (typeof p[k] === 'boolean') return p[k] as boolean
  return undefined
}

export function pArr<T = Record<string, unknown>>(p: Prefill | null, ...keys: string[]): T[] {
  if (!p) return []
  for (const k of keys) if (Array.isArray(p[k])) return p[k] as T[]
  return []
}

/** Warnings the server attached (dropped dishes, switched company…). */
export function pWarnings(p: Prefill | null): string[] {
  return pArr<unknown>(p, 'warnings').filter((w): w is string => typeof w === 'string')
}
