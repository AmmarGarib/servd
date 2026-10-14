'use client'
// Closed shifts that never reached the books (owner decision 6): POST
// /reconciliation/backfill-unposted. Admin only. Preview first (dry run),
// then post — a shift whose month is still open posts into its own month; a
// shift in a closed month posts into the CURRENT open month with a memo naming
// its original close date. A locked month is never reopened for it.
//
// Petty-cash history (finance wave B, H1/H2): POST
// /reconciliation/backfill-petty-cash puts the boxes' past movements on 1011.
// CEO only. A dry run first: per company, where the money already in the
// boxes came from (the safe 1010 — the default — or the Garibsons cashier
// 2210), the resulting 1010 balance (a warning when it would go negative),
// and a pick for every spend with no category and every one-sided transfer or
// return; then Post. 409 BACKFILL_RUNNING while another backfill runs.
import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { orderRef } from '../../lib/orderRef'
import { useAuthStore } from '../../store/auth'
import { BankAccountSelect } from '../../components/finance/BankAccountSelect'

interface Row { shiftId: string; closedAt: string | null; outcome: string; detail: string }
// BOOKS-R2-01: order completions, loyalty earns / redemptions and refund
// restores the ledger refused. Each posts into its own day only — a day inside
// a closed period is listed as 'locked' and never moved.
// Finance gap 8: bank deposits, waste, stock counts, waste from voided items,
// cancelled orders' unwinds and failed till cards the ledger refused. These
// post on their own day while its month is open, else into this month with a
// note naming the original date (owner decision 6). Ones nothing flagged are
// listed as 'unflagged': Post flags them for review, the next run posts them.
type OrderKind = 'order.complete' | 'loyalty.earn' | 'loyalty.redeem' | 'order.refund'
  | 'deposit.drop' | 'inventory.waste' | 'inventory.count' | 'pos.void_waste' | 'order.cancel_unwind' | 'pos.card_failed'
  | 'reservation.deposit_capture'
  // Wave B re-posters (reconciliation/backfillOrders.ts REPOSTERS + step 5).
  | 'fixed_asset.depreciation' | 'prepaid.release' | 'inventory.prep_draw' | 'giftcard.expire' | 'ic.fleet_charge'
  | 'order_item.return' | 'order_item.box_given' | 'order_item.box_given_undo' | 'order.legacy_return'
  | 'order.cogs_late' | 'order.cancel_settle'
  | 'stock.deplete' | 'stock.restore' | 'stock.remake'
interface OrderRow { kind: OrderKind; id: string; orderId: string | null; tenantId: string; date: string | null; outcome: string; detail: string }
interface Result {
  dryRun: boolean
  rows: Row[]
  summary: Record<string, number>
  orders?: { rows: OrderRow[]; summary: Record<string, number> }
}

const LABEL: Record<string, string> = {
  would_post: 'Will post in its own month',
  would_post_into_current_month: 'Will post into this month (its month is closed)',
  posted: 'Posted',
  posted_into_current_month: 'Posted into this month',
  unbalanced: 'Does not balance — for the accountant',
  shift_has_no_company: 'No company — cannot post',
  no_postable_activity: 'Nothing to post',
  already_posted: 'Already on the books',
  error: 'Error',
}

const KIND_LABEL: Record<OrderKind, string> = {
  'order.complete': 'Sale',
  'loyalty.earn': 'Points earned',
  'loyalty.redeem': 'Points spent',
  'order.refund': 'Refund',
  'deposit.drop': 'Bank deposit',
  'inventory.waste': 'Waste',
  'inventory.count': 'Stock count',
  'pos.void_waste': 'Waste from a voided item',
  'order.cancel_unwind': 'Cancelled order',
  'pos.card_failed': 'Failed card payment',
  'reservation.deposit_capture': 'No-show deposit kept',
  'fixed_asset.depreciation': 'Depreciation',
  'prepaid.release': 'Prepayment release',
  'inventory.prep_draw': 'Prep draw',
  'giftcard.expire': 'Gift card breakage',
  'ic.fleet_charge': 'Shared-fleet recharge',
  'order_item.return': 'Line given back (cost of sales)',
  'order_item.box_given': '"Box given" packaging',
  'order_item.box_given_undo': '"Box given" undone',
  'order.legacy_return': 'Stock given back (old order)',
  'order.cogs_late': 'Late stock draw (cost of sales)',
  'order.cancel_settle': 'Cancelled order — settles back',
  'stock.deplete': 'Stock not taken out',
  'stock.restore': 'Cancelled order — stock not given back',
  'stock.remake': 'KDS remake not wasted',
}

// Outcomes of the order / loyalty / refund rows, in plain words. Anything not
// listed is a reason the posting was skipped; it is shown as "Skipped" with
// the reason in the row's detail.
const ORDER_LABEL: Record<string, string> = {
  would_post: 'Will post on its own day',
  would_post_into_current_month: 'Will post into this month (its month is closed)',
  posted: 'Posted',
  posted_into_current_month: 'Posted into this month',
  locked: 'Its day is closed — not posted; for the accountant',
  already_posted: 'Already on the books',
  would_resolve: 'Nothing to post — the flag will be closed',
  resolved: 'Nothing to post — flag closed',
  not_refunded: 'Not refunded — nothing to post',
  unflagged: 'Missing and never flagged — Post flags it for review',
  flagged: 'Flagged for review — the next run posts it',
  no_company: 'No company — cannot post',
  not_cancelled: 'Not cancelled — check by hand',
  error: 'Error — not posted',
}

// Kinds in the order the summary lists them.
const KINDS: OrderKind[] = [
  'order.complete', 'loyalty.earn', 'loyalty.redeem', 'order.refund',
  'deposit.drop', 'inventory.waste', 'inventory.count', 'pos.void_waste', 'order.cancel_unwind', 'pos.card_failed',
  'reservation.deposit_capture',
  'fixed_asset.depreciation', 'prepaid.release', 'inventory.prep_draw', 'giftcard.expire', 'ic.fleet_charge',
  'order_item.return', 'order_item.box_given', 'order_item.box_given_undo', 'order.legacy_return',
  'order.cogs_late', 'order.cancel_settle',
  'stock.deplete', 'stock.restore', 'stock.remake',
]
const SUMMARY_OUTCOMES: Array<{ key: string; label: string }> = [
  { key: 'would_post', label: 'to post' },
  { key: 'would_post_into_current_month', label: 'to post into this month' },
  { key: 'posted', label: 'posted' },
  { key: 'posted_into_current_month', label: 'posted into this month' },
  { key: 'unflagged', label: 'missing, never flagged' },
  { key: 'flagged', label: 'flagged for review' },
  { key: 'locked', label: 'in a closed period' },
  { key: 'error', label: 'errors' },
]
// Outcomes a Post run acts on (posts, closes a flag, or flags a miss).
const ACTIONABLE = new Set(['would_post', 'would_post_into_current_month', 'would_resolve', 'unflagged'])
const PROBLEM = new Set(['error', 'locked', 'no_company'])

function orderOutcomeLabel(outcome: string): string {
  return ORDER_LABEL[outcome] ?? 'Skipped'
}

/** The order number staff read (last 8, uppercased); a document's own id otherwise. */
function refOf(r: OrderRow): string {
  if (r.orderId) return orderRef(r.orderId)
  return r.id ? r.id.slice(0, 8) : '—'
}

export function BackfillUnposted() {
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const [result, setResult] = useState<Result | null>(null)
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<Result>('/reconciliation/backfill-unposted', { dryRun }),
    onSuccess: setResult,
  })
  if (!isAdmin) return null
  return (
    <>
      <UnpostedSection result={result} run={run} />
      <PettyCashHistory />
    </>
  )
}

function UnpostedSection({ result, run }: {
  result: Result | null
  run: { mutate: (dryRun: boolean) => void; isPending: boolean; error: Error | null }
}) {
  const orderRows = result?.orders?.rows ?? []
  const orderSummary = result?.orders?.summary ?? {}
  const postable = (result?.rows ?? []).filter((r) => r.outcome.startsWith('would_post')).length
    + orderRows.filter((r) => ACTIONABLE.has(r.outcome)).length
  return (
    <div className="s-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-s-text">Postings that never reached the books</h2>
          <p className="text-xs text-s-muted">Closed drawers, sales, points, refunds, bank deposits, waste, stock counts, cancelled orders and failed card payments with no ledger entry. A shift, deposit, waste or count in a closed month posts into the current month with a note naming its date. A sale, points or refund posts on its own day only — if that day is closed it is listed for the accountant and not posted. Closed months are never reopened.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run.mutate(true)} disabled={run.isPending} className="s-btn-secondary text-xs">Preview</button>
          <button onClick={() => run.mutate(false)} disabled={run.isPending || !result?.dryRun || postable === 0} className="s-btn-primary text-xs">
            Post {postable > 0 ? postable : ''}
          </button>
        </div>
      </div>
      {run.error && <p role="alert" className="text-xs text-s-red">{backfillErrorText(run.error)}</p>}
      {result && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-s-text">Shifts</h3>
          {result.rows.length === 0
            ? <p className="text-xs text-s-muted">Every closed shift is on the books.</p>
            : (
              <table className="w-full text-xs">
                <thead className="text-s-muted"><tr><th className="text-left py-1">Shift</th><th className="text-left py-1">Closed</th><th className="text-left py-1">Outcome</th></tr></thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.shiftId} className="border-t border-s-border">
                      <td className="py-1 font-mono">{r.shiftId.slice(0, 8)}</td>
                      <td className="py-1">{r.closedAt ? new Date(r.closedAt).toLocaleString() : '—'}</td>
                      <td className="py-1" title={r.detail}>{LABEL[r.outcome] ?? r.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
      {result?.orders && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-s-text">Sales, points, refunds and other postings</h3>
          {orderRows.length === 0
            ? <p className="text-xs text-s-muted">Every sale, points earn or spend, refund, deposit, waste and count is on the books.</p>
            : (
              <>
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-s-muted">
                  {KINDS.map((k) => {
                    const parts = SUMMARY_OUTCOMES
                      .map((o) => ({ ...o, n: orderSummary[`${k}:${o.key}`] ?? 0 }))
                      .filter((o) => o.n > 0)
                    if (parts.length === 0) return null
                    return (
                      <li key={k}>
                        <span className="font-semibold text-s-text">{KIND_LABEL[k]}</span>{' '}
                        {parts.map((o) => `${o.n} ${o.label}`).join(', ')}
                      </li>
                    )
                  })}
                </ul>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-s-muted">
                      <tr>
                        <th className="text-left py-1">What</th>
                        <th className="text-left py-1">Ref</th>
                        <th className="text-left py-1">Day</th>
                        <th className="text-left py-1">Outcome</th>
                        <th className="text-left py-1">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderRows.map((r) => (
                        <tr key={`${r.kind}:${r.id}`} className="border-t border-s-border">
                          <td className="py-1">{KIND_LABEL[r.kind] ?? r.kind}</td>
                          <td className="py-1 font-mono">{refOf(r)}</td>
                          <td className="py-1">{r.date ? new Date(r.date).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' }) : '—'}</td>
                          <td className={`py-1 ${PROBLEM.has(r.outcome) ? 'text-s-red' : ''}`}>{orderOutcomeLabel(r.outcome)}</td>
                          <td className="py-1 text-s-muted break-words">{ORDER_LABEL[r.outcome] ? r.detail : `${r.outcome.replace(/_/g, ' ')}${r.detail ? ` — ${r.detail}` : ''}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
        </div>
      )}
    </div>
  )
}

const BACKFILL_ERROR_TEXT: Record<string, string> = {
  BACKFILL_RUNNING: 'Another backfill is running for this company — wait for it to finish, then try again.',
  NO_ACTIVE_COMPANY: 'Pick a company first.',
  FORBIDDEN: 'Only the CEO runs the backfills.',
}
function backfillErrorText(e: unknown): string {
  const x = e as { code?: string; message?: string } | null
  return (x?.code && BACKFILL_ERROR_TEXT[x.code]) || x?.message || 'Something went wrong'
}

// ─── Petty-cash history ──────────────────────────────────────────────────────

type HistSource = 'safe' | 'garibsons'
type CashSide = 'safe' | 'garibsons' | 'bank'
interface PettyRow {
  kind: 'opening' | 'topup' | 'spend' | 'reconcile' | 'transfer' | 'return' | 'cash_on_hand'
  id: string
  boxId: string | null
  boxName: string | null
  tenantId: string
  date: string | null
  amountCents: number
  accountCode: string | null
  outcome: string
  detail: string
}
interface PettyResult {
  dryRun: boolean
  historicTopupSource: Record<string, HistSource>
  rows: PettyRow[]
  summary: Record<string, number>
}
interface Pick { categoryKey?: string; accountCode?: string; source?: CashSide; destination?: CashSide; bankAccountId?: string }
interface SpendCategory { key: string; label: string; code: string; kind: string }

const PETTY_KIND_LABEL: Record<PettyRow['kind'], string> = {
  opening: 'Opening float',
  topup: 'Top-up',
  spend: 'Spend',
  reconcile: 'Count difference',
  transfer: 'Transfer',
  return: 'Cash returned',
  cash_on_hand: '1010 Cash on hand',
}
const PETTY_OUTCOME_LABEL: Record<string, string> = {
  would_post: 'Will post in its own month',
  would_post_into_current_month: 'Will post into this month (its month is closed)',
  posted: 'Posted',
  posted_into_current_month: 'Posted into this month',
  needs_category: 'Needs a category',
  needs_review: 'Needs a decision',
  locked: 'Its day is closed — not posted; for the accountant',
  already_posted: 'Already on the books',
  error: 'Error — not posted',
  info: 'After this run',
  warning: 'Would go negative',
}
const SOURCE_LABEL: Record<HistSource, string> = { safe: 'The safe (1010)', garibsons: 'The Garibsons cashier (2210)' }
const SIDE_LABEL: Record<CashSide, string> = { safe: 'The safe (1010)', garibsons: 'The Garibsons cashier (2210)', bank: 'A bank account' }
const NEEDS = new Set(['needs_category', 'needs_review'])
const PETTY_ACTIONABLE = new Set(['would_post', 'would_post_into_current_month'])

/** A pick a row needs before Post can book it (null = not answered yet). */
function pickReady(r: PettyRow, p: Pick | undefined): boolean {
  if (!p) return false
  if (r.outcome === 'needs_category') return !!p.categoryKey || /^[56]\d{3}$/.test(p.accountCode ?? '')
  const side = r.kind === 'transfer' && r.amountCents > 0 ? p.source : p.destination
  return !!side
}

function PettyCashHistory() {
  const [sources, setSources] = useState<Record<string, HistSource>>({})
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [result, setResult] = useState<PettyResult | null>(null)
  // Any change after a dry run means the preview no longer matches what Post sends.
  const [stale, setStale] = useState(false)

  const { data: companies = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['tenants-mine'],
    queryFn: () => api.get('/tenants/mine'),
    staleTime: 300_000,
    retry: false,
    meta: { background: true },
  })
  const { data: cats } = useQuery<{ categories: SpendCategory[] }>({
    queryKey: ['petty-cash-categories'],
    queryFn: () => api.get('/trustops/petty-cash/categories'),
    staleTime: 300_000,
    retry: false,
    meta: { background: true },
  })
  const nameOf = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies])

  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<PettyResult>('/reconciliation/backfill-petty-cash', {
      dryRun,
      historicTopupSource: sources,
      picks: Object.fromEntries(Object.entries(picks).map(([id, p]) => [id, {
        ...(p.categoryKey ? { categoryKey: p.categoryKey } : p.accountCode ? { accountCode: p.accountCode.trim() } : {}),
        ...(p.source && { source: p.source }),
        ...(p.destination && { destination: p.destination }),
        ...(p.bankAccountId && (p.source === 'bank' || p.destination === 'bank') && { bankAccountId: p.bankAccountId }),
      }])),
    }),
    onSuccess: (r) => { setResult(r); setStale(false) },
    meta: { inlineErrors: true },
  })

  const rows = result?.rows ?? []
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))]
  const needRows = rows.filter((r) => NEEDS.has(r.outcome))
  const postable = rows.filter((r) => PETTY_ACTIONABLE.has(r.outcome)).length
  const answered = needRows.filter((r) => pickReady(r, picks[r.id])).length
  const setPick = (id: string, p: Partial<Pick>) => { setStale(true); setPicks((all) => ({ ...all, [id]: { ...all[id], ...p } })) }
  const sourceOf = (t: string): HistSource => sources[t] ?? result?.historicTopupSource[t] ?? 'safe'

  return (
    <div className="s-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-s-text">Petty-cash history</h2>
          <p className="text-xs text-s-muted">
            Puts every petty-cash box&apos;s past movements on 1011 Petty cash: opening floats, top-ups, spends, counts, transfers and returns.
            A top-up whose source was never recorded is treated as from the company you pick below. Closed months are never reopened.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run.mutate(true)} disabled={run.isPending} className="s-btn-secondary text-xs">
            {result && (stale || !result.dryRun) ? 'Preview again' : 'Dry run'}
          </button>
          <button
            onClick={() => run.mutate(false)}
            disabled={run.isPending || !result?.dryRun || stale || postable === 0}
            className="s-btn-primary text-xs"
          >
            Post {postable > 0 ? postable : ''}
          </button>
        </div>
      </div>
      {run.error && <p role="alert" className="text-xs text-s-red">{backfillErrorText(run.error)}</p>}
      {stale && result?.dryRun && <p className="text-xs text-s-amber">You changed a pick — run the dry run again before posting.</p>}
      {needRows.length > 0 && (
        <p className="text-xs text-s-muted">{answered} of {needRows.length} pick{needRows.length === 1 ? '' : 's'} answered. Rows without a pick are left out of Post and stay open.</p>
      )}
      {result && !result.dryRun && <p className="text-xs text-success">Posted. Rows still needing a pick stay open — answer them and run again.</p>}

      {result && tenantIds.length === 0 && <p className="text-xs text-s-muted">Every petty-cash movement is on the books.</p>}

      {tenantIds.map((t) => {
        const companyRows = rows.filter((r) => r.tenantId === t)
        const cash = companyRows.find((r) => r.kind === 'cash_on_hand')
        const others = companyRows.filter((r) => r.kind !== 'cash_on_hand')
        const needs = others.filter((r) => NEEDS.has(r.outcome))
        const toPost = others.filter((r) => PETTY_ACTIONABLE.has(r.outcome)).length
        return (
          <div key={t} className="rounded-lg border border-s-border p-3 space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-sm font-semibold text-s-text">{nameOf.get(t) ?? 'Company'}</p>
              <label className="block text-xs">
                <span className="block text-[11px] font-bold uppercase tracking-wider text-s-muted mb-1">Money already in the boxes came from</span>
                <select
                  className="s-input"
                  value={sourceOf(t)}
                  onChange={(e) => { setStale(true); setSources((m) => ({ ...m, [t]: e.target.value as HistSource })) }}
                >
                  {(Object.keys(SOURCE_LABEL) as HistSource[]).map((k) => <option key={k} value={k}>{SOURCE_LABEL[k]}</option>)}
                </select>
              </label>
            </div>
            {cash && (
              <p className={`text-xs rounded px-2 py-1.5 ${cash.outcome === 'warning' ? 'text-s-red' : 'text-s-muted'}`}
                style={cash.outcome === 'warning' ? { background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)' } : undefined}>
                1010 Cash on hand after this run: <span className="font-mono font-semibold">{fmtPkr(cash.amountCents)}</span>
                {cash.outcome === 'warning' && <> — GS Foods holds no cash, so it cannot go negative. Pick the Garibsons cashier (2210) as the source and run the dry run again.</>}
              </p>
            )}

            {needs.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-s-text">Needs a pick ({needs.length})</p>
                {needs.map((r) => (
                  <NeedPick key={r.id} row={r} pick={picks[r.id]} categories={cats?.categories ?? []} onChange={(p) => setPick(r.id, p)} />
                ))}
              </div>
            )}

            <details>
              <summary className="text-xs text-s-muted cursor-pointer">
                All {others.length} movement{others.length === 1 ? '' : 's'} · {toPost > 0 ? `${toPost} to post` : 'nothing to post'}
              </summary>
              <div className="overflow-x-auto mt-2">
                <table className="w-full text-xs">
                  <thead className="text-s-muted">
                    <tr>
                      <th className="text-left py-1 pr-2">Day</th>
                      <th className="text-left py-1 pr-2">Box · what</th>
                      <th className="text-right py-1 pr-2">Amount</th>
                      <th className="text-left py-1 pr-2">Account</th>
                      <th className="text-left py-1">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {others.map((r) => (
                      <tr key={`${r.kind}:${r.id}`} className="border-t border-s-border align-top">
                        <td className="py-1 pr-2 whitespace-nowrap">{r.date ? new Date(r.date).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' }) : '—'}</td>
                        <td className="py-1 pr-2">{r.boxName ?? '—'} · {PETTY_KIND_LABEL[r.kind] ?? r.kind}</td>
                        <td className={`py-1 pr-2 text-right font-mono ${r.amountCents < 0 ? 'text-s-red' : ''}`}>{fmtPkr(r.amountCents)}</td>
                        <td className="py-1 pr-2 font-mono">{r.accountCode ?? '—'}</td>
                        <td className="py-1">
                          <span className={r.outcome === 'error' || r.outcome === 'locked' ? 'text-s-red' : NEEDS.has(r.outcome) ? 'text-s-amber' : ''}>
                            {PETTY_OUTCOME_LABEL[r.outcome] ?? r.outcome.replace(/_/g, ' ')}
                          </span>
                          {r.detail && <div className="text-s-muted break-words">{r.detail}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )
      })}
    </div>
  )
}

/** The pick a needs_category / needs_review row asks for. */
function NeedPick({ row, pick, categories, onChange }: { row: PettyRow; pick: Pick | undefined; categories: SpendCategory[]; onChange: (p: Partial<Pick>) => void }) {
  const p = pick ?? {}
  const inflow = row.kind === 'transfer' && row.amountCents > 0
  const sideKey: 'source' | 'destination' = inflow ? 'source' : 'destination'
  const side = p[sideKey]
  return (
    <div className="rounded border border-s-border px-2 py-2 text-xs space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-s-text font-semibold">
          {row.date ? new Date(row.date).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' }) : '—'} · {row.boxName ?? '—'} · {PETTY_KIND_LABEL[row.kind] ?? row.kind}
        </span>
        <span className="font-mono text-s-text">{fmtPkr(row.amountCents)}</span>
      </div>
      <p className="text-s-muted break-words">{row.detail}</p>
      {row.outcome === 'needs_category' ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="s-input max-w-full"
            value={p.categoryKey ?? ''}
            onChange={(e) => onChange({ categoryKey: e.target.value || undefined, accountCode: undefined })}
          >
            <option value="">Pick a category…</option>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label} ({c.code})</option>)}
          </select>
          <span className="text-s-muted">or account</span>
          <input
            className="s-input w-24 font-mono"
            inputMode="numeric"
            placeholder="6xxx"
            value={p.accountCode ?? ''}
            onChange={(e) => onChange({ accountCode: e.target.value || undefined, categoryKey: undefined })}
          />
          <span className="basis-full text-[11px] text-s-muted">A kitchen purchase from before stock lots: 5010 food, 5020 drinks, 5030 packaging.</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="block text-[11px] text-s-muted mb-0.5">{inflow ? 'The cash came from' : 'The cash went to'}</span>
            <select className="s-input" value={side ?? ''} onChange={(e) => onChange({ [sideKey]: (e.target.value || undefined) as CashSide | undefined })}>
              <option value="">Pick…</option>
              {(Object.keys(SIDE_LABEL) as CashSide[]).map((k) => <option key={k} value={k}>{SIDE_LABEL[k]}</option>)}
            </select>
          </label>
          {side === 'bank' && (
            <div className="min-w-[12rem]">
              <BankAccountSelect tenantId={row.tenantId} value={p.bankAccountId ?? ''} onChange={(v) => onChange({ bankAccountId: v || undefined })} className="s-input" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
