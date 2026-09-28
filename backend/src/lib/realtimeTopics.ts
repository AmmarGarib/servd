// Which realtime topics (rooms / channels) a staff principal may receive.
//
// This is the ONE place that decides. The socket.io server joins a socket to
// exactly these rooms, and the Supabase Realtime token lists exactly these
// topics as claims — so a company can never hear another company's kitchen
// through either transport. Keep the role lists identical to what the socket
// server historically allowed; widening them is a product decision.

import { prisma } from './prisma.js'

export interface RealtimePrincipal {
  id: string
  role: string
  tenantId: string | null
  /** Every company the user belongs to (primary + memberships). */
  tenantIds: string[]
}

export interface RealtimeTopicRequest {
  stationId?: string
  conceptId?: string
}

// Roles that receive the company-wide order feed (`tenant:{id}:orders`,
// `all-orders`).
const ORDER_FEED_ROLES = new Set(['expediter', 'admin', 'owner', 'manager'])
// Roles that receive reservation events (host stand, managers, kitchen tracker).
const RESERVATION_FEED_ROLES = new Set(['admin', 'owner', 'manager', 'cashier', 'expediter', 'kitchen'])

// concept → tenant lookups are hot (every order/reservation event) and brands
// never move between companies in practice, so cache for 5 minutes.
const conceptTenantCache = new Map<string, { tenantId: string | null; expiresAt: number }>()
export async function tenantOfConcept(conceptId: string): Promise<string | null> {
  const hit = conceptTenantCache.get(conceptId)
  if (hit && hit.expiresAt > Date.now()) return hit.tenantId
  const row = await prisma.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true } }).catch(() => null)
  const tenantId = row?.tenantId ?? null
  conceptTenantCache.set(conceptId, { tenantId, expiresAt: Date.now() + 5 * 60_000 })
  return tenantId
}

/**
 * `${kind}:${id}` only if the station/concept belongs to one of the
 * principal's companies. Foreign or unknown ids yield nothing — a client with
 * a guessed id simply gets no events, and learns nothing.
 */
async function ownedTopic(
  tenantIds: string[],
  kind: 'station' | 'concept',
  id: string,
): Promise<string | null> {
  if (tenantIds.length === 0) return null
  try {
    let owner: string | null = null
    if (kind === 'concept') {
      owner = await tenantOfConcept(id)
    } else {
      const st = await prisma.station.findUnique({ where: { id }, select: { conceptId: true } })
      owner = st ? await tenantOfConcept(st.conceptId) : null
    }
    return owner && tenantIds.includes(owner) ? `${kind}:${id}` : null
  } catch {
    return null
  }
}

export async function resolveRealtimeTopics(
  principal: RealtimePrincipal,
  want: RealtimeTopicRequest = {},
): Promise<string[]> {
  const topics = new Set<string>()
  const { role, tenantIds } = principal

  for (const t of tenantIds) topics.add(`tenant:${t}`)
  if (ORDER_FEED_ROLES.has(role)) {
    topics.add('all-orders')
    for (const t of tenantIds) topics.add(`tenant:${t}:orders`)
  }
  if (RESERVATION_FEED_ROLES.has(role)) {
    for (const t of tenantIds) topics.add(`tenant:${t}:reservations`)
  }
  if (want.stationId) {
    const t = await ownedTopic(tenantIds, 'station', want.stationId)
    if (t) topics.add(t)
  }
  if (want.conceptId) {
    const t = await ownedTopic(tenantIds, 'concept', want.conceptId)
    if (t) topics.add(t)
  }
  return Array.from(topics)
}

/**
 * Live principal for a staff user id: current role and every company they
 * belong to. Returns null when the account is gone, inactive or suspended —
 * a valid token signature is not the same as a live session.
 */
export async function loadRealtimePrincipal(userId: string): Promise<RealtimePrincipal | null> {
  const [u, memberships] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true, role: true, isActive: true, accountStatus: true, deletedAt: true },
    }),
    prisma.tenantMember.findMany({ where: { userId }, select: { tenantId: true } }),
  ])
  if (!u || u.deletedAt || !u.isActive || u.accountStatus !== 'active') return null
  const tenantIds = new Set<string>(memberships.map((m) => m.tenantId))
  if (u.tenantId) tenantIds.add(u.tenantId)
  return { id: userId, role: u.role, tenantId: u.tenantId ?? null, tenantIds: Array.from(tenantIds) }
}
