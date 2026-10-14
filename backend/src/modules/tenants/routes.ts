import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { TEMPLATES, getTemplate, TEMPLATE_KEYS } from './templates.js'
import { audit } from '../../lib/audit.js'
import { closedAcrossYearEnd, DEFAULT_FISCAL_YEAR_END_MONTH } from '../accounting/fiscalYear.js'
import { ensureFifoReady, readFifoCutoverAt } from '../../lib/stockLedger.js'

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

async function uniqueSlug(baseName: string, table: 'tenant' | 'concept'): Promise<string> {
  let slug = slugify(baseName) || (table === 'tenant' ? 'restaurant' : 'brand')
  let i = 1
  while (true) {
    const existing = table === 'tenant'
      ? await prisma.tenant.findUnique({ where: { slug } })
      : await prisma.concept.findUnique({ where: { slug } })
    if (!existing) return slug
    i++; slug = `${slugify(baseName)}-${i}`
  }
}

// ─── Combining companies: the finance wave B tables ──────────────────────────
//
// What the merge refuses before any write (422), and what it moves. Kept here
// beside the route so one file says what a merge does.

type MergeTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * A merge the books cannot absorb is refused (read-only; run before the FIFO
 * cut-over and again inside the merge transaction):
 *   422 MERGE_HAS_INTERCOMPANY       either company has inter-company activity (H30):
 *                                    a Due-from / Due-to account with entries, a
 *                                    transfer, or a shared-fleet rate
 *   422 FY_END_MISMATCH              the two fiscal year ends differ and BOTH
 *                                    companies have closed across a year end (H29)
 *   422 MERGE_CARD_SETTLEMENT_CLASH  both companies claimed the same card-payout
 *                                    day for the same unit (H12)
 */
async function assertMergeable(db: typeof prisma | MergeTx, src: string, dst: string): Promise<void> {
  const pair = [src, dst]
  const [icAccounts, transfers, fleetRates] = await Promise.all([
    db.account.count({
      where: {
        controlledBy: 'intercompany',
        OR: [{ tenantId: { in: pair } }, { counterpartyTenantId: { in: pair } }],
        journalLines: { some: {} },
      },
    }),
    db.intercompanyTransfer.count({ where: { OR: [{ tenantId: { in: pair } }, { counterpartyTenantId: { in: pair } }] } }),
    db.fleetRate.count({ where: { OR: [{ tenantId: { in: pair } }, { clientTenantId: { in: pair } }] } }),
  ])
  if (icAccounts + transfers + fleetRates > 0) {
    throw new AppError(
      'MERGE_HAS_INTERCOMPANY',
      'One of these companies has inter-company activity (Due-from / Due-to entries, transfers or shared-fleet rates). Merging would fold both sides of those balances into one company — settle them first, then ask finance how to close them.',
      422,
      { icAccountsWithEntries: icAccounts, transfers, fleetRates },
    )
  }
  const tenants = await db.tenant.findMany({ where: { id: { in: pair } }, select: { id: true, fiscalYearEndMonth: true } })
  const monthOf = (id: string) => tenants.find((t) => t.id === id)?.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH
  if (monthOf(src) !== monthOf(dst)
    && await closedAcrossYearEnd(db, src, [monthOf(src)])
    && await closedAcrossYearEnd(db, dst, [monthOf(dst)])) {
    throw new AppError(
      'FY_END_MISMATCH',
      `The two companies end their fiscal years in different months (${monthOf(src)} and ${monthOf(dst)}) and both have closed their books across a year end — merging would re-present closed years. Align the year ends first.`,
      422,
      { sourceMonth: monthOf(src), targetMonth: monthOf(dst) },
    )
  }
  const [clash] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM card_settlement_days a
      JOIN card_settlement_days b ON b.unit = a.unit AND b.day = a.day
     WHERE a."tenantId" = ${src} AND b."tenantId" = ${dst}`
  if ((clash?.n ?? 0) > 0) {
    throw new AppError(
      'MERGE_CARD_SETTLEMENT_CLASH',
      `Both companies have card payouts claiming the same day(s) (${clash!.n}) — undo one side on Reconciliation → Card payouts before merging.`,
      422,
      { days: clash!.n },
    )
  }
}

/** `base` made unique against `taken`: base, then base-2, base-3 … (added to `taken`). */
function freeName(base: string, taken: Set<string>): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
  taken.add(name)
  return name
}

/**
 * Move every finance wave B company table (and the finance-wave-A parents they
 * hang off) from `src` to `dst`, inside the merge transaction. Company-keyed
 * unique keys stay unique: a fixed-asset class the target already has (by
 * key) absorbs the source's (assets and pools name their class by key); a
 * colliding asset tag or receivable-invoice number gets '-<source slug>'; the
 * source's cash requests are renumbered after the target's (seq is per
 * company; the printed number keeps its old digits plus '-<source slug>').
 * PARKED (owner, 2026-10-13): customer_accounts / _cards / _charges and
 * customer_strikes / customer_bans are NOT moved — the on-account and
 * strikes / bans features are parked; the resume adds them here.
 */
async function mergeFinanceTables(tx: MergeTx, src: string, dst: string, srcSlug: string) {
  // Fixed assets — classes by key.
  const srcClasses = await tx.fixedAssetClass.findMany({ where: { tenantId: src }, select: { id: true, key: true } })
  if (srcClasses.length > 0) {
    const dstKeys = new Set((await tx.fixedAssetClass.findMany({ where: { tenantId: dst }, select: { key: true } })).map((c) => c.key))
    for (const c of srcClasses) {
      if (dstKeys.has(c.key)) await tx.fixedAssetClass.delete({ where: { id: c.id } })
      else await tx.fixedAssetClass.update({ where: { id: c.id }, data: { tenantId: dst } })
    }
  }
  // Asset tags are unique per company.
  let assetTagsRenamed = 0
  const srcTagged = await tx.fixedAsset.findMany({ where: { tenantId: src, assetTag: { not: null } }, select: { id: true, assetTag: true } })
  if (srcTagged.length > 0) {
    const taken = new Set((await tx.fixedAsset.findMany({ where: { tenantId: dst, assetTag: { not: null } }, select: { assetTag: true } }))
      .map((a) => a.assetTag!))
    for (const a of srcTagged) {
      if (!taken.has(a.assetTag!)) { taken.add(a.assetTag!); continue }
      await tx.fixedAsset.update({ where: { id: a.id }, data: { assetTag: freeName(`${a.assetTag}-${srcSlug}`, taken) } })
      assetTagsRenamed++
    }
  }
  // Receivable invoice numbers are unique per company.
  let invoiceNumbersRenamed = 0
  const srcInvoices = await tx.receivableInvoice.findMany({ where: { tenantId: src }, select: { id: true, number: true } })
  if (srcInvoices.length > 0) {
    const taken = new Set((await tx.receivableInvoice.findMany({ where: { tenantId: dst }, select: { number: true } })).map((i) => i.number))
    for (const inv of srcInvoices) {
      if (!taken.has(inv.number)) { taken.add(inv.number); continue }
      await tx.receivableInvoice.update({ where: { id: inv.id }, data: { number: freeName(`${inv.number}-${srcSlug}`, taken) } })
      invoiceNumbersRenamed++
    }
  }
  // Cash requests: seq is per company — the source's continue after the target's.
  let cashRequestsRenumbered = 0
  const dstMaxSeq = (await tx.cashVoucher.aggregate({ where: { tenantId: dst }, _max: { seq: true } }))._max.seq ?? 0
  if (dstMaxSeq > 0) {
    const srcVouchers = await tx.cashVoucher.findMany({ where: { tenantId: src }, select: { id: true, number: true }, orderBy: { seq: 'asc' } })
    let next = dstMaxSeq
    for (const v of srcVouchers) {
      await tx.cashVoucher.update({ where: { id: v.id }, data: { tenantId: dst, seq: ++next, number: `${v.number}-${srcSlug}` } })
      cashRequestsRenumbered++
    }
  }

  const repoint: Array<{
    updateMany(args: { where: { tenantId: string }; data: { tenantId: string } }): Promise<unknown>
  }> = [
    // Fixed assets (v2) and prepayment releases.
    tx.fixedAsset, tx.fixedAssetEvent, tx.fixedAssetPool, tx.fixedAssetTaxYear, tx.fixedAssetRun, tx.fixedAssetDepreciation,
    tx.prepaidRelease,
    // Food cost on FIFO lots: the lots and their movements, GRNI matches, and
    // the stock documents' own company columns.
    tx.stockLot, tx.stockMovement, tx.grniMatch, tx.goodsReceipt, tx.wasteLog, tx.physicalCount, tx.prepBatch,
    // Card payouts (H12).
    tx.cardSettlement, tx.cardSettlementDay,
    // Receivables (the invoices the bad-debt write-offs belong to) and G12 write-offs + evidence.
    tx.receivableInvoice, tx.receivablePayment, tx.receivableWriteOff, tx.receivableWriteOffAttachment,
    // Petty cash and cash requests (the boxes and requests the settlements, spend lines and movements belong to).
    tx.pettyCashBox, tx.cashVoucher, tx.cashVoucherAttachment, tx.cashVoucherSettlement, tx.pettyCashSpendLine, tx.pettyCashMovement,
  ]
  for (const model of repoint) {
    await model.updateMany({ where: { tenantId: src }, data: { tenantId: dst } })
  }
  return { assetTagsRenamed, invoiceNumbersRenamed, cashRequestsRenumbered }
}

export async function tenantRoutes(fastify: FastifyInstance) {
  // ── Templates catalogue (public — needed for signup wizard) ─────────────
  fastify.get('/templates', async () => {
    return TEMPLATES.map((t) => ({
      key: t.key, emoji: t.emoji, label: t.label, blurb: t.blurb,
      conceptType: t.conceptType, primaryColor: t.primaryColor,
      stationCount: t.stations.length, categoryCount: t.categories.length,
      itemCount: t.items.length,
    }))
  })

  // ── List tenants (admin only — internal dashboard for the SaaS owner).
  // Scoped to the companies the operator belongs to: a company they are not
  // a member of is not theirs to list, admin role or not.
  fastify.get('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    return prisma.tenant.findMany({
      where: { deletedAt: null, id: { in: req.staffUser!.memberTenantIds } },
      include: {
        _count: { select: { concepts: true, users: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  // ── Get current tenant (whoever the logged-in user belongs to) ──────────
  fastify.get('/me', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { tenantId: true },
    })
    if (!user?.tenantId) return null
    return prisma.tenant.findUnique({
      where: { id: user.tenantId },
      include: { _count: { select: { concepts: true, users: true } } },
    })
  })

  // ── List tenants the current user is a member of (multi-tenant switcher)
  fastify.get('/mine', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = await prisma.user.findUnique({
      where: { id: req.staffUser!.id },
      select: { tenantId: true },
    })
    // Only the companies this person belongs to — the CEO role included
    // (UI-11). This used to hand every admin EVERY company, with its name,
    // slug, brand count and staff count, so each company's CEO could read the
    // others' and was offered them in Add staff. Belonging is the auth
    // middleware's memberTenantIds (TenantMember rows + the primary company),
    // the same set every write is scoped to — so a company that shows here is
    // exactly one the operator can act in. A CEO who runs several companies is
    // a member of each (POST /tenants makes the creator one). An empty set
    // lists nothing.
    const ids = req.staffUser!.memberTenantIds
    if (ids.length === 0) return []
    const [tenants, memberships] = await Promise.all([
      prisma.tenant.findMany({
        where: { id: { in: ids }, deletedAt: null },
        include: { _count: { select: { concepts: true, users: true } } },
      }),
      prisma.tenantMember.findMany({
        where: { userId: req.staffUser!.id, tenantId: { in: ids } },
        select: { tenantId: true, role: true, createdAt: true },
      }),
    ])
    const membership = new Map(memberships.map((m) => [m.tenantId, m]))
    // Membership order first (as before), then a primary with no member row.
    const order = (id: string) => membership.get(id)?.createdAt.getTime() ?? Number.MAX_SAFE_INTEGER
    return tenants
      .sort((a, b) => order(a.id) - order(b.id) || a.createdAt.getTime() - b.createdAt.getTime())
      .map((t) => ({
        ...t,
        role:     membership.get(t.id)?.role ?? 'member',
        isActive: t.id === user?.tenantId,
      }))
  })

  // ── Create a new tenant (authenticated operator only — used by the
  // in-house onboarding wizard for adding a new brand/JV). Switches the
  // user's active tenant to the newly created one so subsequent wizard
  // steps populate it.
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      name:        z.string().min(1).max(200),
      industry:    z.string().max(40).nullable().optional(),
      countryCode: z.string().length(2).default('PK'),
      timezone:    z.string().max(64).default('Asia/Karachi'),
    }).parse(req.body)

    const slug = await uniqueSlug(body.name, 'tenant')

    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          slug, name: body.name,
          industry:    body.industry ?? null,
          countryCode: body.countryCode,
          currency:    body.countryCode === 'PK' ? 'PKR' : 'USD',
          timezone:    body.timezone,
        },
      })
      await tx.tenantMember.create({
        data: { userId: req.staffUser!.id, tenantId: t.id, role: 'owner' },
      })
      // Switch active tenant to the new one
      await tx.user.update({ where: { id: req.staffUser!.id }, data: { tenantId: t.id } })
      return t
    })
    return reply.status(201).send(tenant)
  })

  // ── Switch active tenant (verifies membership) ──────────────────────────
  //
  // Belonging = a TenantMember row OR the caller's own current users.tenantId
  // (the auth middleware's memberTenantIds). Switching overwrites
  // users.tenantId, so the company being switched AWAY from is first written
  // down as a real membership: a login tied to its company only through
  // users.tenantId used to lose that company on its first switch, with no
  // in-app way back (AUTH-R1). Records a company the caller already belongs
  // to — grants nothing new.
  fastify.post<{ Params: { id: string } }>('/switch/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const userId = req.staffUser!.id
    const target = req.params.id
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } })
    const membership = await prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId, tenantId: target } },
      select: { id: true },
    })
    if (!membership && me?.tenantId !== target) {
      return reply.status(403).send({ error: { code: 'NOT_A_MEMBER', message: 'You are not a member of this tenant' } })
    }
    const live = await prisma.tenant.findFirst({ where: { id: target, deletedAt: null }, select: { id: true } })
    if (!live) return reply.status(403).send({ error: { code: 'NOT_A_MEMBER', message: 'You are not a member of this tenant' } })
    await prisma.$transaction(async (tx) => {
      for (const tid of new Set([me?.tenantId, target])) {
        if (!tid) continue
        await tx.tenantMember.upsert({
          where:  { userId_tenantId: { userId, tenantId: tid } },
          create: { userId, tenantId: tid, role: 'member' },
          update: {},
        })
      }
      await tx.user.update({ where: { id: userId }, data: { tenantId: target } })
    })
    return { activeTenantId: target }
  })

  // ── Combine companies — moves everything from `sourceId` into `targetId`,
  // soft-deletes the source. Admin only, and the caller must be a member of
  // BOTH companies — a foreign id 404s rather than confirming it exists.
  // Everything anchored on a tenantId column moves in the same transaction:
  // brands, staff, memberships, locations, suppliers, inventory, riders, bank
  // accounts, modifier templates, webhooks, domains, capex/opex/pro-forma rows,
  // workforce rows and the per-company singleton configs. Concept-scoped data
  // (orders, items, etc.) follows its brand. Where the target already holds a
  // row with the same company-keyed unique key the target's row wins and the
  // source's duplicate is dropped — except kitchen staff, where the merge is
  // refused so two people's payroll history is never silently collapsed.
  // Finance wave B: the fixed-asset register, FIFO lots / movements / GRNI,
  // card payouts, receivables + bad-debt write-offs and petty cash / cash
  // requests move too (mergeFinanceTables); assertMergeable refuses a merge
  // the books cannot absorb (inter-company activity, a fiscal-year clash,
  // clashing card-payout days). When only one company holds its stock on FIFO
  // lots, the other is cut over first so the merged items all live on lots.
  fastify.post('/merge', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      sourceId: z.string().min(1),
      targetId: z.string().min(1),
    }).parse(req.body)
    if (body.sourceId === body.targetId) {
      return reply.status(400).send({ error: { code: 'SAME_TENANT', message: 'Source and target must differ' } })
    }
    const src = body.sourceId
    const dst = body.targetId
    // memberTenantIds = every company the operator belongs to (non-GET, so
    // never narrowed by the active-company header). Checked before any DB
    // read so a guessed id never confirms a company exists.
    for (const id of [src, dst]) {
      if (!req.staffUser!.memberTenantIds.includes(id)) throw new NotFoundError('Tenant', id)
    }
    const live = await prisma.tenant.findMany({
      where: { id: { in: [src, dst] }, deletedAt: null },
      select: { id: true },
    })
    for (const id of [src, dst]) {
      if (!live.some((t) => t.id === id)) throw new NotFoundError('Tenant', id)
    }

    await assertMergeable(prisma, src, dst)
    // FIFO lots: a company on lots and one not would leave the merged items
    // half on lots (or cut over twice) — cut the other one over first.
    const [srcFifo, dstFifo] = await Promise.all([readFifoCutoverAt(prisma, src), readFifoCutoverAt(prisma, dst)])
    if ((srcFifo || dstFifo) && !(srcFifo && dstFifo)) {
      await ensureFifoReady(src)
      await ensureFifoReady(dst)
    }
    const srcSlug = (await prisma.tenant.findUniqueOrThrow({ where: { id: src }, select: { slug: true } })).slug

    const result = await prisma.$transaction(async (tx) => {
      await assertMergeable(tx, src, dst)
      // Refuse before any write if a kitchen staffer (unique per company on
      // CNIC) exists on both sides.
      const srcStaff = await tx.kitchenStaff.findMany({ where: { tenantId: src }, select: { cnic: true } })
      if (srcStaff.length > 0) {
        const dstStaff = await tx.kitchenStaff.findMany({
          where: { tenantId: dst, cnic: { in: srcStaff.map((s) => s.cnic) } },
          select: { cnic: true },
        })
        if (dstStaff.length > 0) {
          throw new ConflictError(
            `Kitchen staff with CNIC ${dstStaff.map((s) => s.cnic).join(', ')} exist in both companies — resolve them before merging`,
          )
        }
      }

      const conceptsMoved = await tx.concept.updateMany({
        where: { tenantId: src }, data: { tenantId: dst },
      })
      const usersMoved = await tx.user.updateMany({
        where: { tenantId: src }, data: { tenantId: dst },
      })
      // Move memberships — but preserve unique (userId, tenantId). Drop members
      // already in target; otherwise repoint to target.
      const sourceMembers = await tx.tenantMember.findMany({ where: { tenantId: src } })
      for (const m of sourceMembers) {
        const exists = await tx.tenantMember.findUnique({
          where: { userId_tenantId: { userId: m.userId, tenantId: dst } },
        })
        if (exists) {
          await tx.tenantMember.delete({ where: { id: m.id } })
        } else {
          await tx.tenantMember.update({ where: { id: m.id }, data: { tenantId: dst } })
        }
      }

      // Company master data with no company-keyed unique constraint (kitchen
      // staff included — CNIC clashes were refused above): a straight repoint.
      // The ledger merges account-by-account: both companies run the same
      // code numbers (4001, 1010, …) on separate rows, so every journal line
      // pointing at a source account is repointed to the destination's account
      // with the same code before the entries move. A code the destination
      // doesn't have is carried across as-is. Source accounts are then retired.
      // Inter-company pair accounts with no entries (assertMergeable refused
      // any with entries) are lazy — ensurePairAccounts re-creates them — so
      // the source's, and the target's facing the source, are dropped first:
      // they would otherwise land on another pair's code or face themselves.
      await tx.account.deleteMany({
        where: { controlledBy: 'intercompany', OR: [{ tenantId: src }, { tenantId: dst, counterpartyTenantId: src }] },
      })
      const srcAccounts = await tx.account.findMany({
        where: { tenantId: src }, select: { id: true, code: true },
      })
      if (srcAccounts.length > 0) {
        const dstAccounts = await tx.account.findMany({
          where: { tenantId: dst, code: { in: srcAccounts.map((a) => a.code) } },
          select: { id: true, code: true },
        })
        const dstByCode = new Map(dstAccounts.map((a) => [a.code, a.id]))
        for (const a of srcAccounts) {
          const twin = dstByCode.get(a.code)
          if (twin) {
            await tx.journalLine.updateMany({ where: { accountId: a.id }, data: { accountId: twin } })
            await tx.account.delete({ where: { id: a.id } })
          } else {
            await tx.account.update({ where: { id: a.id }, data: { tenantId: dst } })
          }
        }
      }

      const repoint: Array<{
        updateMany(args: { where: { tenantId: string }; data: { tenantId: string } }): Promise<unknown>
      }> = [
        tx.location, tx.inventoryItem, tx.supplier, tx.rider, tx.modifierTemplate,
        tx.bankAccount, tx.kdsDevice, tx.webhookSubscription, tx.domain,
        tx.deliveryZone, tx.notificationTemplate, tx.scheduledReport, tx.shift,
        tx.journalEntry, tx.periodLock,
        tx.capitalLedgerEntry, tx.capexProject, tx.opexCategory, tx.proForma, tx.projection,
        tx.position, tx.kitchenStaff, tx.kitchenPayrollRun, tx.complianceViolation,
      ]
      for (const model of repoint) {
        await model.updateMany({ where: { tenantId: src }, data: { tenantId: dst } })
      }

      // Finance wave B tables (see mergeFinanceTables).
      const finance = await mergeFinanceTables(tx, src, dst, srcSlug)

      // Per-company singleton configs — unique on (tenantId, scope, scopeId).
      // The target's row wins on a clash; the source's duplicate is dropped.
      // Concept-scoped rows can't clash: their scopeId is a brand that just
      // moved with the source.
      const singletons: Array<{
        findMany(args: { where: { tenantId: string }; select: { id: true; scope: true; scopeId: true } }):
          Promise<Array<{ id: string; scope: string; scopeId: string | null }>>
        update(args: { where: { id: string }; data: { tenantId: string } }): Promise<unknown>
        delete(args: { where: { id: string } }): Promise<unknown>
      }> = [tx.refundPolicy, tx.reservationPolicy, tx.receiptConfig, tx.operationsConfig]
      const scopeKey = (r: { scope: string; scopeId: string | null }) => `${r.scope}:${r.scopeId ?? ''}`
      for (const model of singletons) {
        const srcRows = await model.findMany({ where: { tenantId: src }, select: { id: true, scope: true, scopeId: true } })
        if (srcRows.length === 0) continue
        const dstRows = await model.findMany({ where: { tenantId: dst }, select: { id: true, scope: true, scopeId: true } })
        const taken = new Set(dstRows.map(scopeKey))
        for (const r of srcRows) {
          if (taken.has(scopeKey(r))) await model.delete({ where: { id: r.id } })
          else await model.update({ where: { id: r.id }, data: { tenantId: dst } })
        }
      }

      // Wage settings: one row per company.
      const srcWages = await tx.wageSettings.findUnique({ where: { tenantId: src }, select: { id: true } })
      if (srcWages) {
        const dstWages = await tx.wageSettings.findUnique({ where: { tenantId: dst }, select: { id: true } })
        if (dstWages) await tx.wageSettings.delete({ where: { id: srcWages.id } })
        else await tx.wageSettings.update({ where: { id: srcWages.id }, data: { tenantId: dst } })
      }

      // Departments and shift bands are unique per (company, name) and are
      // referenced by positions: a same-named row on the target absorbs the
      // source's positions, otherwise the row itself moves.
      const srcDepts = await tx.department.findMany({ where: { tenantId: src }, select: { id: true, name: true } })
      if (srcDepts.length > 0) {
        const dstDepts = await tx.department.findMany({ where: { tenantId: dst }, select: { id: true, name: true } })
        const twinByName = new Map(dstDepts.map((d) => [d.name, d.id]))
        for (const d of srcDepts) {
          const twin = twinByName.get(d.name)
          if (twin) {
            await tx.position.updateMany({ where: { departmentId: d.id }, data: { departmentId: twin } })
            await tx.department.delete({ where: { id: d.id } })
          } else {
            await tx.department.update({ where: { id: d.id }, data: { tenantId: dst } })
          }
        }
      }
      const srcBands = await tx.shiftBand.findMany({ where: { tenantId: src }, select: { id: true, name: true } })
      if (srcBands.length > 0) {
        const dstBands = await tx.shiftBand.findMany({ where: { tenantId: dst }, select: { id: true, name: true } })
        const twinByName = new Map(dstBands.map((b) => [b.name, b.id]))
        for (const b of srcBands) {
          const twin = twinByName.get(b.name)
          if (twin) {
            await tx.position.updateMany({ where: { shiftBandId: b.id }, data: { shiftBandId: twin } })
            await tx.shiftBand.delete({ where: { id: b.id } })
          } else {
            await tx.shiftBand.update({ where: { id: b.id }, data: { tenantId: dst } })
          }
        }
      }

      // Component par levels — unique on (tenantId, componentId, date); the
      // target's figure wins for a day it already tracks.
      const srcPars = await tx.componentParLevel.findMany({
        where: { tenantId: src }, select: { id: true, componentId: true, date: true },
      })
      if (srcPars.length > 0) {
        const dstPars = await tx.componentParLevel.findMany({
          where: { tenantId: dst, componentId: { in: srcPars.map((p) => p.componentId) } },
          select: { componentId: true, date: true },
        })
        const parKey = (p: { componentId: string; date: Date }) => `${p.componentId}:${p.date.toISOString()}`
        const taken = new Set(dstPars.map(parKey))
        for (const p of srcPars) {
          if (taken.has(parKey(p))) await tx.componentParLevel.delete({ where: { id: p.id } })
          else await tx.componentParLevel.update({ where: { id: p.id }, data: { tenantId: dst } })
        }
      }

      // Inter-company contributions: repoint both ends. One that would now
      // pay the target from the target is meaningless and is closed out.
      await tx.tenantContribution.updateMany({ where: { sourceTenantId: src }, data: { sourceTenantId: dst } })
      await tx.tenantContribution.updateMany({ where: { destinationTenantId: src }, data: { destinationTenantId: dst } })
      await tx.tenantContribution.updateMany({
        where: { sourceTenantId: dst, destinationTenantId: dst, isActive: true },
        data: { isActive: false, endedAt: new Date() },
      })

      // Soft-delete the source tenant
      await tx.tenant.update({
        where: { id: src },
        data: { deletedAt: new Date(), isActive: false },
      })
      return { conceptsMoved: conceptsMoved.count, usersMoved: usersMoved.count, ...finance }
    }, {
      // Many sequential statements — the default 5s interactive-transaction
      // budget is too tight for a company with real history.
      maxWait: 10_000,
      timeout: 60_000,
    })
    return result
  })

  // ── Update tenant — owner edits company name, industry, timezone, etc.
  // No password / no signup; this only mutates safe profile fields. The
  // onboarding wizard hits this on every "Continue". Only a company the
  // operator belongs to — a foreign id 404s rather than confirming it exists.
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      name:        z.string().min(1).max(200).optional(),
      industry:    z.string().max(40).nullable().optional(),
      countryCode: z.string().length(2).optional(),
      currency:    z.string().length(3).optional(),
      timezone:    z.string().max(64).optional(),
      // JV config: flip a tenant into JV mode and supply the partner shares.
      // Empty jvPartners (null) when isJointVenture=false. Frontend uses
      // this to render "Viva 60% / GS 40%" chips on every cost line.
      isJointVenture: z.boolean().optional(),
      jvPartners: z.array(z.object({
        label: z.string().min(1).max(80),
        pct:   z.number().min(0).max(100),
      })).nullable().optional(),
      // H29: the last month of the company's fiscal year (6 = 30 June). The
      // roll-forward is virtual, so a change re-presents every year at once.
      fiscalYearEndMonth: z.number().int().min(1).max(12).optional(),
      // Required to move the year end once the books were closed across one.
      reason: z.string().trim().max(500).optional(),
    }).parse(req.body)
    // memberTenantIds = every company the operator belongs to (non-GET, so
    // never narrowed by the active-company header).
    if (!req.staffUser!.memberTenantIds.includes(req.params.id)) throw new NotFoundError('Tenant', req.params.id)
    const existing = await prisma.tenant.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true, fiscalYearEndMonth: true },
    })
    if (!existing) throw new NotFoundError('Tenant', req.params.id)
    const { reason, fiscalYearEndMonth, ...profile } = body
    const fromMonth = existing.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH
    const fyChange = fiscalYearEndMonth !== undefined && fiscalYearEndMonth !== fromMonth
    // Once a close has spanned a year end (under the old or the new month),
    // a change re-presents closed years: the CEO says why, it is audited and
    // flagged.
    const afterYearEndClose = fyChange && await closedAcrossYearEnd(prisma, existing.id, [fromMonth, fiscalYearEndMonth!])
    if (afterYearEndClose && (reason?.length ?? 0) < 10) {
      throw new AppError(
        'FY_CHANGE_AFTER_YEAR_END_CLOSE',
        `${existing.name}'s books are already closed across a fiscal year end — moving the year end re-presents those closed years. Give a reason (at least 10 characters) to change it.`,
        409,
      )
    }
    const updated = await prisma.tenant.update({
      where: { id: existing.id },
      data: {
        ...profile,
        ...(fyChange ? { fiscalYearEndMonth } : {}),
        jvPartners: profile.jvPartners === undefined ? undefined : (profile.jvPartners ?? undefined),
      },
    })
    if (fyChange) {
      await audit({ category: 'accounting',
        action: 'tenant.fiscal_year_end',
        entity: 'Tenant',
        entityId: existing.id,
        userId: req.staffUser!.id, tenantId: existing.id,
        userEmail: req.staffUser!.email,
        before: { fiscalYearEndMonth: fromMonth },
        after: { fiscalYearEndMonth },
        metadata: { ip: req.ip, reason: reason ?? null, afterYearEndClose },
      })
      if (afterYearEndClose) {
        const { flagException } = await import('../../lib/exceptions.js')
        await flagException({
          tenantId: existing.id,
          kind: 'period_close_override',
          severity: 'high',
          title: `Fiscal year end moved after a year-end close (month ${fromMonth} → ${fiscalYearEndMonth})`,
          description: `${req.staffUser!.email} changed ${existing.name}'s fiscal year end from month ${fromMonth} to ${fiscalYearEndMonth} after its books were closed across a year end. `
            + `Retained earnings b/f and profit for the year are now split on the new boundary for every year, closed ones included. Reason: ${reason}.`,
          entityType: 'Tenant',
          entityId: existing.id,
          actorId: req.staffUser!.id,
          metadata: { from: fromMonth, to: fiscalYearEndMonth, reason },
        })
      }
    }
    return updated
  })

  // ── Apply a template to the ACTIVE company (in-app — for owners who want
  // to bootstrap a new concept after the initial signup). Binds the new brand
  // to req.staffUser.tenantId, which honours x-servd-active-tenant — never to
  // the user's primary company, or a brand picked for GSX Viva would land in
  // GS Foods.
  fastify.post(
    '/apply-template',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = z.object({
        templateKey: z.enum(TEMPLATE_KEYS as [string, ...string[]]),
        conceptName: z.string().min(1).max(100).optional(),
        // The new brand's primary service vessel — a REQUIRED choice at brand
        // creation, no default (owner's FINAL packaging rule; same field as
        // POST /concepts): 'plate' or 'packaging' (packaging IS the vessel,
        // e.g. Stackd — a dish's Packaging section is used on every order).
        serviceVessel: z.enum(['plate', 'packaging']),
      }).parse(req.body)

      const tpl = getTemplate(body.templateKey)
      if (!tpl) return reply.status(400).send({ error: { code: 'BAD_TEMPLATE' } })

      const tenantId = req.staffUser!.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before applying a template', 422)

      const conceptName = body.conceptName ?? tpl.conceptName
      const conceptSlug = await uniqueSlug(conceptName, 'concept')

      const concept = await prisma.$transaction(async (tx) => {
        const c = await tx.concept.create({
          data: {
            tenantId,
            slug: conceptSlug, name: conceptName, type: tpl.conceptType, serviceVessel: body.serviceVessel,
            primaryColor: tpl.primaryColor, taxRate: tpl.taxRate,
            heroTagline: tpl.heroTagline, isActive: true, storefrontVisible: true,
          },
        })
        const stations = await Promise.all(
          tpl.stations.map((n) => tx.station.create({ data: { conceptId: c.id, name: n } })),
        )
        const stationByName = new Map(stations.map((s) => [s.name, s]))
        const cats = await Promise.all(
          tpl.categories.map((n, i) => tx.category.create({ data: { conceptId: c.id, name: n, sortOrder: i } })),
        )
        const catByName = new Map(cats.map((c) => [c.name, c]))
        for (const it of tpl.items) {
          const cat = catByName.get(it.category)
          if (!cat) continue
          const sid = it.station ? stationByName.get(it.station)?.id ?? null : null
          const m = await tx.menuItem.create({
            data: {
              conceptId: c.id, categoryId: cat.id, name: it.name, nameUrdu: it.nameUrdu ?? null,
              description: it.description ?? null, priceCents: it.priceCents, stationId: sid, isAvailable: true,
            },
          })
          if (it.recipe) {
            await tx.recipe.create({
              data: {
                menuItemId: m.id, servings: 1,
                laborMinutes: it.recipe.laborMinutes ?? 0,
                steps: it.recipe.steps ?? null,
                seasons: it.recipe.seasons ?? [],
                isActive: true,
              },
            })
          }
        }
        return c
      })

      return reply.status(201).send({ conceptId: concept.id, conceptSlug: concept.slug })
    },
  )
}
