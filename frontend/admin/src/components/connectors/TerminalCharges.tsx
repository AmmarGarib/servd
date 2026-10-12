'use client'
// POS connector → Card charges tab (spec §10): every card-machine charge and
// refund, for reconciliation against the processor's statement. With the
// built-in test driver, a waiting charge can be approved or declined from
// here (POST /connectors/terminal/test/simulate — test driver only).

import { useState } from 'react'
import Link from 'next/link'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CHARGE_STATUS_LABEL, TERMINAL_CHARGE_STATUSES, connectorsApi, connectorErrorText,
  type ConnectorsOverview, type TerminalChargeStatus,
} from '../../lib/connectorsApi'
import { fmtPkr } from '../../lib/money'
import { canOpenPath } from '../../lib/moduleCatalog'
import { usePermissions } from '../../hooks/useCan'
import { Banner, Card, ChargeChip, ErrorLine, Field, TestBadge, fmtWhen } from './ui'

const dayStart = (d: string) => (d ? `${d}T00:00:00+05:00` : undefined)
const dayEnd = (d: string) => (d ? `${d}T23:59:59.999+05:00` : undefined)

export function TerminalCharges({ data, canConfigure, portfolio = false }: {
  data: ConnectorsOverview
  canConfigure: boolean
  /**
   * All-companies view. GET /connectors/terminal/charges still returns the
   * ACTIVE company's charges only (the API binds it to that company), so
   * this only shows a banner saying so.
   */
  portfolio?: boolean
}) {
  const qc = useQueryClient()
  // IT holds api_pos but not orders: the order id links only for a login that
  // can open /orders (the page guard and the API would refuse it).
  const { data: me } = usePermissions()
  const canOpenOrders = !!me && canOpenPath('/orders', me.role, me.modules ?? [])
  const [status, setStatus] = useState<TerminalChargeStatus | ''>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const filters = { status: status || undefined, from: dayStart(from), to: dayEnd(to) }
  const list = useInfiniteQuery({
    queryKey: ['connector-charges', 'list', filters],
    queryFn: ({ pageParam }) => connectorsApi.charges({ ...filters, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  })
  const rows = list.data?.pages.flatMap((p) => p.items) ?? []
  const isTest = data.terminal.driver === 'test'
  const simulate = useMutation({
    mutationFn: (v: { id: string; outcome: 'approved' | 'declined' }) => connectorsApi.simulateCharge(v.id, v.outcome),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connector-charges'] }),
  })

  return (
    <div className="space-y-4">
      <Card title="Card charges" subtitle="Every charge and refund pushed to a card machine, newest first." actions={isTest ? <TestBadge /> : undefined}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Field label="Status">
            <select className="s-select text-xs" value={status} onChange={(e) => setStatus(e.target.value as TerminalChargeStatus | '')}>
              <option value="">All</option>
              {TERMINAL_CHARGE_STATUSES.map((s) => <option key={s} value={s}>{CHARGE_STATUS_LABEL[s]}</option>)}
            </select>
          </Field>
          <Field label="From"><input type="date" className="s-input text-xs" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" className="s-input text-xs" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </Card>
      {portfolio && (
        <Banner tone="info" title="All-companies view — this list shows the active company only">
          <p>Switch company to see another company&rsquo;s card charges.</p>
        </Banner>
      )}
      <div className="s-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="s-table">
            <thead>
              <tr><th>Time</th><th>Machine</th><th>Order</th><th>Kind</th><th>Amount</th><th>Tip</th><th>Status</th><th>Card</th><th>Approval</th><th>Payment</th><th>Note</th>{isTest && canConfigure && <th />}</tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="text-xs">{fmtWhen(c.createdAt)}</td>
                  <td className="text-xs">{c.terminalLabel}</td>
                  <td>{canOpenOrders
                    ? <Link href={`/orders/${c.orderId}`} className="font-mono text-xs text-primary-ink underline">{c.orderId.slice(-6).toUpperCase()}</Link>
                    : <span className="font-mono text-xs">{c.orderId.slice(-6).toUpperCase()}</span>}</td>
                  <td className="text-xs">{c.kind === 'charge' ? 'Charge' : 'Refund'}</td>
                  <td className="text-xs">{fmtPkr(c.amountCents)}</td>
                  <td className="text-xs">{c.tipCents ? fmtPkr(c.tipCents) : '—'}</td>
                  <td><ChargeChip status={c.status} /></td>
                  <td className="text-xs">{c.cardBrand || c.cardLast4 ? `${c.cardBrand ?? ''} ${c.cardLast4 ? `•${c.cardLast4}` : ''}`.trim() : '—'}</td>
                  <td className="font-mono text-xs">{c.approvalRef ?? '—'}</td>
                  <td className="text-xs">{c.payment ? fmtPkr(c.payment.amountCents) : '—'}</td>
                  <td className="max-w-[220px] whitespace-normal text-[11px] text-s-muted">{c.message ?? c.refusalCode ?? ''}</td>
                  {isTest && canConfigure && (
                    <td className="text-right space-x-1">
                      {['pending', 'sent'].includes(c.status) && (
                        <>
                          <button className="s-btn-secondary px-2 py-1 text-xs" disabled={simulate.isPending} onClick={() => simulate.mutate({ id: c.id, outcome: 'approved' })}>Approve</button>
                          <button className="s-btn-ghost px-2 py-1 text-xs" disabled={simulate.isPending} onClick={() => simulate.mutate({ id: c.id, outcome: 'declined' })}>Decline</button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.isLoading && <p className="p-4 text-xs text-s-muted">Loading…</p>}
        {!list.isLoading && rows.length === 0 && !list.error && <p className="p-4 text-xs text-s-muted">No card charges.</p>}
        <div className="p-3"><ErrorLine>{list.error ? connectorErrorText(list.error) : simulate.error ? connectorErrorText(simulate.error) : null}</ErrorLine></div>
        {list.hasNextPage && (
          <div className="p-3 border-t border-s-border">
            <button className="s-btn-secondary text-xs" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
