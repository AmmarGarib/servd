// Browser origins allowed by the Domain table.
//
// The Domain table (admin → Configuration → Domains) is the ONE list of brand
// hosts. The API's CORS allowlist used to carry its own hardcoded copy
// (DEFAULT_BRAND_HOSTS in lib/corsAllowlist.ts) which had drifted: it still
// listed brands that no longer exist and none of the live .pk domains, so a
// browser call from flipd.pk / stackd.pk / simmer.pk was CORS-blocked unless
// BRAND_HOSTS happened to be set on the box. Now an ACTIVE domain row is
// allowed as `https://<hostname>` — add a domain in admin, flip it active, and
// the API accepts calls from it within one refresh interval. No deploy.
//
// isAllowedOrigin() is synchronous (it runs inside @fastify/cors's origin
// callback), so the set is held in memory and refreshed on a timer. A refresh
// that fails keeps the last good set: a database blip must not turn into
// every brand site losing its API.

import { serviceClient as prisma } from '../../lib/prisma.js'

const REFRESH_MS = 60_000

let origins = new Set<string>()
let loadedAt: number | null = null
let timer: NodeJS.Timeout | null = null

function toOrigin(hostname: string): string {
  return `https://${hostname.trim().toLowerCase().replace(/\.$/, '')}`
}

/** Reload the allowed origins from active Domain rows. Keeps the old set on failure. */
export async function refreshDomainOrigins(): Promise<number> {
  try {
    const rows = await prisma.domain.findMany({
      where: { status: 'active', deletedAt: null },
      select: { hostname: true },
    })
    origins = new Set(rows.map((r) => toOrigin(r.hostname)))
    loadedAt = Date.now()
  } catch (err) {
    console.warn('[domains] CORS host refresh failed, keeping the last list:', (err as Error).message)
  }
  return origins.size
}

/** Is this (already normalised: lowercase, no trailing slash) origin an active custom domain? */
export function isDomainOriginAllowed(origin: string): boolean {
  return origins.has(origin)
}

/** Load once, then keep refreshing. Idempotent. Call at boot, before listen. */
export async function startDomainOriginRefresh(): Promise<void> {
  await refreshDomainOrigins()
  if (timer) return
  timer = setInterval(() => { void refreshDomainOrigins() }, REFRESH_MS)
  timer.unref?.()
}

export function stopDomainOriginRefresh(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** For /health and boot logging. */
export function describeDomainOrigins(): string {
  return `domains: ${origins.size} active host(s)${loadedAt ? '' : ' (not loaded yet)'}`
}
