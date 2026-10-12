// Pure helpers for the order page's "Refund money taken" dialog (LEDGER-R5
// hand-back on a cancelled / rejected ticket) and for the bill-print buttons.
// No React, no API client — the backend suite imports this file as-is
// (backend/tests/i3HandBackUi.test.ts), so keep every import type-only or pure.

import { canOpenPath } from '../../lib/moduleCatalog'

// ─── Amounts ──────────────────────────────────────────────────────────────────

// Plain digits ("1500", "1500.5", "1500.50") or properly grouped thousands
// ("1,500", "12,345.67") — the way PKR is written on every other screen.
// Anything else ("1,5", "1500abc", "-3", "1e3", "") is not an amount.
const PLAIN = /^\d+(\.\d{1,2})?$/
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/

/**
 * A typed PKR amount → paisa, or NaN when it is not a plain amount. Integer
 * maths only (no `parseFloat(x) * 100`), so "1,500" is 150 000 paisa — never
 * PKR 1 — and "0.29" is 29, not 28.999….
 */
export function parsePkrToCents(input: string): number {
  const raw = input.trim()
  if (!PLAIN.test(raw) && !GROUPED.test(raw)) return Number.NaN
  const [whole, frac = ''] = raw.replace(/,/g, '').split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : Number.NaN
}

// ─── Which drawer a cash hand-back leaves from ──────────────────────────────
//
// POST /pos/orders/:id/refund takes `shiftId`: an OPEN drawer of the order's
// company (assertShiftOf), and a manager may name any of them
// (assertDrawerOperator). Without one the server uses the refunder's OWN open
// drawer — which a back-office manager usually does not have (422
// OPEN_DRAWER_REQUIRED). So the dialog offers:
//   - this till's drawer, when this browser has one open (usePosStore.shiftId);
//   - the drawer(s) that took the cash on this ticket — the money is there;
//   - "my own open drawer" (no shiftId: the server picks it).
// The default is the till's drawer, else the drawer that took the cash most
// recently. A drawer that has closed since is refused by the server
// (SHIFT_CLOSED) and the dialog then marks it closed and moves on.

/** '' = no shiftId: the server uses the refunder's own open drawer. */
export const OWN_DRAWER = ''

export interface DrawerChoice { value: string; label: string; closed: boolean }

export interface CashReceipt {
  method: string
  shiftId?: string | null
  processedAt?: string | null
  createdAt?: string | null
}

const shortId = (id: string) => id.slice(0, 8).toUpperCase()

export function cashDrawerChoices(input: {
  tillShiftId: string | null
  receipts: readonly CashReceipt[]
  closed?: ReadonlySet<string>
}): { choices: DrawerChoice[]; defaultValue: string } {
  const closed = input.closed ?? new Set<string>()
  const took = [...input.receipts]
    .filter((p) => p.method === 'cash' && !!p.shiftId)
    .sort((a, b) => +new Date(b.processedAt ?? b.createdAt ?? 0) - +new Date(a.processedAt ?? a.createdAt ?? 0))
  const tookIds: string[] = []
  for (const p of took) if (!tookIds.includes(p.shiftId!)) tookIds.push(p.shiftId!)

  const choices: DrawerChoice[] = []
  if (input.tillShiftId) {
    choices.push({
      value: input.tillShiftId,
      label: tookIds.includes(input.tillShiftId)
        ? 'This till’s drawer — it took the cash'
        : 'This till’s drawer',
      closed: closed.has(input.tillShiftId),
    })
  }
  for (const id of tookIds) {
    if (id === input.tillShiftId) continue
    choices.push({ value: id, label: `The drawer that took the cash (shift ${shortId(id)})`, closed: closed.has(id) })
  }
  choices.push({ value: OWN_DRAWER, label: 'My own open drawer', closed: false })

  const defaultValue = choices.find((c) => !c.closed)?.value ?? OWN_DRAWER
  return { choices, defaultValue }
}

// ─── Who may print a bill ────────────────────────────────────────────────────
//
// GET /pos/receipt/:id, POST /pos/orders/:id/pre-bill and the pre-bill HTML
// are requireAuth(...CASHIERS) (backend auth/middleware.ts). expediter and
// finance hold the 'orders' module but are not cashiers, so a Print / Reprint
// button would only ever answer 403 for them.
//
// The exact list is the server's: GET /permissions/role-modules
// `roles.cashiers`. Until an API serves it, the fallback is "a manager
// (roles.overrideApprovers — every one of them is in CASHIERS) or a login that
// can open the till (/pos)": the default module sets give exactly CASHIERS.

export function canPrintBill(
  role: string | null | undefined,
  opts: { cashierRoles?: readonly string[] | null; overrideApprovers?: readonly string[] | null; modules?: readonly string[] | null },
): boolean {
  if (!role) return false
  if (opts.cashierRoles && opts.cashierRoles.length > 0) return opts.cashierRoles.includes(role)
  if (opts.overrideApprovers?.includes(role)) return true
  return canOpenPath('/pos', role, opts.modules ?? [])
}
