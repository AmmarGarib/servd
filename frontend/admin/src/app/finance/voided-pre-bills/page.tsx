'use client'
// Finance → Voided pre bills (spec §17.1–§17.3, §17.5).
//
// Every pre-bill (the guest check printed before payment) of the companies in
// view, with the flags the server computes at read:
//   ORPHANED          the order was cancelled / rejected, or is still not final
//                     and its drawer closed or the pre-bill is over 12 h old;
//   FINAL_LOWER       the full & final bill came out below what the pre-bill
//                     showed (the lower of its cash and card totals);
//   LINE_VOIDS_AFTER  lines were voided after the pre-bill was printed.
// READ-ONLY: a pre-bill is a permanent record — there is no delete, hide or
// edit, here or in the API. Pre-bills never reach the fiscal POS, the ledger
// or any revenue / tax report.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { Select } from '@/components/ui/Select'

// A pre-bill is priced for cash or the digital rate. 'card' is the digital tax
// group — Card – Keenu and Raast QR share it (backend lib/pricing.ts).
function tenderText(t: string): string {
  if (t === 'card') return 'card / Raast'
  return t
}

// ─── Types (GET /pre-bills) ──────────────────────────────────────────────────

type Flag = 'ORPHANED' | 'FINAL_LOWER' | 'LINE_VOIDS_AFTER'
type Status = 'open' | 'superseded' | 'converted' | 'cancelled'

interface PreBillLine {
  orderItemId: string
  name: string
  qty: number
  unitPriceCents: number
  modifiers: Array<{ name: string; priceDeltaCents: number }>
  lineCents: number
}

interface LineVoidAfter {
  orderItemId: string
  name: string
  qty: number
  cents: number
  voidedAt: string
  reason: string | null
  approverId: string | null
  approver: string | null
}

interface Row {
  id: string
  number: number
  label: string
  tenantId: string
  printedAt: string
  conceptId: string
  brand: string
  table: string | null
  orderId: string
  orderRef: string
  orderStatus: string
  printedById: string
  printedBy: string | null
  tender: string
  totalCents: number
  cardTotalCents: number | null
  subtotalCents: number
  discountCents: number
  serviceChargeCents: number
  taxCents: number
  lines: PreBillLine[]
  status: Status
  statusAt: string | null
  finalTotalCents: number | null
  finalAt: string | null
  differenceCents: number | null
  cancelledById: string | null
  cancelledBy: string | null
  cancelReason: string | null
  lineVoidsAfter: { count: number; cents: number; items: LineVoidAfter[] }
  flags: Flag[]
}

interface ListResp {
  from: string
  to: string
  rows: Row[]
  /** Prints counted (`count`) and orders counted (`orders`); money is once per order, however many reprints. */
  summary: {
    count: number
    orders: number
    valueCents: number
    orphaned: { count: number; orders: number; cents: number }
    finalLower: { count: number; orders: number; diffCents: number }
    lineVoidsAfter: { count: number; orders: number; cents: number }
  }
  truncated: boolean
  facets: {
    concepts: Array<{ id: string; name: string }>
    printers: Array<{ id: string; name: string | null }>
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FLAG_LABEL: Record<Flag, string> = {
  ORPHANED: 'Orphaned',
  FINAL_LOWER: 'Final lower',
  LINE_VOIDS_AFTER: 'Voids after',
}

const FLAG_HINT: Record<Flag, string> = {
  ORPHANED: 'The guest was shown this bill but it never became a full & final bill: the order was cancelled, or it is still open after its drawer closed or 12 hours passed.',
  FINAL_LOWER: 'The full & final bill came out lower than this pre-bill\'s total for the way it was actually paid (the card total only when it was paid wholly by card).',
  LINE_VOIDS_AFTER: 'Lines on this order were voided after the pre-bill was printed.',
}

const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  superseded: 'Reprinted',
  converted: 'Became FnF bill',
  cancelled: 'Order cancelled',
}

function daysAgoPktIso(days: number): string {
  const pkt = new Date(Date.now() + 5 * 3600_000 - days * 86_400_000)
  return pkt.toISOString().slice(0, 10)
}

function fmtPkt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi', hour12: true,
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const danger = 'var(--erp-danger)'
const dangerBg = 'color-mix(in srgb, var(--erp-danger) 10%, transparent)'
const dangerBorder = 'color-mix(in srgb, var(--erp-danger) 30%, transparent)'

function FlagChip({ flag }: { flag: Flag }) {
  return (
    <span
      title={FLAG_HINT[flag]}
      className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
      style={{ background: dangerBg, color: danger, border: `1px solid ${dangerBorder}` }}
    >
      {FLAG_LABEL[flag]}
    </span>
  )
}

function StatusPill({ status }: { status: Status }) {
  const tone = status === 'converted'
    ? { background: 'rgb(var(--fg-rgb) / 0.05)', color: 'var(--erp-primary-ink)' }
    : status === 'cancelled'
      ? { background: dangerBg, color: danger }
      : { background: 'rgb(var(--fg-rgb) / 0.05)', color: 'var(--muted)' }
  return <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={tone}>{STATUS_LABEL[status]}</span>
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function VoidedPreBillsPage() {
  const [from, setFrom] = useState(() => daysAgoPktIso(29))
  const [to, setTo] = useState(() => todayPktIso())
  const [conceptId, setConceptId] = useState('')
  const [printedById, setPrintedById] = useState('')
  const [status, setStatus] = useState<'' | Status>('')
  const [flagged, setFlagged] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [csvErr, setCsvErr] = useState('')

  const qs = useMemo(() => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (conceptId) p.set('conceptId', conceptId)
    if (printedById) p.set('printedById', printedById)
    if (status) p.set('status', status)
    if (flagged) p.set('flagged', '1')
    return p.toString()
  }, [from, to, conceptId, printedById, status, flagged])

  const { data, isLoading, error } = useQuery<ListResp>({
    queryKey: ['pre-bills', qs],
    queryFn: () => api.get(`/pre-bills?${qs}`),
  })

  const rows = data?.rows ?? []
  const open = rows.find((r) => r.id === openId) ?? null

  const downloadCsv = () => {
    setCsvErr('')
    api.download(`/pre-bills?${qs}&format=csv`, `voided-pre-bills-${from}-to-${to}.csv`).catch((e: Error) => setCsvErr(e.message))
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="border-b px-4 py-6 sm:px-7" style={{ borderColor: 'var(--border)' }}>
        <Link href="/finance" className="text-xs text-white/40 hover:text-white/70">← Finance</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-white/90">Voided pre bills</h1>
            <p className="mt-1 max-w-2xl text-sm text-white/45">
              Every pre-bill printed for an open order — the guest check before payment. A pre-bill is never a tax invoice and never goes to the POS; only the full &amp; final bill does.
              Red flags mark pre-bills that never became a full &amp; final bill, came out lower, or had lines voided after printing. Pre-bills are a permanent record and cannot be removed.
            </p>
          </div>
          <button
            onClick={downloadCsv}
            className="rounded-xl border px-4 py-2.5 text-sm font-semibold text-white/70 hover:text-white"
            style={{ borderColor: 'var(--border-strong)', background: 'var(--surface)' }}
          >
            Download CSV
          </button>
        </div>
        {csvErr && <p className="mt-2 text-sm" style={{ color: danger }}>{csvErr}</p>}
      </header>

      <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-7">
        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3 rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <Filter label="From">
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={fieldCls} />
          </Filter>
          <Filter label="To">
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={fieldCls} />
          </Filter>
          <Filter label="Brand">
            <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
              <option value="">All brands</option>
              {(data?.facets.concepts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Filter>
          <Filter label="Printed by">
            <Select value={printedById} onChange={(e) => setPrintedById(e.target.value)} className={fieldCls}>
              <option value="">Everyone</option>
              {(data?.facets.printers ?? []).map((p) => <option key={p.id} value={p.id}>{p.name ?? 'Unnamed'}</option>)}
            </Select>
          </Filter>
          <Filter label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as '' | Status)} className={fieldCls}>
              <option value="">Any status</option>
              {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </Select>
          </Filter>
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-white/70">
            <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} />
            Flagged only
          </label>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="Pre-bills printed" value={String(data?.summary.count ?? 0)} sub={`${fmtPkr(data?.summary.valueCents ?? 0)} · ${ordersLabel(data?.summary.orders ?? 0)}`} />
          <Tile label="Orphaned orders" value={String(data?.summary.orphaned.orders ?? 0)} sub={`${fmtPkr(data?.summary.orphaned.cents ?? 0)} · ${printsLabel(data?.summary.orphaned.count ?? 0)}`} alert={(data?.summary.orphaned.orders ?? 0) > 0} hint={FLAG_HINT.ORPHANED} />
          <Tile label="Final bill lower" value={String(data?.summary.finalLower.orders ?? 0)} sub={`${fmtPkr(data?.summary.finalLower.diffCents ?? 0)} below`} alert={(data?.summary.finalLower.orders ?? 0) > 0} hint={FLAG_HINT.FINAL_LOWER} />
          <Tile label="Lines voided after" value={String(data?.summary.lineVoidsAfter.orders ?? 0)} sub={`${fmtPkr(data?.summary.lineVoidsAfter.cents ?? 0)} · ${printsLabel(data?.summary.lineVoidsAfter.count ?? 0)}`} alert={(data?.summary.lineVoidsAfter.orders ?? 0) > 0} hint={FLAG_HINT.LINE_VOIDS_AFTER} />
        </div>
        {data && <p className="text-xs text-white/40">Amounts count each order once — a reprinted bill is one bill, not several.</p>}
        {flagged && data && <p className="text-xs text-white/40">Totals cover every pre-bill in the range; the table shows only the flagged ones.</p>}
        {data?.truncated && (
          <p className="rounded-xl px-4 py-2 text-sm" style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)' }}>
            Showing the latest 5,000 pre-bills only — narrow the date range to see the rest.
          </p>
        )}

        {/* Table */}
        <div className="overflow-hidden rounded-2xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          {error ? (
            <p className="p-8 text-center text-sm" style={{ color: danger }}>{(error as Error).message}</p>
          ) : isLoading ? (
            <p className="p-8 text-center text-sm text-white/40">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center">
              <p className="font-bold text-white/85">{flagged ? 'Nothing flagged' : 'No pre-bills'}</p>
              <p className="mt-1 text-sm text-white/45">{flagged ? 'Every pre-bill in this range became a full & final bill at the same or a higher total.' : 'No pre-bill was printed in this range.'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-white/40" style={{ borderBottom: '1px solid var(--border)' }}>
                    <th className="px-4 py-3 font-semibold">Pre-bill</th>
                    <th className="px-3 py-3 font-semibold">Printed (PKT)</th>
                    <th className="px-3 py-3 font-semibold">Brand</th>
                    <th className="px-3 py-3 font-semibold">Table</th>
                    <th className="px-3 py-3 font-semibold">Order</th>
                    <th className="px-3 py-3 font-semibold">Printed by</th>
                    <th className="px-3 py-3 text-right font-semibold">Pre-bill total</th>
                    <th className="px-3 py-3 font-semibold">Status</th>
                    <th className="px-3 py-3 text-right font-semibold">Final</th>
                    <th className="px-3 py-3 text-right font-semibold">Difference</th>
                    <th className="px-4 py-3 font-semibold">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setOpenId(r.id)}
                      className="cursor-pointer hover:bg-white/[0.03]"
                      style={{ borderBottom: '1px solid var(--border)', ...(r.flags.length > 0 && { boxShadow: `inset 3px 0 0 ${danger}` }) }}
                    >
                      <td className="px-4 py-2.5 font-mono font-semibold text-white/85">{r.label}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-white/60">{fmtPkt(r.printedAt)}</td>
                      <td className="px-3 py-2.5 text-white/75">{r.brand}</td>
                      <td className="px-3 py-2.5 text-white/60">{r.table ?? '—'}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-white/60">{r.orderRef}</td>
                      <td className="px-3 py-2.5 text-white/75">{r.printedBy ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-white/85">
                        {fmtPkr(r.totalCents)}
                        <span className="ml-1 text-[10px] uppercase text-white/35">{tenderText(r.tender)}</span>
                      </td>
                      <td className="px-3 py-2.5"><StatusPill status={r.status} /></td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-white/75">{r.finalTotalCents != null ? fmtPkr(r.finalTotalCents) : '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right" style={r.differenceCents != null && r.differenceCents < 0 ? { color: danger, fontWeight: 600 } : undefined}>
                        {r.differenceCents != null ? `${r.differenceCents > 0 ? '+' : ''}${fmtPkr(r.differenceCents)}` : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">{r.flags.map((f) => <FlagChip key={f} flag={f} />)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {open && <Drawer row={open} onClose={() => setOpenId(null)} />}
    </div>
  )
}

// ─── Row drawer ──────────────────────────────────────────────────────────────

function Drawer({ row: r, onClose }: { row: Row; onClose: () => void }) {
  const otherCents = r.totalCents - (r.subtotalCents - r.discountCents + r.taxCents + r.serviceChargeCents)
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-secondary/40" onClick={onClose}>
      <aside
        className="h-full w-full max-w-md overflow-y-auto"
        style={{ background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Pre-bill ${r.label}`}
      >
        <div className="sticky top-0 flex items-center justify-between border-b px-5 py-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div>
            <h2 className="font-mono text-lg font-black text-white/90">{r.label}</h2>
            <p className="text-xs text-white/45">{r.brand}{r.table ? ` · Table ${r.table}` : ''} · Order {r.orderRef}</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-white/50 hover:text-white" aria-label="Close">Close</button>
        </div>

        <div className="space-y-5 p-5 text-sm">
          {r.flags.length > 0 && (
            <div className="space-y-2 rounded-xl p-3" style={{ background: dangerBg, border: `1px solid ${dangerBorder}` }}>
              {r.flags.map((f) => (
                <div key={f}>
                  <FlagChip flag={f} />
                  <p className="mt-1 text-xs" style={{ color: danger }}>{FLAG_HINT[f]}</p>
                </div>
              ))}
            </div>
          )}

          <Section title="Printed">
            <KV k="When" v={fmtPkt(r.printedAt)} />
            <KV k="By" v={r.printedBy ?? '—'} />
            <KV k="Status" v={<StatusPill status={r.status} />} />
            <KV k="Order status" v={r.orderStatus} />
          </Section>

          <Section title="What the guest was shown">
            <table className="w-full">
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.orderItemId} className="align-top">
                    <td className="py-1 pr-2 text-white/50">{l.qty}×</td>
                    <td className="py-1 text-white/80">
                      {l.name}
                      {l.modifiers.length > 0 && <div className="text-xs text-white/40">{l.modifiers.map((m) => `+ ${m.name}`).join(', ')}</div>}
                    </td>
                    <td className="whitespace-nowrap py-1 text-right text-white/80">{fmtPkr(l.lineCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 space-y-1 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
              <KV k="Subtotal" v={fmtPkr(r.subtotalCents)} />
              {r.discountCents > 0 && <KV k="Discount" v={`-${fmtPkr(r.discountCents)}`} />}
              {r.taxCents > 0 && <KV k={`GST (${tenderText(r.tender)})`} v={fmtPkr(r.taxCents)} />}
              {r.serviceChargeCents > 0 && <KV k="Service charge" v={fmtPkr(r.serviceChargeCents)} />}
              {otherCents !== 0 && <KV k={otherCents > 0 ? 'Tip' : 'Credits applied'} v={fmtPkr(otherCents)} />}
              <KV k={<strong>Total ({tenderText(r.tender)})</strong>} v={<strong>{fmtPkr(r.totalCents)}</strong>} />
              {r.cardTotalCents != null && <KV k="If paid by card / Raast QR" v={fmtPkr(r.cardTotalCents)} />}
            </div>
          </Section>

          <Section title="Full & final bill">
            {r.finalTotalCents != null ? (
              <>
                <KV k="Final total" v={fmtPkr(r.finalTotalCents)} />
                <KV k="Final at" v={fmtPkt(r.finalAt)} />
                <KV
                  k="Difference"
                  v={<span style={r.differenceCents != null && r.differenceCents < 0 ? { color: danger, fontWeight: 600 } : undefined}>
                    {r.differenceCents != null ? `${r.differenceCents > 0 ? '+' : ''}${fmtPkr(r.differenceCents)}` : '—'}
                  </span>}
                />
              </>
            ) : (
              <p className="text-white/45">{r.status === 'cancelled' ? 'None — the order was cancelled before payment.' : 'Not yet — the order is not final.'}</p>
            )}
          </Section>

          {r.status === 'cancelled' && (
            <Section title="Cancelled">
              <KV k="Approved by (manager)" v={r.cancelledBy ?? (r.cancelledById ? 'Unknown user' : 'System')} />
              <KV k="Reason" v={r.cancelReason ?? '—'} />
              <KV k="When" v={fmtPkt(r.statusAt)} />
            </Section>
          )}

          <Section title={`Lines voided after printing (${r.lineVoidsAfter.count})`}>
            {r.lineVoidsAfter.items.length === 0 ? (
              <p className="text-white/45">None.</p>
            ) : (
              <div className="space-y-2">
                {r.lineVoidsAfter.items.map((v) => (
                  <div key={v.orderItemId} className="rounded-lg p-2.5" style={{ background: dangerBg, border: `1px solid ${dangerBorder}` }}>
                    <div className="flex justify-between gap-2">
                      <span className="text-white/85">{v.qty}× {v.name}</span>
                      <span className="whitespace-nowrap font-semibold" style={{ color: danger }}>{fmtPkr(v.cents)}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-white/50">
                      {fmtPkt(v.voidedAt)} · approved by {v.approver ?? 'unknown'}{v.reason ? ` · ${v.reason}` : ''}
                    </p>
                  </div>
                ))}
                <KV k="Total voided after" v={fmtPkr(r.lineVoidsAfter.cents)} />
              </div>
            )}
          </Section>

          <p className="text-xs text-white/35">
            A pre-bill is a permanent record. It is never filed with the POS, never posts to the ledger and is never counted as revenue.
          </p>
        </div>
      </aside>
    </div>
  )
}

// ─── Bits ────────────────────────────────────────────────────────────────────

const ordersLabel = (n: number) => `${n} ${n === 1 ? 'order' : 'orders'}`
const printsLabel = (n: number) => `${n} ${n === 1 ? 'print' : 'prints'}`

function Tile({ label, value, sub, alert, hint }: { label: string; value: string; sub: string; alert?: boolean; hint?: string }) {
  return (
    <div
      className="rounded-2xl p-4"
      title={hint}
      style={{ background: alert ? dangerBg : 'var(--surface)', border: `1px solid ${alert ? dangerBorder : 'var(--border)'}` }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wider text-white/45">{label}</p>
      <p className="mt-1 text-2xl font-black" style={{ color: alert ? danger : 'var(--text)' }}>{value}</p>
      <p className="text-xs text-white/50">{sub}</p>
    </div>
  )
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-xs text-white/50">{label}{children}</label>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-white/40">{title}</h3>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function KV({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-white/50">{k}</span>
      <span className="text-right text-white/85">{v}</span>
    </div>
  )
}

const fieldCls = 'rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none'
