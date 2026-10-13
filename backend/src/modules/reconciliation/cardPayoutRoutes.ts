// /reconciliation/card-payouts — card payouts at payout (H12, finance wave B).
// Registered from reconciliationRoutes, so the module gate is
// 'reconciliation'. The logic is ./cardPayouts.ts; the split posting is
// BOOKS-11's own (service.ts postCardPayoutSplitTx).
//
//   GET  /settings                     the active company's settings (FINANCIALS_VIEWERS)
//   PUT  /settings                     save them (admin, finance; audited)
//   GET  /                             settlements + unsettled card days of
//                                      the companies in view (FINANCIALS_VIEWERS)
//   GET  /lines/:lineId/suggestions    runs of card days a payout line could
//                                      be (FINANCIALS_VIEWERS; read scope)
//   POST /lines/:lineId/confirm        book a line against named card days
//                                      (admin, owner, finance; write scope)
//   POST /:settlementId/undo           reverse + free the days (APPROVERS)
//   POST /rematch                      re-run the automatic pass for the
//                                      active company (admin, finance)
//
// Company scope: a line / settlement of another company is 404; the payout
// bank must be the active company's (422 BANK_ACCOUNT_NOT_IN_COMPANY). Every
// write is audited in the DOCUMENT's company (the statement's / the
// settings').

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, APPROVERS, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, resolveTenantScope, activeTenantId } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { toCents } from '../../lib/money.js'
import {
  cardSettlementSettings, saveCardSettlementSettings, cardSettlementFields, settleCardPayout, undoCardSettlement,
  rematchCardPayouts, cardSuggestionsForLine, unsettledCardDays, dayNum, dayNumOf, dayStr, MAX_CONFIRM_DAYS,
  type CardSettlementSettings,
} from './cardPayouts.js'

/** Who edits the settings and re-runs matching (finance's own setting; the CEO). */
const SETTINGS_EDITORS = ['admin', 'finance'] as UserRole[]
/** Who confirms a payout against card days. */
const CONFIRMERS = ['admin', 'owner', 'finance'] as UserRole[]

const settingsPatch = z.object(cardSettlementFields).partial().strict()
const dayString = z.string().refine((s) => !Number.isNaN(dayNum(s)), 'A day as YYYY-MM-DD')

/** Unit → what people call it (a brand's name, a card machine's id). */
async function unitLabels(units: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const brandIds = units.filter((u) => u.startsWith('brand:')).map((u) => u.slice('brand:'.length))
  const brands = brandIds.length ? await prisma.concept.findMany({ where: { id: { in: brandIds } }, select: { id: true, name: true } }) : []
  const nameOf = new Map(brands.map((b) => [b.id, b.name]))
  for (const u of units) {
    if (u === 'company') out.set(u, 'Whole company')
    else if (u.startsWith('brand:')) out.set(u, nameOf.get(u.slice('brand:'.length)) ?? 'A brand')
    else if (u === 'terminal:none') out.set(u, 'Card payments with no card machine')
    else out.set(u, `Card machine ${u.slice('terminal:'.length)}`)
  }
  return out
}

function settingsView(s: CardSettlementSettings) {
  return { ...s }
}

export default async function cardPayoutRoutes(fastify: FastifyInstance): Promise<void> {
  // ── GET /settings ────────────────────────────────────────────────────────
  fastify.get('/settings', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const tenantId = activeTenantId(req, 'card payout settings are per company')
    const s = await cardSettlementSettings(prisma, tenantId)
    const bank = s.payoutBankAccountId
      ? await prisma.bankAccount.findFirst({ where: { id: s.payoutBankAccountId, tenantId }, select: { id: true, name: true, bankName: true, accountCode: true, isActive: true, deletedAt: true } })
      : null
    return {
      tenantId,
      settings: settingsView(s),
      payoutBank: bank ? { id: bank.id, name: bank.name, bankName: bank.bankName, accountCode: bank.accountCode, live: bank.isActive && !bank.deletedAt } : null,
      canEdit: (SETTINGS_EDITORS as string[]).includes(req.staffUser!.role),
    }
  })

  // ── PUT /settings (admin, finance) ───────────────────────────────────────
  // Merged over the stored settings. The payout bank must be a live, linked
  // bank of the ACTIVE company (422 BANK_ACCOUNT_NOT_IN_COMPANY). startDay is
  // today on the first switch-on; an earlier one must be after the last
  // manual split that cleared 1030 (422 START_DAY_BEFORE_MANUAL_SPLIT).
  fastify.put('/settings', { preHandler: requireAuth(...SETTINGS_EDITORS) }, async (req) => {
    const tenantId = activeTenantId(req, 'card payout settings are per company')
    const body = settingsPatch.parse(req.body ?? {})
    const { before, after } = await saveCardSettlementSettings(prisma, tenantId, body, req.staffUser!.id)
    await audit({
      category: 'accounting', action: 'card_payouts.settings', entity: 'OperationsConfig',
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      before, after, metadata: { changed: Object.keys(body) },
    })
    return { tenantId, settings: settingsView(after) }
  })

  // ── GET / ────────────────────────────────────────────────────────────────
  // Settlements whose last card day is in [from, to] (default: the last 90
  // days) and the card days with no payout yet, of every company in view.
  fastify.get<{ Querystring: { from?: string; to?: string } }>('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const q = z.object({ from: dayString.optional(), to: dayString.optional() }).parse(req.query)
    const scope = await resolveTenantScope(req)
    const today = dayNumOf(new Date())
    const toN = q.to ? dayNum(q.to) : today
    const fromN = q.from ? dayNum(q.from) : today - 90
    if (fromN > toN) throw new AppError('BAD_RANGE', 'From must be on or before to', 400)

    const rows = await prisma.cardSettlement.findMany({
      where: { tenantId: { in: scope.tenantIds }, dayTo: { gte: dayStr(fromN), lte: dayStr(toN) } },
      include: { days: { select: { day: true, grossCents: true }, orderBy: { day: 'asc' } } },
      orderBy: [{ dayTo: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    })
    const lineIds = rows.map((r) => r.statementLineId)
    const lines = lineIds.length
      ? await prisma.bankStatementLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, postedDate: true, description: true, reference: true, amountCents: true, matchStatus: true } })
      : []
    const lineOf = new Map(lines.map((l) => [l.id, l]))
    const bankIds = [...new Set(rows.map((r) => r.bankAccountId))]
    const banks = bankIds.length ? await prisma.bankAccount.findMany({ where: { id: { in: bankIds } }, select: { id: true, name: true, bankName: true } }) : []
    const bankOf = new Map(banks.map((b) => [b.id, b]))
    const userIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))]
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
    const userOf = new Map(users.map((u) => [u.id, u.name]))

    const companies = []
    const units = new Set(rows.map((r) => r.unit))
    for (const tenantId of scope.tenantIds) {
      const s = await cardSettlementSettings(prisma, tenantId)
      const unsettled = await unsettledCardDays(prisma, tenantId, s, Math.min(toN, today - 1), fromN)
      for (const d of unsettled) units.add(d.unit)
      companies.push({
        tenantId,
        enabled: s.enabled,
        settings: settingsView(s),
        unsettled: unsettled.map((d) => ({ ...d, ageDays: today - dayNum(d.day) })),
        unsettledCents: unsettled.reduce((t, d) => t + d.cents, 0),
      })
    }
    const labels = await unitLabels([...units])
    const role = req.staffUser!.role
    return {
      from: dayStr(fromN),
      to: dayStr(toN),
      companies: companies.map((c) => ({ ...c, unsettled: c.unsettled.map((d) => ({ ...d, unitLabel: labels.get(d.unit) ?? d.unit })) })),
      settlements: rows.map((r) => {
        const line = lineOf.get(r.statementLineId)
        const bank = bankOf.get(r.bankAccountId)
        return {
          id: r.id, tenantId: r.tenantId, unit: r.unit, unitLabel: labels.get(r.unit) ?? r.unit, status: r.status,
          dayFrom: r.dayFrom, dayTo: r.dayTo,
          grossCents: toCents(r.grossCents), feeCents: toCents(r.feeCents), feeTaxCents: toCents(r.feeTaxCents), netCents: toCents(r.netCents),
          feeBps: toCents(r.grossCents) > 0 ? Math.round((toCents(r.feeCents) * 10_000) / toCents(r.grossCents)) : 0,
          journalEntryId: r.journalEntryId, createdAt: r.createdAt,
          createdBy: r.createdById ? { id: r.createdById, name: userOf.get(r.createdById) ?? null } : null,
          bankAccount: bank ? { id: bank.id, name: bank.name, bankName: bank.bankName } : null,
          statementLine: line ? { id: line.id, postedDate: line.postedDate, description: line.description, reference: line.reference, amountCents: toCents(line.amountCents), matchStatus: line.matchStatus } : null,
          days: r.days.map((d) => ({ day: d.day, grossCents: toCents(d.grossCents) })),
        }
      }),
      canConfirm: (CONFIRMERS as string[]).includes(role),
      canUndo: (APPROVERS as string[]).includes(role),
      canEditSettings: (SETTINGS_EDITORS as string[]).includes(role),
      canRematch: (SETTINGS_EDITORS as string[]).includes(role),
    }
  })

  // ── GET /lines/:lineId/suggestions ───────────────────────────────────────
  fastify.get<{ Params: { lineId: string } }>('/lines/:lineId/suggestions', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const line = await prisma.bankStatementLine.findFirst({
      where: { id: req.params.lineId, import: await scopeTenantWhere(req, 'read') },
      select: { id: true, postedDate: true, description: true, reference: true, amountCents: true, matchStatus: true, import: { select: { tenantId: true, bankAccountId: true } } },
    })
    if (!line || !line.import.tenantId) throw new NotFoundError('BankStatementLine', req.params.lineId)
    const amount = toCents(line.amountCents)
    const s = await cardSettlementSettings(prisma, line.import.tenantId)
    const onPayoutBank = !!s.payoutBankAccountId && line.import.bankAccountId === s.payoutBankAccountId
    const res = line.matchStatus === 'unmatched' && onPayoutBank
      ? await cardSuggestionsForLine(prisma, line.import.tenantId, { postedDate: line.postedDate, amountCents: amount })
      : { settings: s, suggestions: [] }
    const labels = await unitLabels([...new Set(res.suggestions.map((x) => x.unit))])
    return {
      line: { id: line.id, tenantId: line.import.tenantId, postedDate: line.postedDate, description: line.description, reference: line.reference, amountCents: amount, matchStatus: line.matchStatus },
      enabled: s.enabled,
      onPayoutBank,
      settings: { unitMode: s.unitMode, mdrBps: s.mdrBps, feeTaxBps: s.feeTaxBps, maxFeeBps: s.maxFeeBps, toleranceBps: s.toleranceBps, startDay: s.startDay },
      suggestions: res.suggestions.map((x) => ({ ...x, unitLabel: labels.get(x.unit) ?? x.unit })),
      canConfirm: (CONFIRMERS as string[]).includes(req.staffUser!.role),
    }
  })

  // ── POST /lines/:lineId/confirm (admin, owner, finance) ──────────────────
  // Refusals: 409 LINE_NOT_UNMATCHED / DAY_ALREADY_SETTLED; 422
  // NO_CARD_MONEY_ON_DAYS / FEE_OUT_OF_RANGE / PERIOD_LOCKED / CARD_PAYOUTS_OFF /
  // NOT_THE_PAYOUT_BANK / CARD_DAYS_INVALID / CARD_UNIT_INVALID / DAY_BEFORE_START.
  fastify.post<{ Params: { lineId: string } }>('/lines/:lineId/confirm', { preHandler: requireAuth(...CONFIRMERS) }, async (req, reply) => {
    const body = z.object({
      days: z.array(dayString).min(1).max(MAX_CONFIRM_DAYS),
      unit: z.string().trim().min(1).max(120).optional(),
    }).parse(req.body)
    const line = await prisma.bankStatementLine.findFirst({
      where: { id: req.params.lineId, import: await scopeTenantWhere(req, 'write') },
      select: { id: true, amountCents: true, import: { select: { tenantId: true } } },
    })
    if (!line || !line.import.tenantId) throw new NotFoundError('BankStatementLine', req.params.lineId)
    const tenantId = line.import.tenantId
    const res = await settleCardPayout({ tenantId, lineId: line.id, unit: body.unit ?? 'company', days: body.days, status: 'confirmed', actorId: req.staffUser!.id })
    const st = await prisma.cardSettlement.findUniqueOrThrow({ where: { id: res.settlementId }, include: { days: { select: { day: true, grossCents: true } } } })
    await audit({
      category: 'accounting', action: 'card_payouts.confirm', entity: 'CardSettlement', entityId: st.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      after: { lineId: line.id, unit: st.unit, dayFrom: st.dayFrom, dayTo: st.dayTo, grossCents: toCents(st.grossCents), feeCents: toCents(st.feeCents), netCents: toCents(st.netCents), entryId: res.entryId },
      metadata: { days: body.days, actorTenantId: req.staffUser!.tenantId ?? null },
    })
    return reply.status(201).send({
      id: st.id, tenantId, unit: st.unit, status: st.status, dayFrom: st.dayFrom, dayTo: st.dayTo,
      grossCents: toCents(st.grossCents), feeCents: toCents(st.feeCents), netCents: toCents(st.netCents), journalEntryId: res.entryId,
      days: st.days.map((d) => ({ day: d.day, grossCents: toCents(d.grossCents) })),
    })
  })

  // ── POST /:settlementId/undo (APPROVERS) ─────────────────────────────────
  fastify.post<{ Params: { settlementId: string } }>('/:settlementId/undo', { preHandler: requireAuth(...APPROVERS) }, async (req) => {
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
    const st = await prisma.cardSettlement.findFirst({
      where: { id: req.params.settlementId, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true, tenantId: true, statementLineId: true, unit: true, dayFrom: true, dayTo: true, status: true, grossCents: true, feeCents: true, netCents: true, journalEntryId: true },
    })
    if (!st) throw new NotFoundError('CardSettlement', req.params.settlementId)
    const res = await undoCardSettlement({ settlementId: st.id, tenantId: st.tenantId, actorId: req.staffUser!.id, reason: body.reason })
    await audit({
      category: 'accounting', action: 'card_payouts.undo', entity: 'CardSettlement', entityId: st.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: st.tenantId,
      before: { ...st, grossCents: toCents(st.grossCents), feeCents: toCents(st.feeCents), netCents: toCents(st.netCents) },
      after: { deleted: true, reversalEntryId: res.reversalEntryId, lineMatchStatus: 'unmatched' },
      metadata: { reason: body.reason, days: res.days, actorTenantId: req.staffUser!.tenantId ?? null },
    })
    return { ok: true, lineId: res.lineId, reversalEntryId: res.reversalEntryId, days: res.days }
  })

  // ── POST /rematch (admin, finance) ───────────────────────────────────────
  // The active company's unmatched credits on its payout bank of the last 60
  // days. A refusal stays on its line (and its card_payout_unmatched flag).
  fastify.post('/rematch', { preHandler: requireAuth(...SETTINGS_EDITORS) }, async (req) => {
    const tenantId = activeTenantId(req, 'card payouts are matched per company')
    const res = await rematchCardPayouts({ tenantId })
    await audit({
      category: 'accounting', action: 'card_payouts.rematch', entity: 'CardSettlement',
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      after: { matched: res.matched, candidates: res.candidates, refused: res.refused.length },
      metadata: { refused: res.refused },
    })
    return res
  })
}
