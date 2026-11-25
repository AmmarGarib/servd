// Shareholder funding — what each shareholder has put in against the agreed split (owner, 2026-11-24: "just add a page
// somewhere that shows how much variance there is so we are always aware of any shareholding disparity"; "Variance of
// shareholding, on 60/40 basis. 60 for Yousuf and 40 for GS"; Flipd only).
//
// PER COMPANY: a company's shareholders, each with an agreed share and the ledger accounts (liability / equity, of
// THAT company) holding what they put in. A company with none set shows nothing — that is how it is "Flipd only".
// READ ONLY over the ledger: funded = Σ (credits − debits) of the shareholder's accounts as at the day asked;
// expected = total funded × share; variance = funded − expected (plus = put in MORE than their share).
// `topUpCents` = what each must still put in for everyone to stand at the agreed split without anyone taking money
// out (the most-ahead shareholder sets the level). Posts nothing; no report, return or posting reads it.
//
//   GET /accounting/shareholders?asOf=YYYY-MM-DD   CEO, co-owner, management, finance — the ACTIVE company
//   GET /accounting/shareholders/accounts          the active company's liability / equity accounts (the picker)
//   PUT /accounting/shareholders {shareholders:[{name, sharePercent, accountCodes[]}]}   the CEO or finance holding
//        `accounting` (owner, 2026-11-25) — replaces the
//        list; shares must add up to 100 (422 SHARES_NOT_100); an account of another type or company 422
//        ACCOUNT_NOT_ALLOWED; one account under two shareholders 422 ACCOUNT_LISTED_TWICE. [] clears it. Audited
//        `shareholders.set`.
// Table `shareholders` (tenantId, RLS, merge repoint). Tests: tests/shareholders.test.ts.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { toCents } from '../../lib/money.js'
import type { UserRole } from '@prisma/client'
import { requireAuth } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { parsePktEndOfDay } from './dates.js'

const FUNDING_TYPES = ['liability', 'equity']
// Who sets a company's shareholders: the CEO, and finance holding `accounting` (owner, 2026-11-25: "Let finance set up
// shareholders also").
const EDITORS = ['admin', 'finance'] as UserRole[]

/** Credits − debits per account code of one company, as at `asOf` (all time when null). */
async function fundingByCode(tenantId: string, codes: string[], asOf: Date | null): Promise<Map<string, { name: string; balanceCents: number }>> {
  const out = new Map<string, { name: string; balanceCents: number }>()
  if (codes.length === 0) return out
  const accounts = await prisma.account.findMany({ where: { tenantId, code: { in: codes } }, select: { id: true, code: true, name: true } })
  const sums = await prisma.journalLine.groupBy({
    by: ['accountId', 'type'], _sum: { amountCents: true },
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: { tenantId, ...(asOf ? { entryDate: { lte: asOf } } : {}) } },
  })
  for (const a of accounts) {
    const of = (t: string) => toCents(sums.find((s) => s.accountId === a.id && s.type === t)?._sum.amountCents ?? 0)
    out.set(a.code, { name: a.name, balanceCents: of('credit') - of('debit') })
  }
  return out
}

export async function shareholdingOf(tenantId: string, asOf: Date | null) {
  const rows = await prisma.shareholder.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  const balances = await fundingByCode(tenantId, [...new Set(rows.flatMap((r) => r.accountCodes))], asOf)
  const funded = rows.map((r) => r.accountCodes.reduce((t, c) => t + (balances.get(c)?.balanceCents ?? 0), 0))
  const totalCents = funded.reduce((a, b) => a + b, 0)
  // The level at which nobody takes money out: the most-ahead shareholder's funding ÷ their share.
  const level = rows.reduce((m, r, i) => Math.max(m, r.shareBps > 0 ? (funded[i]! * 10000) / r.shareBps : 0), 0)
  return {
    totalCents,
    shareholders: rows.map((r, i) => {
      const expectedCents = Math.round((totalCents * r.shareBps) / 10000)
      return {
        id: r.id, name: r.name, sharePercent: r.shareBps / 100,
        accounts: r.accountCodes.map((code) => ({ code, name: balances.get(code)?.name ?? null, balanceCents: balances.get(code)?.balanceCents ?? 0, missing: !balances.has(code) })),
        fundedCents: funded[i]!, fundedPercent: totalCents > 0 ? Math.round((funded[i]! * 10000) / totalCents) / 100 : 0,
        expectedCents, varianceCents: funded[i]! - expectedCents,
        topUpCents: Math.max(0, Math.round((level * r.shareBps) / 10000) - funded[i]!),
      }
    }),
  }
}

export async function shareholderRoutes(fastify: FastifyInstance) {
  const readers = requireAuth('admin', 'owner', 'management', 'finance')
  const activeTenant = (req: FastifyRequest) => {
    const t = req.staffUser!.tenantId
    if (!t) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company — shareholders are kept per company', 422)
    return t
  }

  fastify.get<{ Querystring: { asOf?: string } }>('/', { preHandler: readers }, async (req) => {
    const tenantId = activeTenant(req)
    const asOf = req.query.asOf ? parsePktEndOfDay(req.query.asOf) : null
    if (asOf && Number.isNaN(asOf.getTime())) throw new AppError('INVALID_DATE', 'That is not a date', 422)
    const company = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
    return { tenantId, companyName: company?.name ?? null, asOf: req.query.asOf ?? null, canEdit: EDITORS.includes(req.staffUser!.role), ...(await shareholdingOf(tenantId, asOf)) }
  })

  fastify.get('/accounts', { preHandler: readers }, async (req) => {
    const tenantId = activeTenant(req)
    const accounts = await prisma.account.findMany({ where: { tenantId, type: { in: FUNDING_TYPES as never[] } }, select: { code: true, name: true, type: true, isActive: true }, orderBy: { code: 'asc' } })
    const balances = await fundingByCode(tenantId, accounts.map((a) => a.code), null)
    return { accounts: accounts.map((a) => ({ ...a, balanceCents: balances.get(a.code)?.balanceCents ?? 0 })) }
  })

  fastify.put('/', { preHandler: [requireAuth(...EDITORS), requireModule('accounting')] }, async (req) => {
    const body = z.object({
      shareholders: z.array(z.object({
        name: z.string().trim().min(1).max(120),
        sharePercent: z.number().positive().max(100),
        accountCodes: z.array(z.string().trim().min(1).max(20)).max(20),
      })).max(20),
    }).parse(req.body ?? {})
    const tenantId = activeTenant(req)
    const list = body.shareholders.map((s, i) => ({ name: s.name, shareBps: Math.round(s.sharePercent * 100), accountCodes: [...new Set(s.accountCodes)], sortOrder: i }))
    if (new Set(list.map((s) => s.name.toLowerCase())).size !== list.length) throw new AppError('SHAREHOLDER_LISTED_TWICE', 'Each shareholder is listed once', 422)
    if (list.length && list.reduce((t, s) => t + s.shareBps, 0) !== 10000) throw new AppError('SHARES_NOT_100', 'The shares must add up to 100%', 422)
    const codes = list.flatMap((s) => s.accountCodes)
    if (new Set(codes).size !== codes.length) throw new AppError('ACCOUNT_LISTED_TWICE', 'An account can sit under one shareholder only', 422)
    const ok = await prisma.account.findMany({ where: { tenantId, code: { in: codes }, type: { in: FUNDING_TYPES as never[] } }, select: { code: true } })
    const bad = codes.filter((c) => !ok.some((a) => a.code === c))
    if (bad.length) throw new AppError('ACCOUNT_NOT_ALLOWED', `Account ${bad.join(', ')} is not a liability or equity account of this company`, 422)
    const before = await prisma.shareholder.findMany({ where: { tenantId }, select: { name: true, shareBps: true, accountCodes: true } })
    await prisma.$transaction([
      prisma.shareholder.deleteMany({ where: { tenantId } }),
      prisma.shareholder.createMany({ data: list.map((s) => ({ ...s, tenantId })) }),
    ])
    await audit({
      category: 'accounting', action: 'shareholders.set', entity: 'Shareholder', entityId: tenantId, tenantId,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, before, after: list, metadata: { actorRole: req.staffUser!.role },
    })
    return { saved: true, ...(await shareholdingOf(tenantId, null)) }
  })
}
