'use client'
// Summary: per company, the theoretical → actual walk (explained vs
// unexplained), food / drinks / packaging, MC by order type, per brand
// (measured vs allocated), per item, the Q allowance and the FIFO cut-over.
import { Kpi, Section, StatusBadge, Warnings, pkr, pctText, overUnder } from './ui'
import type { CompanyBlock, BrandBlock, ClassCents, WasteReason } from './types'

type Kind = 'total' | 'explained' | 'unexplained' | 'alignment' | 'timing'
interface Step { label: string; cents: number; kind: Kind; note?: string }

const KIND_LABEL: Record<Kind, string> = { total: '', explained: 'Explained', unexplained: 'Unexplained', alignment: 'Cut-over', timing: 'Timing' }

function steps(b: BrandBlock | CompanyBlock, reasons: Array<{ key: WasteReason; label: string }>): Step[] {
  const k = b.buckets
  const out: Step[] = [{ label: 'Theoretical (recipes at the price paid)', cents: b.theoretical.totalCents, kind: 'total' }]
  const add = (label: string, cents: number, kind: Kind, note?: string) => { if (cents !== 0) out.push({ label, cents, kind, ...(note ? { note } : {}) }) }
  add('Comps', k.comps.totalCents, 'explained')
  add('Staff meals', k.staffMeals.totalCents, 'explained')
  for (const r of reasons) {
    const w = k.waste.byReason[r.key]
    if (w) add(`Waste — ${r.label}`, w.totalCents, 'explained', w.allocatedCents ? `${pkr(w.allocatedCents)} allocated by use` : undefined)
  }
  add('Prep draws', k.prepDraws.totalCents, 'explained')
  add('Count variance', k.countVariance.totalCents, 'unexplained', k.countVariance.allocatedCents ? `${pkr(k.countVariance.allocatedCents)} allocated by use` : undefined)
  add('Issued on receipt', k.issueOnReceipt.totalCents, 'explained')
  add('Late deliveries settling earlier sales', k.shortfallSettles.totalCents, 'explained')
  add('Price adjustments (bills vs receipts)', k.priceAdjustments, 'explained')
  add('Cooked before it was on the books', k.notOnBooks, 'unexplained')
  add('Other entries (manual journals)', k.otherEntries, 'unexplained')
  add('FIFO cut-over (orders before it)', b.alignmentCents, 'alignment')
  if (b.timing) add('Timing (open orders, drawers, postings)', b.timing.totalCents, 'timing')
  if (b.actual) out.push({ label: 'Actual (ledger cost of sales)', cents: b.actual.totalCents, kind: 'total' })
  return out
}

const barColor = (s: Step) => s.kind === 'total' ? 'var(--erp-secondary)'
  : s.cents < 0 ? 'var(--erp-success)'
  : s.kind === 'unexplained' ? 'var(--erp-danger)'
  : 'color-mix(in srgb, var(--muted) 55%, transparent)'

function Waterfall({ list }: { list: Step[] }) {
  // Running position of each step; totals start at 0.
  let run = 0
  const rows = list.map((s, i) => {
    if (s.kind === 'total') {
      const r = { s, start: 0, end: s.cents }
      if (i === 0) run = s.cents
      return r
    }
    const r = { s, start: run, end: run + s.cents }
    run += s.cents
    return r
  })
  const max = Math.max(1, ...rows.map((r) => Math.max(r.start, r.end)))
  return (
    <div className="space-y-1.5">
      {rows.map(({ s, start, end }, i) => {
        const left = (Math.max(0, Math.min(start, end)) / max) * 100
        const width = Math.max(0.5, (Math.abs(end - start) / max) * 100)
        return (
          <div key={i} className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,16rem)_1fr_7rem] sm:items-center sm:gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className={s.kind === 'total' ? 'font-semibold text-s-text' : 'text-s-muted'}>{s.label}</span>
              {s.kind !== 'total' && <span className="text-[10px] uppercase tracking-wider text-s-dim">{KIND_LABEL[s.kind]}</span>}
            </div>
            <div className="relative h-3 rounded" style={{ background: 'rgb(var(--fg-rgb) / 0.05)' }}>
              <div className="absolute top-0 h-3 rounded" style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: barColor(s) }} />
            </div>
            <div className="text-right text-xs font-mono">
              <span className={s.kind === 'total' ? 'font-semibold' : ''}>{s.kind !== 'total' && s.cents > 0 ? '+' : ''}{pkr(s.cents)}</span>
              {s.note && <p className="text-[10px] text-s-dim">{s.note}</p>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ClassTable({ theoretical, actual }: { theoretical: ClassCents; actual: ClassCents | null }) {
  const rows: Array<[string, keyof ClassCents]> = [['Food', 'foodCents'], ['Drinks', 'drinksCents'], ['Packaging', 'packagingCents'], ['Total', 'totalCents']]
  return (
    <div className="overflow-x-auto">
      <table className="s-table">
        <thead><tr><th>Class</th><th className="text-right">Theoretical</th><th className="text-right">Actual</th><th className="text-right">Difference</th></tr></thead>
        <tbody>
          {rows.map(([label, k]) => {
            const a = actual ? actual[k] : null
            const d = a == null ? null : a - theoretical[k]
            return (
              <tr key={k}>
                <td className={k === 'totalCents' ? 'font-semibold' : ''}>{label}</td>
                <td className="text-right font-mono">{pkr(theoretical[k])}</td>
                <td className="text-right font-mono">{a == null ? '—' : pkr(a)}</td>
                <td className="text-right font-mono" style={{ color: d == null ? undefined : d > 0 ? 'var(--erp-danger)' : 'var(--erp-success)' }}>{d == null ? '—' : `${d > 0 ? '+' : ''}${pkr(d)}`}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function McTable({ rows, revenueHidden }: { rows: CompanyBlock['mcByOrderType']; revenueHidden: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="s-table">
        <thead>
          <tr>
            <th>Order type</th><th className="text-right">Orders</th><th className="text-right">Target MC</th>
            <th className="text-right">Actual MC</th><th className="text-right">of which packaging</th>
            {!revenueHidden && <><th className="text-right">Target %</th><th className="text-right">Actual %</th></>}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.fulfilmentType}>
              <td>{m.label}</td>
              <td className="text-right">{m.orders}</td>
              <td className="text-right font-mono">{pkr(m.targetMcCents)}</td>
              <td className="text-right font-mono" style={{ color: m.actualMc.totalCents > m.targetMcCents ? 'var(--erp-danger)' : 'var(--erp-success)' }}>{pkr(m.actualMc.totalCents)}</td>
              <td className="text-right font-mono text-s-muted">{pkr(m.actualMc.packagingCents)}</td>
              {!revenueHidden && <><td className="text-right">{pctText(m.targetMcPct)}</td><td className="text-right">{pctText(m.actualMcPct)}</td></>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BrandTable({ c }: { c: CompanyBlock }) {
  const hidden = c.revenueHidden
  return (
    <div className="overflow-x-auto">
      <table className="s-table">
        <thead>
          <tr>
            <th>Brand</th>
            {!hidden && <th className="text-right">Brand sales</th>}
            <th className="text-right">Theoretical</th><th className="text-right">Actual</th>
            {!hidden && <><th className="text-right">Theoretical %</th><th className="text-right">Actual %</th></>}
            <th className="text-right">Explained</th><th className="text-right">Unexplained</th><th className="text-right">Allocated</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {c.brands.map((b) => {
            const k = b.buckets
            const allocated = k.waste.total.allocatedCents + k.countVariance.allocatedCents + k.prepDraws.allocatedCents + k.issueOnReceipt.allocatedCents
            return (
              <tr key={b.conceptId ?? 'ho'}>
                <td>
                  {b.name}
                  {b.serviceVessel === 'packaging' && <span className="ml-2 s-badge-purple">serves in packaging</span>}
                </td>
                {!hidden && <td className="text-right font-mono">{pkr(b.revenueCents)}</td>}
                <td className="text-right font-mono">{pkr(b.theoretical.totalCents)}</td>
                <td className="text-right font-mono">{b.actual ? pkr(b.actual.totalCents) : '—'}</td>
                {!hidden && <><td className="text-right">{pctText(b.theoreticalPct)}</td><td className="text-right" style={{ color: overUnder(b.actualPct, b.targetPct) }}>{pctText(b.actualPct)}</td></>}
                <td className="text-right font-mono">{pkr(b.explainedCents)}</td>
                <td className="text-right font-mono" style={{ color: b.unexplainedCents > 0 ? 'var(--erp-danger)' : undefined }}>{pkr(b.unexplainedCents)}</td>
                <td className="text-right font-mono text-s-muted">{allocated ? pkr(allocated) : '—'}</td>
                <td><StatusBadge status={b.status} label={b.statusLabel} /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-s-dim">Measured = lines tagged with the brand. Allocated = waste, counts, prep and issued stock with no brand, split by each brand&apos;s recipe use of the item (30 days). Head office holds what neither reaches.</p>
    </div>
  )
}

function ItemTable({ c }: { c: CompanyBlock }) {
  const hidden = c.revenueHidden
  const names = new Map(c.brands.map((b) => [b.conceptId, b.name]))
  if (c.items.length === 0) return <p className="py-4 text-center text-sm text-s-dim">No sales</p>
  return (
    <div className="max-h-[28rem] overflow-auto">
      <table className="s-table">
        <thead>
          <tr>
            <th>Item</th><th>Brand</th><th className="text-right">Sold</th><th className="text-right">Cost</th>
            {!hidden && <><th className="text-right">Sales</th><th className="text-right">Cost %</th><th className="text-right">Target</th></>}
          </tr>
        </thead>
        <tbody>
          {c.items.map((i) => (
            <tr key={i.menuItemId}>
              <td>{i.name}{!i.hasRecipe && <span className="ml-2 s-badge-amber">no recipe</span>}</td>
              <td className="text-s-muted">{names.get(i.conceptId) ?? ''}</td>
              <td className="text-right">{i.qtySold}</td>
              <td className="text-right font-mono">{pkr(i.costCents)}</td>
              {!hidden && <>
                <td className="text-right font-mono">{pkr(i.revenueCents)}</td>
                <td className="text-right" style={{ color: overUnder(i.costPct, i.targetPct) }}>{pctText(i.costPct)}</td>
                <td className="text-right text-s-muted">{pctText(i.targetPct)}</td>
              </>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CompanySummary({ c, reasons }: { c: CompanyBlock; reasons: Array<{ key: WasteReason; label: string }> }) {
  const hidden = c.revenueHidden
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-s-text">{c.companyName}</h2>
        <StatusBadge status={c.status} label={c.statusLabel} />
        {c.cutoverAt && <span className="text-xs text-s-dim">FIFO lots since {c.cutoverAt.slice(0, 10)}</span>}
      </div>
      <Warnings warnings={c.warnings} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {hidden ? (
          <>
            <Kpi label="Theoretical cost" value={pkr(c.theoretical.totalCents)} sub="recipes at the price paid" />
            <Kpi label="Actual cost" value={c.actual ? pkr(c.actual.totalCents) : '—'} sub="ledger cost of sales" />
            <Kpi label="Explained" value={pkr(c.explainedCents)} sub="comps, meals, waste, prep, prices" />
            <Kpi label="Unexplained" value={pkr(c.unexplainedCents)} sub="counts and stock not on the books" color={c.unexplainedCents > 0 ? 'var(--erp-danger)' : undefined} />
          </>
        ) : (
          <>
            <Kpi label="Brand sales" value={pkr(c.revenueCents)} sub="40xx after discounts, ex-GST" />
            <Kpi label="Theoretical %" value={pctText(c.theoreticalPct)} sub={c.targetPct != null ? `Target ${pctText(c.targetPct)}` : 'No recipe target'} />
            <Kpi label="Actual %" value={pctText(c.actualPct)} sub="ledger cost of sales" color={overUnder(c.actualPct, c.targetPct)} />
            <Kpi label="Actual vs theoretical" value={c.avtPoints == null ? '—' : `${c.avtPoints > 0 ? '+' : ''}${c.avtPoints.toFixed(1)} pts`} sub={`${pkr(c.unexplainedCents)} unexplained`} color={c.avtPoints != null && c.avtPoints > 0 ? 'var(--erp-danger)' : 'var(--erp-success)'} />
          </>
        )}
      </div>

      <Section title="Theoretical to actual" hint="Each step from the recipe cost of what was sold to what the books charged. Green steps lower the cost; red is unexplained.">
        <Waterfall list={steps(c, reasons)} />
        <div className="mt-3 space-y-1 border-t pt-3 text-xs text-s-muted" style={{ borderColor: 'var(--border)' }}>
          <p>Q factor allowance: <span className="font-mono">{pkr(c.allowance.qFactorCents)}</span> — {c.allowance.label}.</p>
          <p>{c.alignment.label}: <span className="font-mono">{pkr(c.alignment.preFifoOrdersCents)}</span>{c.alignment.alignedAt ? ` · aligned ${c.alignment.alignedAt.slice(0, 10)}` : ''}.</p>
          {c.identityDiffCents != null && c.identityDiffCents !== 0 && (
            <p style={{ color: 'var(--erp-danger)' }}>The steps miss the ledger by {pkr(c.identityDiffCents)} — tell finance.</p>
          )}
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Food, drinks and packaging"><ClassTable theoretical={c.theoretical} actual={c.actual} /></Section>
        <Section title="Material cost by order type" hint="Target MC: food + drinks + packaging where the order type uses it (today's recipe cost). Actual MC: what the lots gave, Box given included.">
          <McTable rows={c.mcByOrderType} revenueHidden={hidden} />
        </Section>
      </div>

      <Section title="By brand"><BrandTable c={c} /></Section>
      <Section title="By item" hint="Every sale of the item, comps included, at the lots it relieved."><ItemTable c={c} /></Section>
    </div>
  )
}
