'use client'
// Card payouts (H12) — Keenu pays a card day's takings into the payout bank a
// day or two later, NET of its fee. Matching a payout line books the split
// BOOKS-11 books by hand (Dr bank net + Dr 6080 fee, tax on the fee included /
// Cr 1030 gross) and marks the card days settled, so 1030 is never cleared
// twice. API: /reconciliation/card-payouts/* (backend cardPayoutRoutes.ts):
//   GET  /settings · PUT /settings (canEdit: admin, finance)
//   GET  /?from&to   settlements + unsettled card days + capability flags
//   GET  /lines/:id/suggestions → POST /lines/:id/confirm { days, unit }
//   POST /:id/undo { reason } (approvers) · POST /rematch (admin, finance)
// Every figure is the server's; the page never works a fee out.
import { Button, CheckLabel, Field, Input, LinkButton } from '@/components/finance/ui'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { BankAccountSelect } from '../../components/finance/BankAccountSelect'
import { Select } from '@/components/ui/Select'
import { Modal } from '../../components/ui/Modal'
import { NumberField } from '../../components/ui/NumberField'
import { DialogForm } from '../../components/finance/PaymentReceivedFields'

/** A settings string ↔ NumberField value (the strings are what the form always held). */
const asNum = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const fromNum = (n: number | null): string => (n == null ? '' : String(n))

// ─── Types (the API's shapes) ────────────────────────────────────────────────

type UnitMode = 'company' | 'brand' | 'terminal'
export interface CardPayoutSettings {
  enabled: boolean
  payoutBankAccountId: string | null
  unitMode: UnitMode
  mdrBps: number
  feeTaxBps: number
  lagDays: number
  toleranceBps: number
  maxBatchDays: number
  maxFeeBps: number
  startDay: string | null
}
interface SettingsResp {
  tenantId: string
  settings: CardPayoutSettings
  payoutBank: { id: string; name: string; bankName: string | null; accountCode: string | null; live: boolean } | null
  canEdit: boolean
}
interface UnsettledDay { unit: string; unitLabel: string; day: string; cents: number; ageDays: number }
interface Settlement {
  id: string; tenantId: string; unit: string; unitLabel: string
  status: 'auto' | 'confirmed' | 'manual_adjust' | string
  dayFrom: string; dayTo: string
  grossCents: number; feeCents: number; feeTaxCents: number; netCents: number; feeBps: number
  journalEntryId: string | null; createdAt: string
  createdBy: { id: string; name: string | null } | null
  bankAccount: { id: string; name: string; bankName: string | null } | null
  statementLine: { id: string; postedDate: string; description: string; reference: string | null; amountCents: number; matchStatus: string } | null
  days: Array<{ day: string; grossCents: number }>
}
interface ListResp {
  from: string
  to: string
  companies: Array<{ tenantId: string; enabled: boolean; settings: CardPayoutSettings; unsettled: UnsettledDay[]; unsettledCents: number }>
  settlements: Settlement[]
  canConfirm: boolean
  canUndo: boolean
  canEditSettings: boolean
  canRematch: boolean
}
/** A statement line's chip (GET /reconciliation/bank/imports/:id/lines → line.cardSettlement). */
export interface CardSettlementChip { id: string; dayFrom: string; dayTo: string; feeCents: number; grossCents: number; status: string; unit: string }
interface Suggestion {
  unit: string; unitLabel: string; dayFrom: string; dayTo: string; days: string[]
  grossCents: number; expectedNetCents: number; impliedFeeCents: number; impliedFeeBps: number; fits: boolean
}
interface SuggestResp {
  line: { id: string; tenantId: string; postedDate: string; description: string; reference: string | null; amountCents: number; matchStatus: string }
  enabled: boolean
  onPayoutBank: boolean
  settings: { unitMode: UnitMode; mdrBps: number; feeTaxBps: number; maxFeeBps: number; toleranceBps: number; startDay: string | null }
  suggestions: Suggestion[]
  canConfirm: boolean
}

// ─── Words ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  auto: 'Matched automatically',
  confirmed: 'Confirmed by hand',
  manual_adjust: 'Booked as a manual split',
}
const UNIT_MODE_LABEL: Record<UnitMode, string> = {
  company: 'One payout for the whole company',
  brand: 'One payout per brand',
  terminal: 'One payout per card machine',
}
const ERROR_TEXT: Record<string, string> = {
  USE_CARD_PAYOUT_CONFIRM: 'Card payout matching is on for this bank. Use "Card payout?" on the line to confirm which card days it pays — 1030 is never cleared twice.',
  CARD_PAYOUT_LINE: 'This line is a card payout. Undo it on the Card payouts tab: its entry is reversed and its card days are freed.',
  LINE_NOT_UNMATCHED: 'This line is already matched or cleared — refresh the list.',
  LINE_NOT_A_CREDIT: 'A card payout is money coming in — this line is not a credit.',
  NOT_THE_PAYOUT_BANK: 'This line is not on the bank Keenu pays into (see the card payout settings).',
  DAY_ALREADY_SETTLED: 'One of those card days is already settled by another payout — refresh and pick again.',
  NO_CARD_MONEY_ON_DAYS: 'There are no card sales on those days to settle.',
  FEE_OUT_OF_RANGE: 'The fee this payout implies is outside the range allowed in the settings — check the days.',
  PERIOD_LOCKED: 'The books are closed for the payout\'s date — it cannot be booked there.',
  CARD_PAYOUTS_OFF: 'Card payout matching is off for this company — switch it on in the settings first.',
  CARD_DAYS_INVALID: 'The card days must follow each other and be at most five days.',
  CARD_UNIT_INVALID: 'Pick which brand or card machine this payout is for.',
  DAY_BEFORE_START: 'Matching starts on the start day in the settings; earlier days were cleared by hand.',
  DAYS_NOT_BEFORE_PAYOUT: 'A payout settles card days BEFORE its own date.',
  CARD_PAYOUT_CHANGED: 'The card sales on those days changed since the statement was imported — confirm the payout by hand.',
  CARD_SETTLEMENT_ENTRY_MISSING: 'This payout\'s journal entry was not found — ask the CEO to check it.',
  ACCOUNT_NOT_FOUND: 'The payout bank\'s chart code is not an active account of this company.',
  PAYOUT_BANK_REQUIRED: 'Pick the bank account Keenu pays into before switching matching on.',
  MAX_FEE_BELOW_MDR: 'The largest fee allowed is below the MDR itself — raise it or lower the MDR.',
  START_DAY_IN_FUTURE: 'The first card day to match cannot be after today.',
  START_DAY_BEFORE_MANUAL_SPLIT: 'Card days up to that date were cleared by a manual split — start matching after it.',
  BANK_ACCOUNT_NOT_IN_COMPANY: 'That bank account is not an active account of this company.',
  BANK_ACCOUNT_NOT_LINKED: 'Link that bank account to a chart code first (Configuration → Bank accounts).',
  BANK_ACCOUNT_NOT_A_BANK: 'That account is not a bank balance — Keenu pays into a bank.',
  NO_ACTIVE_COMPANY: 'Pick one company first — card payout settings are per company.',
  BAD_RANGE: 'The start date is after the end date.',
  VALIDATION_ERROR: 'One of the values is out of range — check the numbers.',
}
export function cardPayoutErrorText(e: unknown): string {
  const x = e as { code?: string; message?: string; details?: unknown } | null
  if (x instanceof ApiError && x.code === 'START_DAY_BEFORE_MANUAL_SPLIT') {
    const d = x.details as { earliestStartDay?: string } | undefined
    if (d?.earliestStartDay) return `Card days before ${d.earliestStartDay} were cleared by a manual split — start matching on ${d.earliestStartDay} or later.`
  }
  return (x?.code && ERROR_TEXT[x.code]) || x?.message || 'Something went wrong'
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayRange = (a: string, b: string) => (a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`)
/** The % typed → bps (null when not a number). */
const bpsOf = (s: string): number | null => {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

const LIST_KEY = ['card-payouts'] as const

function useCardPayoutList(enabled = true) {
  return useQuery<ListResp>({
    queryKey: LIST_KEY,
    queryFn: () => api.get('/reconciliation/card-payouts'),
    staleTime: 30_000,
    retry: false,
    enabled,
    // The tab shows its own error; the statement view only reads the payout banks.
    meta: { inlineErrors: true },
  })
}

/** The payout banks of the companies in view where matching is on (for the statement lines' "Card payout?"). */
export function useCardPayoutBanks(enabled = true): Set<string> {
  const { data } = useCardPayoutList(enabled)
  const ids = new Set<string>()
  for (const c of data?.companies ?? []) if (c.enabled && c.settings.payoutBankAccountId) ids.add(c.settings.payoutBankAccountId)
  return ids
}

/** The chip a statement line matched to a card payout carries. */
export function CardPayoutChip({ chip, onOpen }: { chip: CardSettlementChip; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${STATUS_LABEL[chip.status] ?? chip.status}: card sales ${fmtPkr(chip.grossCents)}, fee ${fmtPkr(chip.feeCents)}`}
      className="ml-2 s-badge-green text-xs font-semibold"
    >
      Card payout {dayRange(chip.dayFrom, chip.dayTo)}
    </button>
  )
}

// ─── The tab ─────────────────────────────────────────────────────────────────

export function CardPayouts() {
  const qc = useQueryClient()
  const list = useCardPayoutList()
  const [undoing, setUndoing] = useState<Settlement | null>(null)
  const rematch = useMutation({
    mutationFn: () => api.post<{ matched: number; candidates: number; refused: Array<{ lineId: string; code: string; reason: string }> }>('/reconciliation/card-payouts/rematch', {}),
    meta: { inlineErrors: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY })
      void qc.invalidateQueries({ queryKey: ['bank-lines'] })
    },
  })
  const d = list.data

  return (
    <div className="space-y-4">
      <SettingsCard />

      <div className="s-card overflow-hidden">
        <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-s-text">
            Card payouts — last 90 days
            <span className="block font-normal text-s-muted">The fee (and the tax on it) is a cost on 6080, booked when Keenu pays.</span>
          </span>
          {d?.canRematch && (
            <Button size="sm" variant="secondary" type="button" onClick={() => rematch.mutate()} disabled={rematch.isPending}>
              {rematch.isPending ? 'Matching…' : 'Re-run matching'}
            </Button>
          )}
        </div>
        {rematch.data && (
          <div className="px-4 py-2 text-xs border-b border-s-border">
            <p className="text-s-text">
              Matched {rematch.data.matched} of {rematch.data.candidates} unmatched credit{rematch.data.candidates === 1 ? '' : 's'} on the payout bank (last 60 days).
            </p>
            {rematch.data.refused.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-s-muted">
                {rematch.data.refused.slice(0, 20).map((r) => (
                  <li key={r.lineId}>{ERROR_TEXT[r.code] ?? r.reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {rematch.error && <p className="px-4 py-2 text-xs text-s-red">{cardPayoutErrorText(rematch.error)}</p>}
        {list.isLoading && <p className="px-4 py-3 text-xs text-s-muted">Loading…</p>}
        {list.error && <p className="px-4 py-3 text-xs text-s-red">{cardPayoutErrorText(list.error)}</p>}
        {d && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-s-muted">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Card days</th>
                  <th className="px-4 py-2 text-left font-medium">Paid in</th>
                  <th className="px-4 py-2 text-right font-medium">Card sales</th>
                  <th className="px-4 py-2 text-right font-medium">Fee</th>
                  <th className="px-4 py-2 text-right font-medium">Received</th>
                  {d.canUndo && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {d.settlements.map((s) => (
                  <tr key={s.id} className="border-t border-s-border align-top">
                    <td className="px-4 py-2 text-xs text-s-text">
                      <div className="font-semibold whitespace-nowrap">{dayRange(s.dayFrom, s.dayTo)}</div>
                      <div className="text-s-muted">{s.unitLabel}</div>
                      <div className="text-s-muted">{STATUS_LABEL[s.status] ?? s.status}{s.createdBy?.name ? ` · ${s.createdBy.name}` : ''}</div>
                    </td>
                    <td className="px-4 py-2 text-xs text-s-text">
                      {s.statementLine ? s.statementLine.postedDate.slice(0, 10) : '—'}
                      {s.bankAccount && <div className="text-s-muted">{s.bankAccount.name}</div>}
                      {s.statementLine && <div className="text-s-muted break-words">{s.statementLine.description}</div>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(s.grossCents)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                      {fmtPkr(s.feeCents)}
                      <div className="text-s-muted font-sans">{pct(s.feeBps)}{s.feeTaxCents > 0 ? ` · incl. tax ${fmtPkr(s.feeTaxCents)}` : ''}</div>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-s-text">{fmtPkr(s.netCents)}</td>
                    {d.canUndo && (
                      <td className="px-4 py-2 text-right">
                        {s.status !== 'manual_adjust' && (
                          <LinkButton tone="muted" type="button" onClick={() => setUndoing(s)}>Undo</LinkButton>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {d.settlements.length === 0 && (
                  <tr><td colSpan={d.canUndo ? 6 : 5} className="px-4 py-3 text-xs text-s-muted">No card payouts matched in the last 90 days.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {d && d.companies.some((c) => c.enabled) && (
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
            Card days not paid out yet
            <span className="block font-normal text-s-muted">Card sales still in 1030 Card receivable. A day older than the lag plus a few days usually means a payout line is waiting on a statement.</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {d.companies.flatMap((c) => c.unsettled.map((u) => (
                  <tr key={`${c.tenantId}-${u.unit}-${u.day}`} className="border-t border-s-border">
                    <td className="px-4 py-2 text-xs text-s-text whitespace-nowrap">{fmtDay(u.day)}</td>
                    <td className="px-4 py-2 text-xs text-s-muted">{u.unitLabel}</td>
                    <td className={`px-4 py-2 text-xs ${u.ageDays > c.settings.lagDays + 3 ? 'text-s-red' : 'text-s-muted'}`}>{u.ageDays} day{u.ageDays === 1 ? '' : 's'} ago</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(u.cents)}</td>
                  </tr>
                )))}
                {d.companies.every((c) => c.unsettled.length === 0) && (
                  <tr><td className="px-4 py-3 text-xs text-s-muted">Every card day since matching started has its payout.</td></tr>
                )}
              </tbody>
              {d.companies.some((c) => c.unsettled.length > 0) && (
                <tfoot className="border-t border-s-border bg-s-bg-soft">
                  {d.companies.filter((c) => c.unsettled.length > 0).map((c) => (
                    <tr key={c.tenantId}>
                      <td colSpan={3} className="px-4 py-2 text-xs font-semibold text-s-text">Waiting for payout</td>
                      <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-s-text">{fmtPkr(c.unsettledCents)}</td>
                    </tr>
                  ))}
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {undoing && <UndoModal settlement={undoing} onClose={() => setUndoing(null)} />}
    </div>
  )
}

// ─── Settings ────────────────────────────────────────────────────────────────

interface SettingsForm {
  enabled: boolean; payoutBankAccountId: string; unitMode: UnitMode
  mdr: string; feeTax: string; lagDays: string; tolerance: string; maxBatchDays: string; maxFee: string; startDay: string
}
const formOf = (s: CardPayoutSettings): SettingsForm => ({
  enabled: s.enabled, payoutBankAccountId: s.payoutBankAccountId ?? '', unitMode: s.unitMode,
  mdr: String(s.mdrBps / 100), feeTax: String(s.feeTaxBps / 100), lagDays: String(s.lagDays),
  tolerance: String(s.toleranceBps / 100), maxBatchDays: String(s.maxBatchDays), maxFee: String(s.maxFeeBps / 100),
  startDay: s.startDay ?? '',
})

function SettingsCard() {
  const qc = useQueryClient()
  const q = useQuery<SettingsResp>({
    queryKey: ['card-payout-settings'],
    queryFn: () => api.get('/reconciliation/card-payouts/settings'),
    retry: false,
    meta: { inlineErrors: true },
  })
  const [f, setF] = useState<SettingsForm | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { if (q.data) setF(formOf(q.data.settings)) }, [q.data])

  const save = useMutation({
    mutationFn: (body: Partial<CardPayoutSettings>) => api.put<{ tenantId: string; settings: CardPayoutSettings }>('/reconciliation/card-payouts/settings', body),
    meta: { inlineErrors: true },
    onSuccess: () => {
      setSaved(true)
      void qc.invalidateQueries({ queryKey: ['card-payout-settings'] })
      void qc.invalidateQueries({ queryKey: LIST_KEY })
    },
  })

  if (q.isLoading) return <div className="s-card p-4 text-xs text-s-muted">Loading card payout settings…</div>
  if (q.error) return <div className="s-card p-4 text-xs text-s-muted">{cardPayoutErrorText(q.error)}</div>
  if (!q.data || !f) return null
  const s = q.data.settings
  const edit = q.data.canEdit

  // What changed, in the API's units (bps, whole days).
  const patch: Partial<CardPayoutSettings> = {}
  const check = { bad: false }
  const num = (v: string, lo: number, hi: number) => {
    const n = Number(v)
    if (v.trim() === '' || !Number.isInteger(n) || n < lo || n > hi) { check.bad = true; return null }
    return n
  }
  const bps = (v: string, hi: number) => {
    const n = bpsOf(v)
    if (n == null || n < 0 || n > hi) { check.bad = true; return null }
    return n
  }
  const mdrBps = bps(f.mdr, 1000); const feeTaxBps = bps(f.feeTax, 3000)
  const toleranceBps = bps(f.tolerance, 200); const maxFeeBps = bps(f.maxFee, 1000)
  const lagDays = num(f.lagDays, 1, 5); const maxBatchDays = num(f.maxBatchDays, 1, 5)
  if (f.enabled !== s.enabled) patch.enabled = f.enabled
  if ((f.payoutBankAccountId || null) !== s.payoutBankAccountId) patch.payoutBankAccountId = f.payoutBankAccountId || null
  if (f.unitMode !== s.unitMode) patch.unitMode = f.unitMode
  if (mdrBps != null && mdrBps !== s.mdrBps) patch.mdrBps = mdrBps
  if (feeTaxBps != null && feeTaxBps !== s.feeTaxBps) patch.feeTaxBps = feeTaxBps
  if (toleranceBps != null && toleranceBps !== s.toleranceBps) patch.toleranceBps = toleranceBps
  if (maxFeeBps != null && maxFeeBps !== s.maxFeeBps) patch.maxFeeBps = maxFeeBps
  if (lagDays != null && lagDays !== s.lagDays) patch.lagDays = lagDays
  if (maxBatchDays != null && maxBatchDays !== s.maxBatchDays) patch.maxBatchDays = maxBatchDays
  if ((f.startDay || null) !== s.startDay) patch.startDay = f.startDay || null
  const dirty = Object.keys(patch).length > 0
  const bad = check.bad
  const set = (k: keyof SettingsForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSaved(false)
    setF((p) => (p ? { ...p, [k]: e.target.value } : p))
  }

  return (
    <div className="s-card p-4 space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-s-text">Card payout settings</h2>
          <p className="text-xs text-s-muted">
            How Keenu pays this company&apos;s card sales. With matching on, a credit on the payout bank is matched to the card days it pays and booked with its fee.
          </p>
        </div>
        <span className={s.enabled ? 's-badge-green text-xs' : 's-badge-muted text-xs'}>{s.enabled ? 'Matching is on' : 'Matching is off'}</span>
      </div>
      {!edit && <p className="text-xs text-s-muted">Read only — the CEO and finance change these.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <CheckLabel className="flex items-center gap-2 sm:col-span-2">
          <input type="checkbox" className="accent-accent" checked={f.enabled} disabled={!edit} onChange={(e) => { setSaved(false); setF((p) => (p ? { ...p, enabled: e.target.checked } : p)) }} />
          <span className="text-sm text-s-text">Match card payouts automatically</span>
        </CheckLabel>
        <div className="sm:col-span-2">
          {edit
            ? <BankAccountSelect tenantId={q.data.tenantId} value={f.payoutBankAccountId} onChange={(v) => { setSaved(false); setF((p) => (p ? { ...p, payoutBankAccountId: v } : p)) }} className="s-input" label="Payout bank (Keenu pays into)" />
            : <Field label="Payout bank"><span className="block py-1.5 text-s-text">{q.data.payoutBank ? q.data.payoutBank.name : 'Not set'}</span></Field>}
          {q.data.payoutBank && !q.data.payoutBank.live && <p className="text-xs text-s-red mt-1">That bank account is no longer active — pick another.</p>}
        </div>
        <Field label="How Keenu pays">
          <Select className="s-input" value={f.unitMode} disabled={!edit} onChange={set('unitMode')}>
            {(Object.keys(UNIT_MODE_LABEL) as UnitMode[]).map((k) => <option key={k} value={k}>{UNIT_MODE_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label="Matching starts on" hint="Card days before it were cleared by hand. Set automatically the first time matching is switched on.">
          <Input type="date" min="2000-01-01" value={f.startDay} disabled={!edit} onChange={set('startDay')} />
        </Field>
        <Field label="MDR (Keenu's fee), %" hint="Of the card sales, e.g. 2.5">
          <NumberField decimals={2} min={0} max={10} className="s-input" value={asNum(f.mdr)} disabled={!edit} onValueChange={(n) => { setSaved(false); setF((p) => (p ? { ...p, mdr: fromNum(n) } : p)) }} />
        </Field>
        <Field label="Tax on the fee, %" hint="Only helps predict the payout; the whole fee is a cost (6080).">
          <NumberField decimals={2} min={0} max={30} className="s-input" value={asNum(f.feeTax)} disabled={!edit} onValueChange={(n) => { setSaved(false); setF((p) => (p ? { ...p, feeTax: fromNum(n) } : p)) }} />
        </Field>
        <Field label="Paid within (days)" hint="Keenu pays 1 to this many days after the card day (1–5).">
          <NumberField min={1} max={5} className="s-input" value={asNum(f.lagDays)} disabled={!edit} onValueChange={(n) => { setSaved(false); setF((p) => (p ? { ...p, lagDays: fromNum(n) } : p)) }} />
        </Field>
        <Field label="One payout covers at most (days)" hint="A weekend batch is 3 (1–5).">
          <NumberField min={1} max={5} className="s-input" value={asNum(f.maxBatchDays)} disabled={!edit} onValueChange={(n) => { setSaved(false); setF((p) => (p ? { ...p, maxBatchDays: fromNum(n) } : p)) }} />
        </Field>
        <Field label="Tolerance, % of card sales" hint="How far a payout may be from the prediction (0–2).">
          <NumberField decimals={2} min={0} max={2} className="s-input" value={asNum(f.tolerance)} disabled={!edit} onValueChange={(n) => { setSaved(false); setF((p) => (p ? { ...p, tolerance: fromNum(n) } : p)) }} />
        </Field>
        <Field label="Largest fee allowed, %" hint="A confirm implying a bigger fee is refused (0–10).">
          <NumberField decimals={2} min={0} max={10} className="s-input" value={asNum(f.maxFee)} disabled={!edit} onValueChange={(n) => { setSaved(false); setF((p) => (p ? { ...p, maxFee: fromNum(n) } : p)) }} />
        </Field>
      </div>
      {edit && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button"  disabled={!dirty || bad || save.isPending} onClick={() => save.mutate(patch)}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
          {bad && <span className="text-xs text-s-red">A number is out of range — see the hints.</span>}
          {save.error && <span className="text-xs text-s-red">{cardPayoutErrorText(save.error)}</span>}
          {saved && !dirty && !save.error && <span className="text-xs text-success">Saved.</span>}
        </div>
      )}
    </div>
  )
}

// ─── Undo ────────────────────────────────────────────────────────────────────

function UndoModal({ settlement, onClose }: { settlement: Settlement; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const go = useMutation({
    mutationFn: () => api.post(`/reconciliation/card-payouts/${settlement.id}/undo`, { reason: reason.trim() }),
    meta: { inlineErrors: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY })
      void qc.invalidateQueries({ queryKey: ['bank-lines'] })
      onClose()
    },
  })
  return (
    <Modal title="Undo this card payout" onClose={onClose} dirty={!go.isPending && !!reason.trim()}>
      <DialogForm busy={go.isPending} onSubmit={() => go.mutate()} missing={reason.trim().length < 3 ? 'Give a reason (3 characters or more).' : null}>
        <p className="text-sm text-s-muted">
          The payout&apos;s entry ({fmtPkr(settlement.netCents)} received, fee {fmtPkr(settlement.feeCents)}) is reversed, the card days {dayRange(settlement.dayFrom, settlement.dayTo)} are
          free again and the bank line goes back to unmatched.
        </p>
        <div className="mt-3"><Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={reason.trim().length < 3 ? true : undefined} placeholder="Matched to the wrong days" /></Field></div>
        {go.error && <p role="alert" className="text-xs text-s-red mt-3">{cardPayoutErrorText(go.error)}</p>}
        <div className="flex flex-wrap gap-2 mt-4">
          <Button variant="danger" type="submit"  disabled={go.isPending}>
            {go.isPending ? 'Undoing…' : 'Undo payout'}
          </Button>
          <Button variant="secondary" type="button"  onClick={onClose}>Cancel</Button>
        </div>
      </DialogForm>
    </Modal>
  )
}

// ─── "Card payout?" on an unmatched credit ───────────────────────────────────

/** Suggestions for one statement line, then Confirm (POST /lines/:id/confirm). */
export function CardPayoutSuggest({ lineId, onDone, onCancel }: { lineId: string; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient()
  const q = useQuery<SuggestResp>({
    queryKey: ['card-payout-suggestions', lineId],
    queryFn: () => api.get(`/reconciliation/card-payouts/lines/${lineId}/suggestions`),
    retry: false,
    meta: { inlineErrors: true },
  })
  const [picked, setPicked] = useState<number | null>(null)
  const confirm = useMutation({
    mutationFn: (s: Suggestion) => api.post(`/reconciliation/card-payouts/lines/${lineId}/confirm`, { days: s.days, unit: s.unit }),
    meta: { inlineErrors: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LIST_KEY })
      onDone()
    },
  })
  const d = q.data
  const chosen = picked != null ? d?.suggestions[picked] : undefined

  return (
    <div className="px-4 py-3 space-y-2 text-xs">
      {q.isLoading && <p className="text-s-muted">Looking for the card days this pays…</p>}
      {q.error && <p className="text-s-red">{cardPayoutErrorText(q.error)}</p>}
      {d && !d.enabled && <p className="text-s-muted">Card payout matching is off for this company — switch it on in the Card payouts tab first.</p>}
      {d && d.enabled && !d.onPayoutBank && <p className="text-s-muted">This line is not on the bank Keenu pays into.</p>}
      {d && d.enabled && d.onPayoutBank && d.line.matchStatus !== 'unmatched' && <p className="text-s-muted">This line is already {d.line.matchStatus}.</p>}
      {d && d.enabled && d.onPayoutBank && d.line.matchStatus === 'unmatched' && (
        <>
          <p className="text-s-muted">
            Keenu paid {fmtPkr(d.line.amountCents)} on {d.line.postedDate.slice(0, 10)}. Pick the card days it settles (best fit first; the fee is what the bank kept).
          </p>
          {d.suggestions.length === 0 && (
            <p className="text-s-text">No run of unpaid card days fits this amount with a fee up to {pct(d.settings.maxFeeBps)}. If it is not a card payout, book it as an adjustment.</p>
          )}
          {d.suggestions.length > 0 && (
            <div className="space-y-1">
              {d.suggestions.map((s, i) => (
                <CheckLabel key={`${s.unit}-${s.dayFrom}-${s.dayTo}`} className="flex items-start gap-2 rounded border border-s-border px-2 py-1.5 cursor-pointer">
                  <input type="radio" name={`card-payout-${lineId}`} className="mt-0.5" checked={picked === i} onChange={() => setPicked(i)} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-s-text font-semibold">
                      {dayRange(s.dayFrom, s.dayTo)} · {s.unitLabel}
                      {s.fits && <span className="ml-2 s-badge-green text-xs">Fits the settings</span>}
                    </span>
                    <span className="block text-s-muted">
                      Card sales {fmtPkr(s.grossCents)} · fee {fmtPkr(s.impliedFeeCents)} ({pct(s.impliedFeeBps)}) · expected {fmtPkr(s.expectedNetCents)}
                    </span>
                  </span>
                </CheckLabel>
              ))}
            </div>
          )}
          {confirm.error && <p className="text-s-red">{cardPayoutErrorText(confirm.error)}</p>}
          <div className="flex flex-wrap items-center gap-3">
            {d.canConfirm
              ? (
                <LinkButton size="md" type="button"  disabled={!chosen || confirm.isPending} onClick={() => chosen && confirm.mutate(chosen)}>
                  {confirm.isPending ? 'Booking…' : 'Confirm card payout'}
                </LinkButton>
              )
              : <span className="text-s-muted">Finance or the CEO confirms card payouts.</span>}
          </div>
        </>
      )}
      <LinkButton tone="muted" size="md" type="button" onClick={onCancel}>Close</LinkButton>
    </div>
  )
}

