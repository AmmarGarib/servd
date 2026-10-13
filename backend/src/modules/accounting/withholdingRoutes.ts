// /accounting/withholding — income-tax withholding rates and the register
// (finance wave B, H8 / H28). Under the '/accounting' module gate.
//
//   GET /rates     FINANCIALS_VIEWERS, the ACTIVE company: { enabled, rates,
//                  defaultsUsed, sections, canEdit }.
//   PUT /rates     admin, finance (TAX_PAYER_ROLES), the ACTIVE company:
//                  { rates: { [section]: { filerBps, nonFilerBps } } } — any
//                  sections given (0–5000 bps each, 422 WHT_RATE_OUT_OF_RANGE),
//                  merged over the company's current rates. Writes
//                  OperationsConfig.withholdingRates AND keeps
//                  withholdingTaxPct = the 153(1)(a) filer rate / 10000 —
//                  this is the ONLY writer of both (PATCH
//                  /setup/operations-config no longer takes the %). Audited.
//                  422 NO_ACTIVE_COMPANY.
//   GET /register  FINANCIALS_VIEWERS, resolveTenantScope (the active company,
//                  or every company in "All companies"): ?from&to (YYYY-MM-DD,
//                  default this month) [&format=csv]. One row per income-tax
//                  deduction: supplier bills (posted, not void; WHT net of
//                  the bill's live credit notes), paid OpEx payments and paid
//                  CapEx payments with WHT. For the CA's s.165 statement.
//
// The switch itself (OperationsConfig.withholdingTaxEnabled) stays on
// Configuration → Operations.

import type { FastifyInstance } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { toCents } from '../../lib/money.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { activeTenantId, resolveTenantScope } from '../../lib/tenantScope.js'
import {
  WHT_SECTIONS, WHT_SECTION_LABEL, MAX_WHT_BPS, isWhtSection, withholdingRatesFor,
  type WhtRates, type WhtSection,
} from '../../lib/withholding.js'
import { TAX_PAYER_ROLES } from './taxPayments.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay, pktToday } from './dates.js'
import { toCsv, fmtPkr } from './csv.js'

const RATE_EDITORS = [...TAX_PAYER_ROLES] as UserRole[]

/** What a register reader needs to know about the dates (H8 note for the CA). */
export const WITHHOLDING_REGISTER_NOTE =
  'Supplier bills: servd fixes the withholding when the bill is recorded (dated the bill date), while s.153 deducts it when the bill is PAID — '
  + 'agree with your CA which date the s.165 statement uses. OpEx and CapEx withholding is dated the day the payment was made. '
  + 'Bill rows are net of the withholding their credit notes reversed.'

export interface WithholdingRegisterRow {
  tenantId: string
  company: string
  /** YYYY-MM-DD (PKT): the bill date, or the day an OpEx / CapEx payment was made. */
  date: string
  source: 'supplier_bill' | 'opex' | 'capex'
  sourceId: string
  document: string
  vendor: string
  /** The vendor's NTN / STRN (Supplier.taxId). */
  ntn: string | null
  filerStatus: string | null
  section: WhtSection | null
  rateBps: number | null
  baseCents: number
  whtCents: number
  /** Supplier bills only: the withholding the bill's live credit notes reversed (already taken off whtCents). */
  creditNoteWhtCents?: number
  /** CapEx: the base is worked back from the fixed rate (the payment stores no base). */
  baseDerived?: boolean
}

const SOURCE_LABEL: Record<WithholdingRegisterRow['source'], string> = {
  supplier_bill: 'Supplier bill',
  opex: 'OpEx payment',
  capex: 'CapEx payment',
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function sectionOf(x: string | null | undefined): WhtSection | null {
  return isWhtSection(x) ? x : null
}

/** The register rows of `tenantIds` for [from, to]. */
export async function withholdingRegister(db: Prisma.TransactionClient, tenantIds: string[], from: Date, to: Date): Promise<WithholdingRegisterRow[]> {
  if (tenantIds.length === 0) return []
  const scope = { in: tenantIds }
  const [tenants, bills, opex, capex] = await Promise.all([
    db.tenant.findMany({ where: { id: scope }, select: { id: true, name: true } }),
    db.supplierBill.findMany({
      where: {
        kind: 'bill', status: { notIn: ['void', 'draft'] }, voidedAt: null,
        whtCents: { gt: 0 }, billDate: { gte: from, lte: to },
        supplier: { tenantId: scope },
      },
      select: {
        id: true, billNumber: true, billDate: true, subtotalCents: true, whtCents: true, whtSection: true, whtRateBps: true,
        supplier: { select: { tenantId: true, name: true, taxId: true, filerStatus: true } },
      },
      orderBy: { billDate: 'asc' },
    }),
    db.opexPayment.findMany({
      where: { paidAt: { gte: from, lte: to }, whtCents: { gt: 0 }, line: { category: { tenantId: scope } } },
      select: {
        id: true, paidAt: true, periodStart: true, actualCents: true, whtCents: true, inputTaxCents: true,
        whtSection: true, whtRateBps: true, filerStatus: true,
        line: {
          select: {
            name: true, vendor: true,
            supplier: { select: { name: true, taxId: true, filerStatus: true } },
            category: { select: { tenantId: true } },
          },
        },
      },
      orderBy: { paidAt: 'asc' },
    }),
    db.capexPayment.findMany({
      where: { paidAt: { gte: from, lte: to }, whtCents: { gt: 0 }, line: { project: { tenantId: scope } } },
      select: {
        id: true, paidAt: true, label: true, paidAmountCents: true, whtCents: true, whtSection: true, whtRateBps: true, filerStatus: true,
        line: {
          select: {
            item: true, vendor: true,
            supplierRecord: { select: { name: true, taxId: true, filerStatus: true } },
            project: { select: { tenantId: true, name: true } },
          },
        },
      },
      orderBy: { paidAt: 'asc' },
    }),
  ])
  const companyName = new Map(tenants.map((t) => [t.id, t.name]))

  // Credit notes reverse part of their bill's withholding: net them in.
  const cnByBill = new Map<string, { wht: number; subtotal: number }>()
  if (bills.length > 0) {
    const cns = await db.supplierBill.findMany({
      where: { kind: 'credit_note', status: { not: 'void' }, voidedAt: null, originalBillId: { in: bills.map((b) => b.id) } },
      select: { originalBillId: true, whtCents: true, subtotalCents: true },
    })
    for (const c of cns) {
      if (!c.originalBillId) continue
      const t = cnByBill.get(c.originalBillId) ?? { wht: 0, subtotal: 0 }
      t.wht += toCents(c.whtCents)
      t.subtotal += toCents(c.subtotalCents)
      cnByBill.set(c.originalBillId, t)
    }
  }

  const rows: WithholdingRegisterRow[] = []
  for (const b of bills) {
    const tenantId = b.supplier.tenantId
    if (!tenantId) continue
    const cn = cnByBill.get(b.id) ?? { wht: 0, subtotal: 0 }
    const wht = toCents(b.whtCents) - cn.wht
    if (wht <= 0) continue
    rows.push({
      tenantId, company: companyName.get(tenantId) ?? tenantId,
      date: fmtPktDate(b.billDate), source: 'supplier_bill', sourceId: b.id,
      document: `Bill ${b.billNumber}`,
      vendor: b.supplier.name, ntn: b.supplier.taxId, filerStatus: b.supplier.filerStatus,
      section: sectionOf(b.whtSection), rateBps: b.whtRateBps,
      baseCents: Math.max(0, toCents(b.subtotalCents) - cn.subtotal),
      whtCents: wht,
      creditNoteWhtCents: cn.wht,
    })
  }
  for (const p of opex) {
    const tenantId = p.line.category.tenantId
    if (!tenantId || !p.paidAt) continue
    const wht = toCents(p.whtCents)
    rows.push({
      tenantId, company: companyName.get(tenantId) ?? tenantId,
      date: fmtPktDate(p.paidAt), source: 'opex', sourceId: p.id,
      document: `${p.line.name} — ${fmtPktDate(p.periodStart).slice(0, 7)}`,
      vendor: p.line.supplier?.name ?? p.line.vendor ?? '—',
      ntn: p.line.supplier?.taxId ?? null,
      filerStatus: p.filerStatus ?? p.line.supplier?.filerStatus ?? null,
      section: sectionOf(p.whtSection), rateBps: p.whtRateBps,
      // The invoice (cash paid + withholding) less its sales tax — what the section taxes.
      baseCents: Math.max(0, toCents(p.actualCents ?? 0) + wht - toCents(p.inputTaxCents)),
      whtCents: wht,
    })
  }
  for (const p of capex) {
    const tenantId = p.line.project.tenantId
    if (!tenantId || !p.paidAt) continue
    const wht = toCents(p.whtCents)
    const rate = p.whtRateBps ?? 0
    rows.push({
      tenantId, company: companyName.get(tenantId) ?? tenantId,
      date: fmtPktDate(p.paidAt), source: 'capex', sourceId: p.id,
      document: `${p.line.project.name} — ${p.line.item} (${p.label})`,
      vendor: p.line.supplierRecord?.name ?? p.line.vendor ?? '—',
      ntn: p.line.supplierRecord?.taxId ?? null,
      filerStatus: p.filerStatus ?? p.line.supplierRecord?.filerStatus ?? null,
      section: sectionOf(p.whtSection), rateBps: p.whtRateBps,
      baseCents: rate > 0 ? Math.round(wht * (10_000 / rate)) : 0,
      whtCents: wht,
      baseDerived: true,
    })
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.company.localeCompare(b.company) || a.source.localeCompare(b.source))
  return rows
}

const rateBody = z.object({
  rates: z.record(z.string(), z.object({ filerBps: z.number().int(), nonFilerBps: z.number().int() })),
})

export async function withholdingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/rates', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const tenantId = activeTenantId(req, 'withholding rates are per company')
    const r = await withholdingRatesFor(prisma, tenantId)
    return {
      ...r,
      maxBps: MAX_WHT_BPS,
      sections: WHT_SECTIONS.map((key) => ({ key, label: WHT_SECTION_LABEL[key] })),
      canEdit: RATE_EDITORS.includes(req.staffUser!.role),
    }
  })

  fastify.put('/rates', { preHandler: requireAuth(...RATE_EDITORS) }, async (req) => {
    const body = rateBody.parse(req.body ?? {})
    // A create-or-update of the ACTIVE company's own settings row.
    const tenantId = activeTenantId(req, 'withholding rates are per company')
    const given = Object.entries(body.rates)
    if (given.length === 0) throw new AppError('NOTHING_TO_SAVE', 'Give at least one section\'s rates', 422)
    for (const [section, r] of given) {
      if (!isWhtSection(section)) throw new AppError('BAD_WHT_SECTION', `Unknown withholding section "${section}"`, 422)
      for (const v of [r.filerBps, r.nonFilerBps]) {
        if (v < 0 || v > MAX_WHT_BPS) {
          throw new AppError('WHT_RATE_OUT_OF_RANGE', `A withholding rate must be between 0% and ${MAX_WHT_BPS / 100}% (0–${MAX_WHT_BPS} basis points)`, 422)
        }
      }
    }

    const { before, after, cfgId } = await prisma.$transaction(async (tx) => {
      // One writer of a company's settings row at a time (scopeId is NULL, so
      // the unique index cannot stop two creates).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext(${'operations-config'}::text))`
      const prev = await withholdingRatesFor(tx, tenantId)
      const rates: WhtRates = Object.fromEntries(WHT_SECTIONS.map((s) => [s, { ...prev.rates[s] }])) as WhtRates
      for (const [section, r] of given) rates[section as WhtSection] = { filerBps: r.filerBps, nonFilerBps: r.nonFilerBps }
      const data = {
        withholdingRates: rates as unknown as Prisma.InputJsonValue,
        // The legacy single % stays the goods (153(1)(a)) filer rate.
        withholdingTaxPct: rates['153_1_a'].filerBps / 10_000,
        updatedById: req.staffUser!.id,
      }
      const existing = await tx.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null }, select: { id: true } })
      const row = existing
        ? await tx.operationsConfig.update({ where: { id: existing.id }, data, select: { id: true } })
        : await tx.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, ...data }, select: { id: true } })
      return { before: prev, after: rates, cfgId: row.id }
    })
    // Supplier bills read the % through the cached settings reader.
    const { invalidateSetupCache } = await import('../../lib/setup-config.js')
    invalidateSetupCache()

    await audit({ category: 'accounting',
      action: 'withholding.rates_update',
      entity: 'OperationsConfig',
      entityId: cfgId,
      userId: req.staffUser!.id, tenantId,
      userEmail: req.staffUser!.email,
      before: { rates: before.rates, defaultsUsed: before.defaultsUsed },
      after: { rates: after, withholdingTaxPct: after['153_1_a'].filerBps / 10_000 },
      metadata: { ip: req.ip, sections: given.map(([s]) => s) },
    })
    const r = await withholdingRatesFor(prisma, tenantId)
    return { ...r, maxBps: MAX_WHT_BPS, sections: WHT_SECTIONS.map((key) => ({ key, label: WHT_SECTION_LABEL[key] })), canEdit: true }
  })

  fastify.get<{ Querystring: { from?: string; to?: string; format?: string } }>(
    '/register',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req, reply) => {
      const q = req.query
      for (const d of [q.from, q.to]) {
        if (d !== undefined && d !== '' && !ISO_DATE.test(d)) throw new AppError('INVALID_DATE', 'Give the dates as YYYY-MM-DD', 422)
      }
      const today = fmtPktDate(pktToday().from)
      const fromIso = q.from || `${today.slice(0, 7)}-01`
      const toIso = q.to || today
      const from = parsePktStartOfDay(fromIso)
      const to = parsePktEndOfDay(toIso)
      if (to < from) throw new AppError('BAD_PERIOD', 'The period ends before it starts', 422)
      // Read: the active company, or every company in "All companies" view.
      const scope = await resolveTenantScope(req)
      const rows = await withholdingRegister(prisma, scope.tenantIds, from, to)

      if (q.format === 'csv') {
        const csvRows = rows.map((r) => ({
          Company: r.company,
          Date: r.date,
          Source: SOURCE_LABEL[r.source],
          Document: r.document,
          Vendor: r.vendor,
          NTN: r.ntn ?? '',
          'Filer status': r.filerStatus ?? '',
          Section: r.section ? WHT_SECTION_LABEL[r.section] : '',
          'Rate %': r.rateBps == null ? '' : (r.rateBps / 100).toFixed(2),
          Base: fmtPkr(r.baseCents),
          WHT: fmtPkr(r.whtCents),
        }))
        const columns = ['Company', 'Date', 'Source', 'Document', 'Vendor', 'NTN', 'Filer status', 'Section', 'Rate %', 'Base', 'WHT']
        reply.header('Content-Type', 'text/csv; charset=utf-8')
        reply.header('Content-Disposition', `attachment; filename="withholding-register-${fromIso}-${toIso}.csv"`)
        // An empty register still gets its header row.
        return reply.send(csvRows.length > 0 ? toCsv(csvRows, columns) : `﻿${columns.join(',')}\r\n`)
      }

      const totals = { baseCents: 0, whtCents: 0, bySection: {} as Record<string, number> }
      for (const r of rows) {
        totals.baseCents += r.baseCents
        totals.whtCents += r.whtCents
        const k = r.section ?? 'none'
        totals.bySection[k] = (totals.bySection[k] ?? 0) + r.whtCents
      }
      return { from: fromIso, to: toIso, rows, totals, note: WITHHOLDING_REGISTER_NOTE }
    },
  )
}

export default withholdingRoutes
