// Cost allocation engine.
//
// Operator defines rules: "rent (6010) splits 40/30/30 across Stax / Strata
// / GS" or "electricity (6020) splits by revenue share". At period
// end, runRule() reads the source account's net debit balance for the period
// and posts a JE that derecognises it back to source and debits per-concept
// destination accounts (or the same source code with concept memos).

import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { postJournalEntry, revenueCodeForConcept, type JournalLineInput } from '../accounting/journal.js'

const BPS_TOTAL = 10_000

// Net debit balance for an account in a period — what's left to allocate.
async function netDebitForAccount(accountId: string, periodStart: Date, periodEnd: Date): Promise<number> {
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    _sum: { amountCents: true },
    where: {
      accountId,
      journalEntry: { entryDate: { gte: periodStart, lte: periodEnd } },
    },
  })
  let debit = 0, credit = 0
  for (const s of sums) {
    if (s.type === 'debit') debit  = s._sum.amountCents ?? 0
    else                     credit = s._sum.amountCents ?? 0
  }
  return debit - credit
}

interface RevenueByConcept { conceptId: string; revenueCents: number }

async function revenueByConcept(periodStart: Date, periodEnd: Date): Promise<RevenueByConcept[]> {
  const concepts = await prisma.concept.findMany({ select: { id: true, slug: true } })
  const out: RevenueByConcept[] = []
  for (const c of concepts) {
    const account = await prisma.account.findUnique({
      where: { code: revenueCodeForConcept(c.slug) },
      select: { id: true },
    })
    if (!account) continue
    const sums = await prisma.journalLine.groupBy({
      by: ['type'],
      _sum: { amountCents: true },
      where: { accountId: account.id, journalEntry: { entryDate: { gte: periodStart, lte: periodEnd } } },
    })
    let debit = 0, credit = 0
    for (const s of sums) {
      if (s.type === 'debit') debit  = s._sum.amountCents ?? 0
      else                     credit = s._sum.amountCents ?? 0
    }
    out.push({ conceptId: c.id, revenueCents: Math.max(0, credit - debit) })
  }
  return out
}

export async function runAllocationRule(input: {
  ruleId: string
  periodStart: Date
  periodEnd: Date
  postedById: string
}) {
  const rule = await prisma.costAllocationRule.findUnique({
    where: { id: input.ruleId },
    include: { weights: { include: { concept: { select: { slug: true } } } } },
  })
  if (!rule) throw new NotFoundError('CostAllocationRule', input.ruleId)
  if (!rule.isActive) throw new AppError('RULE_INACTIVE', 'Rule is inactive', 422)
  if (rule.weights.length === 0) {
    throw new AppError('NO_WEIGHTS', 'Rule has no weight rows — add at least one concept', 422)
  }

  const sourceAccount = await prisma.account.findUnique({ where: { code: rule.sourceAccountCode } })
  if (!sourceAccount) throw new NotFoundError('Account', rule.sourceAccountCode)

  const totalCents = await netDebitForAccount(sourceAccount.id, input.periodStart, input.periodEnd)
  if (totalCents <= 0) {
    throw new AppError('NOTHING_TO_ALLOCATE', `No net debit balance to allocate from ${rule.sourceAccountCode} in this period`, 422)
  }

  // Compute per-concept allocations
  let perConcept: Array<{ conceptId: string; conceptSlug: string; targetAccountCode: string; amountCents: number }> = []

  if (rule.driver === 'fixed_pct') {
    const totalBps = rule.weights.reduce((s, w) => s + w.weightBps, 0)
    if (totalBps !== BPS_TOTAL) {
      throw new AppError(
        'BAD_WEIGHTS',
        `fixed_pct weights must sum to 10000 bps (got ${totalBps})`,
        422,
      )
    }
    let allocated = 0
    for (let i = 0; i < rule.weights.length; i++) {
      const w = rule.weights[i]!
      const isLast = i === rule.weights.length - 1
      const amount = isLast
        ? totalCents - allocated  // residue to last to avoid rounding drift
        : Math.floor((totalCents * w.weightBps) / BPS_TOTAL)
      allocated += amount
      perConcept.push({
        conceptId: w.conceptId,
        conceptSlug: w.concept.slug,
        targetAccountCode: w.targetAccountCode ?? rule.sourceAccountCode,
        amountCents: amount,
      })
    }
  } else {
    // revenue_share
    const revenues = await revenueByConcept(input.periodStart, input.periodEnd)
    const eligibleConceptIds = new Set(rule.weights.map((w) => w.conceptId))
    const eligibleRevenues = revenues.filter((r) => eligibleConceptIds.has(r.conceptId))
    const totalRevenueCents = eligibleRevenues.reduce((s, r) => s + r.revenueCents, 0)
    if (totalRevenueCents <= 0) {
      throw new AppError('NO_REVENUE', 'No revenue across eligible concepts in this period — cannot revenue-share', 422)
    }
    const weightByConcept = new Map(rule.weights.map((w) => [w.conceptId, w]))
    let allocated = 0
    for (let i = 0; i < eligibleRevenues.length; i++) {
      const r = eligibleRevenues[i]!
      const isLast = i === eligibleRevenues.length - 1
      const amount = isLast
        ? totalCents - allocated
        : Math.floor((totalCents * r.revenueCents) / totalRevenueCents)
      allocated += amount
      const w = weightByConcept.get(r.conceptId)!
      const concept = await prisma.concept.findUnique({ where: { id: r.conceptId }, select: { slug: true } })
      perConcept.push({
        conceptId: r.conceptId,
        conceptSlug: concept?.slug ?? '',
        targetAccountCode: w.targetAccountCode ?? rule.sourceAccountCode,
        amountCents: amount,
      })
    }
  }

  // Filter zero-amount allocations (e.g. opted-out concepts)
  perConcept = perConcept.filter((p) => p.amountCents > 0)
  if (perConcept.length === 0) {
    throw new AppError('NO_ALLOCATIONS', 'All allocations rounded to zero', 422)
  }

  const lines: JournalLineInput[] = perConcept.map((p) => ({
    accountCode: p.targetAccountCode,
    type: 'debit',
    amountCents: p.amountCents,
    memo: `Allocated to ${p.conceptSlug}`,
  }))
  lines.push({
    accountCode: rule.sourceAccountCode,
    type: 'credit',
    amountCents: totalCents,
    memo: `Allocated out for ${input.periodStart.toISOString().slice(0,10)}–${input.periodEnd.toISOString().slice(0,10)}`,
  })

  const run = await prisma.costAllocationRun.create({
    data: {
      ruleId: rule.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totalAmountCents: totalCents,
      postedById: input.postedById,
    },
  })

  await postJournalEntry({
    sourceType: 'allocation.run',
    sourceId: run.id,
    description: `${rule.name}: ${rule.sourceAccountCode} allocated across concepts`,
    entryDate: input.periodEnd,
    postedBy: input.postedById,
    lines,
  })

  return { runId: run.id, totalAmountCents: totalCents, allocations: perConcept }
}
