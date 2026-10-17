// Loyalty programme settings, per company.
//
// Earn rate, point value, minimum redeem, expiry, birthday bonus and stamp
// threshold used to be ONE set of Setting rows for the whole platform, so a
// manager in one company changing the earn rate changed it for every other
// company too. Each company now has its own keys, suffixed with its tenant id
// the way HR settings are (`hr.settings.<tenantId>`):
//
//   loyalty.earn_cents_per_point.<tenantId>, loyalty.point_value_cents.<tenantId>, …
//
// Migration: the first time a company's settings are read and it has none, the
// old global values are copied into its own keys (one time — later edits to
// either company never touch the other). With no global rows either, the
// bootstrap defaults in lib/loyaltySettings.ts apply.
//
// Point value (owner decision 12): one point is worth PKR 0.10. Customers have
// always been shown and paid 10 paisa a point at checkout, while the admin
// setting defaulted to PKR 1. So that balances keep the value customers see,
// every company's stored point value is set to 10 once (marker key
// `loyalty.migrated.point_value_d12.<tenantId>`), and any value copied in from
// the legacy global keys is copied as 10. Later edits in admin are respected.

import { prisma } from '../../lib/prisma.js'
import { LOYALTY_SETTING_KEYS, LOYALTY_DEFAULTS, POINT_VALUE_CENTS } from '../../lib/loyaltySettings.js'

export type LoyaltySettingKey = typeof LOYALTY_SETTING_KEYS[number]
export type LoyaltyValues = typeof LOYALTY_DEFAULTS

/** The Setting key holding `key` for one company. */
export const companyLoyaltyKey = (key: LoyaltySettingKey, tenantId: string): string => `${key}.${tenantId}`

function parse(tenantId: string, rows: Array<{ key: string; value: string }>): LoyaltyValues {
  const out = { ...LOYALTY_DEFAULTS }
  const suffix = `.${tenantId}`
  for (const r of rows) {
    if (!r.key.endsWith(suffix)) continue
    const base = r.key.slice(0, -suffix.length) as LoyaltySettingKey
    if (!(LOYALTY_SETTING_KEYS as readonly string[]).includes(base)) continue
    const n = Number(r.value)
    if (Number.isFinite(n) && n >= 0) out[base] = n
  }
  return out
}

/**
 * One company's loyalty settings. Seeds the company's keys from the legacy
 * global keys the first time (when the company has none of its own).
 */
export async function loadCompanyLoyaltySettings(tenantId: string): Promise<LoyaltyValues> {
  const keys = LOYALTY_SETTING_KEYS.map((k) => companyLoyaltyKey(k, tenantId))
  let rows = await prisma.setting.findMany({ where: { key: { in: keys } } })
  if (rows.length === 0) {
    const legacy = await prisma.setting.findMany({ where: { key: { in: [...LOYALTY_SETTING_KEYS] } } })
    if (legacy.length > 0) {
      await prisma.setting.createMany({
        data: legacy.map((r) => ({
          key: companyLoyaltyKey(r.key as LoyaltySettingKey, tenantId),
          // Decision 12: the point value is never inherited from the old global row.
          value: r.key === 'loyalty.point_value_cents' ? String(POINT_VALUE_CENTS) : r.value,
        })),
        skipDuplicates: true,
      })
      rows = await prisma.setting.findMany({ where: { key: { in: keys } } })
    }
  }
  if (await applyPointValueDecision(tenantId, rows)) {
    rows = await prisma.setting.findMany({ where: { key: { in: keys } } })
  }
  return parse(tenantId, rows)
}

/** Marker recording that decision 12 has been applied to a company's stored point value. */
export const pointValueMarkerKey = (tenantId: string): string => `loyalty.migrated.point_value_d12.${tenantId}`

/**
 * One-time correction (owner decision 12): a company's stored point value is
 * set to PKR 0.10. Runs once per company, before any operator edit made after
 * this release, so it never overrides a deliberate later change. Returns true
 * when it wrote.
 */
async function applyPointValueDecision(tenantId: string, rows: Array<{ key: string; value: string }>): Promise<boolean> {
  const marker = pointValueMarkerKey(tenantId)
  const done = await prisma.setting.findUnique({ where: { key: marker }, select: { key: true } })
  if (done) return false
  const key = companyLoyaltyKey('loyalty.point_value_cents', tenantId)
  const stored = rows.find((r) => r.key === key)
  const writes = [prisma.setting.create({ data: { key: marker, value: new Date().toISOString() } })]
  if (stored && stored.value !== String(POINT_VALUE_CENTS)) {
    writes.push(prisma.setting.update({ where: { key }, data: { value: String(POINT_VALUE_CENTS) } }))
  }
  try {
    await prisma.$transaction(writes)
  } catch {
    return false   // a concurrent load wrote the marker first
  }
  return writes.length > 1
}

/**
 * Write the keys present in `patch` for one company only. A change of the
 * point value revalues 2060 in the same transaction (./revaluation.ts — owner,
 * 2026-10-17). Pass the actor for the audit row and the entry's postedBy.
 */
export async function saveCompanyLoyaltySettings(
  tenantId: string,
  patch: Partial<Record<LoyaltySettingKey, number | undefined>>,
  actor: { userId?: string | null; userEmail?: string | null } = {},
): Promise<LoyaltyValues> {
  // Seed first so a partial PATCH keeps the inherited values of the other keys.
  await loadCompanyLoyaltySettings(tenantId)
  const writes = Object.entries(patch).filter((e): e is [LoyaltySettingKey, number] => typeof e[1] === 'number')
  const { writeLoyaltySettingsWithRevaluation } = await import('./revaluation.js')
  await writeLoyaltySettingsWithRevaluation(tenantId, writes, actor)
  return loadCompanyLoyaltySettings(tenantId)
}
