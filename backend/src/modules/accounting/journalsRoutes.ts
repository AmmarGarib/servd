// /accounting/journals — the Journals tab (owner, 2026-10-23; journalsRegister.ts).
// Under the /accounting module gate; readers = the ledger's (FINANCIALS_VIEWERS),
// company scope = resolveTenantScope.
//
//   GET /        ?view=manual|payment|receipt|all &q &from &to (YYYY-MM-DD PKT) &accountCode &brandId
//                &minCents &maxCents &includeSales=1 (receipt view: till / sales too) &cursor &limit (≤200)
//                → { view, rows: JournalRow[], nextCursor, hasMore, viewer: { isCeo, canPost } }
//                ?format=csv|xlsx|pdf exports the filtered list (up to 20,000 entries; lib/reportExport.ts).
//   GET /:id     → { entry: JournalRow, changes: JournalRequestDto[] (every edit / cancel asked for),
//                    textEdits: [{ at, userId, userName, before, after }] }. Foreign / unknown → 404.
//
// Writes stay on the existing routes: PATCH /accounting/journal/:id/text, POST /accounting/journal/:id/amend |
// /reverse (finance → 202 pending the CEO), /accounting/journal-requests/:id/approve | reject | diff.

import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { exportFormatOf, sendReportFor } from '../../lib/reportExport.js'
import { fmtPkr } from './csv.js'
import { fmtPktDate } from './dates.js'
import { journalsQuerySchema, listJournals, journalRow } from './journalsRegister.js'
import { requestsForEntry } from './journalRequests.js'

const VIEW_TITLE = { manual: 'Manual journals', payment: 'Payment journals', receipt: 'Receipt journals', all: 'All journal entries' } as const
const STATUS_LABEL = { live: 'Live', reversed: 'Reversed', reversal: 'Reversal', change_pending: 'Change pending' } as const

export async function journalsRoutes(fastify: FastifyInstance) {
  fastify.get('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req, reply) => {
    const q = journalsQuerySchema.parse(req.query ?? {})
    const format = exportFormatOf(q.format)
    if (!format) {
      const r = await listJournals(req, q)
      return { ...r, viewer: { isCeo: r.viewer.isCeo, canPost: r.viewer.canPost } }
    }
    const r = await listJournals(req, { ...q, cursor: undefined }, { maxRows: 20_000 })
    const multi = new Set(r.rows.map((x) => x.tenantId)).size > 1
    const money = q.view === 'payment' || q.view === 'receipt'
    const rows: Array<Record<string, string>> = r.rows.map((x) => ({
      ...(multi && { company: x.companyName ?? '' }),
      date: fmtPktDate(new Date(x.entryDate)),
      voucher_no: x.voucherNo ?? '',
      // The document's own narration (owner, 2026-10-24) and the cheque reference typed on a manual entry.
      particulars: x.particulars,
      cheque_reference: x.operatorReference ?? '',
      source: x.sourceType,
      money_account: x.moneyAccounts.map((m) => `${m.code} ${m.name}`).join(', '),
      counter_account: x.counterSummary,
      amount: fmtPkr(money ? Math.abs(x.moneyNetCents) : x.totalCents),
      status: STATUS_LABEL[x.status],
    }))
    if (rows.length) {
      rows.push({
        ...(multi && { company: '' }), date: '', voucher_no: '', particulars: 'TOTAL', cheque_reference: '', source: '', money_account: '', counter_account: '',
        amount: fmtPkr(r.rows.reduce((s, x) => s + (money ? Math.abs(x.moneyNetCents) : x.totalCents), 0)), status: '',
      })
    }
    return sendReportFor(req, reply, format, { base: `journals-${q.view}`, suffix: `${q.from ?? 'start'}-${q.to ?? fmtPktDate(new Date())}` }, {
      title: VIEW_TITLE[q.view],
      period: `${q.from ?? 'From the first entry'} to ${q.to ?? fmtPktDate(new Date())}`,
      rows,
      types: { amount: 'pkr' },
      labels: { voucher_no: 'Voucher no.', particulars: 'Particulars', cheque_reference: 'Cheque reference', money_account: 'Money account', counter_account: 'Account' },
      wrapKeys: ['particulars'],
      isTotal: (row) => row.particulars === 'TOTAL',
      ...(r.hasMore && { notes: ['Only the newest 20,000 entries are included — narrow the dates for the rest.'] }),
    })
  })

  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const entry = await journalRow(req, req.params.id)
    const [changes, edits] = await Promise.all([
      entry.tenantId ? requestsForEntry(entry.tenantId, entry.id) : [],
      prisma.auditLog.findMany({
        where: { entity: 'JournalEntry', entityId: entry.id, action: 'journal.text_edit' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, userId: true, userEmail: true, before: true, after: true },
      }),
    ])
    const ids = [...new Set(edits.map((e) => e.userId).filter((u): u is string => !!u))]
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
    const name = new Map(users.map((u) => [u.id, u.name]))
    return {
      entry,
      changes,
      textEdits: edits.map((e) => ({ at: e.createdAt.toISOString(), userId: e.userId, userName: (e.userId && name.get(e.userId)) || e.userEmail, before: e.before, after: e.after })),
    }
  })
}
