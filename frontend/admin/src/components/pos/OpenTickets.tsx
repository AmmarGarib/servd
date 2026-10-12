'use client'
import { useState } from 'react'
import { fmtPkrWhole } from '../../lib/money'
import { useAuthStore } from '../../store/auth'
import { paidCentsOf, preBillErrorMessage, printPreBill, type TillOrder } from './tillApi'

interface OpenTicketsProps {
  brandName: string | undefined
  tickets: TillOrder[]
  loading: boolean
  error: unknown
  onPick: (order: TillOrder) => void
  onClose: () => void
}

function minutesSince(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

// FOH-20: tables a waiter sent (and sales rung but not paid) for this brand,
// so the cashier can take ONE payment for the whole bill — no split, no
// re-ringing the ticket. The amount shown is the server's stored bill; the
// payment step re-asks the server for the tender the customer pays with.
export function OpenTickets({ brandName, tickets, loading, error, onPick, onClose }: OpenTicketsProps) {
  // "Pre-bill" prints the guest's bill for an open ticket (spec §17.1): not a
  // tax invoice, never sent to the POS, recorded for Finance → Voided pre bills.
  const [printing, setPrinting] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  function preBill(o: TillOrder) {
    setNote(null)
    setPrinting(o.id)
    printPreBill(o.id, 'cash', useAuthStore.getState().token)
      .then(() => setNote({ ok: true, text: `Pre-bill printed for ${o.table?.label ? `table ${o.table.label}` : `order ${o.id.slice(0, 8)}`}.` }))
      .catch((e: unknown) => setNote({ ok: false, text: preBillErrorMessage(e) }))
      .finally(() => setPrinting(null))
  }
  return (
    <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center"
      role="dialog" aria-modal="true" aria-label="Open tickets">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl bg-kds-card sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-kds-border px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-kds-text">Open tickets</h2>
            <p className="text-xs text-kds-subtext">{brandName ?? 'This brand'} · rung, not yet paid</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-xl text-kds-subtext">✕</button>
        </div>
        {note && (
          <p className={`border-b border-kds-border px-5 py-2 text-xs ${note.ok ? 'text-kds-subtext' : 'text-kds-red'}`} role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
        <div className="flex-1 overflow-y-auto">
          {loading && tickets.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-kds-subtext">Loading…</p>
          ) : error ? (
            <p className="px-5 py-8 text-center text-sm text-kds-red">
              {error instanceof Error ? error.message : 'Could not load open tickets'}
            </p>
          ) : tickets.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-kds-subtext">No open tickets for this brand.</p>
          ) : (
            <ul className="divide-y divide-kds-border">
              {tickets.map((o) => {
                const paid = paidCentsOf(o)
                const items = o.items.filter((i) => i.status !== 'voided').reduce((n, i) => n + i.quantity, 0)
                return (
                  <li key={o.id} className="flex items-stretch">
                    <button
                      onClick={() => onPick(o)}
                      className="flex min-w-0 flex-1 items-center gap-3 py-4 pl-5 pr-2 text-left hover:bg-kds-border/30 active:bg-kds-border/50"
                    >
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-kds-border text-sm font-black text-kds-text">
                        {o.table?.label ?? '—'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-kds-text">
                          {o.table?.label ? `Table ${o.table.label}` : `Order ${o.id.slice(0, 8)}`}
                        </p>
                        <p className="text-xs text-kds-subtext">
                          {items} item{items !== 1 ? 's' : ''} · {o.status} · {minutesSince(o.placedAt)} ago
                          {paid > 0 && ` · ${fmtPkrWhole(paid)} paid`}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-kds-green">{fmtPkrWhole(o.totalCents - paid)}</p>
                        <p className="text-[10px] uppercase tracking-wider text-kds-subtext">Take payment</p>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => preBill(o)}
                      disabled={printing !== null}
                      aria-label={`Print pre-bill for ${o.table?.label ? `table ${o.table.label}` : `order ${o.id.slice(0, 8)}`}`}
                      className="shrink-0 border-l border-kds-border px-4 text-xs font-semibold text-kds-subtext hover:bg-kds-border/30 disabled:opacity-30"
                    >
                      {printing === o.id ? 'Printing…' : 'Pre-bill'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
