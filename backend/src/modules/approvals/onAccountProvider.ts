// ── On-account clients (resumed 2026-10-15) ─────────────────────────────────
// receivables/customerAccounts.ts: GET /accounting/customer-accounts?pending=1
// (CLIENT_VIEWERS; module accounting) lists a new client waiting for the CEO
// and a credit-limit increase waiting for the CEO. POST
// /accounting/customer-accounts/:id/approve | reject {note} — ADMIN_ONLY; the
// route's own assertNotSelfApproval decides (the CEO is exempt). Never
// delegable (APPROVAL_RIGHTS.on_account_client, section 'ceo').
//
// Until the company's till clearing is split off 1110 the route answers 409
// TILL_CLEARING_NOT_SPLIT, so Approve is listed disabled with that reason;
// Reject stays.

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from './types.js'

const RIGHTS = APPROVAL_RIGHTS.on_account_client
const BASE = '/accounting/customer-accounts'
const LINK = '/accounting/receivables/clients'

function pkr(cents: number | null | undefined): string {
  return `PKR ${Math.round((cents ?? 0) / 100).toLocaleString('en-PK')}`
}
const iso = (d: unknown): string | null => {
  if (!d) return null
  const t = new Date(d as string)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}

/** A row of GET /accounting/customer-accounts (the fields the inbox reads). */
interface ClientRow {
  id: string
  tenantId: string
  number: string
  legalName: string
  tradeName: string | null
  ntn: string | null
  status: string
  creditLimitCents: number
  requestedCreditLimitCents: number | null
  termsDays: number
  overdueGraceDays: number
  brands: Array<{ id: string; name: string | null }>
  exposureCents?: number
  pending: 'new_client' | 'limit_increase' | null
  pendingSince: string | null
  requestedById: string | null
  requestedByName: string | null
  approveBlockedReason?: string | null
}

export const onAccountClients: ApprovalProvider = {
  type: 'on_account_client',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: ClientRow[] }>(`${BASE}?pending=1`)
    if (res === null) return null
    return (res.items ?? []).filter((r) => r.pending).map((r): ApprovalItem => {
      const isNew = r.pending === 'new_client'
      const newLimit = isNew ? r.creditLimitCents : r.requestedCreditLimitCents ?? r.creditLimitCents
      const name = r.tradeName && r.tradeName !== r.legalName ? `${r.legalName} (${r.tradeName})` : r.legalName
      const brands = r.brands.length ? r.brands.map((b) => b.name ?? 'Brand').join(', ') : 'Every brand of the company'
      const rows: Array<[string, string | null | undefined]> = [
        ['Client', name],
        ['Account', r.number],
        ['Request', isNew ? 'New on-account client' : 'Credit limit increase'],
        [isNew ? 'Credit limit' : 'New limit', pkr(newLimit)],
        ['Current limit', isNew ? null : pkr(r.creditLimitCents)],
        ['Owes now', isNew || r.exposureCents == null ? null : pkr(r.exposureCents)],
        ['Terms', `${r.termsDays} days, ${r.overdueGraceDays} days' grace`],
        ['NTN', r.ntn],
        ['Brands', brands],
        ['Requested by', r.requestedByName],
      ]
      return {
        type: 'on_account_client',
        id: r.id,
        tenantId: r.tenantId,
        section: RIGHTS.section,
        submittedByIds: r.requestedById ? [r.requestedById] : [],
        title: isNew
          ? `${r.number} — ${r.legalName} — new client, limit ${pkr(newLimit)}`
          : `${r.number} — ${r.legalName} — limit ${pkr(r.creditLimitCents)} → ${pkr(newLimit)}`,
        subtitle: isNew ? 'New on-account client' : 'Credit limit increase',
        facts: rows.filter(([, v]) => v != null && v !== '').map(([label, value]) => ({ label, value: String(value) })),
        amountCents: newLimit,
        waitingSince: iso(r.pendingSince),
        link: `${LINK}/${encodeURIComponent(r.id)}`,
        actions: [
          {
            kind: 'approve', label: 'Approve', method: 'POST', path: `${BASE}/${r.id}/approve`, body: {},
            confirm: isNew
              ? 'Approve this client? Finance can then issue its cards and the tills can charge it up to its limit.'
              : `Raise this client's limit to ${pkr(newLimit)}?`,
            ...(r.approveBlockedReason ? { disabledReason: r.approveBlockedReason } : {}),
          },
          {
            kind: 'reject', label: 'Reject', method: 'POST', path: `${BASE}/${r.id}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true },
          },
        ],
      }
    })
  },
}
