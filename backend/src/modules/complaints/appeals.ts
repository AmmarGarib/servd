// Ban appeals via the help desk (owner, 2026-10-13: people change numbers).
//
// A blocked customer asks the help desk to review their block. An appeal is an
// OrderComplaint of kind 'ban_appeal' pointing at the CustomerBan (banId) — the
// existing Complaints queue is the help desk; there is no second appeals table
// or approval engine. Deciding it:
//   - lift the block      → POST /crm/bans/:id/lift (lib/strikes.ts liftBanTx
//                           resolves the open appeal);
//   - release one contact → POST /crm/bans/:id/release-contact (resolves it);
//   - keep the block      → PATCH /complaints/:id { status: 'closed' }.
//
// Owner decision 2026-10-15: strikes and bans are about the customer's servd
// ACCOUNT, so they are servd-wide (one block applies at every brand of every
// company) and the appeals are one queue — any company in the customer's
// history sees it (complaints/routes.ts). Customer-facing copy says "your
// servd account", never a single company. The appeal still sits on ONE brand
// (OrderComplaint.conceptId is required): a brand of the ban's company,
// resolved on the server (never trusted from the client).
//
// SWITCH: customer-facing appeals are OFF until the CEO turns them on
// (platform Setting 'crm.banAppealsEnabled', absent = off; the Complaints
// page writes it through PUT /complaints/settings/appeals). While off, the
// storefront appeal routes answer 404 and WhatsApp keeps today's BANNED reply.
// Staff screens (the queue, scoping, lifting) do not depend on it.

import type { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

/** The platform Setting key of the customer-facing appeals switch. */
export const BAN_APPEALS_SETTING = 'crm.banAppealsEnabled'

/** After a decline ('closed'), a new appeal on the same block waits this long. */
export const APPEAL_COOLDOWN_DAYS = 30

export type AppealReason = 'new_number' | 'mistake' | 'other'
export type AppealVia = 'storefront' | 'mobile' | 'whatsapp'

export const APPEAL_REASON_LABEL: Record<AppealReason, string> = {
  new_number: 'This number or email is new to me',
  mistake:    'I think this is a mistake',
  other:      'Something else',
}

export interface BanAppealsSetting {
  enabled: boolean
  reason: string | null
  updatedAt: string | null
  updatedById: string | null
}

/** The appeals switch. Absent, unreadable or malformed = OFF. Never throws. */
export async function readBanAppealsSetting(): Promise<BanAppealsSetting> {
  const off: BanAppealsSetting = { enabled: false, reason: null, updatedAt: null, updatedById: null }
  try {
    const row = await serviceClient.setting.findUnique({ where: { key: BAN_APPEALS_SETTING } })
    if (!row) return off
    const v = JSON.parse(row.value) as Partial<BanAppealsSetting> | boolean
    if (typeof v === 'boolean') return { ...off, enabled: v, updatedAt: row.updatedAt.toISOString() }
    if (!v || typeof v !== 'object') return off
    return {
      enabled: v.enabled === true,
      reason: typeof v.reason === 'string' ? v.reason : null,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : row.updatedAt.toISOString(),
      updatedById: typeof v.updatedById === 'string' ? v.updatedById : null,
    }
  } catch (err) {
    console.error('[appeals] could not read the appeals switch — treating it as off:', (err as Error).message)
    return off
  }
}

export async function banAppealsEnabled(): Promise<boolean> {
  return (await readBanAppealsSetting()).enabled
}

/** Write the switch (the route audits it). */
export async function writeBanAppealsSetting(a: { enabled: boolean; reason: string; actorId: string }): Promise<BanAppealsSetting> {
  const value: BanAppealsSetting = { enabled: a.enabled, reason: a.reason, updatedAt: new Date().toISOString(), updatedById: a.actorId }
  await serviceClient.setting.upsert({
    where: { key: BAN_APPEALS_SETTING },
    create: { key: BAN_APPEALS_SETTING, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  })
  return value
}

const activeBan = (now: Date): Prisma.CustomerBanWhereInput => ({
  liftedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
})

/** A brand that can carry an appeal: not deleted, in a company. */
const BRAND_OK = { deletedAt: null, tenantId: { not: null } } as const

/**
 * The brand an appeal sits on, resolved on the server:
 *  1. the company: the ban's company; a legacy NULL-company ban → the company
 *     of the brand the customer was refused at (the given conceptId); else the
 *     customer's latest order / reservation brand's company;
 *  2. the brand within it: the given brand if it is of that company, else the
 *     customer's latest order or reservation brand there, else the company's
 *     first active brand (then any brand of it).
 * A client brand of ANOTHER company is ignored, never trusted.
 */
async function resolveAppealConcept(
  ban: { tenantId: string | null; customerId: string | null },
  customerId: string | null,
  conceptId: string | undefined,
): Promise<{ id: string; tenantId: string }> {
  const db = serviceClient
  const given = conceptId
    ? await db.concept.findFirst({ where: { id: conceptId, ...BRAND_OK }, select: { id: true, tenantId: true } })
    : null
  const who = customerId ?? ban.customerId

  const latestBrand = async (tenantId: string | null) => {
    if (!who) return null
    const conceptFilter = tenantId ? { tenantId, deletedAt: null } : BRAND_OK
    const [o, r] = await Promise.all([
      db.order.findFirst({
        where: { customerId: who, deletedAt: null, concept: conceptFilter },
        orderBy: { placedAt: 'desc' },
        select: { placedAt: true, concept: { select: { id: true, tenantId: true } } },
      }),
      db.reservation.findFirst({
        where: { customerId: who, concept: conceptFilter },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, concept: { select: { id: true, tenantId: true } } },
      }),
    ])
    const pick = o && r ? (o.placedAt >= r.createdAt ? o.concept : r.concept) : (o?.concept ?? r?.concept ?? null)
    return pick?.tenantId ? { id: pick.id, tenantId: pick.tenantId } : null
  }

  let tenantId = ban.tenantId ?? given?.tenantId ?? null
  if (!tenantId) tenantId = (await latestBrand(null))?.tenantId ?? null
  if (!tenantId) {
    throw new AppError('APPEAL_NO_BRAND', 'We could not find a kitchen to send this appeal to. Please contact us directly.', 422)
  }

  if (given && given.tenantId === tenantId) return { id: given.id, tenantId }
  const latest = await latestBrand(tenantId)
  if (latest) return latest
  const first = await db.concept.findFirst({ where: { tenantId, deletedAt: null, isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    ?? await db.concept.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (!first) throw new AppError('APPEAL_NO_BRAND', 'We could not find a kitchen to send this appeal to. Please contact us directly.', 422)
  return { id: first.id, tenantId }
}

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === 'P2002' || /order_complaints_one_open_appeal_per_ban/.test((err as Error)?.message ?? '')

/**
 * Open a help-desk appeal against a block. The caller has already proved the
 * ban is the customer's (storefront: matched to the session's account; WhatsApp:
 * matched to the sender's number). Contact details come from the session or
 * the sender, never from the client body.
 *
 * 404 when the ban does not exist or is no longer in force; 409 APPEAL_OPEN
 * when an appeal on it is already open (also the partial unique
 * order_complaints_one_open_appeal_per_ban under a race); 429 APPEAL_TOO_SOON
 * within 30 days of a declined appeal.
 */
export async function createBanAppeal(a: {
  banId: string
  customerId?: string
  contactPhone?: string
  conceptId?: string
  reason: AppealReason | string
  message: string
  via: AppealVia
}): Promise<{ appealId: string }> {
  const db = serviceClient
  const now = new Date()
  const ban = await db.customerBan.findFirst({
    where: { id: a.banId, ...activeBan(now) },
    select: { id: true, tenantId: true, customerId: true },
  })
  if (!ban) throw new NotFoundError('Block', a.banId)

  const [open, lastDecline] = await Promise.all([
    db.orderComplaint.findFirst({
      where: { banId: ban.id, kind: 'ban_appeal', status: { in: ['open', 'in_progress'] } },
      select: { id: true },
    }),
    db.orderComplaint.findFirst({
      where: { banId: ban.id, kind: 'ban_appeal', status: 'closed' },
      orderBy: { updatedAt: 'desc' },
      select: { resolvedAt: true, updatedAt: true },
    }),
  ])
  if (open) throw new AppError('APPEAL_OPEN', 'Your request is already with our help desk. We will get back to you.', 409, { appealId: open.id })
  if (lastDecline) {
    const at = lastDecline.resolvedAt ?? lastDecline.updatedAt
    const until = new Date(at.getTime() + APPEAL_COOLDOWN_DAYS * 86_400_000)
    if (until > now) {
      throw new AppError('APPEAL_TOO_SOON', `Our help desk reviewed this recently. You can ask again after ${until.toISOString().slice(0, 10)}.`, 429, { retryAfter: until.toISOString() })
    }
  }

  const customerId = a.customerId ?? ban.customerId ?? null
  const concept = await resolveAppealConcept(ban, customerId, a.conceptId)
  const reasonLabel = APPEAL_REASON_LABEL[a.reason as AppealReason] ?? APPEAL_REASON_LABEL.other
  const message = a.message.trim().slice(0, 1000)
  try {
    const row = await db.orderComplaint.create({
      data: {
        kind:         'ban_appeal',
        banId:        ban.id,
        conceptId:    concept.id,
        customerId,
        contactPhone: a.contactPhone ?? null,
        title:        'Ban appeal',
        description:  `Reason: ${reasonLabel}\nSent from: ${a.via}\n\n${message}`,
        category:     'other',
        priority:     'medium',
      },
      select: { id: true },
    })
    return { appealId: row.id }
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('APPEAL_OPEN', 'Your request is already with our help desk. We will get back to you.', 409)
    }
    throw err
  }
}

/**
 * The customer's blocks in force, matched by account id, email or phone.
 * Servd-wide (owner, 2026-10-15): one entry per block, never naming a company.
 */
export async function activeBansForCustomer(customer: { id: string; email: string | null; phone: string | null }) {
  const or: Prisma.CustomerBanWhereInput[] = [{ customerId: customer.id }]
  if (customer.email) or.push({ email: customer.email.toLowerCase() })
  if (customer.phone) or.push({ phone: customer.phone })
  return serviceClient.customerBan.findMany({
    where: { AND: [{ OR: or }, activeBan(new Date())] },
    select: { id: true, bannedAt: true, tenantId: true, customerId: true },
    orderBy: { bannedAt: 'desc' },
  })
}
