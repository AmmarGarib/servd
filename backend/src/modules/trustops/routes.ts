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
import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { flagException } from '../../lib/exceptions.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError, AppError } from '../../lib/errors.js'

// 4-digit OTP for rider hand-off
function generateOtp(): string {
  return Math.floor(1000 + Math.random() * 9000).toString()
}

async function verifyManagerPin(pin: string | undefined): Promise<{ id: string; name: string; role: string } | null> {
  if (!pin) return null
  const managers = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null, role: { in: ['admin', 'manager'] }, pin: { not: null } },
    select: { id: true, name: true, role: true, pin: true },
  })
  for (const m of managers) {
    if (m.pin && (await bcrypt.compare(pin, m.pin))) return { id: m.id, name: m.name, role: m.role }
  }
  return null
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
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        select: { id: true, deliveryOtp: true, source: true, status: true },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      // Generate OTP on first read if missing (defensive)
      if (!order.deliveryOtp) {
        const otp = generateOtp()
        await prisma.order.update({ where: { id: req.params.id }, data: { deliveryOtp: otp } })
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
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        select: { id: true, deliveryOtp: true, deliveryOtpAttempts: true, riderId: true, customerId: true, customerName: true, totalCents: true },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      if (!order.deliveryOtp) {
        throw new AppError('NO_OTP', 'No OTP set on this order. Customer should refresh their order page.', 400)
      }

      if (body.otp !== order.deliveryOtp) {
        const attempts = order.deliveryOtpAttempts + 1
        await prisma.order.update({ where: { id: req.params.id }, data: { deliveryOtpAttempts: attempts } })
        if (attempts >= 3) {
          await flagException({
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
        where: { id: req.params.id },
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

  fastify.get('/petty-cash/boxes', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.pettyCashBox.findMany({
      where: { deletedAt: null },
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
    const created = await prisma.pettyCashBox.create({ data: body })
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
      managerOverridePin: z.string().min(4).max(8).optional(),
    }).parse(req.body)

    const box = await prisma.pettyCashBox.findUnique({ where: { id: body.boxId } })
    if (!box) throw new NotFoundError('PettyCashBox', body.boxId)

    const { getOperationsConfig } = await import('../../lib/setup-config.js')
    const ops = await getOperationsConfig()
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
      const approver = await verifyManagerPin(body.managerOverridePin)
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

    const movement = await prisma.$transaction(async (tx) => {
      const m = await tx.pettyCashMovement.create({
        data: {
          boxId: body.boxId,
          type: body.type,
          amountCents: signedAmount,
          category: body.category ?? null,
          reason: body.reason,
          receiptUrl: body.receiptUrl ?? null,
          vendorName: body.vendorName ?? null,
          approvedById,
          createdById: req.staffUser!.id,
        },
      })
      await tx.pettyCashBox.update({
        where: { id: body.boxId },
        data: { floatCents: newFloat },
      })
      return m
    })

    await audit({
      action: `petty_cash.${body.type}`,
      entity: 'PettyCashMovement',
      entityId: movement.id,
      userId: req.staffUser!.id,
      userEmail: req.staffUser!.email,
      after: { box: box.name, amount: signedAmount, reason: body.reason },
      metadata: { ip: req.ip, approvedById },
    })

    return reply.status(201).send({ movement, newFloatCents: newFloat })
  })

  // GET /trustops/petty-cash/boxes/:id/reconcile — show variance vs physical count
  fastify.post<{ Params: { id: string } }>('/petty-cash/boxes/:id/reconcile',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({ countedCents: z.number().int().min(0), notes: z.string().max(500).optional() }).parse(req.body)
      const box = await prisma.pettyCashBox.findUnique({ where: { id: req.params.id } })
      if (!box) throw new NotFoundError('PettyCashBox', req.params.id)
      const variance = body.countedCents - box.floatCents

      const movement = await prisma.pettyCashMovement.create({
        data: {
          boxId: box.id, type: 'reconcile',
          amountCents: variance, reason: body.notes ?? 'Reconciliation', createdById: req.staffUser!.id,
        },
      })
      await prisma.pettyCashBox.update({ where: { id: box.id }, data: { floatCents: body.countedCents } })

      // Variance flag — anything over PKR 200 needs eyes
      if (Math.abs(variance) >= 20000) {
        await flagException({
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
    return prisma.depositDrop.findMany({
      where: { ...(conceptId && { conceptId }) },
      orderBy: { droppedAt: 'desc' },
      take: 100,
    })
  })

  // Computes expected = cash sales for the shift, captures variance.
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

    // Compute expected cash from the shift's cash payments
    let expected = 0
    if (body.shiftId) {
      const cashPayments = await prisma.payment.aggregate({
        where: { shiftId: body.shiftId, method: 'cash', status: 'paid' },
        _sum: { amountCents: true },
      })
      expected = cashPayments._sum.amountCents ?? 0
    }

    const variance = body.amountCents - expected

    const drop = await prisma.depositDrop.create({
      data: {
        ...body,
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

    // Variance > PKR 200 fires a cash-variance flag (different entity than till variance)
    if (Math.abs(variance) >= 20000 && expected > 0) {
      await flagException({
        kind: 'cash_variance',
        severity: Math.abs(variance) > 100000 ? 'high' : 'medium',
        title: `Deposit drop variance: ${variance >= 0 ? '+' : ''}PKR ${(variance / 100).toFixed(0)}`,
        description: `Expected PKR ${(expected / 100).toFixed(0)} from shift cash sales, deposited PKR ${(body.amountCents / 100).toFixed(0)}. ${variance < 0 ? 'Cash short — investigate till handover.' : 'Cash over — check shift records.'}`,
        entityType: 'DepositDrop',
        entityId: drop.id,
        actorId: req.staffUser!.id,
        amountCents: Math.abs(variance),
        metadata: { expected, deposited: body.amountCents, variance, shiftId: body.shiftId, bagSerial: body.bagSerial },
      })
    }

    // Also flag when receipt photo missing on a meaningful drop
    if (body.amountCents >= 100000 && !body.receiptUrl) {
      await flagException({
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

  fastify.get('/staff-meals', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { conceptId, days } = req.query as { conceptId?: string; days?: string }
    const since = new Date(Date.now() - parseInt(days ?? '30', 10) * 86400_000)
    return prisma.staffMeal.findMany({
      where: { consumedAt: { gte: since }, ...(conceptId && { conceptId }) },
      orderBy: { consumedAt: 'desc' },
      take: 200,
    })
  })

  // POST — manager-PIN approval required. Above PKR cap fires flag.
  fastify.post('/staff-meals', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      staffId:            z.string().uuid(),
      shiftId:            z.string().uuid().nullable().optional(),
      conceptId:          z.string().uuid().nullable().optional(),
      description:        z.string().min(1).max(200),
      estimatedCostCents: z.number().int().min(0).default(0),
      reason:             z.enum(['shift_meal', 'training', 'tasting', 'comp']).default('shift_meal'),
      managerPin:         z.string().min(4).max(8),                      // mandatory
    }).parse(req.body)

    const approver = await verifyManagerPin(body.managerPin)
    if (!approver) throw new AppError('MANAGER_PIN_REQUIRED', 'Manager PIN required to log a staff meal.', 403)

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
    // the last 7 days, flag for review (configurable later via OperationsConfig).
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000)
    const recent = await prisma.staffMeal.aggregate({
      where: { staffId: body.staffId, consumedAt: { gte: sevenDaysAgo } },
      _sum: { estimatedCostCents: true },
      _count: { _all: true },
    })
    const cumulative = recent._sum.estimatedCostCents ?? 0
    if (cumulative >= 200000) {       // PKR 2,000
      const staff = await prisma.user.findUnique({ where: { id: body.staffId }, select: { name: true, role: true } })
      await flagException({
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
