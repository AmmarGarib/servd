'use client'
// The kitchen floor view of stock and recipes (wave 3, audit UI-10).
//
// The line cook (boh) holds the inventory and recipes modules, so the API lets
// them read stock, the low-stock list, the waste log and the recipe book —
// but with every cost, list price, supplier and margin taken out: each row
// comes back with `costsHidden: true`. They also cannot add or edit items
// (POST/PATCH /inventory), cost or price recipes, or edit them.
//
// Pages use this to hide what the server will refuse — the "+ Add item"
// button, the waste-cost totals, the Sourcing sheet (catalogue + prices) and
// Menu engineering (plate cost vs price). The server flag decides when there
// are rows; the role covers an empty list. The role set mirrors the API's
// COSTS_HIDDEN_ROLES (backend src/modules/inventory/routes.ts).
import { usePermissions } from '../../hooks/useCan'

const KITCHEN_FLOOR_ROLES = new Set(['boh', 'kitchen', 'expediter'])

export function useKitchenView(rows?: ReadonlyArray<{ costsHidden?: boolean }>): boolean {
  const { data: me } = usePermissions()
  if (rows?.some((r) => r.costsHidden === true)) return true
  return me ? KITCHEN_FLOOR_ROLES.has(me.role) : false
}

/**
 * For a page that should not even ask (its read is refused to the floor):
 * `settled` turns true once the signed-in role is known (or failed to load,
 * in which case the page asks and the server decides).
 */
export function useKitchenRole(): { settled: boolean; kitchen: boolean } {
  const { data: me, isFetched } = usePermissions()
  return { settled: isFetched, kitchen: me ? KITCHEN_FLOOR_ROLES.has(me.role) : false }
}

// ─── Stock actions by role (wave 3 review, W3D-RV-3) ─────────────────────────
// Mirrors of the API's role lists, so a page shows only the buttons the server
// will accept:
//   • waste — backend src/modules/inventory/routes.ts WASTE_LOGGERS
//     (managers + boh). procurement reads stock but does not log waste.
//   • count — POST /crosschecks/physical-counts (managers + boh). The buyer
//     does not certify the stock it buys (owner-visible judgement call), so
//     procurement gets no Count button.
const MANAGER_ROLES = ['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager']
const WASTE_LOGGER_ROLES = new Set([...MANAGER_ROLES, 'boh'])
const STOCK_COUNTER_ROLES = new Set([...MANAGER_ROLES, 'boh'])

/**
 * Which stock actions the signed-in role may take. Hidden while the role is
 * loading; if it fails to load the buttons show and the server decides.
 */
export function useStockActions(): { canWaste: boolean; canCount: boolean } {
  const { data: me, isFetched } = usePermissions()
  if (!isFetched) return { canWaste: false, canCount: false }
  if (!me) return { canWaste: true, canCount: true }
  return { canWaste: WASTE_LOGGER_ROLES.has(me.role), canCount: STOCK_COUNTER_ROLES.has(me.role) }
}
