'use client'
// Raast QR → Bank SMS log (GET /connectors/raast/sms): every SMS servd
// stored for the active company and what it did with it. SMS from senders
// not on the list, and SMS with an ignore keyword (OTPs, PINs), are never
// stored, so they never appear here — only the device's "ignored" count.
// Attaching an SMS to a bill is a till action; finance matches statements.

import { Fragment, useState } from 'react'
import Link from 'next/link'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  BANK_SMS_STATUSES, BANK_SMS_STATUS_LABEL, connectorsApi, connectorErrorText,
  type BankSmsStatus, type RaastSettingsPage,
} from '../../../lib/connectorsApi'
import { fmtPkr } from '../../../lib/money'
import { orderRef } from '../../../lib/orderRef'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { usePermissions } from '../../../hooks/useCan'
import { Badge, Card, ErrorLine, Field, fmtWhen, type Tone } from '../ui'
import { Select } from '@/components/ui/Select'

function smsTone(s: BankSmsStatus): Tone {
  switch (s) {
    case 'matched': case 'confirmed': case 'attached': return 'ok'
    case 'needs_attention': case 'unparsed': return 'bad'
    case 'unmatched': case 'ambiguous': case 'debit': case 'received': case 'processing': return 'warn'
    case 'off': return 'info'
    default: return 'muted'
  }
}

export function RaastSmsLog({ data }: { data: RaastSettingsPage }) {
  const { data: me } = usePermissions()
  const canOpenOrders = !!me && canOpenPath('/orders', me.role, me.modules ?? [])
  const [status, setStatus] = useState<BankSmsStatus | ''>('')
  const [open, setOpen] = useState<string | null>(null)
  const list = useInfiniteQuery({
    queryKey: ['raast-sms', status],
    queryFn: ({ pageParam }) => connectorsApi.raastSms({ status: status || undefined, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  })
  const rows = list.data?.pages.flatMap((p) => p.items) ?? []
  const accountName = (id: string | null) => {
    if (!id) return null
    const a = data.receivingAccounts.bankAccounts.find((x) => x.id === id)
    return a ? `${a.name}${a.last4 ? ` ·${a.last4}` : ''}` : null
  }

  return (
    <Card title="Bank SMS log" subtitle="Every bank SMS servd stored, newest first. Texts are cleared after 90 days (30 for SMS it could not read).">
      <div className="max-w-[260px]">
        <Field label="Status">
          <Select className="s-select text-xs" value={status} onChange={(e) => setStatus(e.target.value as BankSmsStatus | '')}>
            <option value="">All</option>
            {BANK_SMS_STATUSES.map((s) => <option key={s} value={s}>{BANK_SMS_STATUS_LABEL[s]}</option>)}
          </Select>
        </Field>
      </div>
      {list.isLoading && <p className="text-xs text-s-muted">Loading…</p>}
      <ErrorLine>{list.error ? connectorErrorText(list.error) : null}</ErrorLine>
      {!list.isLoading && rows.length === 0 && <p className="text-xs text-s-muted">No bank SMS{status ? ' with this status' : ''} yet.</p>}
      {rows.length > 0 && (
        <div className="-mx-4 overflow-x-auto sm:mx-0">
          <table className="s-table">
            <thead>
              <tr><th>Received</th><th>Sender</th><th>Phone</th><th>Status</th><th className="text-right">Amount</th><th>Reference</th><th>Payer</th><th>Account</th><th>Bill</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <Fragment key={a.id}>
                  <tr>
                    <td className="whitespace-nowrap text-xs">{fmtWhen(a.receivedAt)}</td>
                    <td className="font-mono text-xs">{a.sender}</td>
                    <td className="text-xs">{a.device}</td>
                    <td>
                      <Badge tone={smsTone(a.status)} title={a.resolution ?? undefined}>{BANK_SMS_STATUS_LABEL[a.status] ?? a.status}</Badge>
                      {a.kind === 'debit' && a.status !== 'debit' && <span className="ml-1 text-[11px] text-s-muted">money out</span>}
                    </td>
                    <td className="whitespace-nowrap text-right text-xs">{a.amountCents != null ? fmtPkr(a.amountCents) : '—'}</td>
                    <td className="font-mono text-xs">{a.bankRef ?? '—'}</td>
                    <td className="text-xs">{a.payer ?? '—'}</td>
                    <td className="text-xs">{accountName(a.bankAccountId) ?? (a.accountLast4 ? `…${a.accountLast4}` : '—')}</td>
                    <td className="text-xs">
                      {a.receipt
                        ? canOpenOrders
                          ? <Link className="font-mono text-primary hover:underline" href={`/orders/${encodeURIComponent(a.receipt.orderId)}`}>#{orderRef(a.receipt.orderId)}</Link>
                          : <span className="font-mono">#{orderRef(a.receipt.orderId)}</span>
                        : '—'}
                    </td>
                    <td>
                      <button className="s-btn-ghost px-2 py-1 text-xs" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                        {open === a.id ? 'Hide' : 'Text'}
                      </button>
                    </td>
                  </tr>
                  {open === a.id && (
                    <tr>
                      <td colSpan={10} className="bg-s-bg">
                        <div className="space-y-1 text-xs">
                          {a.body
                            ? <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-s-text">{a.body}</pre>
                            : <p className="text-s-muted">The text has been cleared (retention).</p>}
                          {a.occurredAt && <p className="text-s-muted">Time in the SMS: {fmtWhen(a.occurredAt)}</p>}
                          {a.resolution && <p className="text-s-muted">Note: {a.resolution}</p>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && (
        <button className="s-btn-secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </Card>
  )
}
