// Cost allocation engine.
//
// Operator defines rules: "rent (6010) splits 40/30/20/10 across Stax / Strata
// / Simmer / GS" or "electricity (6020) splits by revenue share". At period
// end, runRule() reads the source account's net debit balance for the period
// and posts a JE that derecognises it back to source and debits per-concept
// destination accounts (or the same source code with concept memos).

import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { postJournalEntry, revenueCodeForConcept, type JournalLineInput } from '../accounting/journal.js'
import { sumCents } from '../../lib/money.js'

const BPS_TOTAL = 10_000

// Net debit balance for an account in a period — the cost to allocate.
// Allocation runs' own lines are excluded: a run debits the brands and
// credits the source on the SAME account when no target code is set, so
// counting them would make an overlapping later run (January, then Q1) see
// January's cost again and allocate it twice.
async function netDebitForAccount(accountId: string, periodStart: Date, periodEnd: Date): Promise<number> {
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    _sum: { amountCents: true },
    where: {
      accountId,
      journalEntry: {
        entryDate: { gte: periodStart, lte: periodEnd },
        NOT: { reference: { startsWith: 'allocation.run:' } },
      },
    },
  })
  let debit = 0, credit = 0
  for (const s of sums) {
    if (s.type === 'debit') debit  = sumCents(s._sum.amountCents)
    else                     credit = sumCents(s._sum.amountCents)
  }
  return debit - credit
}

interface RevenueByConcept { conceptId: string; revenueCents: number }

async function revenueByConcept(tenantId: string, periodStart: Date, periodEnd: Date): Promise<RevenueByConcept[]> {
  // Only this company's brands and this company's revenue accounts — an
  // allocation must never spread one company's overhead over another's sales.
  const concepts = await prisma.concept.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, slug: true } })
  const out: RevenueByConcept[] = []
  for (const c of concepts) {
    const account = await prisma.account.findFirst({
      where: { tenantId, code: revenueCodeForConcept(c.slug) },
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
      if (s.type === 'debit') debit  = sumCents(s._sum.amountCents)
      else                     credit = sumCents(s._sum.amountCents)
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
  // The rule's own company (CostAllocationRule.tenantId). The source
  // account, the eligible brands, the run row and the posting all resolve
  // inside it — the route passes rule.tenantId, never the caller's active
  // company, and the rule must belong to it.
  tenantId: string
}) {
  const rule = await prisma.costAllocationRule.findFirst({
    where: { id: input.ruleId, tenantId: input.tenantId },
    include: { weights: { include: { concept: { select: { slug: true, tenantId: true } } } } },
  })
  if (!rule) throw new NotFoundError('CostAllocationRule', input.ruleId)
  if (!rule.isActive) throw new AppError('RULE_INACTIVE', 'Rule is inactive', 422)
  if (rule.weights.length === 0) {
    throw new AppError('NO_WEIGHTS', 'Rule has no weight rows — add at least one concept', 422)
  }
  // Every weighted brand must be the rule's company's. A weight left over from
  // before rules were per company (or a brand since moved) would otherwise
  // debit this company's ledger for another company's brand.
  const foreign = rule.weights.filter((w) => w.concept.tenantId !== input.tenantId)
  if (foreign.length > 0) {
    throw new AppError(
      'WEIGHT_NOT_IN_COMPANY',
      `Rule weights name brands of another company (${foreign.map((w) => w.concept.slug).join(', ')}) — edit the rule`,
      422,
    )
  }

  if (!(input.periodEnd > input.periodStart)) throw new AppError('BAD_PERIOD', 'Period end must be after its start', 400)
  // One run per rule per stretch of time: a run whose period overlaps an
  // earlier run of the same rule would allocate that cost a second time.
  const overlapping = await prisma.costAllocationRun.findFirst({
    where: { ruleId: rule.id, periodStart: { lte: input.periodEnd }, periodEnd: { gte: input.periodStart } },
    select: { periodStart: true, periodEnd: true },
  })
  if (overlapping) {
    throw new AppError(
      'RUN_OVERLAPS',
      `This rule already ran for ${overlapping.periodStart.toISOString().slice(0, 10)}–${overlapping.periodEnd.toISOString().slice(0, 10)} — pick a period that does not overlap it`,
      409,
    )
  }

  const sourceAccount = await prisma.account.findFirst({ where: { tenantId: input.tenantId, code: rule.sourceAccountCode } })
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
    const revenues = await revenueByConcept(input.tenantId, input.periodStart, input.periodEnd)
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

  // Each debit is TAGGED with its brand, so the allocated cost becomes that
  // brand's measured cost in pnlByConcept and the CEO brand P&L; the credit
  // stays untagged and takes the cost out of the shared (head-office) bucket.
  // Without the tag a run was Dr 6010 / Cr 6010 with no brand on either side
  // — it changed no report at all.
  const lines: JournalLineInput[] = perConcept.map((p) => ({
    accountCode: p.targetAccountCode,
    type: 'debit',
    amountCents: p.amountCents,
    memo: `Allocated to ${p.conceptSlug}`,
    conceptId: p.conceptId,
  }))
  lines.push({
    accountCode: rule.sourceAccountCode,
    type: 'credit',
    amountCents: totalCents,
    memo: `Allocated out for ${input.periodStart.toISOString().slice(0,10)}–${input.periodEnd.toISOString().slice(0,10)}`,
    conceptId: null,
  })

  // The run row and its entry together: a run the ledger refuses (closed
  // period, missing account) leaves no run row behind to block a retry.
  const run = await prisma.$transaction(async (tx) => {
    const run = await tx.costAllocationRun.create({
      data: {
        tenantId: input.tenantId,
        ruleId: rule.id,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        totalAmountCents: totalCents,
        postedById: input.postedById,
      },
    })
    await postJournalEntry({
      tenantId: input.tenantId,
      sourceType: 'allocation.run',
      sourceId: run.id,
      description: `${rule.name}: ${rule.sourceAccountCode} allocated across concepts`,
      entryDate: input.periodEnd,
      postedBy: input.postedById,
      lines,
    }, { tx })
    return run
  })

  return { runId: run.id, totalAmountCents: totalCents, allocations: perConcept }
}
