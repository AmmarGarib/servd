// Code-only delivery — the per-company switch (Delivery & customers, resumed
// 2026-10-15; parked plan .handoff/parked/2026-10-14/).
//
// ON: a delivery order completes only with the customer's 4-digit code (rider
// app, or staff "Enter code"); the staff "Delivered" override is refused.
// OFF (the default, and today's behaviour): staff "Delivered" works as before.
//
// Stored as one Setting row per company, key `delivery.codeOnlyAt:<tenantId>`,
// value = the ISO time it was switched on. Present = on; switching off deletes
// the row. Every switch writes an audit row in that company.

import type { PrismaClient, Prisma } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export const DELIVERY_CODE_ONLY_SETTING = 'delivery.codeOnlyAt'

function keyOf(tenantId: string): string {
  return `${DELIVERY_CODE_ONLY_SETTING}:${tenantId}`
}

/** Is code-only delivery on for this company? A missing company id is OFF. */
export async function codeOnlyDelivery(db: Db, tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return false
  const row = await db.setting.findUnique({ where: { key: keyOf(tenantId) }, select: { key: true } })
  return row !== null
}

/**
 * Switch code-only delivery on or off for one company, and audit it in that
 * company. Idempotent: switching on keeps the first switch-on time.
 */
export async function setCodeOnlyDelivery(
  tx: Prisma.TransactionClient,
  a: { tenantId: string; on: boolean; actorId: string; reason: string },
): Promise<{ on: boolean; since: Date | null }> {
  const key = keyOf(a.tenantId)
  const before = await tx.setting.findUnique({ where: { key }, select: { value: true } })
  let since: Date | null = null
  if (a.on) {
    const at = before?.value ?? new Date().toISOString()
    await tx.setting.upsert({ where: { key }, create: { key, value: at }, update: {} })
    since = new Date(at)
  } else if (before) {
    await tx.setting.delete({ where: { key } })
  }
  await tx.auditLog.create({
    data: {
      category: 'identity',
      tenantId: a.tenantId,
      action: 'delivery.code_only.switch',
      entity: 'Tenant',
      entityId: a.tenantId,
      userId: a.actorId,
      before: { on: before !== null, since: before?.value ?? null },
      after: { on: a.on, since: since ? since.toISOString() : null },
      metadata: { reason: a.reason },
    },
  })
  return { on: a.on, since }
}
