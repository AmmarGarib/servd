// Public reads + tracking for the storefront content module, plus the stable
// visitor id and A/B variant pick the mobile renderer uses.
//
// All three endpoints are public (no auth); `api` attaches the customer token
// when there is one, which the backend ignores here.

import * as SecureStore from 'expo-secure-store'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import type { Block, LivePopup, SiteLayout, TrackEvent, Variant } from './types'

export async function fetchSiteLayout(slug: string): Promise<SiteLayout | null> {
  try {
    const row = await api.get<Partial<SiteLayout> | null>(`/site-layouts/${encodeURIComponent(slug)}`)
    if (!row) return null
    return {
      slug: row.slug ?? slug,
      ...(row.kind !== undefined && { kind: row.kind }),
      title: row.title ?? null,
      version: typeof row.version === 'number' ? row.version : 0,
      blocks: Array.isArray(row.blocks) ? row.blocks : null,
      settings: row.settings ?? null,
      fonts: Array.isArray(row.fonts) ? row.fonts : [],
      publishedAt: row.publishedAt ?? null,
      updatedAt: row.updatedAt ?? null,
    }
  } catch {
    // Content is decoration on top of the app's own screens: a failed read
    // just means "nothing live", never an error screen.
    return null
  }
}

export async function fetchLivePopups(): Promise<LivePopup[]> {
  try {
    const rows = await api.get<LivePopup[]>('/site-layouts/popups/live')
    return Array.isArray(rows) ? rows.filter((p) => p && p.rules && Array.isArray(p.blocks)) : []
  } catch {
    return []
  }
}

export function trackContent(slug: string, version: number, variant: Variant, event: TrackEvent): void {
  api.post(`/site-layouts/${encodeURIComponent(slug)}/track`, { version, variant, event }).catch(() => { /* best effort */ })
}

/** Live layout for a slug, or null when nothing is live. */
export function useSiteLayout(slug: string | undefined) {
  return useQuery({
    queryKey: ['site-layout', slug],
    queryFn: () => fetchSiteLayout(slug as string),
    enabled: !!slug,
    staleTime: 60_000,
  })
}

/** True when the layout has something to render. */
export function hasLiveBlocks(layout: SiteLayout | null | undefined): layout is SiteLayout & { blocks: Block[] } {
  return !!layout && Array.isArray(layout.blocks) && layout.blocks.some((b) => !b.hidden)
}

// ── Visitor id + A/B ────────────────────────────────────────────────────────

const VISITOR_KEY = 'servd_visitor_id'
let visitorIdCache: string | null = null
let visitorIdPromise: Promise<string> | null = null

function randomId(): string {
  let out = ''
  for (let i = 0; i < 4; i++) out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20, 32)}`
}

export function getVisitorId(): Promise<string> {
  if (visitorIdCache) return Promise.resolve(visitorIdCache)
  visitorIdPromise ??= (async () => {
    let id: string | null = null
    try { id = await SecureStore.getItemAsync(VISITOR_KEY) } catch { /* unavailable */ }
    if (!id) {
      id = randomId()
      try { await SecureStore.setItemAsync(VISITOR_KEY, id) } catch { /* keep in memory */ }
    }
    visitorIdCache = id
    return id
  })()
  return visitorIdPromise
}

export function peekVisitorId(): string | null {
  return visitorIdCache
}

/** FNV-1a, 32-bit, unsigned. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Same rule as web: hash(visitorId + slug + version) % 100 < splitPct → 'b'. */
export function pickVariant(visitorId: string, layout: Pick<SiteLayout, 'slug' | 'version' | 'settings'>): Variant {
  const ab = layout.settings?.ab
  if (!ab || !Array.isArray(ab.blocks) || ab.blocks.length === 0) return 'a'
  const pct = Math.max(0, Math.min(100, Number(ab.splitPct) || 0))
  if (pct <= 0) return 'a'
  return hash32(`${visitorId}${layout.slug}${layout.version}`) % 100 < pct ? 'b' : 'a'
}
