// The live brand kits (GET /site-layouts/kits/live), fetched on the server
// with a small module-level cache:
//   - a good answer is fresh for 60 s; after that the SAME value is served at
//     once while one background refresh runs (stale-while-revalidate), so no
//     request ever waits on the API once a value exists;
//   - a failure never replaces the last good kits: they keep being served and
//     the next refresh is tried after 5 s (never cache a failure longer — the
//     "fetch caching gotcha" in CLAUDE.md);
//   - {} (= every brand on its code defaults, lib/brandKit.ts) only when
//     nothing has ever loaded, so the API being down never breaks a page.
//
// Every good answer is also stored as the snapshot lib/concept.ts reads
// (brandAccent), so the synchronous helpers follow the published kit. A
// failure leaves the snapshot alone (it still matches the served kits).

import { normalizeLiveKits, setLiveKitsSnapshot, type LiveKits } from './brandKit'

const API_URL = process.env['INTERNAL_API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const TTL_MS = 60_000
const MISS_TTL_MS = 5_000
const TIMEOUT_MS = 3_000

/** The last good kits and when the cache should next refresh. */
let lastGood: LiveKits | null = null
let freshUntil = 0
/** The one refresh in flight (single flight). */
let inflight: Promise<LiveKits> | null = null

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

function refresh(): Promise<LiveKits> {
  if (inflight) return inflight
  const p = load().then((kits) => {
    if (kits) {
      lastGood = kits
      freshUntil = Date.now() + TTL_MS
      // The snapshot always matches what the pages paint (the injected CSS).
      setLiveKitsSnapshot(kits)
      return kits
    }
    freshUntil = Date.now() + MISS_TTL_MS
    return lastGood ?? {}
  }).finally(() => { if (inflight === p) inflight = null })
  inflight = p
  return p
}

/** Every brand's live kit: the last good answer ({} only when nothing ever loaded). */
export function getLiveKits(): Promise<LiveKits> {
  const now = Date.now()
  if (now >= freshUntil) {
    const p = refresh()
    // Once a value exists nobody waits on the refresh.
    if (lastGood === null) return p
  }
  if (lastGood !== null) return Promise.resolve(lastGood)
  // Nothing loaded yet and the last attempt failed < 5 s ago.
  return inflight ?? Promise.resolve({})
}

/** Test hook: forget the cached answer. */
export function resetLiveKitsCache(): void {
  lastGood = null
  freshUntil = 0
  inflight = null
}
