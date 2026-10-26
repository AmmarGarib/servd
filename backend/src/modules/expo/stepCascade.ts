// Step-cascade engine.
//
// When a station bumps a step on an order-item, we:
//   1. Mark the OrderItemStep `done`.
//   2. Find every step on the same item whose `dependsOnStepIds` are now all
//      satisfied (i.e. every dep is `done` or `voided`). Flip those to
//      `preparing` and broadcast to their station's KDS.
//   3. If every step on the item is now `done`/`voided`, mark the item
//      `bumped`. The order-level all-done check in the existing
//      updateItemStatus path handles order completion + financial entry.
//
// The whole thing is one DB transaction so two simultaneous bumps on
// sibling steps don't both fire the same downstream twice.

import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { getIOSafe } from '../../lib/ws.js'

type Tx = Prisma.TransactionClient | PrismaClient

export interface BumpResult {
  step: { id: string; status: string }
  unlocked: Array<{ id: string; stationId: string | null; instruction: string; estimatedSeconds: number }>
  itemBumped: boolean
}

/**
 * Bump a single OrderItemStep. Returns the resulting state + the list of
 * step IDs that the cascade just promoted to `preparing`.
 */
export async function bumpStep(stepId: string, bumpedById?: string): Promise<BumpResult> {
  return prisma.$transaction(async (tx: Tx) => {
    const step = await tx.orderItemStep.findUnique({
      where: { id: stepId },
      include: {
        recipeStep: true,
        orderItem:  { include: { steps: true } },
      },
    })
    if (!step) throw new NotFoundError('OrderItemStep', stepId)
    if (step.status === 'done' || step.status === 'voided') {
      // Idempotent — same input, same output. KDS duplicate-bump is harmless.
      return {
        step: { id: step.id, status: step.status },
        unlocked: [],
        itemBumped: step.orderItem.steps.every((s) => s.status === 'done' || s.status === 'voided'),
      }
    }
    if (step.status === 'pending') {
      throw new AppError('STEP_NOT_FIRED', 'Step hasn\'t been fired yet — expo must confirm the order first', 409)
    }

    // Flip the step done.
    await tx.orderItemStep.update({
      where: { id: step.id },
      data: { status: 'done', completedAt: new Date(), bumpedById: bumpedById ?? null },
    })

    // Re-read all sibling steps to evaluate cascades against fresh state.
    const siblings = await tx.orderItemStep.findMany({
      where: { orderItemId: step.orderItemId },
      include: { recipeStep: true },
    })

    const doneIds = new Set(siblings.filter((s) =>
      s.id === step.id || s.status === 'done' || s.status === 'voided',
    ).map((s) => s.recipeStepId))

    const unlocked: BumpResult['unlocked'] = []
    for (const sib of siblings) {
      if (sib.status !== 'waiting') continue
      const deps = sib.dependsOnStepIds ?? []
      const allDepsDone = deps.every((d) => doneIds.has(d))
      if (!allDepsDone) continue
      // Promote.
      await tx.orderItemStep.update({
        where: { id: sib.id },
        data:  { status: 'preparing', firedAt: new Date() },
      })
      unlocked.push({
        id: sib.id,
        stationId: sib.stationId,
        instruction: sib.recipeStep.instruction,
        estimatedSeconds: sib.recipeStep.estimatedSeconds,
      })
    }

    // After both the original bump + cascade, is every step on this item
    // finished? If so, the OrderItem itself moves to `bumped` so the existing
    // order-level "all items done → complete" logic fires.
    const finalSteps = await tx.orderItemStep.findMany({
      where: { orderItemId: step.orderItemId },
      select: { status: true },
    })
    const itemBumped = finalSteps.length > 0 && finalSteps.every((s) => s.status === 'done' || s.status === 'voided')

    return {
      step: { id: step.id, status: 'done' },
      unlocked,
      itemBumped,
    }
  })
}

/**
 * Broadcast the cascade effects to the relevant station rooms. Called after
 * `bumpStep` resolves so the WS messages happen post-commit (no spurious
 * fires if the txn rolls back).
 */
export function broadcastCascade(result: BumpResult, orderItemId: string) {
  const ws = getIOSafe()
  if (!ws) return
  for (const step of result.unlocked) {
    if (!step.stationId) continue
    ws.to(`station:${step.stationId}`).emit('expo:fire', {
      itemId:           orderItemId,
      stepId:           step.id,
      stationId:        step.stationId,
      instruction:      step.instruction,
      estimatedSeconds: step.estimatedSeconds,
    })
  }
}

/**
 * A station's step bump with every side effect (the ONE path — POST
 * /expo/steps/:id/bump and the station card's "done" tick, owner B12 call it):
 * the cascade (bumpStep), its station broadcast, and — when the last step of
 * the dish is done — the item's own bump through updateItemStatus, so the
 * order-level "all done → ready / complete" logic runs. The caller has
 * already checked the step belongs to the caller's company.
 */
export async function completeStepBump(stepId: string, orderItemId: string, staffId: string): Promise<BumpResult> {
  const result = await bumpStep(stepId, staffId)
  broadcastCascade(result, orderItemId)
  if (result.itemBumped) {
    const cur = await prisma.orderItem.findUnique({ where: { id: orderItemId }, select: { status: true } })
    if (cur && cur.status !== 'bumped' && cur.status !== 'voided') {
      const { updateItemStatus } = await import('../orders/service.js')
      try {
        // Every step is done, so the dish is done: a hold on the item (not
        // offered for step tickets, but possible through the API) is resumed
        // first — a held item can't be bumped directly (R4).
        if (cur.status === 'held') await updateItemStatus(orderItemId, 'preparing', staffId)
        await updateItemStatus(orderItemId, 'bumped', staffId)
      } catch (e) {
        // State-machine may reject if the item already moved — that's fine.
        if ((e as { code?: string })?.code !== 'INVALID_TRANSITION') throw e
      }
    }
  }
  return result
}
