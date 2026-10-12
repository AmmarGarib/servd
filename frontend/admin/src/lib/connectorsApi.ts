// API client for Dev → API (spec §8.1, §8.5, §10, §17.0, §17.7).
//
// Coded against the REAL routes in backend/src/modules/connectors/routes.ts
// (prefix /connectors) and the WhatsApp handlers in
// backend/src/modules/auth/routes.ts (/auth/integrations/*). Every
// /connectors call binds to the operator's ACTIVE company on the server; the
// pages say which company they show.
//
// Secrets never come back from the server — only hints (first 4 + last 4).
// The exceptions are a freshly regenerated webhook secret
// (`newWebhookSecret`, returned once by PUT /connectors/:kind) and a bank-SMS
// device token (returned once when a device is added or rotated; the CEO may
// reveal it again, audited).
//
// Raast QR bank alerts (2026-10-12) live under /connectors/raast (module
// api_pos — no new module id). Bank-SMS matching is OFF per company until the
// CEO switches it on; servd never logs in to internet banking.
//
// There is NO skip anywhere (§17.0): held documents are released all at once
// per company (or per brand), never by date range, and no document can be
// excluded from filing by an operator.

import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from './api'

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** Kinds the generic PUT /connectors/:kind configures. Raast has its own routes (/connectors/raast/*). */
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
  /** Raast QR bank alerts. Optional only so an older API (before Raast) still types. */
  raast?: RaastOverview
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

// ─── Raast QR bank alerts (/connectors/raast/*) ─────────────────────────────

export interface RaastCounts {
  /** Raast intents waiting at a till for the customer's transfer. */
  awaiting: number
  /** Paid at the till, not yet matched to a bank-statement line. */
  provisional: number
  needsAttention: number
  /** Bank SMS that fit no bill, or more than one, or need a person. */
  unmatchedAlerts: number
  /** Bank SMS from a listed sender that no template could read, last 24 h. */
  unparsed24h: number
}

/** GET /connectors overview → raast. */
export interface RaastOverview {
  /** Bank-SMS matching ON for the company. */
  enabled: boolean
  /** Active counter phones. */
  devices: number
  lastSmsAt: string | null
  counts: RaastCounts
}

export interface RaastSender {
  id: string
  /** Normalised by the server (HBL-Alert → HBLALERT, 0300… → 92300…). */
  senderId: string
  bankAccountId: string
  /** Needed when one sender reports on several accounts. */
  accountLast4?: string
  templateIds: string[]
  active: boolean
}

export type RaastTemplateKind = 'credit' | 'debit'

export interface RaastTemplate {
  id: string
  label: string
  kind: RaastTemplateKind
  /** servd's own template language — placeholders {amount} {ref} {date} {time} {account} {payer} {*}. Never a regex. */
  template: string
  dateFormat?: string
  timeFormat?: string
  active: boolean
}

export interface RaastSettings {
  matchWindowMin: number
  intentTtlMin: number
  clockSkewMin: number
  smsConfirmMin: number
  unmatchedAlertEscalateMin: number
  statementMatchDays: number
  provisionalFlagDays: number
  refMinLength: number
  refMaxLength: number
  ignoreKeywords: string[]
  senders: RaastSender[]
  templates: RaastTemplate[]
}

export type RaastNumberKey =
  | 'matchWindowMin' | 'intentTtlMin' | 'clockSkewMin' | 'smsConfirmMin' | 'unmatchedAlertEscalateMin'
  | 'statementMatchDays' | 'provisionalFlagDays' | 'refMinLength' | 'refMaxLength'

/** The scalar Raast settings, with their allowed ranges (backend connectors/config.ts). */
export const RAAST_NUMBER_SETTINGS: Array<{ key: RaastNumberKey; label: string; min: number; max: number; hint: string }> = [
  { key: 'intentTtlMin', label: 'Raast request expires after (min)', min: 5, max: 120, hint: 'How long a till waits for the customer’s transfer before the request lapses.' },
  { key: 'matchWindowMin', label: 'Match window (min)', min: 2, max: 60, hint: 'How far back from the SMS time a waiting bill may have been put up for Raast.' },
  { key: 'clockSkewMin', label: 'Clock difference allowed (min)', min: 0, max: 10, hint: 'Allowance for the bank’s SMS clock running ahead of servd.' },
  { key: 'smsConfirmMin', label: 'Flag a typed reference with no SMS after (min)', min: 5, max: 240, hint: 'While matching is on, a cashier-typed reference with no bank SMS raises a flag after this.' },
  { key: 'unmatchedAlertEscalateMin', label: 'Escalate an unmatched SMS after (min)', min: 15, max: 1440, hint: 'An SMS nobody attached to a bill is flagged to finance and the floor.' },
  { key: 'statementMatchDays', label: 'Statement match window (days)', min: 1, max: 10, hint: 'Days either side of the payment a statement line may fall on.' },
  { key: 'provisionalFlagDays', label: 'Flag unmatched receipts after (days)', min: 1, max: 30, hint: 'Receipts still not on a bank statement after this are flagged to finance.' },
  { key: 'refMinLength', label: 'Shortest reference', min: 4, max: 20, hint: 'Characters, after spaces and dashes are removed.' },
  { key: 'refMaxLength', label: 'Longest reference', min: 8, max: 64, hint: 'Characters, after spaces and dashes are removed.' },
]

/** The raast connector row as /connectors/raast shows it. */
export interface RaastConnectorView {
  id: string
  kind: 'raast'
  driver: string
  enabled: boolean
  smsMatching: boolean
  smsOnSince: string | null
  settings: RaastSettings
  updatedAt: string
}

export interface RaastDevice {
  id: string
  label: string
  locationId: string | null
  active: boolean
  /** S2: the forwarder may put the token in the URL (weaker — URLs land in logs). Off by default. */
  allowPathToken: boolean
  tokenHint: string
  lastSeenAt: string | null
  lastSmsAt: string | null
  /** SMS from senders not on the list (or with an ignore keyword) — never stored. */
  ignoredCount: number
  lastIgnoredAt: string | null
  rotatedAt: string | null
  createdAt: string
}

export interface RaastAccount {
  bankAccountId: string
  ledgerCode: string
  bankName: string | null
  accountTitle: string | null
  raastId: string | null
  last4: string | null
}

export interface RaastBankAccountLite {
  id: string
  name: string
  bankName: string | null
  last4: string | null
  accountCode: string | null
  raastId: string | null
}

export interface RaastReceivingAccounts {
  default: RaastAccount | null
  brands: Array<{ conceptId: string; name: string; overrideBankAccountId: string | null; effective: RaastAccount | null }>
  /** The company's active, ledger-linked bank accounts (a sender reports on one of these). */
  bankAccounts: RaastBankAccountLite[]
}

/** GET /connectors/raast/settings */
export interface RaastSettingsPage {
  connector: RaastConnectorView
  devices: RaastDevice[]
  receivingAccounts: RaastReceivingAccounts
  counts: RaastCounts
  /** What stops the CEO switching SMS matching on (empty when ready). */
  readiness: { ready: boolean; missing: string[] }
  secretKeyConfigured: boolean
}

/** PUT /connectors/raast/settings — partial; a list (senders / templates) replaces the stored one. New entries have no id. */
export type RaastSettingsPatch = Partial<Omit<RaastSettings, 'senders' | 'templates'>> & {
  senders?: Array<Omit<RaastSender, 'id'> & { id?: string }>
  templates?: Array<Omit<RaastTemplate, 'id'> & { id?: string }>
}

/** A new / rotated / revealed device token — shown ONCE. */
export interface RaastDeviceToken {
  device: RaastDevice
  token: string
  /** Where the forwarder posts (header auth — preferred). */
  postUrl: string
  /** The header line to put in the forwarder. */
  header: string
  /** Only when the device allows a token in the URL (S2); else null. */
  pathUrl: string | null
}

export interface RaastParseFields {
  amountCents: number
  bankRef: string | null
  refValid: boolean
  occurredAt: string
  occurredAtSource?: 'sms' | 'forwarder' | 'server'
  accountLast4: string | null
  payer: string | null
}

/** POST /connectors/raast/test-parse — writes nothing. */
export interface RaastTestParseResult {
  sender: string
  senderAllowed: boolean
  ignoredByKeyword: boolean
  results: Array<{
    templateId: string
    label: string
    kind: RaastTemplateKind
    active: boolean
    matched: boolean
    fields: RaastParseFields | null
    problems: string[]
  }>
}

export type BankSmsStatus =
  | 'received' | 'processing' | 'unparsed' | 'off' | 'debit' | 'duplicate' | 'matched' | 'confirmed'
  | 'unmatched' | 'ambiguous' | 'needs_attention' | 'attached' | 'dismissed'

export const BANK_SMS_STATUSES: BankSmsStatus[] = [
  'received', 'processing', 'unparsed', 'off', 'debit', 'duplicate', 'matched', 'confirmed',
  'unmatched', 'ambiguous', 'needs_attention', 'attached', 'dismissed',
]

export const BANK_SMS_STATUS_LABEL: Record<BankSmsStatus, string> = {
  received: 'Received',
  processing: 'Reading',
  unparsed: 'Not understood',
  off: 'Read (matching off)',
  debit: 'Money out',
  duplicate: 'Duplicate',
  matched: 'Paid a bill',
  confirmed: 'Confirmed a typed reference',
  unmatched: 'No bill found',
  ambiguous: 'Fits more than one bill',
  needs_attention: 'Needs attention',
  attached: 'Attached at the till',
  dismissed: 'Not a sale',
}

export interface BankSmsRow {
  id: string
  status: BankSmsStatus
  sender: string
  /** null after the retention period. */
  body: string | null
  device: string
  locationId: string | null
  receivedAt: string
  kind: RaastTemplateKind | null
  templateId: string | null
  amountCents: number | null
  bankRef: string | null
  occurredAt: string | null
  payer: string | null
  accountLast4: string | null
  bankAccountId: string | null
  resolution: string | null
  receipt: { id: string; orderId: string; status: string } | null
}

export interface BankSmsPage { items: BankSmsRow[]; nextCursor: string | null }

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

  // Raast QR bank alerts (/connectors/raast — the ACTIVE company).
  raastSettings: () => api.get<RaastSettingsPage>('/connectors/raast/settings'),
  saveRaastSettings: (patch: RaastSettingsPatch) => api.put<RaastConnectorView>('/connectors/raast/settings', patch),
  /** CEO only; 409 NOT_READY { missing[] } until the readiness check passes. */
  raastSmsOn: () => api.post<RaastConnectorView>('/connectors/raast/sms-on', { confirm: 'SMS ON' }),
  raastSmsOff: () => api.post<RaastConnectorView & { awaiting: number }>('/connectors/raast/sms-off', { confirm: 'SMS OFF' }),
  addRaastDevice: (body: { label: string; locationId?: string | null; allowPathToken?: boolean }) =>
    api.post<RaastDeviceToken>('/connectors/raast/devices', body),
  rotateRaastDevice: (id: string) => api.post<RaastDeviceToken>(`/connectors/raast/devices/${encodeURIComponent(id)}/rotate`, {}),
  updateRaastDevice: (id: string, body: { label?: string; locationId?: string | null; active?: boolean; allowPathToken?: boolean }) =>
    api.patch<RaastDevice>(`/connectors/raast/devices/${encodeURIComponent(id)}`, body),
  /** CEO only, audited. */
  revealRaastDevice: (id: string) => api.post<RaastDeviceToken>(`/connectors/raast/devices/${encodeURIComponent(id)}/reveal`, {}),
  raastTestParse: (body: { sender: string; body: string; templates?: Array<Omit<RaastTemplate, 'id'> & { id?: string }> }) =>
    api.post<RaastTestParseResult>('/connectors/raast/test-parse', body),
  raastSms: (f: { status?: string; cursor?: string; limit?: number }) =>
    api.get<BankSmsPage>(`/connectors/raast/sms${q(f)}`),

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

/** The active company's Raast QR set-up (settings, devices, receiving accounts, readiness). */
export function useRaastSettings(opts: { refetchMs?: number } = {}) {
  return useQuery({
    queryKey: ['raast-settings'],
    queryFn: connectorsApi.raastSettings,
    refetchInterval: opts.refetchMs,
    retry: (n, err) => !(err instanceof ApiError && [401, 403, 404, 422].includes(err.status)) && n < 2,
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
      case 'NOT_READY':
        return err.message || 'Not ready yet — see the list of what is missing.'
      case 'INVALID_TEMPLATE':
        return `Template not saved: ${err.message.replace(/^Template /, '')}`
      case 'BANK_ACCOUNT_NOT_IN_COMPANY':
        return `${err.message}. Finance links the account to the chart in Finance → Bank accounts.`
      case 'NOT_IN_COMPANY':
        return 'That outlet does not belong to this company.'
      case 'INVALID_SETTINGS':
        return err.message || 'Those settings do not fit together.'
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
