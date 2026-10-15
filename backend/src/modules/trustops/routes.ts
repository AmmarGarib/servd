// Trust-ops module — closes the remaining cash + product theft loops:
//   • Rider OTP at delivery (proves customer received it)
//   • Petty cash box (audit trail on small-spend)
//   • Bank deposit drop (cash-to-bank reconciliation)
//   • Staff meal logging (caps untracked food consumption)
//   • Bank-statement reconciliation file enforcement
//
// All actions fire ExceptionFlag on policy breach.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { verifyManagerPin } from '../auth/managerPin.js'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, HR_TEAM } from '../auth/middleware.js'
import { flagException } from '../../lib/exceptions.js'
import {
  CASH_GUARD, passesCashGuard, insufficientFloatError,
  recordPettyCashSpendTx, recordPettyCashTopupTx, recordPettyCashTransferTx, recordPettyCashCountTx, recordPettyCashReturnTx,
} from './pettyCash.js'
import { postPettyCashMovementTx, pettyCashTieOut, type SpendLineInput } from '../accounting/pettyCashPosting.js'
import { EXPENSE_PAYOUT_CATEGORIES } from '../accounting/expenseCategories.js'
import { assertNotEquipmentLine } from '../fixedAssets/classes.js'
import { decodeEvidenceFile, sendEvidence } from '../../lib/evidenceFile.js'
import { zInt4Cents } from '../../lib/money.js'
import { moneyAccountCode, zPaymentRef } from '../../lib/bankAccounts.js'
import { findPaymentReferenceUses } from '../../lib/paymentRefs.js'
import { cashVoucherRoutes } from './cashVouchers.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError, AppError, ForbiddenError } from '../../lib/errors.js'
import type { FastifyRequest } from 'fastify'
import {
  scopeTenantWhere, conceptWhere, assertConceptOwned, assertShiftOf, conceptIdsInScope, resolveTenantScope,
  SHIFT_COMPANY_INCLUDE, shiftTenantId, shiftOfCompany,
} from '../../lib/tenantScope.js'
import { cashVarianceLimitCents } from '../../lib/drawer.js'
import { generateDeliveryOtp, deliveryOtpMatches, DELIVERY_OTP_READERS, DELIVERY_OTP_MAX_ATTEMPTS } from '../../lib/deliveryOtp.js'
import { codeOnlyDelivery } from '../../lib/deliveryRules.js'
import type { Prisma, UserRole } from '@prisma/client'
import { orderRefOf } from '../../lib/orderRef.js'

// The 4-digit hand-off code: generated with crypto.randomInt and compared in
// constant time — the same helpers as the rider app (lib/deliveryOtp.ts).

// Manager PIN: the ONE verifier (auth/managerPin.ts) — active accounts,
// owner-decision-7 approvers, and only approvers of the company the action
// happens in. The local copy here had no company filter, so a manager at
// company B could approve a company-A staff meal or petty-cash top-up.

// ─── Company scope ──────────────────────────────────────────────────────────
//
// A delivery order belongs to its brand's company; a petty-cash box carries
// its own tenantId (stamped on create); a staff meal has no company column
// yet, so its company is answered by the precedence chain in mealCompanies.

/** The order, or 404 when its brand is not a company the operator belongs to. */
async function findOrderInScope<S extends Record<string, unknown>>(req: FastifyRequest, id: string, select: S) {
  const order = await prisma.order.findFirst({
    where: { id, concept: await scopeTenantWhere(req, 'write') },
    select: { ...select, concept: { select: { tenantId: true } } },
  })
  if (!order) throw new NotFoundError('Order', id)
  return order
}

/** The petty-cash box, or 404 when it is not one of the operator's companies'. */
async function findBoxInScope(req: FastifyRequest, id: string) {
  const box = await prisma.pettyCashBox.findFirst({
    where: { id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
  })
  if (!box || !box.tenantId) throw new NotFoundError('PettyCashBox', id)
  return { ...box, tenantId: box.tenantId }
}

/** True when the user is a member of `tenantId` (primary company or membership). */
async function isMemberOf(userId: string, tenantId: string): Promise<boolean> {
  const u = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
    select: { id: true },
  })
  return !!u
}

// Who (wave 3, UI-07 / UI-09):
//   CASH_KEEPERS — petty-cash boxes (list, open a box, count/reconcile one)
//     and deposit drops (list, record the cash taken to the bank): the
//     manager tiers plus finance. Both pages sit in the 'accounting' module of
//     the Finance workspace that finance owns; they used to 403 finance.
//     A top-up over a box's limit still needs an approver's PIN of the box's
//     company (verifyManagerPin), whoever records it.
//   MEAL_READERS — the staff-meal log: the manager tiers plus HR. The page is
//     in HR's 'staff_directory' (Workforce); HR reads it, nobody writes here
//     (meals are rung through the till).
// CASH_KEEPERS / CASH_GUARD live in pettyCash.ts, shared with the cash
// vouchers (cashVouchers.ts) so both pages are gated the same way.
const MEAL_READERS = HR_TEAM
// /trustops is not a central module-gated prefix (and must not be wholesale:
// /petty-cash/movements is ALL_STAFF), so the roles newly let in must also
// hold the module whose page this is — finance 'accounting', HR
// 'staff_directory' — or the CEO's Module Access untick closes nothing
// (W3B-RV-1). The deposit-drop POST posts Dr bank / Cr cash. Manager tiers
// pass exactly as before.
const MEAL_GUARD = [requireAuth(...MEAL_READERS), moduleGateForNewRoles(['staff_directory'])]

type MealRow = { id: string; conceptId: string | null; shiftId: string | null; staffId: string }

/**
 * The company of each staff meal. StaffMeal has no tenantId column yet, so
 * it is a precedence chain — each step applies only when the one above it is
 * null: the brand's company, else the drawer's company, else the staff
 * member's company when they belong to exactly one. Null = unattributable,
 * and an unattributable meal is shown to nobody (fail closed).
 */
async function mealCompanies(meals: MealRow[]): Promise<Map<string, string | null>> {
  const conceptIds = [...new Set(meals.map((m) => m.conceptId).filter((x): x is string => !!x))]
  const shiftIds = [...new Set(meals.filter((m) => !m.conceptId && m.shiftId).map((m) => m.shiftId!))]
  const staffIds = [...new Set(meals.filter((m) => !m.conceptId && !m.shiftId).map((m) => m.staffId))]
  const [concepts, shifts, staff] = await Promise.all([
    conceptIds.length ? prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, tenantId: true } }) : [],
    shiftIds.length ? prisma.shift.findMany({ where: { id: { in: shiftIds } }, include: SHIFT_COMPANY_INCLUDE }) : [],
    staffIds.length
      ? prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } } })
      : [],
  ])
  const byConcept = new Map(concepts.map((c) => [c.id, c.tenantId]))
  const byShift = new Map(shifts.map((s) => [s.id, shiftTenantId(s)]))
  const byStaff = new Map(staff.map((u) => {
    const ids = new Set(u.tenantMemberships.map((m) => m.tenantId))
    if (u.tenantId) ids.add(u.tenantId)
    return [u.id, ids.size === 1 ? [...ids][0]! : null] as const
  }))
  const out = new Map<string, string | null>()
  for (const m of meals) {
    out.set(m.id,
      m.conceptId ? (byConcept.get(m.conceptId) ?? null)
      : m.shiftId ? (byShift.get(m.shiftId) ?? null)
      : (byStaff.get(m.staffId) ?? null))
  }
  return out
}

/**
 * Attach a person's display name to each row (`key` → name or null). Only the
 * name is read, and only for users the rows already point at — rows that are
 * themselves in the operator's scope.
 */
async function withNames<T, K extends string>(rows: T[], idOf: (r: T) => string, key: K): Promise<Array<T & Record<K, string | null>>> {
  const ids = [...new Set(rows.map(idOf))]
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  const byId = new Map(users.map((u) => [u.id, u.name]))
  return rows.map((r) => ({ ...r, [key]: byId.get(idOf(r)) ?? null }) as T & Record<K, string | null>)
}

// ─── Petty cash helpers (finance wave B) ────────────────────────────────────

/** Where a top-up's cash came from, on the routes (cash_request / opening are writer-only). */
const TOPUP_SOURCES = ['garibsons', 'safe', 'bank', 'till'] as const

/** One line of a spend: an expense, a stock item (a settled cash-purchase receipt on FIFO lots) or a CapEx line (the writer checks each against the box's company). */
const SPEND_LINE = z.object({
  kind:          z.enum(['expense', 'stock', 'capex']).default('expense'),
  categoryKey:   z.string().trim().min(1).max(40).nullable().optional(),
  accountCode:   z.string().trim().min(1).max(10).nullable().optional(),
  amountCents:   zInt4Cents('A line', { sign: 'positive' }),
  conceptId:     z.string().min(1).nullable().optional(),
  locationId:    z.string().min(1).nullable().optional(),
  description:   z.string().trim().min(1).max(200),
  notEquipment:  z.boolean().optional(),
  notEquipmentReason: z.string().max(500).nullable().optional(),
  inventoryItemId: z.string().min(1).nullable().optional(),
  quantity:      z.number().positive().nullable().optional(),
  unit:          z.string().max(20).nullable().optional(),
  capexLineId:   z.string().min(1).nullable().optional(),
})

/** 403 unless the signed-in user passes CASH_GUARD (for routes that also admit a custodian elsewhere). */
async function requireCashKeeper(req: FastifyRequest): Promise<void> {
  if (!(await passesCashGuard(req))) throw new ForbiddenError('Only a manager or finance can see the petty-cash boxes')
}

/**
 * The receipts a spend links: each a 'receipt' uploaded for THIS box (422
 * RECEIPT_NOT_ON_BOX otherwise) and on no other spend yet (409 RECEIPT_IN_USE).
 */
async function assertReceiptsFree(box: { id: string; tenantId: string }, ids: string[]): Promise<void> {
  const rows = await prisma.cashVoucherAttachment.findMany({
    where: { id: { in: ids }, kind: 'receipt', boxId: box.id, tenantId: box.tenantId },
    select: { id: true, movementId: true, settlementId: true, voucherId: true },
  })
  if (rows.length !== ids.length) throw new AppError('RECEIPT_NOT_ON_BOX', 'A receipt was not uploaded for this box', 422)
  if (rows.some((r) => r.movementId || r.settlementId || r.voucherId)) {
    throw new AppError('RECEIPT_IN_USE', 'A receipt is already on another spend', 409)
  }
}

/** Link the receipts to the spend inside its transaction — conditional, so two spends never share one. */
async function linkReceiptsTx(tx: Prisma.TransactionClient, boxId: string, ids: string[], movementId: string): Promise<void> {
  const linked = await tx.cashVoucherAttachment.updateMany({
    where: { id: { in: ids }, boxId, kind: 'receipt', movementId: null, settlementId: null, voucherId: null },
    data: { movementId },
  })
  if (linked.count !== ids.length) throw new AppError('RECEIPT_IN_USE', 'A receipt is already on another spend', 409)
}

/** A box-spend receipt (no bytes) of a box in the operator's companies, or 404. */
async function findReceiptInScope(req: FastifyRequest, id: string) {
  const att = await prisma.cashVoucherAttachment.findFirst({
    where: { id, kind: 'receipt', boxId: { not: null }, ...(await scopeTenantWhere(req, 'write')) },
    select: { id: true, boxId: true, movementId: true, uploadedById: true, tenantId: true },
  })
  if (!att || !att.boxId) throw new NotFoundError('Receipt', id)
  return { ...att, boxId: att.boxId }
}

/**
 * A line that looked like equipment but was booked as an expense (finance /
 * CEO override): audited and raised as 'equipment_override' in the BOX's
 * company.
 */
async function flagEquipmentOverrides(
  req: FastifyRequest,
  box: { tenantId: string; name: string; conceptId: string | null },
  movementId: string,
  lines: Array<{ accountCode: string; amountCents: number; description: string; overrideReason: string | null }>,
): Promise<void> {
  for (const l of lines) {
    await audit({ category: 'accounting',
      action: 'petty_cash.equipment_override', entity: 'PettyCashMovement', entityId: movementId,
      userId: req.staffUser!.id, tenantId: box.tenantId, userEmail: req.staffUser!.email,
      after: { accountCode: l.accountCode, amountCents: l.amountCents, description: l.description, reason: l.overrideReason },
      metadata: { ip: req.ip },
    })
    await flagException({
      tenantId: box.tenantId,
      conceptId: box.conceptId,
      kind: 'equipment_override',
      severity: 'medium',
      title: `Petty cash line booked as an expense though it looks like equipment: ${l.description}`.slice(0, 200),
      description: `${box.name}: "${l.description}" (PKR ${(l.amountCents / 100).toFixed(0)}) was booked to ${l.accountCode}. Reason given: ${l.overrideReason ?? '—'}. Equipment belongs on the register through CapEx.`,
      entityType: 'PettyCashMovement',
      entityId: movementId,
      actorId: req.staffUser!.id,
      amountCents: l.amountCents,
      metadata: { accountCode: l.accountCode, reason: l.overrideReason },
    })
  }
}

export async function trustopsRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // 1. RIDER OTP — generate on order, verify on dispatch
  // ════════════════════════════════════════════════════════════════════════

  // GET /trustops/orders/:id/otp — support read of the hand-over code.
  // admin / management ONLY (docs/rider-app.md): anyone who can read the code
  // can "deliver" without going to the door. The customer gets their own code
  // from GET /storefront/orders/:id and on WhatsApp at pick-up.
  // A company with code-only delivery ON (lib/deliveryRules.ts): 404 for
  // every role, the CEO included — reading the code would be a disguised
  // "Delivered" (owner rule 2026-10-13). A stuck door is resolved by sending
  // the code to the rider (Emergency overrides).
  fastify.get<{ Params: { id: string } }>(
    '/orders/:id/otp',
    { preHandler: requireAuth(...(DELIVERY_OTP_READERS as UserRole[])) },
    async (req) => {
      // Scoped through the order's brand → company: a foreign order is 404.
      const order = await findOrderInScope(req, req.params.id, { id: true, deliveryOtp: true, source: true, status: true })
      if (await codeOnlyDelivery(prisma, order.concept.tenantId)) throw new NotFoundError('Order', req.params.id)
      // Generate OTP on first read if missing (defensive)
      if (!order.deliveryOtp) {
        const otp = generateDeliveryOtp()
        // Conditional: two first reads must not mint two different codes.
        await prisma.order.updateMany({ where: { id: order.id, deliveryOtp: null }, data: { deliveryOtp: otp } })
        const fresh = await prisma.order.findUnique({ where: { id: order.id }, select: { deliveryOtp: true } })
        return { otp: fresh?.deliveryOtp ?? otp }
      }
      return { otp: order.deliveryOtp }
    },
  )

  // POST /trustops/orders/:id/verify-otp — staff enter the customer's code
  // for a rider without the app. Same budget as the rider app: each try takes
  // an attempt slot BEFORE the compare (dispatch/service claimHandoverAttempt),
  // DELIVERY_OTP_MAX_ATTEMPTS in total across both doors, then 423 OTP_LOCKED
  // — a manager completes a locked order through /dispatch/orders/:id/delivered
  // (code-only OFF), or sends the code to the rider (code-only ON, Emergency
  // overrides — which resets the budget).
  // It used to have no lock at all (any staff role could walk all 10,000 codes
  // and record a fake "hand-over code verified") and wrote back a stale
  // absolute count that could lower the rider app's. 3+ failures still raise a
  // `lost_package` flag.
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/verify-otp',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({ otp: z.string().length(4) }).parse(req.body)
      const order = await findOrderInScope(req, req.params.id, {
        id: true, deliveryOtp: true, deliveryOtpAttempts: true, riderId: true, customerId: true, customerName: true, totalCents: true, conceptId: true,
      })
      if (!order.deliveryOtp) {
        throw new AppError('NO_OTP', 'No OTP set on this order. Customer should refresh their order page.', 400)
      }

      const { claimHandoverAttempt, releaseHandoverAttempt, markDelivered } = await import('../dispatch/service.js')
      const slot = await claimHandoverAttempt(order.id, DELIVERY_OTP_MAX_ATTEMPTS)
      if (!slot.claimed) {
        const codeOnly = await codeOnlyDelivery(prisma, order.concept.tenantId)
        throw new AppError(
          'OTP_LOCKED',
          codeOnly
            ? 'Too many wrong codes on this order. Ask a manager to send the code to the rider (Emergency overrides).'
            : 'Too many wrong codes on this order. A manager has to mark it delivered from Dispatch.',
          423,
        )
      }

      if (!deliveryOtpMatches(order.deliveryOtp, body.otp)) {
        const attempts = slot.attempts
        if (attempts >= 3) {
          // Advice follows the company's switch: with code-only delivery on,
          // the way out is Emergency overrides; off, today's text stands.
          const codeOnlyFlag = await codeOnlyDelivery(prisma, order.concept.tenantId)
          await flagException({
            tenantId: order.concept.tenantId,
            conceptId: order.conceptId,
            kind: 'lost_package',
            severity: 'high',
            title: `OTP failed 3+ times on order ${orderRefOf(order.id)}`,
            description: codeOnlyFlag
              ? `${attempts} wrong hand-over codes were entered on this delivery. The customer may be disputing it, `
                + 'or the rider may be at the wrong door. Call the customer before anything else; if they really cannot give the code, '
                + 'a manager can send it to the rider (Emergency overrides) or log the food as returned.'
              : `Rider attempted delivery hand-off ${attempts} times without correct OTP. Either customer dispute or rider attempting to deliver to wrong recipient. Investigate before marking delivered.`,
            entityType: 'Order',
            entityId: order.id,
            actorId: order.riderId ?? req.staffUser!.id,
            amountCents: order.totalCents,
            metadata: { attempts, customerId: order.customerId, customerName: order.customerName },
          })
        }
        const left = Math.max(0, DELIVERY_OTP_MAX_ATTEMPTS - attempts)
        throw new AppError(
          'OTP_MISMATCH',
          `Wrong code (attempt ${attempts} of ${DELIVERY_OTP_MAX_ATTEMPTS}). Ask the customer to re-read the code.`,
          403,
          { attemptsLeft: left },
        )
      }

      // OTP matched — the drop-off is proven. The slot goes back (a clean
      // hand-over is not a failed attempt), and it goes through the one
      // "delivered" rule (dispatch/service markDelivered): stamps the OTP
      // verification and the drop-off, frees the rider, and completes the
      // order through the one completion routine (decision 8). It used to
      // write status 'completed' directly — no ledger entry, no tax invoice,
      // no FBR/SRB filing, no loyalty earn, no rollups.
      await releaseHandoverAttempt(order.id)
      await markDelivered(order.id, {
        otpVerified: true,
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
      })
      return reply.status(200).send({ verified: true })
    },
  )

  // ════════════════════════════════════════════════════════════════════════
  // 2. PETTY CASH — float boxes, on the books (finance wave B, H1–H3)
  // ════════════════════════════════════════════════════════════════════════
  //
  // Every movement is booked by the one poster (accounting/pettyCashPosting.ts)
  // inside its own transaction — a closed month is 422 PERIOD_LOCKED and
  // nothing is saved. Who:
  //   • a cash keeper (CASH_GUARD: manager tiers + finance holding 'accounting')
  //     runs the boxes: open, edit, count, transfer, return cash, reclass a
  //     line, read the tie-out;
  //   • a box's custodian (Jamil sb) and a keeper top it up (a till drawer is
  //     a keeper's source only), spend from it and upload its receipts.

  // GET /trustops/petty-cash/boxes — the keepers' list (CASH_GUARD), each box
  // with its last 10 movements (lines, receipts without their bytes, Booked).
  // ?mine=1 — any staff: the boxes I hold (custodianId = me) in my companies,
  // no movements, no bytes (the custodian's box picker).
  fastify.get<{ Querystring: { mine?: string } }>('/petty-cash/boxes', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    if (req.query.mine === '1' || req.query.mine === 'true') {
      return prisma.pettyCashBox.findMany({
        where: { deletedAt: null, isActive: true, custodianId: req.staffUser!.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true, name: true, tenantId: true, conceptId: true, custodianId: true, floatCents: true, topUpLimitCents: true, isActive: true },
        orderBy: { name: 'asc' },
      })
    }
    await requireCashKeeper(req)
    const boxes = await prisma.pettyCashBox.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      include: {
        movements: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            lines: { orderBy: { createdAt: 'asc' } },
            // Never the bytes in a list (GET /petty-cash/receipts/:id serves one).
            attachments: { select: { id: true, mime: true, sizeBytes: true, kind: true, createdAt: true } },
          },
        },
      },
      orderBy: { name: 'asc' },
    })
    // `ledger`: 'booked' (on the books — journalEntryId), 'no_entry' (a
    // box-to-box transfer or a count with no difference: nothing to book) or
    // 'not_booked' (history the CEO's backfill still has to book).
    const withBooked = boxes.map((b) => ({
      ...b,
      movements: b.movements.map((m) => {
        const noEntry = m.amountCents === 0 || (m.type === 'transfer' && !m.accountCode)
        return { ...m, booked: !!m.journalEntryId, ledger: m.journalEntryId ? 'booked' : noEntry ? 'no_entry' : 'not_booked' }
      }),
    }))
    // The custodian's name rides on the box (names only), so the page does
    // not need the staff-account list (/auth/users) — finance cannot read it.
    return withNames(withBooked, (b) => b.custodianId, 'custodianName')
  })

  // A new box binds to the ACTIVE company. Its opening float is written as a
  // 'topup' movement from the chosen source (Garibsons cashier by default,
  // H1; the safe, a bank of the company, or an open till drawer) through the
  // one movement writer, so the box's history explains its balance and the
  // books carry it from day one. Creation is audited.
  fastify.post('/petty-cash/boxes', { preHandler: CASH_GUARD }, async (req, reply) => {
    const body = z.object({
      name:          z.string().trim().min(1).max(80),
      conceptId:     z.string().uuid().nullable().optional(),
      custodianId:   z.string().uuid(),
      floatCents:    zInt4Cents('The opening float').default(0),
      topUpLimitCents: zInt4Cents('The top-up limit').default(2000000),
      managerOverridePin: z.string().min(4).max(8).optional(),
      openingSource: z.enum(TOPUP_SOURCES).default('garibsons'),
      bankAccountId: z.string().min(1).nullable().optional(),
      shiftId:       z.string().min(1).nullable().optional(),
    }).parse(req.body)
    // A new box binds to the ACTIVE company: its brand must be one of that
    // company's brands and its custodian one of that company's people.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before creating a petty-cash box', 422)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    if (!(await isMemberOf(body.custodianId, tenantId))) {
      throw new AppError('CUSTODIAN_NOT_IN_COMPANY', 'The custodian must be a member of your active company', 422)
    }
    // An opening float above the box's own top-up limit is a top-up over the
    // limit — it needs a manager of this company, like any other (else a
    // big new box + a transfer would load a capped box with no approval).
    let approvedById: string | null = null
    if (body.floatCents > body.topUpLimitCents) {
      const approver = await verifyManagerPin(body.managerOverridePin, tenantId, undefined, {
        actorId: req.staffUser!.id, action: 'petty_cash_topup',
      })
      if (!approver && body.managerOverridePin?.trim()) {
        throw new AppError('INVALID_MANAGER_PIN', 'That PIN does not belong to an active manager of this company', 403)
      }
      if (!approver) {
        throw new AppError('TOPUP_OVER_LIMIT', `An opening float above the box's top-up limit of PKR ${(body.topUpLimitCents / 100).toFixed(0)} needs a manager PIN.`, 403)
      }
      approvedById = approver.id
    }
    const { created, openingMovementId } = await prisma.$transaction(async (tx) => {
      const box = await tx.pettyCashBox.create({
        data: {
          name: body.name, conceptId: body.conceptId ?? null, custodianId: body.custodianId,
          topUpLimitCents: body.topUpLimitCents, floatCents: 0, tenantId,
        },
      })
      let openingMovementId: string | null = null
      if (body.floatCents > 0) {
        const opening = await recordPettyCashTopupTx(tx, {
          box, amountCents: body.floatCents, reason: 'Opening float', createdById: req.staffUser!.id, approvedById,
          source: body.openingSource, bankAccountId: body.bankAccountId ?? null, shiftId: body.shiftId ?? null,
        })
        openingMovementId = opening.movementId
      }
      return { created: await tx.pettyCashBox.findUniqueOrThrow({ where: { id: box.id } }), openingMovementId }
    })
    await audit({ category: 'identity',
      action: 'petty_cash.box_create', entity: 'PettyCashBox', entityId: created.id,
      userId: req.staffUser!.id, tenantId, userEmail: req.staffUser!.email,
      after: {
        name: created.name, conceptId: created.conceptId, custodianId: created.custodianId,
        floatCents: created.floatCents, topUpLimitCents: created.topUpLimitCents,
        openingSource: body.floatCents > 0 ? body.openingSource : null,
      },
      metadata: { ip: req.ip, openingMovementId },
    })
    return reply.status(201).send(created)
  })
  // PATCH /trustops/petty-cash/boxes/:id — rename, change the custodian (a
  // member of the box's company), or set the top-up limit. Raising the limit
  // lets bigger top-ups through without a PIN, so it needs an approver's PIN
  // of the box's company — whoever records it, like a top-up over the limit.
  fastify.patch<{ Params: { id: string } }>('/petty-cash/boxes/:id', { preHandler: CASH_GUARD }, async (req) => {
    const body = z.object({
      name:            z.string().trim().min(1).max(80).optional(),
      custodianId:     z.string().uuid().optional(),
      topUpLimitCents: zInt4Cents('The top-up limit').optional(),
      managerOverridePin: z.string().min(4).max(8).optional(),
    }).parse(req.body ?? {})
    const box = await findBoxInScope(req, req.params.id)
    const data: { name?: string; custodianId?: string; topUpLimitCents?: number } = {}
    if (body.name !== undefined && body.name !== box.name) data.name = body.name
    if (body.custodianId !== undefined && body.custodianId !== box.custodianId) {
      if (!(await isMemberOf(body.custodianId, box.tenantId))) {
        throw new AppError('CUSTODIAN_NOT_IN_COMPANY', 'The custodian must be a member of the box\'s company', 422)
      }
      data.custodianId = body.custodianId
    }
    let approvedById: string | null = null
    if (body.topUpLimitCents !== undefined && body.topUpLimitCents !== box.topUpLimitCents) {
      if (body.topUpLimitCents > box.topUpLimitCents) {
        const approver = await verifyManagerPin(body.managerOverridePin, box.tenantId, undefined, {
          actorId: req.staffUser!.id, action: 'petty_cash_limit',
        })
        if (!approver && body.managerOverridePin?.trim()) {
          throw new AppError('INVALID_MANAGER_PIN', 'That PIN does not belong to an active manager of this company', 403)
        }
        if (!approver) {
          throw new AppError('LIMIT_RAISE_NEEDS_PIN', 'Raising a box\'s top-up limit needs a manager PIN', 403)
        }
        approvedById = approver.id
      }
      data.topUpLimitCents = body.topUpLimitCents
    }
    if (Object.keys(data).length === 0) return box
    const updated = await prisma.pettyCashBox.update({ where: { id: box.id }, data })
    await audit({ category: 'identity',
      action: 'petty_cash.box_update', entity: 'PettyCashBox', entityId: box.id,
      userId: req.staffUser!.id, tenantId: box.tenantId, userEmail: req.staffUser!.email,
      before: Object.fromEntries(Object.keys(data).map((k) => [k, box[k as keyof typeof data]])),
      after: data,
      metadata: { ip: req.ip, approvedById },
    })
    return updated
  })

  // POST /trustops/petty-cash/transfers — move cash from one box to another
  // of the SAME company: two 'transfer' movements with one shared reference,
  // in one transaction, the source's float claimed conditionally. A box of a
  // company the operator does not belong to is 404; two boxes of different
  // companies are 422 BOX_NOT_IN_COMPANY.
  fastify.post('/petty-cash/transfers', { preHandler: CASH_GUARD }, async (req, reply) => {
    const body = z.object({
      fromBoxId:   z.string().min(1),
      toBoxId:     z.string().min(1),
      amountCents: zInt4Cents('The transfer amount', { sign: 'positive' }),
      reason:      z.string().trim().min(1).max(160),
    }).parse(req.body)
    if (body.fromBoxId === body.toBoxId) throw new AppError('SAME_BOX', 'Pick two different boxes', 400)
    const from = await findBoxInScope(req, body.fromBoxId)
    const to = await findBoxInScope(req, body.toBoxId)
    if (from.tenantId !== to.tenantId) {
      throw new AppError('BOX_NOT_IN_COMPANY', 'Both boxes must belong to the same company', 422)
    }
    if (from.floatCents < body.amountCents) throw insufficientFloatError(body.amountCents, from.floatCents)
    const result = await prisma.$transaction((tx) => recordPettyCashTransferTx(tx, {
      fromBox: from, toBox: to, amountCents: body.amountCents, reason: body.reason, createdById: req.staffUser!.id,
    }))
    await audit({ category: 'identity',
      action: 'petty_cash.transfer', entity: 'PettyCashBox', entityId: from.id,
      userId: req.staffUser!.id, tenantId: from.tenantId, userEmail: req.staffUser!.email,
      after: { ref: result.ref, from: from.name, to: to.name, amountCents: body.amountCents, reason: body.reason },
      metadata: { ip: req.ip, toBoxId: to.id, outMovementId: result.out.id, inMovementId: result.in.id },
    })
    return reply.status(201).send({
      ref: result.ref,
      out: result.out,
      in: result.in,
      fromFloatCents: result.fromFloatCents,
      toFloatCents: result.toFloatCents,
    })
  })

  // POST /trustops/petty-cash/movements — a top-up or a spend. Nothing else:
  // a count goes through /boxes/:id/reconcile, box-to-box through /transfers,
  // cash handed back through /returns.
  //   • Top-up: a cash keeper or the box's custodian; `source` is required
  //     (400 TOPUP_SOURCE_REQUIRED): garibsons | safe | bank (bankAccountId, a
  //     live linked bank of the BOX's company) | till (shiftId, an open drawer
  //     of the box's company — keepers only). Above the box's limit an
  //     approver's PIN of the box's company.
  //   • Spend: a cash keeper or the box's custodian (403 SPEND_NOT_ALLOWED).
  //     What it was for: a supplier bill (supplierBillId — recorded as that
  //     bill's cash SupplierPayment), or expense lines (`lines`, or the
  //     one-line shorthand categoryKey / accountCode — an explicit 6xxx code
  //     is a keeper's only). Receipt photos (receiptIds, ≤ 5, uploaded through
  //     POST /petty-cash/receipts for this box) above the company's photo
  //     threshold (400 PHOTO_REQUIRED).
  // Booked in the same transaction (accounting/pettyCashPosting.ts).
  fastify.post('/petty-cash/movements', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      boxId:        z.string().min(1),
      type:         z.enum(['topup', 'spend']),
      amountCents:  zInt4Cents('The amount', { sign: 'positive' }),
      reason:       z.string().trim().min(1).max(200),
      // Top-up
      source:        z.enum(TOPUP_SOURCES).optional(),
      bankAccountId: z.string().min(1).nullable().optional(),
      shiftId:       z.string().min(1).nullable().optional(),
      managerOverridePin: z.string().min(4).max(8).optional(),
      // Spend
      categoryKey:  z.string().trim().min(1).max(40).nullable().optional(),
      accountCode:  z.string().trim().min(1).max(10).nullable().optional(),
      lines:        z.array(SPEND_LINE).min(1).max(20).optional(),
      conceptId:    z.string().min(1).nullable().optional(),
      receiptIds:   z.array(z.string().min(1)).max(5).optional(),
      receiptUrl:   z.string().url().nullable().optional(),
      vendorName:   z.string().max(120).nullable().optional(),
      // Spend only: the supplier bill this cash pays. The spend is then
      // recorded as that bill's SupplierPayment (method 'cash') — the one
      // ledger-backed way to hand a vendor cash (Dr 2010 AP / Cr 1010, plus
      // Dr 1010 / Cr 1011 here) — so a bill already booked through AP is
      // never expensed a second time.
      supplierBillId: z.string().uuid().nullable().optional(),
    }).parse(req.body)

    // The box, scoped: a box of a company the operator doesn't belong to is 404.
    // Everything below (thresholds, approver, bill, ledger) is the BOX's company.
    const box = await findBoxInScope(req, body.boxId)
    const me = req.staffUser!.id
    const keeper = await passesCashGuard(req)
    const custodian = box.custodianId === me

    if (body.type === 'topup') {
      // Cash goes INTO a box only by a cash keeper or the person who holds it.
      if (!custodian && !keeper) {
        throw new AppError('TOPUP_NOT_ALLOWED', 'Only a manager, finance or this box\'s custodian can top it up', 403)
      }
      if (!body.source) {
        throw new AppError('TOPUP_SOURCE_REQUIRED', 'Say where the cash came from: the Garibsons cashier, the safe, a bank account or a till drawer', 400)
      }
      if (body.source === 'till' && !keeper) {
        throw new AppError('TILL_TOPUP_NOT_ALLOWED', 'Only a manager or finance can take cash from a till drawer into a box', 403)
      }
      if (body.supplierBillId) throw new AppError('BILL_ON_NON_SPEND', 'Only a spend can pay a supplier bill', 400)
      if (body.lines || body.categoryKey || body.accountCode || body.receiptIds?.length) {
        throw new AppError('LINES_ON_TOPUP', 'A top-up has no expense lines or receipts', 400)
      }
    } else if (!custodian && !keeper) {
      throw new AppError('SPEND_NOT_ALLOWED', 'Only a manager, finance or this box\'s custodian can spend from it', 403)
    }

    // The bill must be an open bill of a supplier of the box's company: the
    // cash leaves that company's box, so the payment must post to that
    // company's ledger (postSupplierPayment resolves it from the supplier).
    let bill: { id: string; supplierId: string; billNumber: string; supplierName: string } | null = null
    if (body.supplierBillId) {
      if (body.lines?.some((l) => l.kind === 'stock')) {
        throw new AppError('STOCK_ON_BILL_SPEND', 'A spend that pays a supplier bill brings no goods in — the bill\'s own delivery did', 422)
      }
      if (body.lines || body.categoryKey || body.accountCode) {
        throw new AppError('LINES_ON_BILL', 'A spend that pays a supplier bill has no expense lines — the bill carries them', 400)
      }
      const found = await prisma.supplierBill.findFirst({
        where: { id: body.supplierBillId, supplier: { tenantId: box.tenantId } },
        select: { id: true, supplierId: true, billNumber: true, status: true, kind: true, totalCents: true, whtCents: true, paidCents: true, creditedCents: true, supplier: { select: { name: true } } },
      })
      if (!found) throw new AppError('BILL_NOT_IN_COMPANY', 'That supplier bill is not one of this box\'s company\'s', 422)
      if (found.kind !== 'bill') throw new AppError('NOT_A_BILL', 'That is a credit note, not a bill', 422)
      if (found.status === 'void' || found.status === 'paid') throw new AppError('BILL_NOT_OPEN', `Bill ${found.billNumber} is ${found.status}`, 422)
      // Net of withholding — the one "still due" rule (procurement billDueCents).
      const { billDueCents } = await import('../procurement/service.js')
      const due = billDueCents(found)
      if (body.amountCents > due) {
        throw new AppError('OVER_APPLIED', `Only ${due} is still due on bill ${found.billNumber}`, 400)
      }
      bill = { id: found.id, supplierId: found.supplierId, billNumber: found.billNumber, supplierName: found.supplier.name }
    }

    // The expense lines of a spend that pays no bill.
    let lines: SpendLineInput[] | undefined
    if (body.type === 'spend' && !bill) {
      lines = body.lines ?? ((body.categoryKey || body.accountCode)
        ? [{ categoryKey: body.categoryKey ?? null, accountCode: body.accountCode ?? null, amountCents: body.amountCents, conceptId: body.conceptId ?? null, description: body.reason }]
        : undefined)
      if (!lines) throw new AppError('SPEND_CATEGORY_REQUIRED', 'Say what the spend was for — pick a category', 400)
    }

    const { getOperationsConfig } = await import('../../lib/setup-config.js')
    const ops = await getOperationsConfig(box.tenantId)
    const photoThreshold = ops?.photoRequiredAboveCents ?? 50000
    const amount = body.amountCents

    // Receipt photo enforcement on spend
    const receiptIds = [...new Set(body.receiptIds ?? [])]
    if (body.type === 'spend' && amount >= photoThreshold && receiptIds.length === 0 && !body.receiptUrl) {
      throw new AppError(
        'PHOTO_REQUIRED',
        `Spend above PKR ${(photoThreshold / 100).toFixed(0)} requires a receipt photo.`,
        400,
      )
    }
    if (receiptIds.length > 0) await assertReceiptsFree(box, receiptIds)

    // Top-up limit — above limit requires manager PIN
    let approvedById: string | null = null
    if (body.type === 'topup' && amount > box.topUpLimitCents) {
      // Only an approver of the box's own company may lift its limit.
      const approver = await verifyManagerPin(body.managerOverridePin, box.tenantId, undefined, {
        actorId: me, action: 'petty_cash_topup',
      })
      // A PIN was sent and did not verify (wrong, or not a manager of the
      // box's company): say so, the way every till override does — "PIN
      // required" would read as if none had been entered.
      if (!approver && body.managerOverridePin?.trim()) {
        throw new AppError('INVALID_MANAGER_PIN', 'That PIN does not belong to an active manager of this company', 403)
      }
      if (!approver) {
        throw new AppError(
          'TOPUP_OVER_LIMIT',
          `Top-up of PKR ${(amount / 100).toFixed(0)} exceeds box limit of PKR ${(box.topUpLimitCents / 100).toFixed(0)}. Manager PIN required.`,
          403,
        )
      }
      approvedById = approver.id
    }

    // Sign convention: topup positive, spend negative
    const signedAmount = body.type === 'topup' ? amount : -amount

    // Fast refusal before anything is written (a bill payment included). The
    // authoritative check is the conditional float update inside the
    // transaction (pettyCash.ts).
    if (box.floatCents + signedAmount < 0) throw insufficientFloatError(amount, box.floatCents)

    // Stock lines land on FIFO lots: the company's cut-over runs BEFORE the
    // spend's transaction (it opens its own); the writer re-checks as a fallback.
    if (lines?.some((l) => l.kind === 'stock')) await (await import('../../lib/stockLedger.js')).ensureFifoReady(box.tenantId)

    const { movement, supplierPaymentId, newFloatCents, overrides } = await prisma.$transaction(async (tx) => {
      let supplierPaymentId: string | null = null
      if (bill) {
        const { createPaymentTx } = await import('../procurement/service.js')
        const payment = await createPaymentTx(tx, {
          supplierId: bill.supplierId,
          paymentDate: new Date().toISOString(),
          method: 'cash',
          reference: `petty cash: ${box.name}`,
          amountCents: amount,
          notes: body.reason,
          applications: [{ billId: bill.id, amountAppliedCents: amount }],
          createdBy: me,
        })
        supplierPaymentId = payment.id
      }
      // Both go through the one movement writer (pettyCash.ts), which books it.
      if (body.type === 'spend') {
        const done = await recordPettyCashSpendTx(tx, {
          box,
          amountCents: amount,
          reason: body.reason,
          receiptUrl: body.receiptUrl ?? null,
          vendorName: body.vendorName ?? bill?.supplierName ?? null,
          approvedById,
          supplierPaymentId,
          createdById: me,
          nature: bill ? 'bill' : 'expense',
          lines,
          conceptId: body.conceptId ?? null,
          actor: { id: me, role: req.staffUser!.role },
          allowExplicit: keeper,
        })
        if (receiptIds.length > 0) await linkReceiptsTx(tx, box.id, receiptIds, done.movementId)
        return { movement: done.movement, supplierPaymentId, newFloatCents: done.newFloatCents, overrides: done.lines.filter((l) => l.equipmentOverride) }
      }
      const done = await recordPettyCashTopupTx(tx, {
        box,
        amountCents: amount,
        reason: body.reason,
        receiptUrl: body.receiptUrl ?? null,
        vendorName: body.vendorName ?? null,
        approvedById,
        createdById: me,
        source: body.source!,
        bankAccountId: body.bankAccountId ?? null,
        shiftId: body.shiftId ?? null,
      })
      return { movement: done.movement, supplierPaymentId, newFloatCents: done.newFloatCents, overrides: [] }
    }, { timeout: 20_000, maxWait: 10_000 })

    await audit({ category: 'identity',
      action: `petty_cash.${body.type}`,
      entity: 'PettyCashMovement',
      entityId: movement.id,
      userId: me, tenantId: box.tenantId,
      userEmail: req.staffUser!.email,
      after: {
        box: box.name, amount: signedAmount, reason: body.reason, supplierBillId: bill?.id ?? null,
        source: movement.source, accountCode: movement.accountCode, journalEntryId: movement.journalEntryId,
      },
      metadata: { ip: req.ip, approvedById, supplierPaymentId, receiptIds, cashMovementId: movement.cashMovementId },
    })
    await flagEquipmentOverrides(req, box, movement.id, overrides)

    return reply.status(201).send({ movement, newFloatCents, booked: !!movement.journalEntryId })
  })

  // POST /trustops/petty-cash/returns — cash handed back OUT of a box: to the
  // safe (Dr 1010), a bank of the box's company (Dr its code) or the Garibsons
  // cashier (Dr 2210) / Cr 1011. Cash keepers only.
  fastify.post('/petty-cash/returns', { preHandler: CASH_GUARD }, async (req, reply) => {
    const body = z.object({
      boxId:         z.string().min(1),
      amountCents:   zInt4Cents('The amount', { sign: 'positive' }),
      destination:   z.enum(['safe', 'bank', 'garibsons']),
      bankAccountId: z.string().min(1).nullable().optional(),
      reason:        z.string().trim().min(1).max(200),
    }).parse(req.body)
    const box = await findBoxInScope(req, body.boxId)
    if (box.floatCents < body.amountCents) throw insufficientFloatError(body.amountCents, box.floatCents)
    const done = await prisma.$transaction((tx) => recordPettyCashReturnTx(tx, {
      boxId: box.id, amountCents: body.amountCents, destination: body.destination,
      bankAccountId: body.bankAccountId ?? null, reason: body.reason, actorId: req.staffUser!.id,
    }))
    await audit({ category: 'identity',
      action: 'petty_cash.return', entity: 'PettyCashMovement', entityId: done.movementId,
      userId: req.staffUser!.id, tenantId: box.tenantId, userEmail: req.staffUser!.email,
      after: { box: box.name, amount: -body.amountCents, destination: body.destination, accountCode: done.movement.accountCode, reason: body.reason },
      metadata: { ip: req.ip, bankAccountId: done.movement.bankAccountId },
    })
    return reply.status(201).send({ movement: done.movement, newFloatCents: done.newFloatCents, booked: !!done.movement.journalEntryId })
  })

  // POST /trustops/petty-cash/boxes/:id/reconcile — record a physical count:
  // the variance against the float becomes a 'reconcile' movement (the one
  // movement writer, pettyCash.ts), booked to 8010 (short Dr 8010 / Cr 1011,
  // over the other way), and the float becomes the count.
  // movement writer, pettyCash.ts) and the float becomes the count.
  fastify.post<{ Params: { id: string } }>('/petty-cash/boxes/:id/reconcile',
    { preHandler: CASH_GUARD },
    async (req, reply) => {
      const body = z.object({ countedCents: zInt4Cents('The counted cash'), notes: z.string().max(500).optional() }).parse(req.body)
      const scoped = await findBoxInScope(req, req.params.id)
      // The variance is against the float AS LOCKED, so a spend or voucher
      // payment landing during the count is never folded into the variance.
      const { movement, box, varianceCents: variance } = await prisma.$transaction((tx) => recordPettyCashCountTx(tx, {
        boxId: scoped.id, countedCents: body.countedCents, notes: body.notes ?? null, createdById: req.staffUser!.id,
      }))
      await audit({ category: 'identity',
        action: 'petty_cash.reconcile', entity: 'PettyCashMovement', entityId: movement.id,
        userId: req.staffUser!.id, tenantId: scoped.tenantId, userEmail: req.staffUser!.email,
        before: { floatCents: box.floatCents },
        after: { box: box.name, countedCents: body.countedCents, varianceCents: variance },
        metadata: { ip: req.ip },
      })

      // Variance flag — beyond the box's company's cash tolerance
      // (Configuration → Receipts, the same limit the till drawers use).
      const limit = await cashVarianceLimitCents(scoped.tenantId)
      if (Math.abs(variance) > limit) {
        await flagException({
          tenantId: scoped.tenantId,
          conceptId: box.conceptId,
          kind: 'cash_variance',
          severity: Math.abs(variance) > 50000 ? 'high' : 'medium',
          title: `Petty cash variance: ${variance >= 0 ? '+' : ''}PKR ${(variance / 100).toFixed(0)}`,
          description: `${box.name} reconciled with PKR ${(variance / 100).toFixed(0)} ${variance >= 0 ? 'over' : 'short'}. System said ${(box.floatCents / 100).toFixed(0)}, counted ${(body.countedCents / 100).toFixed(0)}.`,
          entityType: 'PettyCashBox',
          entityId: box.id,
          actorId: req.staffUser!.id,
          amountCents: Math.abs(variance),
          metadata: { systemFloat: box.floatCents, counted: body.countedCents, variance },
        })
      }

      return reply.status(200).send({ movement, varianceCents: variance })
    },
  )

  // ── Receipts of direct box spends (CashVoucherAttachment kind 'receipt',
  //    boxId = the box, company = the box's). Bytes in the DB, checked by
  //    lib/evidenceFile.ts (JPEG / PNG / WebP / PDF, magic bytes, ≤ 3 MB).

  // POST /trustops/petty-cash/receipts — the box's custodian or a keeper.
  fastify.post('/petty-cash/receipts', { preHandler: requireAuth(...ALL_STAFF), bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const body = z.object({
      boxId: z.string().min(1),
      photo: z.string().min(1),
      mime:  z.string().min(1).max(40),
    }).parse(req.body)
    const box = await findBoxInScope(req, body.boxId)
    if (box.custodianId !== req.staffUser!.id && !(await passesCashGuard(req))) {
      throw new AppError('RECEIPT_NOT_ALLOWED', 'Only this box\'s custodian, a manager or finance can add its receipts', 403)
    }
    const file = decodeEvidenceFile(body.photo, body.mime, { allowPdf: true })
    const row = await prisma.cashVoucherAttachment.create({
      data: {
        tenantId: box.tenantId, boxId: box.id, kind: 'receipt', mime: file.mime, sizeBytes: file.sizeBytes,
        data: file.bytes, uploadedById: req.staffUser!.id,
      },
      select: { id: true, mime: true, sizeBytes: true, createdAt: true },
    })
    return reply.status(201).send(row)
  })

  // GET /trustops/petty-cash/receipts/:id — the bytes, inline (private,
  // no-store, nosniff): a keeper, the box's custodian or the uploader.
  fastify.get<{ Params: { id: string } }>('/petty-cash/receipts/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const att = await findReceiptInScope(req, req.params.id)
    const box = await prisma.pettyCashBox.findUnique({ where: { id: att.boxId }, select: { custodianId: true } })
    const me = req.staffUser!.id
    if (box?.custodianId !== me && att.uploadedById !== me && !(await passesCashGuard(req))) {
      throw new AppError('RECEIPT_NOT_ALLOWED', 'Only this box\'s custodian, a manager or finance can see its receipts', 403)
    }
    const full = await prisma.cashVoucherAttachment.findUniqueOrThrow({ where: { id: att.id }, select: { mime: true, data: true } })
    return sendEvidence(reply, full, `petty-cash-receipt-${att.id.slice(0, 8)}`)
  })

  // DELETE /trustops/petty-cash/receipts/:id — the uploader or a keeper, and
  // only while it is on no spend (409 RECEIPT_IN_USE).
  fastify.delete<{ Params: { id: string } }>('/petty-cash/receipts/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const att = await findReceiptInScope(req, req.params.id)
    if (att.uploadedById !== req.staffUser!.id && !(await passesCashGuard(req))) {
      throw new AppError('RECEIPT_NOT_ALLOWED', 'Only the person who added this receipt, a manager or finance can remove it', 403)
    }
    const gone = await prisma.cashVoucherAttachment.deleteMany({
      where: { id: att.id, kind: 'receipt', movementId: null, settlementId: null, voucherId: null },
    })
    if (gone.count === 0) throw new AppError('RECEIPT_IN_USE', 'This receipt is on a recorded spend — it cannot be removed', 409)
    return reply.status(204).send()
  })

  // PATCH /trustops/petty-cash/movements/:id/lines/:lineId — finance moves an
  // expense line to another account (a category or an explicit 6xxx). The
  // ledger keeps ONE live entry: the old one is reversed today and the spend
  // reposted on its own date (422 PERIOD_LOCKED when that month is closed).
  fastify.patch<{ Params: { id: string; lineId: string } }>('/petty-cash/movements/:id/lines/:lineId', { preHandler: CASH_GUARD }, async (req) => {
    const body = z.object({
      categoryKey: z.string().trim().min(1).max(40).nullable().optional(),
      accountCode: z.string().trim().min(1).max(10).nullable().optional(),
      notEquipment: z.boolean().optional(),
      notEquipmentReason: z.string().max(500).nullable().optional(),
    }).parse(req.body ?? {})
    const movement = await prisma.pettyCashMovement.findFirst({
      where: { id: req.params.id, box: await scopeTenantWhere(req, 'write') },
      select: { id: true, boxId: true, cashVoucherId: true, box: { select: { tenantId: true, name: true, conceptId: true } } },
    })
    if (!movement || !movement.box.tenantId) throw new NotFoundError('PettyCashMovement', req.params.id)
    const tenantId = movement.box.tenantId
    // The cash request this spend paid, if any: its row is locked before the
    // box below (cash-pay-reclass-race) — the same request → box order as the
    // pay and the return-change — so a settlement or change that read this
    // pay's account cannot commit alongside a reclass that moves it
    // (CASH_REQUEST_PAID_FIXED then reads committed counters).
    const voucherIds = (await prisma.cashVoucher.findMany({
      where: { tenantId, OR: [{ pettyCashMovementId: movement.id }, ...(movement.cashVoucherId ? [{ id: movement.cashVoucherId }] : [])] },
      select: { id: true },
    })).map((v) => v.id).sort()
    const line = await prisma.pettyCashSpendLine.findFirst({ where: { id: req.params.lineId, movementId: movement.id, tenantId } })
    if (!line) throw new NotFoundError('PettyCashSpendLine', req.params.lineId)
    if (line.kind !== 'expense') {
      throw new AppError('STOCK_LINE_FIXED', 'Only an expense line can be moved to another account — stock and CapEx lines are fixed by their documents', 409)
    }
    const { resolveSpendAccount } = await import('../accounting/expenseCategories.js')
    const acct = await resolveSpendAccount(prisma, tenantId, { categoryKey: body.categoryKey, accountCode: body.accountCode }, { allowExplicit: true })
    const eq = assertNotEquipmentLine({
      description: line.description, expenseAccountCode: acct.code, notEquipment: body.notEquipment, notEquipmentReason: body.notEquipmentReason ?? null,
    }, { role: req.staffUser!.role })
    if (acct.code === line.accountCode && acct.categoryKey === line.categoryKey) return { line, entryId: null, outcome: 'unchanged' }
    const result = await prisma.$transaction(async (tx) => {
      for (const id of voucherIds) await tx.$queryRaw`SELECT id FROM cash_vouchers WHERE id = ${id} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM petty_cash_boxes WHERE id = ${movement.boxId} FOR UPDATE`
      const updated = await tx.pettyCashSpendLine.update({ where: { id: line.id }, data: { accountCode: acct.code, categoryKey: acct.categoryKey } })
      const posted = await postPettyCashMovementTx(tx, movement.id, { postedBy: req.staffUser!.id })
      return { line: updated, ...posted }
    })
    await audit({ category: 'accounting',
      action: 'petty_cash.line_reclass', entity: 'PettyCashSpendLine', entityId: line.id,
      userId: req.staffUser!.id, tenantId, userEmail: req.staffUser!.email,
      before: { accountCode: line.accountCode, categoryKey: line.categoryKey },
      after: { accountCode: acct.code, categoryKey: acct.categoryKey },
      metadata: { ip: req.ip, movementId: movement.id, entryId: result.entryId, outcome: result.outcome },
    })
    if (eq.overridden) {
      await flagEquipmentOverrides(req, { tenantId, name: movement.box.name, conceptId: movement.box.conceptId }, movement.id, [{
        accountCode: acct.code, amountCents: line.amountCents, description: line.description, overrideReason: body.notEquipmentReason ?? null,
      }])
    }
    return result
  })

  // GET /trustops/petty-cash/categories — what a box spend can be for: the
  // 'expense' PAYOUT_CATEGORIES (key, label, code). The 'cogs' keys are
  // history-backfill picks only — food, drinks and packaging bought with cash
  // come in as stock lines.
  fastify.get('/petty-cash/categories', { preHandler: requireAuth(...ALL_STAFF) }, async () => ({ categories: EXPENSE_PAYOUT_CATEGORIES }))

  // GET /trustops/petty-cash/open-drawers?boxId= — the open till drawers of
  // the box's company, for a top-up from the till.
  fastify.get<{ Querystring: { boxId?: string } }>('/petty-cash/open-drawers', { preHandler: CASH_GUARD }, async (req) => {
    if (!req.query.boxId) throw new AppError('BOX_REQUIRED', 'Say which box the cash goes into', 400)
    const box = await findBoxInScope(req, req.query.boxId)
    const shifts = await prisma.shift.findMany({
      where: { status: 'open', ...shiftOfCompany({ tenantId: box.tenantId }) },
      select: { id: true, openedAt: true, location: { select: { name: true } }, user: { select: { name: true } } },
      orderBy: { openedAt: 'desc' },
      take: 50,
    })
    return {
      drawers: shifts.map((s) => ({ id: s.id, openedAt: s.openedAt, locationName: s.location?.name ?? null, cashierName: s.user.name })),
    }
  })

  // GET /trustops/petty-cash/tie-out — per company in view: Σ box floats vs
  // 1011, open cash advances vs 1355, movements not yet on the books.
  fastify.get('/petty-cash/tie-out', { preHandler: CASH_GUARD }, async (req) => {
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) return { companies: [] }
    const rows = await pettyCashTieOut(scope.tenantIds)
    const tenants = await prisma.tenant.findMany({ where: { id: { in: scope.tenantIds } }, select: { id: true, name: true } })
    const nameOf = new Map(tenants.map((t) => [t.id, t.name]))
    return { companies: rows.map((r) => ({ ...r, tenantName: nameOf.get(r.tenantId) ?? null })) }
  })

  // ════════════════════════════════════════════════════════════════════════
  // 2b. CASH VOUCHERS — /trustops/cash-vouchers (cashVouchers.ts)
  // ════════════════════════════════════════════════════════════════════════
  // Cash requests (H3): anyone raises, the HOD signs, the director approves,
  // the box's custodian pays — ONE petty-cash spend through
  // recordPettyCashSpendTx, booked to the request's category (Dr 6xxx /
  // Cr 1011) at payment. Receipts book nothing; settlements reclass out of
  // the paid account (cashRequestSettle.ts).
  await fastify.register(cashVoucherRoutes, { prefix: '/cash-vouchers' })

  // ════════════════════════════════════════════════════════════════════════
  // 3. DEPOSIT DROP — cash to bank
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/deposit-drops', { preHandler: CASH_GUARD }, async (req) => {
    const { conceptId } = req.query as { conceptId?: string }
    const rows = await prisma.depositDrop.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        ...(conceptId ? await conceptWhere(req, conceptId, 'read') : {}),
      },
      orderBy: { droppedAt: 'desc' },
      take: 100,
    })
    // Each drop is judged by its own company's cash tolerance — clients show
    // `withinTolerance` instead of hard-coding a threshold.
    const limits = new Map<string | null, number>()
    const out = []
    for (const r of rows) {
      if (!limits.has(r.tenantId)) limits.set(r.tenantId, await cashVarianceLimitCents(r.tenantId))
      const varianceLimitCents = limits.get(r.tenantId)!
      out.push({ ...r, varianceLimitCents, withinTolerance: Math.abs(r.varianceCents) <= varianceLimitCents })
    }
    return out
  })

  // Record cash taken to the bank. Expected = the shift's drops plus its
  // counted close less the float kept in the drawer (accounting/
  // depositPosting.ts); the drop posts Dr <bank's code> / Cr the cash
  // accounts it came from, so the bank statement can match it.
  //
  // The bank is resolved by the one resolver (lib/bankAccounts.ts
  // moneyAccountCode, method 'bank'): a named account must be a live, linked
  // account of the active company (422); none named = the company's only bank,
  // 1020 when it has none, 422 BANK_ACCOUNT_REQUIRED when it has two or more.
  // The posting is AWAITED: the drop is the fact of record and stays saved,
  // but a posting the ledger refused (a closed period, a missing account)
  // raises a posting_failed flag in the drop's company for the re-poster —
  // it used to be fire-and-forget with only a log line.
  //
  // The bank's deposit slip # (`slipNumber`, owner 2026-10-14) is stored, put
  // in the posting's description and memos, and checked against the
  // company's other payment references: a slip # used before answers
  // `referenceUsedBefore` — a warning, never a refusal (lib/paymentRefs.ts).
  // A drop has no separate "banked" step, so the slip # is optional here; the
  // list shows it next to the bag serial and flags a drop without one.
  fastify.post('/deposit-drops', { preHandler: CASH_GUARD }, async (req, reply) => {
    const body = z.object({
      shiftId:       z.string().uuid().nullable().optional(),
      conceptId:     z.string().uuid().nullable().optional(),
      bankAccountId: z.string().min(1).nullable().optional(),
      amountCents:   zInt4Cents('The deposit'),
      bagSerial:     z.string().max(80).nullable().optional(),
      slipNumber:    zPaymentRef.nullable().optional(),
      receiptUrl:    z.string().url().nullable().optional(),
      witnessedById: z.string().uuid().nullable().optional(),
      notes:         z.string().max(500).nullable().optional(),
    }).parse(req.body)

    // A deposit is a NEW row: it binds to the active company, and everything
    // it points at must be that company's own (foreign → 422, never a peek
    // at another company's shift cash).
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before recording a deposit', 422)
    if (body.shiftId) await assertShiftOf(tenantId, body.shiftId, false)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    const bank = await moneyAccountCode(prisma, tenantId, { method: 'bank', bankAccountId: body.bankAccountId ?? null })

    const { expectedShiftDeposit, postDepositDrop } = await import('../accounting/depositPosting.js')
    const expected = body.shiftId ? (await expectedShiftDeposit(body.shiftId)).expectedCents : 0
    const variance = body.amountCents - expected

    const drop = await prisma.depositDrop.create({
      data: {
        ...body,
        tenantId,
        shiftId: body.shiftId ?? null,
        conceptId: body.conceptId ?? null,
        bankAccountId: bank.bankAccountId,
        bagSerial: body.bagSerial ?? null,
        slipNumber: body.slipNumber || null,
        receiptUrl: body.receiptUrl ?? null,
        witnessedById: body.witnessedById ?? null,
        notes: body.notes ?? null,
        expectedCents: expected,
        varianceCents: variance,
        droppedById: req.staffUser!.id,
      },
    })

    // Awaited; a refusal is flagged, never swallowed. no_amount (a PKR 0
    // drop) and deposit_has_no_company are not postings that failed.
    let posted = false
    let postingError: string | null = null
    try {
      const r = await postDepositDrop(drop.id)
      posted = r.posted || (!r.reason && !!r.entryId)
      if (!r.posted && r.reason && r.reason !== 'no_amount' && r.reason !== 'deposit_has_no_company') postingError = r.reason
    } catch (err) {
      postingError = (err as Error).message || 'posting failed'
    }
    if (postingError) {
      req.log.error({ dropId: drop.id, reason: postingError }, 'deposit drop not posted')
      const { flagPostingFailed } = await import('../accounting/journal.js')
      await flagPostingFailed({
        tenantId: drop.tenantId,
        sourceType: 'deposit.drop',
        sourceId: drop.id,
        entityType: 'DepositDrop',
        entityId: drop.id,
        reason: postingError,
        title: `Bank deposit of PKR ${(drop.amountCents / 100).toFixed(0)} is not in the books`,
        conceptId: drop.conceptId,
        amountCents: drop.amountCents,
      })
    }

    // Beyond the company's cash tolerance fires a cash-variance flag
    // (a different entity than the till variance).
    const limit = await cashVarianceLimitCents(tenantId)
    if (Math.abs(variance) > limit && expected > 0) {
      await flagException({
        tenantId,
        conceptId: body.conceptId ?? null,
        kind: 'cash_variance',
        severity: Math.abs(variance) > 100000 ? 'high' : 'medium',
        title: `Deposit drop variance: ${variance >= 0 ? '+' : ''}PKR ${(variance / 100).toFixed(0)}`,
        description: `Expected PKR ${(expected / 100).toFixed(0)} from the shift (drops + counted close − float kept), deposited PKR ${(body.amountCents / 100).toFixed(0)}. ${variance < 0 ? 'Cash short — investigate till handover.' : 'Cash over — check shift records.'}`,
        entityType: 'DepositDrop',
        entityId: drop.id,
        actorId: req.staffUser!.id,
        amountCents: Math.abs(variance),
        metadata: { expected, deposited: body.amountCents, variance, limitCents: limit, shiftId: body.shiftId, bagSerial: body.bagSerial },
      })
    }

    // Also flag when receipt photo missing on a meaningful drop
    if (body.amountCents >= 100000 && !body.receiptUrl) {
      await flagException({
        tenantId,
        conceptId: body.conceptId ?? null,
        kind: 'cash_variance',
        severity: 'medium',
        title: `Deposit drop without bank receipt`,
        description: `PKR ${(body.amountCents / 100).toFixed(0)} dropped to bank but no teller-receipt photo attached. Without proof we can't reconcile this drop on the bank statement.`,
        entityType: 'DepositDrop',
        entityId: drop.id,
        actorId: req.staffUser!.id,
        amountCents: body.amountCents,
      })
    }

    const referenceUsedBefore = await findPaymentReferenceUses(prisma, tenantId, drop.slipNumber, { exclude: { kind: 'deposit_drop', id: drop.id } })
    return reply.status(201).send({ ...drop, posted, postingError, referenceUsedBefore })
  })

  // ════════════════════════════════════════════════════════════════════════
  // 4. STAFF MEAL — cap + flag
  // ════════════════════════════════════════════════════════════════════════

  // Scoped to the operator's companies (view-aware). A client conceptId is
  // checked (foreign → 404); without one, brand-tagged meals are narrowed to
  // the brands in scope and brand-less meals to their company by the
  // mealCompanies precedence chain — never "every company's meals".
  fastify.get('/staff-meals', { preHandler: MEAL_GUARD }, async (req) => {
    const { conceptId, days } = req.query as { conceptId?: string; days?: string }
    const d = Math.min(Math.max(parseInt(days ?? '30', 10) || 30, 1), 366)
    const since = new Date(Date.now() - d * 86400_000)
    if (conceptId) {
      const meals = await prisma.staffMeal.findMany({
        where: { consumedAt: { gte: since }, ...(await conceptWhere(req, conceptId, 'read')) },
        orderBy: { consumedAt: 'desc' },
        take: 200,
      })
      return withNames(meals, (m) => m.staffId, 'staffName')
    }
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) return []
    const inScope = new Set(scope.tenantIds)
    const rows = await prisma.staffMeal.findMany({
      where: {
        consumedAt: { gte: since },
        OR: [{ conceptId: { in: await conceptIdsInScope(req, 'read') } }, { conceptId: null }],
      },
      orderBy: { consumedAt: 'desc' },
      take: 1000,
    })
    const brandless = rows.filter((m) => !m.conceptId)
    const company = await mealCompanies(brandless)
    const visible = rows
      .filter((m) => m.conceptId || inScope.has(company.get(m.id) ?? ''))
      .slice(0, 200)
    // Who ate (names only) — so the log reads without the staff-account list.
    return withNames(visible, (m) => m.staffId, 'staffName')
  })

  // POST /trustops/staff-meals — retired (owner decision 11). A staff meal is
  // rung through the till and comped in full with a manager PIN: POST
  // /pos/orders/:orderId/comp with { staffMealFor: <staff user id> }. That
  // takes the stock out through the normal order path, books the food cost
  // on the drawer's close, and writes the staff-meal row this log lists (with
  // the weekly cap flag). A hand-typed meal with an estimated cost did none
  // of that — the food left the kitchen with no stock movement and no cost.
  fastify.post('/staff-meals', { preHandler: requireAuth(...ALL_STAFF) }, async (_req, reply) => {
    return reply.status(410).send({
      error: {
        code: 'USE_TILL_STAFF_MEAL',
        message: 'Ring the staff meal up at the till and comp it as a staff meal (POST /pos/orders/:orderId/comp with staffMealFor).',
      },
    })
  })
}
