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
import { requireAuth, MANAGERS, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { flagException } from '../../lib/exceptions.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import type { FastifyRequest } from 'fastify'
import {
  scopeTenantWhere, conceptWhere, assertConceptOwned, assertShiftOf, conceptIdsInScope, resolveTenantScope,
  SHIFT_COMPANY_INCLUDE, shiftTenantId,
} from '../../lib/tenantScope.js'
import { cashVarianceLimitCents } from '../../lib/drawer.js'

// 4-digit OTP for rider hand-off
function generateOtp(): string {
  return Math.floor(1000 + Math.random() * 9000).toString()
}

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

export async function trustopsRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // 1. RIDER OTP — generate on order, verify on dispatch
  // ════════════════════════════════════════════════════════════════════════

  // GET /trustops/orders/:id/otp — customer-facing fetch (storefront calls this).
  // Returns the OTP for the customer to show their rider. Auth via customer
  // token in production; for now locked to ALL_STAFF + customer.
  fastify.get<{ Params: { id: string } }>(
    '/orders/:id/otp',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      // Scoped through the order's brand → company: a foreign order is 404.
      const order = await findOrderInScope(req, req.params.id, { id: true, deliveryOtp: true, source: true, status: true })
      // Generate OTP on first read if missing (defensive)
      if (!order.deliveryOtp) {
        const otp = generateOtp()
        await prisma.order.update({ where: { id: order.id }, data: { deliveryOtp: otp } })
        return { otp }
      }
      return { otp: order.deliveryOtp }
    },
  )

  // POST /trustops/orders/:id/verify-otp — rider enters customer-provided OTP.
  // Wrong OTP increments counter; 3+ failures = `lost_package` flag.
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

      if (body.otp !== order.deliveryOtp) {
        const attempts = order.deliveryOtpAttempts + 1
        await prisma.order.update({ where: { id: order.id }, data: { deliveryOtpAttempts: attempts } })
        if (attempts >= 3) {
          await flagException({
            tenantId: order.concept.tenantId,
            conceptId: order.conceptId,
            kind: 'lost_package',
            severity: 'high',
            title: `OTP failed 3+ times on order ${order.id.slice(0, 8)}`,
            description: `Rider attempted delivery hand-off ${attempts} times without correct OTP. Either customer dispute or rider attempting to deliver to wrong recipient. Investigate before marking delivered.`,
            entityType: 'Order',
            entityId: order.id,
            actorId: order.riderId ?? req.staffUser!.id,
            amountCents: order.totalCents,
            metadata: { attempts, customerId: order.customerId, customerName: order.customerName },
          })
        }
        throw new AppError('OTP_MISMATCH', `Wrong OTP (attempt ${attempts}/3). Ask the customer to re-read the code.`, 403)
      }

      // OTP matched — mark delivered + verified
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'completed', completedAt: new Date(),
          deliveryOtpVerifiedAt: new Date(),
        },
      })
      return reply.status(200).send({ verified: true })
    },
  )

  // ════════════════════════════════════════════════════════════════════════
  // 2. PETTY CASH — float boxes
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/petty-cash/boxes', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.pettyCashBox.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      include: {
        movements: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: { name: 'asc' },
    })
  })

  fastify.post('/petty-cash/boxes', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
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
      const approver = await verifyManagerPin(body.managerOverridePin, box.tenantId)
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

    if (supplierPaymentId) {
      const { postSupplierPayment } = await import('../accounting/supplierPosting.js')
      postSupplierPayment(supplierPaymentId).catch((err) =>
        req.log.error({ err: (err as Error).message, supplierPaymentId }, 'postSupplierPayment failed (petty cash)'),
      )
    }

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
    { preHandler: requireAuth(...MANAGERS) },
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

  fastify.get('/deposit-drops', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
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
  fastify.post('/deposit-drops', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
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
  fastify.get('/staff-meals', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { conceptId, days } = req.query as { conceptId?: string; days?: string }
    const d = Math.min(Math.max(parseInt(days ?? '30', 10) || 30, 1), 366)
    const since = new Date(Date.now() - d * 86400_000)
    if (conceptId) {
      return prisma.staffMeal.findMany({
        where: { consumedAt: { gte: since }, ...(await conceptWhere(req, conceptId, 'read')) },
        orderBy: { consumedAt: 'desc' },
        take: 200,
      })
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
    return rows
      .filter((m) => m.conceptId || inScope.has(company.get(m.id) ?? ''))
      .slice(0, 200)
  })

  // POST — manager-PIN approval required. Above PKR cap fires flag.
  fastify.post('/staff-meals', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      staffId:            z.string().uuid(),
      shiftId:            z.string().uuid().nullable().optional(),
      conceptId:          z.string().uuid().nullable().optional(),
      description:        z.string().min(1).max(200),
      estimatedCostCents: z.number().int().min(0).default(0),
      // No 'comp': comping a customer's order goes through the till's one
      // comp engine (POST /pos/orders/:id/comp). Old 'comp' rows are kept.
      reason:             z.enum(['shift_meal', 'training', 'tasting']).default('shift_meal'),
      managerPin:         z.string().min(4).max(8),                      // mandatory
    }).parse(req.body)

    // A new meal binds to the ACTIVE company: its brand, its drawer and the
    // person who ate must all be that company's (foreign → 404 / 422).
    const mealTenantId = req.staffUser!.tenantId
    if (!mealTenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before logging a staff meal', 422)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    if (!(await isMemberOf(body.staffId, mealTenantId))) {
      throw new AppError('STAFF_NOT_IN_COMPANY', 'That staff member is not a member of your active company', 422)
    }
    const approver = await verifyManagerPin(body.managerPin, mealTenantId)
    if (!approver) throw new AppError('MANAGER_PIN_REQUIRED', 'Manager PIN required to log a staff meal.', 403)
    // A new row bound to a drawer: the drawer must be the active company's.
    if (body.shiftId) await assertShiftOf(mealTenantId, body.shiftId, false)

    const meal = await prisma.staffMeal.create({
      data: {
        staffId: body.staffId,
        approvedById: approver.id,
        shiftId: body.shiftId ?? null,
        conceptId: body.conceptId ?? null,
        description: body.description,
        estimatedCostCents: body.estimatedCostCents,
        reason: body.reason,
      },
    })

    // Per-staff cumulative check — if this person has consumed > PKR 2,000 in
    // the last 7 days AT THIS COMPANY, flag it for this company's review
    // (configurable later via OperationsConfig). Meals at another company
    // are that company's business and never counted into this flag.
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000)
    const weekMeals = await prisma.staffMeal.findMany({
      where: { staffId: body.staffId, consumedAt: { gte: sevenDaysAgo } },
      select: { id: true, conceptId: true, shiftId: true, staffId: true, estimatedCostCents: true },
    })
    const weekCompany = await mealCompanies(weekMeals)
    const ours = weekMeals.filter((m) => m.id === meal.id || weekCompany.get(m.id) === mealTenantId)
    const recent = { _sum: { estimatedCostCents: ours.reduce((t, m) => t + m.estimatedCostCents, 0) }, _count: { _all: ours.length } }
    const cumulative = recent._sum.estimatedCostCents
    if (cumulative >= 200000) {       // PKR 2,000
      const staff = await prisma.user.findUnique({ where: { id: body.staffId }, select: { name: true, role: true } })
      await flagException({
        tenantId: mealTenantId,
        conceptId: body.conceptId ?? null,
        kind: 'shrinkage',
        severity: cumulative >= 500000 ? 'high' : 'medium',
        title: `Heavy staff meal log: ${staff?.name ?? 'staff'}`,
        description: `${staff?.name ?? 'Staff'} (${staff?.role ?? 'role unknown'}) has logged PKR ${(cumulative / 100).toFixed(0)} in staff meals across ${recent._count._all} entries in the last 7 days. Confirm policy compliance.`,
        entityType: 'User',
        entityId: body.staffId,
        actorId: approver.id,
        amountCents: cumulative,
        metadata: { weeklyTotal: cumulative, count: recent._count._all },
      })
    }

    return reply.status(201).send(meal)
  })
}
