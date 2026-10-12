// API client for Dev → API (spec §8.1, §8.5, §10, §17.0, §17.7).
//
// Coded against the REAL routes in backend/src/modules/connectors/routes.ts
// (prefix /connectors) and the WhatsApp handlers in
// backend/src/modules/auth/routes.ts (/auth/integrations/*). Every
// /connectors call binds to the operator's ACTIVE company on the server; the
// pages say which company they show.
//
// Secrets never come back from the server — only hints (first 4 + last 4).
// The one exception is a freshly regenerated webhook secret
// (`newWebhookSecret`), returned once by PUT /connectors/:kind.
//
// There is NO skip anywhere (§17.0): held documents are released all at once
// per company (or per brand), never by date range, and no document can be
// excluded from filing by an operator.

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from './api'

// ─── Shapes ──────────────────────────────────────────────────────────────────

export type ConnectorKind = 'fiscal' | 'terminal'
export type Authority = 'fbr' | 'srb' | 'pra' | 'kpra' | 'bra'
export const AUTHORITIES: Authority[] = ['fbr', 'srb', 'pra', 'kpra', 'bra']

export interface FiscalOutlet {
  locationId: string
  /** null = every brand at that outlet. */
  conceptId: string | null
  authority: Authority
  posId: string
  storeId?: string
}

export interface FiscalSettings {
  syncTimeoutMs: number
  syncAtTill: boolean
  fileZeroValue: boolean
  maxAgeHours: number
  outlets: FiscalOutlet[]
  apiKeyHeader?: string
  paths?: Partial<Record<'sales' | 'refunds' | 'documents' | 'health', string>>
  test?: { scenario: string }
}

export interface TerminalEntry {
  id: string
  label: string
  locationId: string
  terminalId: string
  active: boolean
}

export interface TerminalSettings {
  chargeTimeoutSec: number
  pollMs: number
  allowManualRef: boolean
  terminals: TerminalEntry[]
  apiKeyHeader?: string
  paths?: Partial<Record<'charges' | 'refunds' | 'health', string>>
  test?: { scenario: string }
}

export interface ConnectorView<S> {
  id: string
  kind: ConnectorKind
  driver: string
  enabled: boolean
  isTest: boolean
  liveSince: string | null
  baseUrl: string | null
  apiKeyHint: string | null
  webhookSecretHint: string | null
  webhookUrl: string
  settings: S
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestDetail: string | null
  lastOkAt: string | null
  lastError: string | null
  lastErrorAt: string | null
}

export interface FiscalCounts {
  held: number
  waiting: number
  pending: number
  submittingStale: number
  failed: number
  rejected: number
  manualRequired: number
  filedToday: number
  oldestPendingAt: string | null
}

export interface BrandPosIds {
  conceptId: string
  name: string
  fbrPosId: number | null
  srbPosId: number | null
  province: string | null
}

/** GET /connectors */
export interface ConnectorsOverview {
  fiscal: ConnectorView<FiscalSettings>
  terminal: ConnectorView<TerminalSettings>
  /** §17.7 — the company's "fiscal reporting required" switch (default true). */
  fiscalReportingRequired: boolean
  /**
   * BOOKS-R2-02 / FOH-R2-02: while reporting is OFF and sales held from before
   * are still there, the server's plain sentence about them (kept, never
   * skipped, not a backlog while off, release when switched back on). null
   * otherwise. Optional only so an older API (before the field) still types.
   */
  heldNote?: string | null
  legacyDrained: boolean
  brandPosIds: BrandPosIds[]
  counts: FiscalCounts
  terminalAttention: number
}

export interface DriverInfo {
  kind: ConnectorKind
  id: string
  label: string
  needs: { baseUrl: boolean; apiKey: boolean; webhookSecret: boolean }
}

export type FiscalDocStatus =
  | 'held' | 'waiting' | 'pending' | 'submitting' | 'filed' | 'rejected'
  | 'failed' | 'skipped' | 'manual_required' | 'manual_filed'

export const FISCAL_DOC_STATUSES: FiscalDocStatus[] = [
  'held', 'waiting', 'pending', 'submitting', 'filed', 'rejected', 'failed', 'skipped', 'manual_required', 'manual_filed',
]

export interface FiscalDocRow {
  id: string
  kind: 'sale' | 'refund'
  status: FiscalDocStatus
  statusReason: string | null
  orderId: string
  orderRef: string
  conceptId: string
  brand: string | null
  amountCents: number
  attempts: number
  fiscalNumber: string | null
  authority: string | null
  isTest: boolean
  driver: string | null
  lastErrorCode: string | null
  lastError: string | null
  createdAt: string
  filedAt: string | null
  nextAttemptAt: string
}

export interface FiscalDocsPage {
  items: FiscalDocRow[]
  nextCursor: string | null
  counts: FiscalCounts
}

export interface FiscalAttemptRow {
  id: string
  attemptNo: number
  op: string
  outcome: string
  httpStatus: number | null
  errorCode: string | null
  message: string | null
  durationMs: number
  via: string
  createdAt: string
}

/** GET /connectors/fiscal/documents/:id — the row plus its payload and last 50 attempts. */
export interface FiscalDocDetail extends Omit<FiscalDocRow, 'brand'> {
  payload: unknown
  payloadHash: string
  idempotencyKey: string
  qrPayload: string | null
  verifyUrl: string | null
  fiscalAt: string | null
  attemptsLog: FiscalAttemptRow[]
}

export type TerminalChargeStatus =
  | 'pending' | 'sent' | 'approved' | 'recorded' | 'declined' | 'cancel_requested' | 'cancelled'
  | 'expired' | 'unknown' | 'unverified' | 'void_pending' | 'voided' | 'needs_attention' | 'manual_resolved'

export const TERMINAL_CHARGE_STATUSES: TerminalChargeStatus[] = [
  'pending', 'sent', 'approved', 'recorded', 'declined', 'cancel_requested', 'cancelled',
  'expired', 'unknown', 'unverified', 'void_pending', 'voided', 'needs_attention', 'manual_resolved',
]

export interface TerminalChargeView {
  id: string
  kind: 'charge' | 'refund'
  status: TerminalChargeStatus
  final: boolean
  orderId: string
  terminalId: string
  terminalLabel: string
  amountCents: number
  tipCents: number
  quoteDueCents: number
  approvalRef: string | null
  cardBrand: string | null
  cardLast4: string | null
  message: string | null
  refusalCode: string | null
  expiresAt: string
  createdAt: string
  payment: { id: string; method: string; amountCents: number } | null
}

export interface ChargesPage { items: TerminalChargeView[]; nextCursor: string | null }

export interface TestResult {
  ok: boolean
  latencyMs: number
  detail: string
  dryRun?: { outcome: string; fiscalNumber?: string }
}

/** PUT /connectors/:kind body. Omit a field to leave it unchanged; '' clears a secret or the URL. */
export interface ConnectorPut {
  driver?: string
  baseUrl?: string
  apiKey?: string
  webhookSecret?: string
  regenerateWebhookSecret?: boolean
  /** Terminal only — the fiscal connector goes live through go-live / switch-off. */
  enabled?: boolean
  settings?: Record<string, unknown>
}

/** PUT /connectors/fiscal/reporting-required — the held backlog is left exactly as it is. */
export interface ReportingRequiredResult {
  fiscalReportingRequired: boolean
  /** Documents of the company still held (never skipped by the switch). */
  heldCount: number
  /** The server's sentence about them when reporting is now OFF and some are held; else null. */
  heldNote: string | null
}

// ─── WhatsApp (platform-wide gateway, /auth/integrations/*) ─────────────────

export interface WhatsappStatus {
  apiUrl: string
  apiKeyHint: string
  source: 'database' | 'environment' | 'unset'
  configured: boolean
  /** Added by W2: one gateway for every company. */
  scope?: 'platform'
}

export interface DeliveryState {
  ok: boolean
  cause: 'ok' | 'unconfigured' | 'session_dropped' | 'bad_key' | 'gateway_unreachable' | 'unknown'
  detail: string
  fix: string
  checkedAt: string | null
}

// ─── Calls ───────────────────────────────────────────────────────────────────

const q = (params: Record<string, string | number | undefined | null>) => {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const connectorsApi = {
  overview: () => api.get<ConnectorsOverview>('/connectors'),
  drivers: () => api.get<DriverInfo[]>('/connectors/drivers'),
  save: <S>(kind: ConnectorKind, body: ConnectorPut) =>
    api.put<ConnectorView<S> & { newWebhookSecret?: string }>(`/connectors/${kind}`, body),
  rotateWebhookToken: (kind: ConnectorKind) =>
    api.post<{ webhookUrl: string }>(`/connectors/${kind}/rotate-webhook-token`, {}),
  test: (kind: ConnectorKind, body: { dryRun?: boolean; terminalId?: string } = {}) =>
    api.post<TestResult>(`/connectors/${kind}/test`, body),
  goLive: () => api.post<ConnectorView<FiscalSettings>>('/connectors/fiscal/go-live', { confirm: 'GO LIVE' }),
  switchOff: () => api.post<ConnectorView<FiscalSettings>>('/connectors/fiscal/switch-off', { confirm: 'SWITCH OFF' }),
  setReportingRequired: (required: boolean, reason: string) =>
    api.put<ReportingRequiredResult>('/connectors/fiscal/reporting-required', { required, reason }),
  saveBrandPosIds: (items: Array<{ conceptId: string; fbrPosId: number | null; srbPosId: number | null }>) =>
    api.put<{ updated: number }>('/connectors/fiscal/brand-pos-ids', { items }),
  documents: (f: { status?: string; kind?: string; from?: string; to?: string; conceptId?: string; q?: string; cursor?: string; limit?: number }) =>
    api.get<FiscalDocsPage>(`/connectors/fiscal/documents${q(f)}`),
  document: (id: string) => api.get<FiscalDocDetail>(`/connectors/fiscal/documents/${encodeURIComponent(id)}`),
  retry: (id: string) => api.post<{ id: string; status: FiscalDocStatus }>(`/connectors/fiscal/documents/${encodeURIComponent(id)}/retry`, {}),
  retryAllFailed: () => api.post<{ count: number }>('/connectors/fiscal/documents/retry-failed', {}),
  /** ALL held documents of the company, or of one brand. No date range, no skip (§17.0). */
  releaseHeld: (conceptId?: string) =>
    api.post<{ released: number; stillHeld: number }>('/connectors/fiscal/documents/release', conceptId ? { conceptId } : {}),
  recordManual: (id: string, body: { fiscalNumber: string; authority: Authority; qrPayload?: string; verifyUrl?: string; note?: string }) =>
    api.post<{ id: string; status: FiscalDocStatus; fiscalNumber: string; authority: string }>(
      `/connectors/fiscal/documents/${encodeURIComponent(id)}/manual`, body),
  charges: (f: { status?: string; from?: string; to?: string; cursor?: string; limit?: number }) =>
    api.get<ChargesPage>(`/connectors/terminal/charges${q(f)}`),
  simulateCharge: (chargeId: string, outcome: 'approved' | 'declined') =>
    api.post<{ charge: TerminalChargeView }>('/connectors/terminal/test/simulate', { chargeId, outcome }),
  // Till routes (posRoutes.ts) the status tab uses for card-machine attention.
  resolveCharge: (id: string, body: { outcome: 'approved_manual'; gatewayRef: string } | { outcome: 'not_charged'; note?: string }) =>
    api.post<TerminalChargeView>(`/pos/terminal/charges/${encodeURIComponent(id)}/resolve`, body),
  reverseCharge: (id: string, body: { markRefundedOnMachine?: boolean; note?: string }) =>
    api.post<TerminalChargeView>(`/pos/terminal/charges/${encodeURIComponent(id)}/reverse`, body),

  // WhatsApp (same endpoints as before the move).
  whatsapp: () => api.get<WhatsappStatus>('/auth/integrations/whatsapp'),
  saveWhatsapp: (body: { apiUrl: string; apiKey?: string }) => api.put<{ ok: true }>('/auth/integrations/whatsapp', body),
  testWhatsapp: (phone: string) =>
    api.post<{ ok: boolean; error?: string; sentTo?: string }>('/auth/integrations/whatsapp/test', { phone }),
  deliveryStatus: () => api.get<DeliveryState>('/auth/integrations/delivery-status'),
  checkDelivery: () => api.post<DeliveryState>('/auth/integrations/delivery-status/check', {}),
}

// ─── /health (public, at the API root — not under /api/v1) ──────────────────

export interface HealthBody {
  status: string
  checks: Record<string, string>
  details: Record<string, string>
}

/** Reads the public /health. A 503 still carries the body; a network failure is null. */
export async function fetchHealth(): Promise<HealthBody | null> {
  const base = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
  try {
    const res = await fetch(`${base}/health`, { cache: 'no-store' })
    const body = (await res.json()) as Partial<HealthBody>
    return { status: body.status ?? 'unknown', checks: body.checks ?? {}, details: body.details ?? {} }
  } catch {
    return null
  }
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useConnectorsOverview(opts: { refetchMs?: number } = {}) {
  return useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.overview,
    refetchInterval: opts.refetchMs,
    retry: (n, err) => !(err instanceof ApiError && [401, 403, 404, 422].includes(err.status)) && n < 2,
  })
}

export function useDrivers() {
  return useQuery({
    queryKey: ['connector-drivers'],
    queryFn: connectorsApi.drivers,
    staleTime: 5 * 60_000,
    // Management reads the page but may not list drivers (403) — don't retry that.
    retry: (n, err) => !(err instanceof ApiError && err.status === 403) && n < 2,
  })
}

interface TenantMine { id: string; name: string; isActive?: boolean }

/** The operator's active company (the one every /connectors call binds to). */
export function useActiveCompany(): TenantMine | null {
  const { data } = useQuery<TenantMine[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<TenantMine[]>('/tenants/mine'),
    staleTime: 30_000,
  })
  return data?.find((t) => t.isActive) ?? data?.[0] ?? null
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The server's `error.details`, when the API client carries it (see needsOtherFiles: api.ts). */
export function errorDetails(err: unknown): unknown {
  return err && typeof err === 'object' && 'details' in err ? (err as { details?: unknown }).details : undefined
}

/** One readable line for a connector error, with the fix where there is one. */
export function connectorErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'SECRET_KEY_MISSING':
        return 'Secrets cannot be saved yet — ask IT to set SERVD_SECRET_KEY on the server.'
      case 'SWITCH_OFF_FIRST':
        return err.message || 'The fiscal POS is live — the CEO switches it off before the driver or address can change.'
      case 'NO_ACTIVE_COMPANY':
        return 'Pick a company in the sidebar — the POS connector belongs to one company.'
      case 'URL_NOT_ALLOWED':
        return `That address is not allowed: ${err.message}. It must be a public https:// address.`
      case 'FORBIDDEN':
        return 'Your role cannot do this here.'
      case 'REPORTING_OFF':
        return 'Fiscal reporting is switched off for this company, so nothing is released or filed. The held sales are kept as they are — switch "Fiscal reporting required" back on (CEO, Fiscal setup) to release them.'
      case 'NOT_LIVE':
        return 'The fiscal POS is not live yet, so held sales cannot be released. The CEO goes live first (Fiscal setup → Go live), then releases them.'
      case 'TOTALS_MISMATCH':
        return `The figures still do not add up, so it was not sent. ${err.message.replace(/^The figures still do not add up:\s*/, 'Problem: ')} Check the order's stored figures; if it cannot be corrected, file it on the authority portal and use Record manual filing.`
      case 'FISCAL_IN_DOUBT':
        return `${err.message} Do not file it on the authority portal until the fiscal POS confirms it never got it.`
      case 'NOT_RETRYABLE':
        return 'This document has moved on since the list loaded — reload it.'
      default:
        return err.message || err.code
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong'
}

/** The NOT_READY `missing` list from go-live, when the API client passes details through. */
export function missingFrom(err: unknown): string[] {
  const d = errorDetails(err)
  if (d && typeof d === 'object' && Array.isArray((d as { missing?: unknown }).missing)) {
    return ((d as { missing: unknown[] }).missing).filter((x): x is string => typeof x === 'string')
  }
  return []
}

// ─── Documents held back because their figures do not add up ────────────────
//
// backend connectors/fiscal/outbox.ts: a document whose lines + tax + service +
// tip + delivery do not equal the bill is NEVER sent. It is stored `failed`
// with statusReason 'totals_mismatch' (lastErrorCode TOTALS_MISMATCH, the
// problems in lastError) and raises a fiscal_failed flag in the Inbox.
//
// What Retry really does (retryMismatch):
//   - a SALE nobody may have yet → rebuilt from the order and checked again
//     (409 TOTALS_MISMATCH when still wrong) — so "fix the order, then Retry"
//     works;
//   - a REFUND → never rebuilt: the same stored figures are checked again, so
//     Retry cannot make it pass — it is filed by hand (Record manual filing);
//   - IN DOUBT (an earlier submit's outcome is unknown, the fiscal POS may
//     already hold it) → the outbox only lands here when it could not ask the
//     fiscal POS (no lookup), so a sale's Retry answers 409 FISCAL_IN_DOUBT
//     and a refund's 409 TOTALS_MISMATCH. The vendor must confirm OUTSIDE
//     servd before anyone files it by hand — filing it twice is a duplicate
//     invoice / credit note.

export const TOTALS_MISMATCH_REASON = 'totals_mismatch'

type MismatchFields = Pick<FiscalDocRow, 'kind' | 'status' | 'statusReason' | 'lastErrorCode' | 'lastError'>

/** A document held back (not sent) because its figures do not add up. */
export function isTotalsMismatch(d: Pick<FiscalDocRow, 'status' | 'statusReason'>): boolean {
  return d.status === 'failed' && d.statusReason === TOTALS_MISMATCH_REASON
}

/** …and an earlier submit's outcome is unknown, so the fiscal POS may already have it. */
export function isMismatchInDoubt(d: Omit<MismatchFields, 'kind'>): boolean {
  if (!isTotalsMismatch(d)) return false
  return (!!d.lastErrorCode && d.lastErrorCode !== 'TOTALS_MISMATCH')
    || (d.lastError ?? '').startsWith('TOTALS_MISMATCH (an earlier')
}

const IN_DOUBT_STEPS = (what: 'sale' | 'refund') =>
  `The fiscal POS may already have filed this ${what}, and servd cannot ask this fiscal POS about it automatically, so Retry will not settle it. ` +
  'Ask the fiscal POS vendor (outside servd) whether they have it. If they do, use Record manual filing with the fiscal number they give you. ' +
  'Only if they confirm they never got it, file it on the authority portal and record that. Do NOT file it by hand before they confirm — that would file it twice.'

/** What to do about a totals-mismatch document, in plain words; null for any other document. */
export function mismatchAdvice(d: MismatchFields): { title: string; steps: string } | null {
  if (!isTotalsMismatch(d)) return null
  const what = d.kind === 'refund' ? 'refund' : 'sale'
  if (isMismatchInDoubt(d)) {
    return {
      title: 'Not sent again: the figures do not add up, and an earlier send’s result is unknown',
      steps: IN_DOUBT_STEPS(what),
    }
  }
  if (d.kind === 'refund') {
    return {
      title: 'Not sent: the figures do not add up',
      steps: 'The refund’s lines, tax and total do not agree, so servd held it back rather than file wrong numbers. A refund is not rebuilt from the order — Retry only checks the same stored figures again, so it will not pass. File the refund on the authority portal and use Record manual filing.',
    }
  }
  return {
    title: 'Not sent: the figures do not add up',
    steps: 'The lines, tax, service, tip and delivery do not equal the bill, so servd held it back rather than file wrong numbers. Check the order’s stored figures, then press Retry — servd rebuilds the sale from the order and checks again. If it still does not add up, file it on the authority portal and use Record manual filing.',
  }
}

/**
 * The line shown when Retry on a document fails. For a totals-mismatch row the
 * row's own situation decides (in doubt → never "file it by hand"; a refund →
 * Retry cannot rebuild it); everything else is connectorErrorText.
 */
export function retryErrorText(err: unknown, d: MismatchFields | null | undefined): string {
  if (d && isTotalsMismatch(d) && err instanceof ApiError && (err.code === 'TOTALS_MISMATCH' || err.code === 'FISCAL_IN_DOUBT')) {
    const what = d.kind === 'refund' ? 'refund' : 'sale'
    if (isMismatchInDoubt(d) || err.code === 'FISCAL_IN_DOUBT') return `Not sent. ${IN_DOUBT_STEPS(what)}`
    if (d.kind === 'refund') {
      return 'The refund’s stored figures still do not add up — Retry does not rebuild a refund, so it cannot pass. File it on the authority portal and use Record manual filing.'
    }
  }
  return connectorErrorText(err)
}

/** Plain words for a document's statusReason (the server's codes). */
export function docReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null
  switch (reason) {
    case TOTALS_MISMATCH_REASON: return 'Figures do not add up — not sent'
    case 'no_connector': return 'Fiscal POS not live'
    case 'not_registered': return 'Brand has no POS id'
    case 'zero_value': return 'Zero-value bill (not filed by setting)'
    case 'zero_value_unsupported': return 'Zero-value bill the fiscal POS cannot take'
    case 'prefiled_direct': case 'prefiled_direct_refund': return 'Filed directly before the connector'
    case 'no_sale_document': return 'No sale document to refund against'
    case 'refunds_unsupported': return 'The fiscal POS does not take refunds'
    case 'legacy_unfiled': return 'Unfiled sale from the old direct queue'
    case 'operator': return 'Recorded by hand'
    default: return reason.replace(/_/g, ' ')
  }
}

// ─── Labels ──────────────────────────────────────────────────────────────────

export const DOC_STATUS_LABEL: Record<FiscalDocStatus, string> = {
  held: 'Held',
  waiting: 'Waiting for sale',
  pending: 'Pending',
  submitting: 'Sending',
  filed: 'Filed',
  rejected: 'Rejected',
  failed: 'Failed',
  skipped: 'Not required',
  manual_required: 'File by hand',
  manual_filed: 'Filed by hand',
}

export const CHARGE_STATUS_LABEL: Record<TerminalChargeStatus, string> = {
  pending: 'Starting',
  sent: 'On the machine',
  approved: 'Approved',
  recorded: 'Paid',
  declined: 'Declined',
  cancel_requested: 'Cancelling',
  cancelled: 'Cancelled',
  expired: 'Expired',
  unknown: 'Outcome unknown',
  unverified: 'Not charged (to verify)',
  void_pending: 'Reversing',
  voided: 'Reversed',
  needs_attention: 'Needs attention',
  manual_resolved: 'Recorded from slip',
}

export function authorityLabel(a: string | null | undefined): string {
  return a ? a.toUpperCase() : '—'
}
