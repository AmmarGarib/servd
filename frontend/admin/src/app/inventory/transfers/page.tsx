'use client'
// Stock transfers — move stock between two OUTLETS of ONE company.
//
// Contract: backend/src/modules/stockTransfers/routes.ts (header). Requested →
// approved (receiving outlet) → shipped (stock leaves the sending outlet's lots,
// FIFO, never clamped: INSUFFICIENT_STOCK) → received (what arrived; a short
// receipt needs a reason and is booked as waste at the receiving outlet).
// Outlet on-hand comes from GET /inventory/by-site; this page keeps no copy of
// the rules — the server refuses cross-company pairs (TRANSFER_CROSS_COMPANY).

import { ArrowLeft } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { stockErrorText, errorCode } from '../../../lib/stockUi'
import { Select } from '@/components/ui/Select'
import { NumberField } from '../../../components/ui/NumberField'
import { Button, Dialog, DialogFooter, ErrorBanner, Field, Input, LinkButton, SectionCard } from '../../../components/finance/ui'

interface Site { id: string; name: string; tenantId: string }
interface SiteRow { inventoryItemId: string; locationId: string; qty: number }
interface BySite { sites: Site[]; rows: SiteRow[] }
interface Item { id: string; name: string; unit: string; tenantId?: string | null }
interface Transfer {
  id: string; status: 'requested' | 'approved' | 'shipped' | 'received' | 'cancelled'
  quantity: number; unit: string; receivedQuantity?: number | null; reason?: string | null; requestedAt: string
  inventoryItem?: { name: string; unit: string } | null
  fromLocation?: { name: string } | null
  toLocation?: { name: string } | null
}

const STATUS_LABEL: Record<Transfer['status'], string> = {
  requested: 'Requested', approved: 'Approved', shipped: 'On the way', received: 'Received', cancelled: 'Cancelled',
}
const STATUS_BADGE: Record<Transfer['status'], string> = {
  requested: 's-badge-purple', approved: 's-badge-purple', shipped: 's-badge-purple', received: 's-badge-green', cancelled: 's-badge-purple',
}

// The server's own message leads; these are the codes this screen explains in its own words.
const OWN_TEXT: Record<string, string> = {
  INSUFFICIENT_STOCK: 'The sending outlet does not hold that much of this item, so nothing was moved. Lower the quantity, or count / receive stock at that outlet first.',
  TRANSFER_CROSS_COMPANY: 'A transfer moves stock between two outlets of ONE company. These two belong to different companies.',
  OVER_RECEIVED: 'More cannot arrive than was sent.',
}
function errText(e: unknown): string {
  return OWN_TEXT[errorCode(e)] ?? stockErrorText(e)
}

const qtyText = (n: number) => String(Math.round(n * 1000) / 1000)

export default function StockTransfersPage() {
  const qc = useQueryClient()
  const { data: bySite } = useQuery<BySite>({ queryKey: ['inventory', 'by-site'], queryFn: () => api.get('/inventory/by-site') })
  const { data: items = [] } = useQuery<Item[]>({ queryKey: ['inventory'], queryFn: () => api.get('/inventory') })
  const { data: transfers = [] } = useQuery<Transfer[]>({ queryKey: ['stock-transfers'], queryFn: () => api.get('/stock-transfers'), refetchInterval: 30_000 })

  const sites = bySite?.sites ?? []
  const onHand = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of bySite?.rows ?? []) m.set(`${r.locationId}:${r.inventoryItemId}`, r.qty)
    return m
  }, [bySite])

  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [itemId, setItemId] = useState('')
  const [qty, setQty] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)
  const [receiveFor, setReceiveFor] = useState<Transfer | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const from = sites.find((s) => s.id === fromId)
  // Only outlets of the sending outlet's company can receive.
  const toChoices = sites.filter((s) => s.id !== fromId && (!from || s.tenantId === from.tenantId))
  const item = items.find((i) => i.id === itemId)
  const itemChoices = items.filter((i) => !from || !i.tenantId || i.tenantId === from.tenantId)
  const fromHas = fromId && itemId ? onHand.get(`${fromId}:${itemId}`) ?? 0 : null
  const toHas = toId && itemId ? onHand.get(`${toId}:${itemId}`) ?? 0 : null

  const problem = !fromId ? 'Pick the outlet the stock leaves.'
    : !toId ? 'Pick the outlet it goes to.'
    : !itemId ? 'Pick the item.'
    : !(qty && qty > 0) ? 'Enter how much to move.'
    : null

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['stock-transfers'] })
    void qc.invalidateQueries({ queryKey: ['inventory'] })
  }

  const create = useMutation({
    mutationFn: () => api.post('/stock-transfers', {
      inventoryItemId: itemId, fromLocationId: fromId, toLocationId: toId,
      quantity: qty, unit: item?.unit ?? '', reason: reason.trim() || undefined,
    }),
    onSuccess: () => { setQty(null); setReason(''); setTried(false); refresh() },
  })
  const act = useMutation({
    mutationFn: (a: { id: string; verb: 'approve' | 'ship' | 'cancel' }) => api.patch(`/stock-transfers/${a.id}/${a.verb}`, {}),
    onMutate: () => setActionError(null),
    onSuccess: refresh,
    onError: (e) => setActionError(errText(e)),
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6" style={{ borderBottom: '1px solid var(--border)' }}>
        <Link href="/inventory" className="inline-flex min-h-11 items-center gap-1.5 text-xs text-s-muted hover:text-s-text"><ArrowLeft size={14} aria-hidden="true" />Inventory</Link>
        <h1 className="text-2xl font-black text-s-text mt-2">Stock transfers</h1>
        <p className="text-sm text-s-muted mt-1 max-w-2xl">
          Move stock between two outlets of one company. It leaves the sending outlet when it is shipped (oldest stock first, at what it cost)
          and lands at the receiving outlet when it is received. A short receipt needs a reason.
        </p>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-5">
        <SectionCard heading="Request a transfer">
          <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); setTried(true); if (!problem && !create.isPending) create.mutate() }}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="From outlet" error={tried && !fromId ? 'Pick the outlet the stock leaves.' : null}>
                <Select value={fromId} onChange={(e) => { setFromId(e.target.value); setToId(''); setItemId('') }}>
                  <option value="">— from —</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="To outlet" error={tried && !toId ? 'Pick the outlet it goes to.' : null}
                hint={from ? 'Only outlets of the same company are listed.' : undefined}>
                <Select value={toId} onChange={(e) => setToId(e.target.value)} disabled={!fromId}>
                  <option value="">— to —</option>
                  {toChoices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-3">
              <Field label="Item" error={tried && !itemId ? 'Pick the item.' : null}>
                <Select value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={!fromId}>
                  <option value="">— item —</option>
                  {itemChoices.map((i) => {
                    const here = fromId ? onHand.get(`${fromId}:${i.id}`) ?? 0 : 0
                    return <option key={i.id} value={i.id}>{i.name} ({qtyText(here)} {i.unit} at the sending outlet)</option>
                  })}
                </Select>
              </Field>
              <Field label={`Quantity${item ? ` (${item.unit})` : ''}`} error={tried && !(qty && qty > 0) ? 'Enter how much to move.' : null}>
                <NumberField decimals={3} min={0} value={qty} onValueChange={setQty} placeholder="0" />
              </Field>
            </div>
            {item && fromId && (
              <p className="text-xs text-s-muted font-mono" role="status">
                On hand — {from?.name}: <strong className="text-s-text">{qtyText(fromHas ?? 0)} {item.unit}</strong>
                {toId && <> · {sites.find((s) => s.id === toId)?.name}: <strong className="text-s-text">{qtyText(toHas ?? 0)} {item.unit}</strong></>}
                {qty != null && fromHas != null && qty > fromHas + 1e-9 && (
                  <span className="ml-2 font-bold" style={{ color: 'var(--erp-warning)' }}>More than the sending outlet holds — shipping will be refused.</span>
                )}
              </p>
            )}
            <Field label="Reason (optional)"><Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. weekend event, restock" /></Field>
            {create.error && <ErrorBanner message={errText(create.error)} />}
            <div className="flex items-center justify-end gap-3">
              {tried && problem && <p role="alert" className="text-xs font-bold" style={{ color: 'var(--erp-warning)' }}>{problem}</p>}
              <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Requesting…' : 'Request transfer'}</Button>
            </div>
          </form>
        </SectionCard>

        <SectionCard heading="Transfers">
          {actionError && <ErrorBanner message={actionError} />}
          {transfers.length === 0 ? (
            <p className="text-xs text-s-muted italic">No transfers yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-s-border/50 text-s-muted">
                    <th className="text-left py-1.5">Item</th>
                    <th className="text-left py-1.5">From → to</th>
                    <th className="text-right py-1.5">Sent</th>
                    <th className="text-right py-1.5">Received</th>
                    <th className="text-left py-1.5 pl-3">Status</th>
                    <th className="py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.id} className="border-b border-s-border/30 last:border-0 align-top">
                      <td className="py-1.5 text-s-text font-semibold">{t.inventoryItem?.name ?? '—'}</td>
                      <td className="py-1.5 text-s-text">{t.fromLocation?.name ?? '—'} → {t.toLocation?.name ?? '—'}</td>
                      <td className="py-1.5 text-right font-mono">{qtyText(t.quantity)} {t.unit}</td>
                      <td className="py-1.5 text-right font-mono">{t.receivedQuantity != null ? `${qtyText(t.receivedQuantity)} ${t.unit}` : '—'}</td>
                      <td className="py-1.5 pl-3"><span className={STATUS_BADGE[t.status]}>{STATUS_LABEL[t.status]}</span></td>
                      <td className="py-1.5 text-right whitespace-nowrap space-x-3">
                        {t.status === 'requested' && <LinkButton disabled={act.isPending} onClick={() => act.mutate({ id: t.id, verb: 'approve' })}>Approve</LinkButton>}
                        {t.status === 'approved' && <LinkButton disabled={act.isPending} onClick={() => act.mutate({ id: t.id, verb: 'ship' })}>Ship</LinkButton>}
                        {t.status === 'shipped' && <LinkButton onClick={() => setReceiveFor(t)}>Receive</LinkButton>}
                        {(t.status === 'requested' || t.status === 'approved' || t.status === 'shipped') && (
                          <LinkButton tone="danger" disabled={act.isPending} onClick={() => act.mutate({ id: t.id, verb: 'cancel' })}>Cancel</LinkButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>

      {receiveFor && <ReceiveDialog transfer={receiveFor} onClose={() => setReceiveFor(null)} onDone={() => { setReceiveFor(null); refresh() }} />}
    </div>
  )
}

function ReceiveDialog({ transfer, onClose, onDone }: { transfer: Transfer; onClose: () => void; onDone: () => void }) {
  const [received, setReceived] = useState<number | null>(transfer.quantity)
  const [why, setWhy] = useState('')
  const [tried, setTried] = useState(false)
  const got = received ?? 0
  const short = Math.max(0, transfer.quantity - got)
  const over = got > transfer.quantity + 1e-9
  const needReason = short > 1e-9 && why.trim().length < 3
  const submit = useMutation({
    mutationFn: () => api.patch(`/stock-transfers/${transfer.id}/receive`, {
      receivedQuantity: got, ...(short > 1e-9 ? { shortfallReason: why.trim() } : {}),
    }),
    onSuccess: onDone,
  })
  return (
    <Dialog title={`Receive ${transfer.inventoryItem?.name ?? 'transfer'}`} onClose={onClose} dirty={received !== transfer.quantity || why !== ''}>
      <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); setTried(true); if (!over && !needReason && received != null && !submit.isPending) submit.mutate() }}>
        <p className="text-xs text-s-muted">
          {transfer.fromLocation?.name} sent <strong className="text-s-text">{qtyText(transfer.quantity)} {transfer.unit}</strong> to {transfer.toLocation?.name}. Enter what actually arrived.
        </p>
        <Field label={`Received (${transfer.unit})`} error={over ? 'More cannot arrive than was sent.' : null}>
          <NumberField decimals={3} min={0} value={received} onValueChange={setReceived} />
        </Field>
        {short > 1e-9 && (
          <Field label={`Why is it short by ${qtyText(short)} ${transfer.unit}?`} error={tried && needReason ? 'Say why it came up short (at least 3 characters).' : null}
            hint="The missing stock is booked as waste at the receiving outlet, for the CEO to review.">
            <Input value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} placeholder="e.g. spilled in transit" />
          </Field>
        )}
        {submit.error && <ErrorBanner message={errText(submit.error)} />}
        <DialogFooter onCancel={onClose}>
          <Button type="submit" disabled={submit.isPending}>{submit.isPending ? 'Saving…' : 'Confirm receipt'}</Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
