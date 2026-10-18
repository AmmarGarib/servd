'use client'
// Director → Brand performance (owner, 2026-10-18): "a new category of login,
// 'Director'. For Yusuf and Ali, partners in Flipd, to be able to see how
// business is doing."
//
// Read-only. Every figure comes from GET /director/* (backend
// modules/director), which answers only for the brands on the director's own
// login (the CEO may preview any brand of their companies). The page never
// sends a company, only the brand id the API itself listed; a brand outside
// the login's list is a 404. Each table downloads as CSV from the same
// handler (GET /director/export.csv?view=…). Money is in paisa.

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkrWhole, todayPktIso, startOfMonthPktIso } from '../../lib/money'

interface Brand { id: string; name: string; slug: string }
interface Head { brand: { id: string; name: string } | null; period: { dateFrom: string; dateTo: string } }

interface Totals {
  orders: number; gross: number; discount: number; tax: number; tips: number; deliveryFees: number
  comps: number; loyaltyRedeemed: number; refunds: number; net: number; averageBillCents: number
}
interface SalesResp extends Head {
  totals: Totals | null
  daily: Array<{ date: string; gross: number; net: number; orders: number }>
  byChannel: Array<{ source: string; orders: number; gross: number; net: number; discount: number; refunds: number }>
  byTender: { tenders: Array<{ tender: string; label: string; amountCents: number; payments: number; orders: number; sharePct: number }>; totalCents: number; comp: { amountCents: number; orders: number } } | null
  topItems: Array<{ rank: number; name: string; quantity: number; revenueCents: number }>
}
interface PnlRow {
  revenueCents: number; contraCents: number; netRevenueCents: number; cogsCents: number
  foodCents: number; drinksCents: number; packagingCents: number; opexCents: number; labourCents: number
  otherIncomeCents: number; grossProfitCents: number; netProfitCents: number
  grossMarginPct: number; netMarginPct: number; costOfSalesPct: number; foodPct: number; drinksPct: number
  packagingPct: number; labourPct: number; primeCostPct: number
}
interface PnlResp extends Head { pnl: PnlRow | null }
interface FoodCostResp extends Head {
  summary: { name: string; status: string; statusLabel: string; revenueCents?: number; targetPct?: number | null; theoreticalPct?: number | null; actualPct?: number | null } | null
  items: Array<{ menuItemId: string; name: string; qtySold: number; hasRecipe: boolean; costCents: number; revenueCents?: number; costPct?: number | null; targetPct?: number | null }>
}
interface MenuResp extends Head {
  items: Array<{ menuItemId: string; name: string; priceCents: number; qtySold: number; foodCostCents: number; grossMarginPct: number; quadrant: string }>
}
interface ReviewsResp extends Head {
  reviews: Array<{ id: string; rating: number; comment: string | null; tags: string[]; source: string; createdAt: string }>
  total: number; average: number | null
}
interface ComplaintsResp extends Head {
  complaints: Array<{ id: string; title: string; description: string; category: string; status: string; priority: string; createdAt: string; resolvedAt: string | null; resolution: string | null }>
  stats: { total: number; open: number; inProgress: number; resolved: number; closed: number }
}

type Tab = 'sales' | 'pnl' | 'food' | 'menu' | 'reviews' | 'complaints'
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'sales', label: 'Sales' },
  { key: 'pnl', label: 'P&L' },
  { key: 'food', label: 'Food cost' },
  { key: 'menu', label: 'Menu' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'complaints', label: 'Complaints' },
]

const QUADRANT: Record<string, string> = { star: 'Star', plowHorse: 'Plowhorse', puzzle: 'Puzzle', dog: 'Dog' }
const CHANNEL: Record<string, string> = { pos: 'Till', servd: 'servd.pk', cart: 'Cart', manual: 'Manual', whatsapp: 'WhatsApp' }

function lastMonth(): { from: string; to: string } {
  const start = startOfMonthPktIso()
  const end = new Date(`${start}T00:00:00Z`)
  end.setUTCDate(0)
  const to = end.toISOString().slice(0, 10)
  return { from: `${to.slice(0, 8)}01`, to }
}
function daysBack(n: number): { from: string; to: string } {
  const to = todayPktIso()
  const d = new Date(`${to}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - (n - 1))
  return { from: d.toISOString().slice(0, 10), to }
}
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)

export default function DirectorPage() {
  const [tab, setTab] = useState<Tab>('sales')
  const [dateFrom, setDateFrom] = useState(startOfMonthPktIso)
  const [dateTo, setDateTo] = useState(todayPktIso)
  const [conceptId, setConceptId] = useState<string>('')
  const [downloadErr, setDownloadErr] = useState<string | null>(null)

  const { data: brandsResp, isLoading: brandsLoading } = useQuery<{ brands: Brand[] }>({
    queryKey: ['director', 'brands'],
    queryFn: () => api.get('/director/brands'),
  })
  const brands = useMemo(() => brandsResp?.brands ?? [], [brandsResp])
  useEffect(() => {
    if (!conceptId && brands[0]) setConceptId(brands[0].id)
  }, [brands, conceptId])

  const qs = `conceptId=${encodeURIComponent(conceptId)}&dateFrom=${dateFrom}&dateTo=${dateTo}`
  const ready = !!conceptId && !!dateFrom && !!dateTo && dateFrom <= dateTo
  const q = <T,>(key: Tab, path: string) => ({
    queryKey: ['director', path, conceptId, dateFrom, dateTo],
    queryFn: () => api.get<T>(`/director/${path}?${qs}`),
    enabled: ready && tab === key,
  })
  const sales = useQuery<SalesResp>(q<SalesResp>('sales', 'sales'))
  const pnl = useQuery<PnlResp>(q<PnlResp>('pnl', 'pnl'))
  const food = useQuery<FoodCostResp>(q<FoodCostResp>('food', 'food-cost'))
  const menu = useQuery<MenuResp>(q<MenuResp>('menu', 'menu'))
  const reviews = useQuery<ReviewsResp>(q<ReviewsResp>('reviews', 'reviews'))
  const complaints = useQuery<ComplaintsResp>(q<ComplaintsResp>('complaints', 'complaints'))

  const brandName = brands.find((b) => b.id === conceptId)?.name ?? ''
  async function csv(view: string) {
    setDownloadErr(null)
    try {
      await api.download(`/director/export.csv?view=${view}&${qs}`, `${(brandName || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${view}-${dateFrom}-to-${dateTo}.csv`)
    } catch (e) {
      setDownloadErr(e instanceof Error ? e.message : 'Download failed')
    }
  }
  function setRange(r: { from: string; to: string }) { setDateFrom(r.from); setDateTo(r.to) }

  if (!brandsLoading && brands.length === 0) {
    return (
      <div className="min-h-full flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-s-border bg-s-surface p-6 text-center">
          <p className="text-base font-bold text-s-text">No brand to show yet</p>
          <p className="mt-2 text-sm text-s-muted">Your login has no brand on it. Ask the CEO to add the brand you are a director of.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-full bg-s-bg">
      <header className="border-b border-s-border px-4 sm:px-6 py-4 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-success">Director · read-only</p>
            <h1 className="text-xl font-bold text-s-text">{brandName || 'Brand performance'}</h1>
          </div>
          {brands.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-s-muted">
              Brand
              <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className="s-input text-sm h-8">
                {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Preset label="This month" onClick={() => setRange({ from: startOfMonthPktIso(), to: todayPktIso() })} />
          <Preset label="Last month" onClick={() => setRange(lastMonth())} />
          <Preset label="Last 7 days" onClick={() => setRange(daysBack(7))} />
          <Preset label="Last 30 days" onClick={() => setRange(daysBack(30))} />
          <input type="date" aria-label="From" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} className="s-input text-sm h-8 w-36" />
          <span className="text-xs text-s-muted">to</span>
          <input type="date" aria-label="To" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} className="s-input text-sm h-8 w-36" />
        </div>
        <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className={`whitespace-nowrap px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key ? 'border-s-teal text-primary-ink' : 'border-transparent text-s-muted hover:text-s-text'
              }`}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="p-4 sm:p-6 space-y-5 max-w-5xl mx-auto">
        {downloadErr && <p className="text-xs font-bold text-s-red">{downloadErr}</p>}

        {tab === 'sales' && (sales.isLoading ? <Loading /> : sales.data?.totals ? (() => {
          const s = sales.data
          const t = s.totals!
          const maxNet = Math.max(1, ...s.daily.map((d) => d.net))
          return (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card label="Net sales" value={fmtPkrWhole(t.net)} sub="ex-GST, after discounts, comps and refunds" />
                <Card label="Orders" value={t.orders.toLocaleString('en-PK')} sub="completed in the period" />
                <Card label="Average bill" value={fmtPkrWhole(t.averageBillCents)} sub="net sales per order" />
                <Card label="Sales incl. GST" value={fmtPkrWhole(t.gross)} sub="before refunds" />
                <Card label="Discounts" value={fmtPkrWhole(t.discount)} />
                <Card label="Refunds" value={fmtPkrWhole(t.refunds)} />
                <Card label="Comps" value={fmtPkrWhole(t.comps)} />
                <Card label="GST" value={fmtPkrWhole(t.tax)} />
              </div>

              <Section title="Net sales by day" onCsv={() => void csv('sales-daily')}>
                {s.daily.length === 0 ? <Empty /> : (
                  <div className="space-y-1">
                    {s.daily.map((d) => (
                      <div key={d.date} className="flex items-center gap-2 text-xs">
                        <span className="w-20 shrink-0 tabular-nums text-s-muted">{d.date.slice(5)}</span>
                        <div className="flex-1 h-3 rounded bg-s-bg overflow-hidden">
                          <div className="h-full rounded" style={{ width: `${Math.max(0, (d.net / maxNet) * 100)}%`, background: 'var(--erp-accent)' }} />
                        </div>
                        <span className="w-28 shrink-0 text-right tabular-nums text-s-text">{fmtPkrWhole(d.net)}</span>
                        <span className="w-12 shrink-0 text-right tabular-nums text-s-muted">{d.orders}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title="By channel" onCsv={() => void csv('sales-channels')}>
                <Table head={['Channel', 'Orders', 'Net sales']} rows={s.byChannel.map((c) => [CHANNEL[c.source] ?? c.source, c.orders, fmtPkrWhole(c.net)])} />
              </Section>

              <Section title="By tender" onCsv={() => void csv('sales-tenders')}>
                <Table head={['Tender', 'Orders', 'Amount', 'Share']}
                  rows={(s.byTender?.tenders ?? []).map((x) => [x.label, x.orders, fmtPkrWhole(x.amountCents), pct(x.sharePct)])} />
                {(s.byTender?.comp.orders ?? 0) > 0 && (
                  <p className="mt-2 text-xs text-s-muted">Comps (not money): {s.byTender!.comp.orders} orders, {fmtPkrWhole(s.byTender!.comp.amountCents)}</p>
                )}
              </Section>

              <Section title="Top items" onCsv={() => void csv('top-items')}>
                <Table head={['#', 'Item', 'Sold', 'Revenue']} rows={s.topItems.map((i) => [i.rank, i.name, i.quantity, fmtPkrWhole(i.revenueCents)])} />
              </Section>
            </>
          )
        })() : <Empty />)}

        {tab === 'pnl' && (pnl.isLoading ? <Loading /> : pnl.data?.pnl ? (() => {
          const r = pnl.data.pnl!
          const lines: Array<[string, number, string, boolean?]> = [
            ['Revenue', r.revenueCents, ''],
            ['Discounts and loyalty', -r.contraCents, ''],
            ['Net revenue', r.netRevenueCents, '', true],
            ['Cost of sales', -r.cogsCents, pct(r.costOfSalesPct)],
            ['  Food', -r.foodCents, pct(r.foodPct)],
            ['  Drinks', -r.drinksCents, pct(r.drinksPct)],
            ['  Packaging', -r.packagingCents, pct(r.packagingPct)],
            ['Gross profit', r.grossProfitCents, pct(r.grossMarginPct), true],
            ['Operating expenses (incl. labour)', -r.opexCents, ''],
            ['  Labour', -r.labourCents, pct(r.labourPct)],
            ['Other income', r.otherIncomeCents, ''],
            ['Net profit', r.netProfitCents, pct(r.netMarginPct), true],
          ]
          return (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card label="Net revenue" value={fmtPkrWhole(r.netRevenueCents)} />
                <Card label="Gross margin" value={pct(r.grossMarginPct)} />
                <Card label="Labour" value={pct(r.labourPct)} sub="of revenue" />
                <Card label="Prime cost" value={pct(r.primeCostPct)} sub="cost of sales + labour" />
              </div>
              <Section title="Profit and loss" onCsv={() => void csv('pnl')}>
                <table className="w-full text-sm">
                  <tbody>
                    {lines.map(([label, cents, p, bold]) => (
                      <tr key={label} className={`border-t border-s-border ${bold ? 'font-bold' : ''}`}>
                        <td className="py-1.5 pr-2 text-s-text whitespace-pre">{label}</td>
                        <td className={`py-1.5 pr-2 text-right tabular-nums ${cents < 0 ? 'text-s-red' : 'text-s-text'}`}>{fmtPkrWhole(cents)}</td>
                        <td className="py-1.5 text-right tabular-nums text-s-muted w-20">{p}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-s-muted">From the ledger: what is booked to this brand. Shared company costs reach a brand only through allocation runs.</p>
              </Section>
            </>
          )
        })() : <Empty />)}

        {tab === 'food' && (food.isLoading ? <Loading /> : food.data ? (
          <>
            {food.data.summary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card label="Actual food cost" value={pct(food.data.summary.actualPct)} />
                <Card label="Recipe (theoretical)" value={pct(food.data.summary.theoreticalPct)} />
                <Card label="Target" value={pct(food.data.summary.targetPct)} />
                <Card label="Status" value={food.data.summary.statusLabel} />
              </div>
            )}
            <Section title="Items" onCsv={() => void csv('food-cost')}>
              <Table head={['Item', 'Sold', 'Cost', 'Revenue', 'Cost %']}
                rows={food.data.items.map((i) => [i.name, i.qtySold, fmtPkrWhole(i.costCents), fmtPkrWhole(i.revenueCents ?? null), pct(i.costPct)])} />
            </Section>
          </>
        ) : <Empty />)}

        {tab === 'menu' && (menu.isLoading ? <Loading /> : (
          <Section title="Menu engineering" onCsv={() => void csv('menu')}>
            <Table head={['Item', 'Price', 'Sold', 'Plate cost', 'Margin', 'Class']}
              rows={(menu.data?.items ?? []).map((i) => [i.name, fmtPkrWhole(i.priceCents), i.qtySold, fmtPkrWhole(i.foodCostCents), pct(i.grossMarginPct), QUADRANT[i.quadrant] ?? i.quadrant])} />
            <p className="mt-3 text-xs text-s-muted">Star: popular and profitable. Plowhorse: popular, low margin. Puzzle: profitable, sells little. Dog: neither.</p>
          </Section>
        ))}

        {tab === 'reviews' && (reviews.isLoading ? <Loading /> : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Card label="Average rating" value={reviews.data?.average != null ? `${reviews.data.average} / 5` : '—'} />
              <Card label="Reviews" value={String(reviews.data?.total ?? 0)} />
            </div>
            <Section title="Reviews" onCsv={() => void csv('reviews')}>
              {(reviews.data?.reviews ?? []).length === 0 ? <Empty /> : (
                <ul className="divide-y divide-s-border">
                  {reviews.data!.reviews.map((r) => (
                    <li key={r.id} className="py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-bold text-s-text">{r.rating} / 5</span>
                        <span className="text-s-muted">{r.createdAt.slice(0, 10)}</span>
                      </div>
                      {r.comment && <p className="mt-1 text-sm text-s-text">{r.comment}</p>}
                      {r.tags.length > 0 && <p className="mt-1 text-xs text-s-muted">{r.tags.join(' · ')}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        ))}

        {tab === 'complaints' && (complaints.isLoading ? <Loading /> : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card label="Complaints" value={String(complaints.data?.stats.total ?? 0)} />
              <Card label="Open" value={String(complaints.data?.stats.open ?? 0)} />
              <Card label="In progress" value={String(complaints.data?.stats.inProgress ?? 0)} />
              <Card label="Resolved" value={String((complaints.data?.stats.resolved ?? 0) + (complaints.data?.stats.closed ?? 0))} />
            </div>
            <Section title="Complaints" onCsv={() => void csv('complaints')}>
              {(complaints.data?.complaints ?? []).length === 0 ? <Empty /> : (
                <ul className="divide-y divide-s-border">
                  {complaints.data!.complaints.map((c) => (
                    <li key={c.id} className="py-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-bold text-s-text">{c.title}</span>
                        <span className="rounded-full border border-s-border px-2 py-0.5 text-s-muted">{c.category.replace(/_/g, ' ')}</span>
                        <span className="rounded-full border border-s-border px-2 py-0.5 text-s-muted">{c.status.replace(/_/g, ' ')}</span>
                        <span className="text-s-muted">{c.createdAt.slice(0, 10)}</span>
                      </div>
                      <p className="mt-1 text-sm text-s-text">{c.description}</p>
                      {c.resolution && <p className="mt-1 text-xs text-s-muted">Resolution: {c.resolution}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        ))}
      </div>
    </div>
  )
}

function Preset({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-s-surface border border-s-border text-s-muted hover:text-s-text">
      {label}
    </button>
  )
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-s-border bg-s-surface p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-s-muted">{label}</p>
      <p className="mt-1 text-lg font-bold text-s-text tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-s-muted">{sub}</p>}
    </div>
  )
}

function Section({ title, onCsv, children }: { title: string; onCsv: () => void; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-s-border bg-s-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-s-text">{title}</h2>
        <button type="button" onClick={onCsv}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-s-border text-s-muted hover:text-primary-ink">
          Download CSV
        </button>
      </div>
      {children}
    </section>
  )
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  if (rows.length === 0) return <Empty />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>{head.map((h, i) => <th key={h} className={`pb-2 text-xs font-semibold text-s-muted ${i === 0 || (i === 1 && head[0] === '#') ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t border-s-border">
              {r.map((c, ci) => (
                <td key={ci} className={`py-1.5 pr-2 ${ci === 0 || (ci === 1 && head[0] === '#') ? 'text-left text-s-text' : 'text-right tabular-nums text-s-text'}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Empty() {
  return <p className="py-6 text-center text-sm text-s-muted">Nothing in this period.</p>
}

function Loading() {
  return <p className="py-6 text-center text-sm text-s-muted">Loading…</p>
}
