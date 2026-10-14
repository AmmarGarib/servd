// The live brand kits (GET /site-layouts/kits/live), fetched on the server
// with a small module-level cache: 60 s after a good answer, 5 s after a
// failure (never cache a failure longer — the "fetch caching gotcha" in
// CLAUDE.md). A failure answers {} = every brand on its defaults, which are
// in code (lib/brandKit.ts), so the API being down never breaks a page.
//
// Every good answer is also stored as the snapshot lib/concept.ts reads
// (brandAccent), so the synchronous helpers follow the published kit.

import { normalizeLiveKits, setLiveKitsSnapshot, type LiveKits } from './brandKit'

const API_URL = process.env['INTERNAL_API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const TTL_MS = 60_000
const MISS_TTL_MS = 5_000
const TIMEOUT_MS = 3_000

let entry: { at: number; ttl: number; value: Promise<LiveKits> } | null = null

async function load(): Promise<LiveKits | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_URL}/api/v1/site-layouts/kits/live`, { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) return null
    return normalizeLiveKits(await res.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Every brand's live kit ({} when the API can't be reached). */
export function getLiveKits(): Promise<LiveKits> {
  const now = Date.now()
  if (entry && now - entry.at < entry.ttl) return entry.value
  const e: { at: number; ttl: number; value: Promise<LiveKits> } = { at: now, ttl: TTL_MS, value: Promise.resolve({}) }
  e.value = load().then((kits) => {
    if (!kits) { e.ttl = MISS_TTL_MS; kits = {} }
    // The snapshot always matches what the pages paint (the injected CSS).
    setLiveKitsSnapshot(kits)
    return kits
  })
  entry = e
  return e.value
}

/** Test hook: forget the cached answer. */
export function resetLiveKitsCache(): void {
  entry = null
}
