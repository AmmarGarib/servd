'use client'
// Renders the DailyReport snapshot (or a live preview) as plain sections.
import { fmtPkr } from '../../../lib/money'
import { type CloseProblem, type DailyReport, fmtDayLong, fmtWhen } from './types'

const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 break-inside-avoid">
      <h4 className="text-sm font-semibold text-s-text">{title}</h4>
      {children}
    </section>
  )
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  if (rows.length === 0) return <p className="text-xs text-s-muted">Nothing for this day.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-s-muted">
          <tr>{head.map((h, i) => <th key={h} className={`py-1 pr-3 font-medium ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-s-border">
              {r.map((c, j) => <td key={j} className={`py-1 pr-3 ${j === 0 ? 'text-left text-s-text' : 'text-right text-s-text tabular-nums'}`}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stat({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-s-border p-2">
      <p className="text-[11px] text-s-muted">{k}</p>
      <p className="text-sm font-semibold text-s-text tabular-nums">{v}</p>
    </div>
  )
}

function Problems({ title, list }: { title: string; list: CloseProblem[] }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-s-text">{title}</p>
      {list.length === 0 ? <p className="text-xs text-s-muted">Clear.</p> : list.map((p) => (
        <p key={p.key} className="text-xs text-s-muted">
          <span className={p.severity === 'block' ? 'text-s-red' : 'text-s-text'}>{p.title}</span> — {p.count}{p.cents ? ` · ${fmtPkr(p.cents)}` : ''}
        </p>
      ))}
    </div>
  )
}

export function DailyReportView({ report: r, preview }: { report: DailyReport; preview?: boolean }) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs text-s-muted">{r.companyName}{preview ? ' · Preview (not saved)' : ''}</p>
        <p className="text-base font-semibold text-s-text">Daily audit report — {fmtDayLong(r.day)}</p>
        <p className="text-[11px] text-s-muted">Generated {fmtWhen(r.generatedAt)}</p>
      </div>

      <Section title="Sales">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat k="Orders" v={r.sales.orders} />
          <Stat k="Net sales" v={fmtPkr(r.sales.netSalesCents)} />
          <Stat k="Tax" v={fmtPkr(r.sales.taxCents)} />
          <Stat k="Total" v={fmtPkr(r.sales.totalCents)} />
          <Stat k="Gross" v={fmtPkr(r.sales.grossCents)} />
          <Stat k="Discounts" v={fmtPkr(r.sales.discountCents)} />
          <Stat k="Service charge" v={fmtPkr(r.sales.serviceChargeCents)} />
          <Stat k="Delivery fees / tips" v={`${fmtPkr(r.sales.deliveryFeeCents)} / ${fmtPkr(r.sales.tipCents)}`} />
        </div>
        <Table head={['Brand', 'Orders', 'Net sales', 'Tax', 'Total']}
          rows={r.sales.byBrand.map((b) => [b.name, b.orders, fmtPkr(b.netSalesCents), fmtPkr(b.taxCents), fmtPkr(b.totalCents)])} />
        <Table head={['Channel', 'Orders', 'Total']} rows={r.sales.byChannel.map((c) => [label(c.source), c.orders, fmtPkr(c.totalCents)])} />
        <Table head={['Fulfilment', 'Orders', 'Total']} rows={r.sales.byFulfilment.map((c) => [label(c.type), c.orders, fmtPkr(c.totalCents)])} />
      </Section>

      <Section title="Tenders">
        <Table head={['Method', 'Count', 'Paid', 'Refunded', 'Pending']}
          rows={r.tenders.map((t) => [label(t.method), t.count, fmtPkr(t.paidCents), fmtPkr(t.refundedCents), fmtPkr(t.pendingCents)])} />
      </Section>

      <Section title="Cash by till">
        <Table head={['Till', 'Expected', 'Counted', 'Variance', 'Deposit']}
          rows={r.cash.shifts.map((s) => [
            <span key="n">{s.cashier}{s.location ? ` · ${s.location}` : ''}{s.varianceFlag ? ` (variance ${s.varianceFlag})` : ''}</span>,
            fmtPkr(s.expectedCents),
            s.countedCents == null ? 'Not counted' : fmtPkr(s.countedCents),
            s.varianceCents == null ? '—' : <span key="v" className={s.varianceCents === 0 ? 'text-success' : 'text-s-red'}>{fmtPkr(s.varianceCents)}</span>,
            fmtPkr(s.depositDropCents),
          ])} />
        <p className="text-xs text-s-muted">Payouts {fmtPkr(r.cash.payoutsCents)} · Drops {fmtPkr(r.cash.dropsCents)} · Total variance {fmtPkr(r.cash.totalVarianceCents)}</p>
      </Section>

      <Section title="Voids and comps">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Stat k="Item voids" v={`${r.voids.itemVoids} · ${fmtPkr(r.voids.itemVoidCents)}`} />
          <Stat k="Order cancels" v={`${r.voids.orderCancels} · ${fmtPkr(r.voids.orderCancelCents)}`} />
          <Stat k="Comps" v={`${r.voids.comps} · ${fmtPkr(r.voids.compCents)}`} />
        </div>
        <Table head={['Approved by', 'Count', 'Value']} rows={r.voids.byApprover.map((a) => [a.name, a.count, fmtPkr(a.cents)])} />
      </Section>

      <Section title="Discounts">
        <p className="text-xs text-s-muted">Total {fmtPkr(r.discounts.totalCents)} · Promo {fmtPkr(r.discounts.promoCents)} · Manual {fmtPkr(r.discounts.manualCents)} · Loyalty {fmtPkr(r.discounts.loyaltyRedeemedCents)}</p>
        <Table head={['Reason', 'Value']} rows={r.discounts.byReason.map((x) => [x.reason, fmtPkr(x.cents)])} />
      </Section>

      <Section title="Refunds">
        <p className="text-xs text-s-muted">{r.refunds.count} refund{r.refunds.count === 1 ? '' : 's'} · {fmtPkr(r.refunds.cents)}</p>
        <Table head={['Method', 'Value']} rows={r.refunds.byMethod.map((x) => [label(x.method), fmtPkr(x.cents)])} />
      </Section>

      <Section title="Pre-bills">
        <p className="text-xs text-s-muted">Printed {r.preBills.printed} · Orphaned {r.preBills.orphaned} · Final lower than pre-bill {r.preBills.finalLower}</p>
      </Section>

      <Section title="Cash on delivery">
        <p className="text-xs text-s-muted">Delivered {r.cod.delivered} · Handed in {fmtPkr(r.cod.collectedCents)} · Still with riders {fmtPkr(r.cod.pendingCents)}</p>
      </Section>

      <Section title="Raast QR">
        <Table head={['Status', 'Count', 'Value']} rows={r.raast.byStatus.map((x) => [label(x.status), x.count, fmtPkr(x.cents)])} />
      </Section>

      <Section title="Card">
        <p className="text-xs text-s-muted">Gross {fmtPkr(r.card.grossCents)}</p>
        <Table head={['Unit', 'Value', 'Payout']}
          rows={r.card.byUnit.map((u) => [u.unit, fmtPkr(u.cents), <span key="s" className={u.settled ? 'text-success' : 'text-s-muted'}>{u.settled ? 'Settled' : 'Waiting'}</span>])} />
      </Section>

      <Section title="Exceptions raised">
        <Table head={['Kind', 'Count', 'Value']} rows={r.exceptions.map((x) => [label(x.kind), x.count, fmtPkr(x.cents)])} />
      </Section>

      <Section title="Checks at the run">
        <Problems title="Night run" list={r.checks.night} />
        <Problems title="Settlement" list={r.checks.settlement} />
      </Section>

      {r.closing && (
        <Section title="Closing">
          <p className="text-xs text-s-muted">
            Closed {fmtWhen(r.closing.at)} · Card settled {fmtPkr(r.closing.card.settledCents)} (fees {fmtPkr(r.closing.card.feeCents)}) ·
            Unmatched bank lines {r.closing.bank.unmatchedLines} · Raast matched {r.closing.raast.matched}, open {r.closing.raast.open}
          </p>
        </Section>
      )}
    </div>
  )
}
