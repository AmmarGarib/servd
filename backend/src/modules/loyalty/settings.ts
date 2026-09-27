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
// bootstrap defaults in lib/loyaltySettings.ts apply. This module changes no
// values (owner decision 12 still governs the point value).

import { prisma } from '../../lib/prisma.js'
import { LOYALTY_SETTING_KEYS, LOYALTY_DEFAULTS } from '../../lib/loyaltySettings.js'

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
        data: legacy.map((r) => ({ key: companyLoyaltyKey(r.key as LoyaltySettingKey, tenantId), value: r.value })),
        skipDuplicates: true,
      })
      rows = await prisma.setting.findMany({ where: { key: { in: keys } } })
    }
  }
  return parse(tenantId, rows)
}

/** Write the keys present in `patch` for one company only. */
export async function saveCompanyLoyaltySettings(
  tenantId: string,
  patch: Partial<Record<LoyaltySettingKey, number | undefined>>,
): Promise<LoyaltyValues> {
  // Seed first so a partial PATCH keeps the inherited values of the other keys.
  await loadCompanyLoyaltySettings(tenantId)
  const writes = Object.entries(patch).filter((e): e is [LoyaltySettingKey, number] => typeof e[1] === 'number')
  await prisma.$transaction(
    writes.map(([k, value]) => {
      const key = companyLoyaltyKey(k, tenantId)
      return prisma.setting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } })
    }),
  )
  return loadCompanyLoyaltySettings(tenantId)
}
