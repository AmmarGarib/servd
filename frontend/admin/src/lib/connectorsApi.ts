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
    api.put<{ fiscalReportingRequired: boolean }>('/connectors/fiscal/reporting-required', { required, reason }),
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
