// Typed calls for the CEO head-office pages (D1/D3, spec §10). Coded against
// backend/src/modules/headOffices/{routes,setup,runRoutes}.ts and
// modules/hr/transferRoutes.ts. Money is paisa; shares are basis points
// (10000 = 100%); months are 'YYYY-MM' (Karachi).

import { api } from './api'

// ─── Months and shares ───────────────────────────────────────────────────────

/** This month in Karachi as YYYY-MM. */
export function currentMonthPkt(): string {
  return new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 7)
}
export function addMonthsTo(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}
export function monthLabel(month: string | null | undefined): string {
  if (!month) return '—'
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}
/** The next `count` months starting at `from` (for month pickers). */
export function monthRange(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonthsTo(from, i))
}
export const bpsToPct = (bps: number): string => (bps / 100).toFixed(2)
export const pctToBps = (pct: string): number => Math.round(Number(pct) * 100)

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface AccountView { id: string; code: string; name: string; type: string; isActive: boolean; controlledBy: string | null }
export interface CostPool {
  include: Array<{ from: number; to: number }>
  includeCodes: string[]
  excludeCodes: string[]
}
export interface BooksView {
  tenantId: string
  rechargeAccount: AccountView | null
  costPool: CostPool
  confirmed: boolean
  accountsConfirmedAt: string | null
  accountsConfirmedNote: string | null
  taxAnswer: string | null
  rechargeEnabled: boolean
  rechargeFromPeriod: string | null
  requireLockedPayroll: boolean
  setupAppliedAt: string | null
  links: Array<{ linkId: string; companyTenantId: string; companyName: string; chargesAccount: AccountView | null }>
  warnings: string[]
}
export interface HeadOfficeRow {
  id: string; name: string; slug: string; isActive: boolean; isTest: boolean; createdAt: string
  companies: Array<{ id: string; name: string }>
  confirmed: boolean
  rechargeEnabled: boolean
  rechargeFromPeriod: string | null
  setupAppliedAt: string | null
}
export interface SplitLine { companyTenantId: string; shareBps: number }
export interface SplitVersion {
  id: string; tenantId: string; effectiveFrom: string; note: string | null; createdAt: string
  lines: SplitLine[]; totalBps: number
}
export interface HeadOfficeLinkRow {
  id: string; companyTenantId: string; companyName: string; companyIsTest: boolean
  live: boolean; startedAt: string; endedAt: string | null; lastChargedPeriod: string | null; endReason: string | null
  chargesAccount: { id: string; code: string; name: string; isActive: boolean } | null
}
export interface RunSummary {
  id: string; period: string; kind: string; status: string; stale: boolean
  baseCents: number; rechargedCents: number; retainedCents: number
  submittedAt: string | null; postedAt: string | null; createdAt?: string
}
export interface HoWideDelegation {
  id: string; section: string; approvalTypes: string[]; delegateUserId: string; delegateName: string | null
  startsAt: string; endsAt: string | null
}
export interface HeadOfficeDetail {
  headOffice: { id: string; name: string; slug: string; isActive: boolean; isTest: boolean }
  links: HeadOfficeLinkRow[]
  currentSplit: SplitVersion | null
  books: BooksView | null
  lastRuns: RunSummary[]
  hoWideDelegations: HoWideDelegation[]
}
export interface LinkResult { link: { id: string; companyTenantId: string }; companyName: string; extendedDelegationIds: string[]; revokedDelegationIds: string[]; wasConfirmed: boolean }

// Setup wizard
export interface PlanningRow {
  tenantId: string; name: string; seatsMonthlyCents: number; contributionsNetMonthlyCents: number
  headOfficeChargesMonthlyCents: number; rechargedOutMonthlyCents: number; netMonthlyCents: number
}
export interface SetupPreview {
  alreadyApplied: { headOfficeId: string; name: string; at: string } | null
  effectiveFrom: string
  rechargeStaysOff: boolean
  hoName: string
  companies: Array<{ id: string; name: string; slug: string; isTest: boolean }>
  contributions: Array<{ id: string; label: string; monthlyCents: number; description: string | null; sourceName: string; destinationName: string }>
  departments: Array<{
    id: string; tenantId: string; companyName: string; name: string
    seats: Array<{ id: string; title: string; status: string; headcount: number; monthlySalaryCents: number; tenantCostShareCents: number }>
    employees: Array<{ id: string; employeeCode: string; fullName: string; status: string }>
  }>
  seatsShareNotGross: Array<{ id: string; title: string; monthlySalaryCents: number; tenantCostShareCents: number; headcount: number; moves: boolean }>
  suggestedSplit: { lines: Array<SplitLine & { name: string }>; source: 'records' | 'owner_default' | 'equal'; note: string }
  split: SplitLine[]
  planning: {
    labels: Record<string, string>
    before: { companies: PlanningRow[]; portfolioNetMonthlyCents: number }
    after: { companies: PlanningRow[]; headOffice: PlanningRow; portfolioNetMonthlyCents: number }
  }
  hodCandidates: Array<{ userId: string; name: string; email: string | null }>
  warnings: string[]
}
export interface SetupApplyBody {
  name?: string; companyIds?: string[]; split?: SplitLine[]; effectiveFrom?: string; addHodMemberships?: string[]
}
export interface SetupResult {
  headOffice: { id: string; name: string; slug: string; isTest: boolean }
  links: Array<{ companyTenantId: string; companyName: string; chargesAccountCode: string }>
  split: { id: string; effectiveFrom: string; lines: SplitLine[] }
  hodMembershipsAdded: string[]
  warnings?: string[]
}

// Recharge runs (read-only here)
export interface RechargeRunsSummary {
  headOffice: { id: string; name: string; isActive: boolean }
  books: { rechargeEnabled: boolean; rechargeFromPeriod: string | null; requireLockedPayroll: boolean; accountsConfirmedAt: string | null } | null
  split: SplitVersion | null
  companies: Array<{
    linkId: string; companyTenantId: string; companyName: string; startedAt: string; endedAt: string | null
    lastChargedPeriod: string | null; shareBps: number; owedByCompanyCents: number; mismatchCents: number
  }>
  lastMonth: string
  runs: unknown[]
}

// Reconciliation pairs (/accounting/intercompany/balances)
export interface PairBalance {
  a: { id: string; name: string | null }; b: { id: string; name: string | null }
  memberOfBoth: boolean; headOfficePair: boolean
  aDueFromB: number | null; aDueToB: number | null; bDueFromA: number | null; bDueToA: number | null
  netOwedByA: number | null; mismatchCents: number | null
}

// Move people to head office
export interface TransferBody {
  employeeIds: string[]
  headOfficeTenantId: string
  effectiveDate: string // YYYY-MM-01
  keepJoiningDate?: boolean
  keepCompanyMemberships?: string[]
}
export interface TransferEmployeePreview {
  employeeId: string; employeeCode: string; fullName: string; fromTenantId: string; fromTenantName: string; status: string
  blockers: Array<{ code: string; status: number; message: string }>
  warnings: string[]
  department: { name: string; match: 'existing' | 'create' } | null
  designation: { name: string; match: 'existing' | 'create' } | null
  grade: { name: string; match: 'existing' | 'create' } | null
  joiningDate: string | null
  lastWorkingDay: string
  leave: Array<{ name: string; days: number; accruedDays: number }>
  suggestedAdjustmentCents: number
  login: {
    userId: string; addHeadOfficeMembership: boolean; primaryCompanyToHeadOffice: boolean
    removeMemberships: string[]; keepMemberships: string[]
  } | null
  positions: Array<{ id: string; title: string; moves: boolean; note?: string }>
}
export interface TransferPreview {
  headOffice: { id: string; name: string }
  effectiveDate: string; effectivePeriod: string; keepJoiningDate: boolean; ok: boolean
  employees: TransferEmployeePreview[]
  warnings: string[]
  suggestedAdjustmentCents: number; suggestedAdjustmentNote: string
}
export interface TransferResult {
  headOfficeTenantId: string; effectiveDate: string
  moved: Array<{ fromEmployeeId: string; fromTenantId: string; toEmployeeId: string; toEmployeeCode: string; removedMemberships: string[] }>
  warnings: string[]
}
export interface HrEmployeeRow {
  id: string; employeeCode: string; fullName: string; status: string; userId: string | null; tenantId: string
  department: string | null; designation: string | null; grossSalaryCents: number | null
}

export interface DelegationRow {
  id: string; tenantId: string; companyTenantId: string | null; section: string; sectionTitle: string
  approvalTypes: string[]; delegateName: string | null; scopeName: string; startsAt: string; endsAt: string | null
  note: string | null; state: 'live' | 'not_started' | 'expired' | 'revoked'; revokedReason?: string | null
}

// ─── Calls ───────────────────────────────────────────────────────────────────

const e = encodeURIComponent

export const headOfficeApi = {
  list: () => api.get<{ headOffices: HeadOfficeRow[] }>('/head-offices'),
  create: (body: { name: string; isTest?: boolean }) => api.post<{ headOffice: { id: string; name: string } }>('/head-offices', body),
  detail: (id: string) => api.get<HeadOfficeDetail>(`/head-offices/${e(id)}`),
  update: (id: string, body: { name?: string; isActive?: boolean }) => api.patch<{ headOffice: unknown }>(`/head-offices/${e(id)}`, body),
  link: (id: string, body: { companyTenantId: string; extendDelegationIds: string[]; revokeDelegationIds: string[] }) =>
    api.post<LinkResult>(`/head-offices/${e(id)}/companies`, body),
  endLink: (id: string, companyId: string, body: { reason: string; lastChargedPeriod: string }) =>
    api.post<{ linkId: string; companyName: string; staleRuns: number }>(`/head-offices/${e(id)}/companies/${e(companyId)}/end`, body),
  splits: (id: string) => api.get<{ splits: Array<SplitVersion & { runCount: number }>; current: SplitVersion | null }>(`/head-offices/${e(id)}/splits`),
  createSplit: (id: string, body: { effectiveFrom: string; lines: SplitLine[]; note?: string | null }) =>
    api.post<{ split: SplitVersion; staleRuns: number; retainedBps: number; warning?: string }>(`/head-offices/${e(id)}/splits`, body),
  deleteSplit: (id: string, splitId: string) => api.delete<{ deleted: string }>(`/head-offices/${e(id)}/splits/${e(splitId)}`),
  books: (id: string) => api.get<{ books: BooksView }>(`/head-offices/${e(id)}/books`),
  mapAccounts: (id: string, body: { rechargeAccountId?: string; charges?: Array<{ companyTenantId: string; accountId: string }> }) =>
    api.put<{ books: BooksView }>(`/head-offices/${e(id)}/books/accounts`, body),
  savePool: (id: string, pool: CostPool) => api.put<{ books: BooksView }>(`/head-offices/${e(id)}/books/pool`, pool),
  confirmBooks: (id: string, body: { note: string; taxAnswer: string }) => api.post<{ books: BooksView }>(`/head-offices/${e(id)}/books/confirm`, body),
  setRecharge: (id: string, body: { enabled: boolean; fromPeriod?: string | null; requireLockedPayroll?: boolean }) =>
    api.put<{ books: BooksView }>(`/head-offices/${e(id)}/books/recharge`, body),

  // Setup wizard
  setupPreview: (q: { companyIds?: string[]; name?: string } = {}) => {
    const p = new URLSearchParams()
    if (q.companyIds?.length) p.set('companyIds', q.companyIds.join(','))
    if (q.name) p.set('name', q.name)
    const s = p.toString()
    return api.get<SetupPreview>(`/head-offices/setup/preview${s ? `?${s}` : ''}`)
  },
  setupApply: (body: SetupApplyBody) => api.post<SetupResult>('/head-offices/setup', body),

  // Recharge runs (read-only on these pages)
  runsSummary: (id: string) => api.get<RechargeRunsSummary>(`/accounting/intercompany/recharge-runs/summary?headOfficeId=${e(id)}`),
  runs: (id: string) => api.get<{ runs: RunSummary[] }>(`/accounting/intercompany/recharge-runs?headOfficeId=${e(id)}&limit=24`).then((r) => ({ items: r.runs })),

  // Reconciliation
  balances: () => api.getAcrossTenants<{ asOf: string | null; pairs: PairBalance[] }>('/accounting/intercompany/balances'),

  // The CEO's own companies (for the link picker)
  myCompanies: () => api.get<Array<{ id: string; name: string; kind: 'company' | 'head_office'; isActive?: boolean; isTest?: boolean }>>('/tenants/mine'),

  // Hand-over (the dialogs live in components/approvals/DelegationDialogs.tsx)
  delegations: () => api.get<{ delegations: DelegationRow[] }>('/approvals/delegations'),
  revokeDelegation: (id: string, reason: string) => api.post<{ delegation: unknown }>(`/approvals/delegations/${e(id)}/revoke`, { reason }),

  // People
  employees: () => api.getAcrossTenants<HrEmployeeRow[]>('/hr/employees?status=current'),
  transferPreview: (body: TransferBody) => api.post<TransferPreview>('/hr/head-office-transfers/preview', body),
  transfer: (body: TransferBody) => api.post<TransferResult>('/hr/head-office-transfers', body),
}

/** The books status line shown on the list and the detail header. */
export function booksStatus(b: { confirmed: boolean; rechargeEnabled: boolean; rechargeFromPeriod: string | null }): { label: string; tone: 'amber' | 'purple' | 'green' } {
  if (b.rechargeEnabled) return { label: `Recharge on from ${monthLabel(b.rechargeFromPeriod)}`, tone: 'green' }
  if (b.confirmed) return { label: 'Confirmed', tone: 'purple' }
  return { label: 'Confirm with your CA', tone: 'amber' }
}

/** The one warning-box look on the head-office pages (ERP tokens only). */
export const WARNING_BOX_STYLE = {
  background: 'color-mix(in srgb, var(--erp-warning) 14%, transparent)',
  color: 'var(--erp-warning)',
} as const
