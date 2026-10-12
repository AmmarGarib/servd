// Table capacity for one time window (ONL-08).
//
// The public booking form never checked capacity: five parties of six were all
// accepted for a brand with one six-top, the availability search still showed
// the slot free (it only counted bookings that already had a table), and the
// clash surfaced at the host stand on the night. Both now use this one rule.
//
// Inputs: every live table of the brand, and every active booking (booked /
// confirmed / seated) overlapping the window. A booking WITH a table holds it.
// A booking WITHOUT one — a staff booking the host has not placed yet, or an
// older public booking — still needs a table, so it is given one on paper:
// largest party first, each to the smallest free table that fits. Because a
// party fits every table that fits a larger party, that order never strands a
// party some other arrangement could have seated. A waiting-list entry with no
// table holds nothing (the host seats it only if a table frees up).
//
// The window is treated as one block: every booking overlapping any part of it
// competes for the whole of it. That is deliberately conservative — it can
// turn away a booking that two back-to-back sittings could have shared, but it
// never double-books a table.

export interface CapacityTable { id: string; capacity: number }
export interface CapacityBooking { tableId: string | null; partySize: number; waitlist?: boolean }

export interface SeatPlan {
  /** The table for the new party, or null when the window is full for it. */
  tableId: string | null
  /** Tables that fit the party and are still free once every booking is placed. */
  tablesAvailable: number
}

function placeParties(free: CapacityTable[], parties: number[]): { ok: boolean; left: CapacityTable[]; placed: (string | null)[] } {
  const left = [...free].sort((a, b) => a.capacity - b.capacity || a.id.localeCompare(b.id))
  const placed: (string | null)[] = []
  for (const size of parties) {
    const i = left.findIndex((t) => t.capacity >= size)
    if (i === -1) { placed.push(null); return { ok: false, left, placed } }
    placed.push(left[i]!.id)
    left.splice(i, 1)
  }
  return { ok: true, left, placed }
}

/** Where (if anywhere) a party of `partySize` can sit, given what already overlaps. */
export function planSeat(tables: CapacityTable[], overlapping: CapacityBooking[], partySize: number): SeatPlan {
  const held = new Set(overlapping.map((b) => b.tableId).filter((id): id is string => !!id))
  const free = tables.filter((t) => !held.has(t.id))
  const unplaced = overlapping
    .filter((b) => !b.tableId && !b.waitlist)
    .map((b) => b.partySize)
    .sort((a, b) => b - a)

  // The existing parties first: what is left for the new one?
  const existing = placeParties(free, unplaced)
  const tablesAvailable = existing.ok ? existing.left.filter((t) => t.capacity >= partySize).length : 0

  // The new party among them, in size order (ties: the new party last, so an
  // equal existing party is never displaced on paper).
  const sizes = [...unplaced, partySize].map((size, i) => ({ size, isNew: i === unplaced.length }))
  sizes.sort((a, b) => b.size - a.size || Number(a.isNew) - Number(b.isNew))
  const all = placeParties(free, sizes.map((s) => s.size))
  if (!all.ok) return { tableId: null, tablesAvailable: 0 }
  const tableId = all.placed[sizes.findIndex((s) => s.isNew)] ?? null
  return { tableId, tablesAvailable: Math.max(tablesAvailable, tableId ? 1 : 0) }
}

// ─── Unverified online bookings (ONLINE-R2) ────────────────────────────────
//
// A public booking needs no account, and both of the route's limits (per IP,
// per typed phone) are values the caller chooses. Once public bookings held
// real tables (above), one person could fill a brand's whole online book with
// made-up numbers, and every real guest got SLOT_FULL.
//
// So an online booking that nobody can be held to account for — not linked to
// a signed-in customer with a verified phone or email — may only take a share
// of the brand's tables in any window: a third of them, at least one. Signed-in
// guests with a verified contact, and every booking the host stand makes, use
// the rest. Staff can still cancel a fake row, and ban its IP.

export const UNVERIFIED_TABLE_SHARE = 1 / 3

/** How many unverified online bookings may overlap one window. */
export function unverifiedCap(tableCount: number): number {
  return Math.max(1, Math.floor(tableCount * UNVERIFIED_TABLE_SHARE))
}

export interface TrustRow {
  source: string
  status: string
  customer?: { phoneVerifiedAt: Date | null; emailVerifiedAt: Date | null } | null
}

/**
 * An online booking still waiting to be seated that is not tied to a customer
 * with a verified contact. (Seated ones turned up; staff bookings are the host
 * stand's own.)
 */
export function isUnverifiedOnline(r: TrustRow): boolean {
  if (r.source !== 'website') return false
  if (r.status !== 'booked' && r.status !== 'confirmed') return false
  return !(r.customer?.phoneVerifiedAt || r.customer?.emailVerifiedAt)
}
