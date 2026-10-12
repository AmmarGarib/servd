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
import { requireAuth, ALL_STAFF, ADMIN_ONLY, FINANCE_TEAM, HR_TEAM } from '../auth/middleware.js'
import { flagException } from '../../lib/exceptions.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import type { FastifyRequest } from 'fastify'
import {
  scopeTenantWhere, conceptWhere, assertConceptOwned, assertShiftOf, conceptIdsInScope, resolveTenantScope,
  SHIFT_COMPANY_INCLUDE, shiftTenantId,
} from '../../lib/tenantScope.js'
import { cashVarianceLimitCents } from '../../lib/drawer.js'
import { generateDeliveryOtp, deliveryOtpMatches, DELIVERY_OTP_READERS, DELIVERY_OTP_MAX_ATTEMPTS } from '../../lib/deliveryOtp.js'
import type { UserRole } from '@prisma/client'
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
const CASH_KEEPERS = FINANCE_TEAM
const MEAL_READERS = HR_TEAM
// /trustops is not a central module-gated prefix (and must not be wholesale:
// /petty-cash/movements is ALL_STAFF), so the roles newly let in must also
// hold the module whose page this is — finance 'accounting', HR
// 'staff_directory' — or the CEO's Module Access untick closes nothing
// (W3B-RV-1). The deposit-drop POST posts Dr bank / Cr cash. Manager tiers
// pass exactly as before.
const CASH_GUARD = [requireAuth(...CASH_KEEPERS), moduleGateForNewRoles(['accounting'])]
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

export async function trustopsRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // 1. RIDER OTP — generate on order, verify on dispatch
  // ════════════════════════════════════════════════════════════════════════

  // GET /trustops/orders/:id/otp — support read of the hand-over code.
  // admin / management ONLY (docs/rider-app.md): anyone who can read the code
  // can "deliver" without going to the door. The customer gets their own code
  // from GET /storefront/orders/:id and on WhatsApp at pick-up.
  fastify.get<{ Params: { id: string } }>(
    '/orders/:id/otp',
    { preHandler: requireAuth(...(DELIVERY_OTP_READERS as UserRole[])) },
    async (req) => {
      // Scoped through the order's brand → company: a foreign order is 404.
      const order = await findOrderInScope(req, req.params.id, { id: true, deliveryOtp: true, source: true, status: true })
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
  // — a manager completes a locked order through /dispatch/orders/:id/delivered.
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
        throw new AppError(
          'OTP_LOCKED',
          'Too many wrong codes on this order. A manager has to mark it delivered from Dispatch.',
          423,
        )
      }

      if (!deliveryOtpMatches(order.deliveryOtp, body.otp)) {
        const attempts = slot.attempts
        if (attempts >= 3) {
          await flagException({
            tenantId: order.concept.tenantId,
            conceptId: order.conceptId,
            kind: 'lost_package',
            severity: 'high',
            title: `OTP failed 3+ times on order ${orderRefOf(order.id)}`,
            description: `Rider attempted delivery hand-off ${attempts} times without correct OTP. Either customer dispute or rider attempting to deliver to wrong recipient. Investigate before marking delivered.`,
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
  // 2. PETTY CASH — float boxes
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/petty-cash/boxes', { preHandler: CASH_GUARD }, async (req) => {
    const boxes = await prisma.pettyCashBox.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      include: {
        movements: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: { name: 'asc' },
    })
    // The custodian's name rides on the box (names only), so the page does
    // not need the staff-account list (/auth/users) — finance cannot read it.
    return withNames(boxes, (b) => b.custodianId, 'custodianName')
  })

  fastify.post('/petty-cash/boxes', { preHandler: CASH_GUARD }, async (req, reply) => {
    const body = z.object({
      name:          z.string().min(1).max(80),
      conceptId:     z.string().uuid().nullable().optional(),
      custodianId:   z.string().uuid(),
      floatCents:    z.number().int().min(0).default(0),
      topUpLimitCents: z.number().int().min(0).default(2000000),
    }).parse(req.body)
    // A new box binds to the ACTIVE company: its brand must be one of that
    // company's brands and its custodian one of that company's people.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before creating a petty-cash box', 422)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    if (!(await isMemberOf(body.custodianId, tenantId))) {
      throw new AppError('CUSTODIAN_NOT_IN_COMPANY', 'The custodian must be a member of your active company', 422)
    }
    const created = await prisma.pettyCashBox.create({ data: { ...body, conceptId: body.conceptId ?? null, tenantId } })
    return reply.status(201).send(created)
  })

  // POST /trustops/petty-cash/movements — record a top-up or spend.
  // Spend above PKR threshold requires receipt photo. Above box's topUpLimit
  // requires manager PIN. Every movement audit-logged + flagged if suspicious.
  fastify.post('/petty-cash/movements', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      boxId:        z.string().min(1),
      type:         z.enum(['topup', 'spend', 'reconcile', 'transfer']),
      amountCents:  z.number().int(),                                  // signed
      category:     z.string().max(40).nullable().optional(),
      reason:       z.string().min(1).max(200),
      receiptUrl:   z.string().url().nullable().optional(),
      vendorName:   z.string().max(120).nullable().optional(),
      // Spend only: the supplier bill this cash pays. The spend is then
      // recorded as that bill's SupplierPayment (method 'cash') — the one
      // ledger-backed way to hand a vendor cash (Dr 2010 AP / Cr 1010) — so
      // a bill already booked through AP is never expensed a second time.
      supplierBillId: z.string().uuid().nullable().optional(),
      managerOverridePin: z.string().min(4).max(8).optional(),
    }).parse(req.body)

    // The box, scoped: a box of a company the operator doesn't belong to is 404.
    // Everything below (thresholds, approver, bill, ledger) is the BOX's company.
    const box = await findBoxInScope(req, body.boxId)

    // The bill must be an open bill of a supplier of the box's company: the
    // cash leaves that company's box, so the payment must post to that
    // company's ledger (postSupplierPayment resolves it from the supplier).
    let bill: { id: string; supplierId: string; billNumber: string; supplierName: string } | null = null
    if (body.supplierBillId) {
      if (body.type !== 'spend') throw new AppError('BILL_ON_NON_SPEND', 'Only a spend can pay a supplier bill', 400)
      const found = await prisma.supplierBill.findFirst({
        where: { id: body.supplierBillId, supplier: { tenantId: box.tenantId } },
        select: { id: true, supplierId: true, billNumber: true, status: true, totalCents: true, whtCents: true, paidCents: true, supplier: { select: { name: true } } },
      })
      if (!found) throw new AppError('BILL_NOT_IN_COMPANY', 'That supplier bill is not one of this box\'s company\'s', 422)
      if (found.status === 'void' || found.status === 'paid') throw new AppError('BILL_NOT_OPEN', `Bill ${found.billNumber} is ${found.status}`, 422)
      // Net of withholding — the one "still due" rule (procurement billDueCents).
      const { billDueCents } = await import('../procurement/service.js')
      const due = billDueCents(found)
      if (Math.abs(body.amountCents) > due) {
        throw new AppError('OVER_APPLIED', `Only ${due} is still due on bill ${found.billNumber}`, 400)
      }
      bill = { id: found.id, supplierId: found.supplierId, billNumber: found.billNumber, supplierName: found.supplier.name }
    }

    const { getOperationsConfig } = await import('../../lib/setup-config.js')
    const ops = await getOperationsConfig(box.tenantId)
    const photoThreshold = ops?.photoRequiredAboveCents ?? 50000

    const absAmount = Math.abs(body.amountCents)

    // Receipt photo enforcement on spend
    if (body.type === 'spend' && absAmount >= photoThreshold && !body.receiptUrl) {
      throw new AppError(
        'PHOTO_REQUIRED',
        `Spend above PKR ${(photoThreshold / 100).toFixed(0)} requires a receipt photo.`,
        400,
      )
    }

    // Top-up limit — above limit requires manager PIN
    let approvedById: string | null = null
    if (body.type === 'topup' && absAmount > box.topUpLimitCents) {
      // Only an approver of the box's own company may lift its limit.
      const approver = await verifyManagerPin(body.managerOverridePin, box.tenantId, undefined, {
        actorId: req.staffUser!.id, action: 'petty_cash_topup',
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
          `Top-up of PKR ${(absAmount / 100).toFixed(0)} exceeds box limit of PKR ${(box.topUpLimitCents / 100).toFixed(0)}. Manager PIN required.`,
          403,
        )
      }
      approvedById = approver.id
    }

    // Sign convention: topup positive, spend negative
    const signedAmount =
      body.type === 'topup' ? Math.abs(body.amountCents) :
      body.type === 'spend' ? -Math.abs(body.amountCents) :
      body.amountCents

    const newFloat = box.floatCents + signedAmount
    if (newFloat < 0) {
      throw new AppError('INSUFFICIENT_FLOAT', `This spend of PKR ${(absAmount / 100).toFixed(0)} exceeds box float of PKR ${(box.floatCents / 100).toFixed(0)}.`, 400)
    }

    const { movement, supplierPaymentId } = await prisma.$transaction(async (tx) => {
      let supplierPaymentId: string | null = null
      if (bill) {
        const { createPaymentTx } = await import('../procurement/service.js')
        const payment = await createPaymentTx(tx, {
          supplierId: bill.supplierId,
          paymentDate: new Date().toISOString(),
          method: 'cash',
          reference: `petty cash: ${box.name}`,
          amountCents: absAmount,
          notes: body.reason,
          applications: [{ billId: bill.id, amountAppliedCents: absAmount }],
          createdBy: req.staffUser!.id,
        })
        supplierPaymentId = payment.id
      }
      const m = await tx.pettyCashMovement.create({
        data: {
          boxId: box.id,
          type: body.type,
          amountCents: signedAmount,
          category: body.category ?? null,
          reason: body.reason,
          receiptUrl: body.receiptUrl ?? null,
          vendorName: body.vendorName ?? bill?.supplierName ?? null,
          approvedById,
          supplierPaymentId,
          createdById: req.staffUser!.id,
        },
      })
      await tx.pettyCashBox.update({
        where: { id: box.id },
        data: { floatCents: newFloat },
      })
      return { movement: m, supplierPaymentId }
    })

    // The supplier payment's entry (Dr 2010 / Cr 1010) was posted inside the
    // transaction above by procurement createPaymentTx.

    await audit({ category: 'identity',
      action: `petty_cash.${body.type}`,
      entity: 'PettyCashMovement',
      entityId: movement.id,
      userId: req.staffUser!.id, tenantId: box.tenantId,
      userEmail: req.staffUser!.email,
      after: { box: box.name, amount: signedAmount, reason: body.reason, supplierBillId: bill?.id ?? null },
      metadata: { ip: req.ip, approvedById, supplierPaymentId },
    })

    return reply.status(201).send({ movement, newFloatCents: newFloat })
  })

  // GET /trustops/petty-cash/boxes/:id/reconcile — show variance vs physical count
  fastify.post<{ Params: { id: string } }>('/petty-cash/boxes/:id/reconcile',
    { preHandler: CASH_GUARD },
    async (req, reply) => {
      const body = z.object({ countedCents: z.number().int().min(0), notes: z.string().max(500).optional() }).parse(req.body)
      const box = await findBoxInScope(req, req.params.id)
      const variance = body.countedCents - box.floatCents

      const movement = await prisma.pettyCashMovement.create({
        data: {
          boxId: box.id, type: 'reconcile',
          amountCents: variance, reason: body.notes ?? 'Reconciliation', createdById: req.staffUser!.id,
        },
      })
      await prisma.pettyCashBox.update({ where: { id: box.id }, data: { floatCents: body.countedCents } })

      // Variance flag — beyond the box's company's cash tolerance
      // (Configuration → Receipts, the same limit the till drawers use).
      const limit = await cashVarianceLimitCents(box.tenantId)
      if (Math.abs(variance) > limit) {
        await flagException({
          tenantId: box.tenantId,
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
  fastify.post('/deposit-drops', { preHandler: CASH_GUARD }, async (req, reply) => {
    const body = z.object({
      shiftId:       z.string().uuid().nullable().optional(),
      conceptId:     z.string().uuid().nullable().optional(),
      bankAccountId: z.string().min(1).nullable().optional(),
      amountCents:   z.number().int().min(0),
      bagSerial:     z.string().max(80).nullable().optional(),
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
    if (body.bankAccountId) {
      const bank = await prisma.bankAccount.findFirst({
        where: { id: body.bankAccountId, tenantId, deletedAt: null },
        select: { id: true },
      })
      if (!bank) throw new AppError('BANK_ACCOUNT_NOT_IN_COMPANY', 'That bank account is not one of your active company\'s', 422)
    }

    const { expectedShiftDeposit, postDepositDrop } = await import('../accounting/depositPosting.js')
    const expected = body.shiftId ? (await expectedShiftDeposit(body.shiftId)).expectedCents : 0
    const variance = body.amountCents - expected

    const drop = await prisma.depositDrop.create({
      data: {
        ...body,
        tenantId,
        shiftId: body.shiftId ?? null,
        conceptId: body.conceptId ?? null,
        bankAccountId: body.bankAccountId ?? null,
        bagSerial: body.bagSerial ?? null,
        receiptUrl: body.receiptUrl ?? null,
        witnessedById: body.witnessedById ?? null,
        notes: body.notes ?? null,
        expectedCents: expected,
        varianceCents: variance,
        droppedById: req.staffUser!.id,
      },
    })

    postDepositDrop(drop.id)
      .then((r) => { if (!r.posted && r.reason) req.log.warn({ dropId: drop.id, reason: r.reason }, 'deposit drop not posted') })
      .catch((err) => req.log.error({ err: (err as Error).message, dropId: drop.id }, 'postDepositDrop failed'))

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

    return reply.status(201).send(drop)
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
