// Public brand filter (test company, owner 2026-10-14).
//
// A test company's brands are never ADVERTISED: they stay out of every public
// listing (storefront concepts + search, live pages and kits, public
// locations, the WhatsApp brand menu, the custom-domain host map). They still
// work when someone goes straight to the brand by slug or URL, so online
// ordering can be tested — those payloads carry `isTestCompany: true`.
//
// Spread this into a `Concept` where-clause. It is a NOT (not `tenant:
// { isTest: false }`) so a legacy brand with no company stays listed exactly
// as before. For a model that reaches the brand through a relation, nest it:
// `concept: { ...publicBrandWhere() }`.
import { isTestTenant } from './testCompany.js'

export function publicBrandWhere(): { NOT: { tenant: { isTest: true } } } {
  return { NOT: { tenant: { isTest: true } } }
}

/** `isTestCompany` for a brand payload, from its company id. */
export async function isTestCompanyOf(tenantId: string | null | undefined): Promise<boolean> {
  return isTestTenant(tenantId)
}

/**
 * THE rule for a brand that may be LISTED to the public (owner, 2026-10-26:
 * "G's kitchen is a no revenue brand" — it must never appear in any public
 * picker): active, not deleted, shown on the storefront (storefrontVisible —
 * the CEO's switch, off for G's Kitchen) and not a test company's. Every
 * public brand LIST (storefront brand list + search, group-order and booking
 * pickers via /storefront/concepts, live pages, WhatsApp brand menu) spreads
 * this; a by-slug lookup that must still work for a test company keeps
 * publicBrandWhere() alone.
 */
export function listedBrandWhere(): {
  isActive: true; deletedAt: null; storefrontVisible: true; NOT: { tenant: { isTest: true } }
} {
  return { isActive: true, deletedAt: null, storefrontVisible: true, ...publicBrandWhere() }
}
