'use client'
// Compensation tickets (owner, 2026-10-27: "extend Complaints"). Every void,
// comp / No Charge, refund, discount above the limit and price override at the
// till is a ticket (made by the server from what the till records — nothing is
// typed here). Managers' tickets go through; the CEO may flag one with a note
// (an exception naming the approving manager) and unflag it again.
// API: GET /complaints/compensation, POST /complaints/:id/flag | /unflag.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkrWhole } from '../../lib/money'
import { Select } from '@/components/ui/Select'
import { Modal } from '../ui/Modal'
import { CompactEmptyState } from '../ui/CompactEmptyState'

type CompType = 'void' | 'comp' | 'refund' | 'discount' | 'price_override'
interface Person { id: string; name: string; role: string | null }
interface Ticket {
  id: string
  type: CompType
  typeLabel: string
  valueCents: number
  orderId: string | null
  orderRef: string | null
  brand: { id: string; name: string }
  reason: string
  createdAt: string
  approver: Person | null
  actor: Person | null
  flagged: { at: string; by: Person | null; note: string | null } | null
}
interface TicketsResponse {
  tickets: Ticket[]
  nextCursor: string | null
  stats: { total: number; valueCents: number; flagged: number }
  canFlag: boolean
}

const TYPES: Array<{ value: CompType; label: string }> = [
  { value: 'void', label: 'Void' },
  { value: 'comp', label: 'Comp / No Charge' },
  { value: 'refund', label: 'Refund' },
  { value: 'discount', label: 'Discount above limit' },
  { value: 'price_override', label: 'Price override' },
]

const inp = 'rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'That did not work'
}

export function CompensationTickets({ conceptOptions }: { conceptOptions: Array<{ id: string; name: string }> }) {
  const qc = useQueryClient()
  const [type, setType] = useState('')
  const [flagged, setFlagged] = useState('')
  const [conceptId, setConceptId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [flagging, setFlagging] = useState<Ticket | null>(null)
  const [note, setNote] = useState('')

  const params = new URLSearchParams({
    ...(type && { type }),
    ...(flagged && { flagged }),
    ...(conceptId && { conceptId }),
    ...(dateFrom && { dateFrom }),
    ...(dateTo && { dateTo }),
    limit: '100',
  }).toString()
  const { data, isLoading, error } = useQuery({
    queryKey: ['complaints', 'compensation', params],
    queryFn: () => api.get<TicketsResponse>(`/complaints/compensation?${params}`),
  })

  const flag = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => api.post(`/complaints/${id}/flag`, { note: text }),
    onSuccess: () => { setFlagging(null); setNote(''); void qc.invalidateQueries({ queryKey: ['complaints', 'compensation'] }) },
  })
  const unflag = useMutation({
    mutationFn: (id: string) => api.post(`/complaints/${id}/unflag`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['complaints', 'compensation'] }) },
  })

  const tickets = data?.tickets ?? []
  const stats = data?.stats ?? { total: 0, valueCents: 0, flagged: 0 }
  const canFlag = !!data?.canFlag

  return (
    <div>
      <p className="text-sm text-s-muted mb-4">
        Every void, comp / No Charge, refund, discount above the limit and price override at the till is a ticket.
        A manager&apos;s ticket goes through{canFlag ? '; flag any you want looked at' : '; the CEO may flag one'}.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {[
          { label: 'Tickets', value: String(stats.total), color: 'text-s-text' },
          { label: 'Value', value: fmtPkrWhole(stats.valueCents), color: 'text-s-text' },
          { label: 'Flagged', value: String(stats.flagged), color: stats.flagged > 0 ? 'text-s-red' : 'text-s-muted' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-s-border bg-s-surface p-4 min-w-0">
            <p className="text-xs text-s-muted">{s.label}</p>
            <p className={`text-2xl font-black truncate ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <Select value={type} onChange={(e) => setType(e.target.value)} className={`${inp} w-auto`} aria-label="Type">
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
        <Select value={flagged} onChange={(e) => setFlagged(e.target.value)} className={`${inp} w-auto`} aria-label="Flagged">
          <option value="">Flagged or not</option>
          <option value="1">Flagged</option>
          <option value="0">Not flagged</option>
        </Select>
        <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={`${inp} w-auto`} aria-label="Brand">
          <option value="">All brands</option>
          {conceptOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <label className="flex items-center gap-1 text-xs text-s-muted">
          From <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={`${inp} w-auto`} />
        </label>
        <label className="flex items-center gap-1 text-xs text-s-muted">
          To <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={`${inp} w-auto`} />
        </label>
      </div>

      {error && <p role="alert" className="text-sm text-s-red mb-3">{errText(error)}</p>}

      <div className="rounded-xl border border-s-border bg-s-surface overflow-hidden">
        {isLoading ? (
          <p className="p-6 text-sm text-s-muted">Loading…</p>
        ) : tickets.length === 0 ? (
          <CompactEmptyState message="No compensation tickets for these filters." />
        ) : (
          <ul>
            {tickets.map((t) => (
              <li key={t.id} className={`px-4 py-3 border-b border-s-border last:border-0 ${t.flagged ? 'bg-s-red/5' : ''}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary-ink">{t.typeLabel}</span>
                      <span className="font-bold text-s-text">{fmtPkrWhole(t.valueCents)}</span>
                      {t.orderRef && <span className="text-xs text-s-muted font-mono">#{t.orderRef}</span>}
                      <span className="text-xs text-s-muted">{t.brand.name}</span>
                      <span className="text-xs text-s-muted">{new Date(t.createdAt).toLocaleString()}</span>
                      {t.flagged && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-s-red/15 text-s-red">Flagged</span>}
                    </div>
                    <p className="text-sm text-s-text mt-1 break-words">{t.reason}</p>
                    <p className="text-xs text-s-muted mt-1 break-words">
                      Approved by {t.approver ? t.approver.name : 'a manager PIN (not recorded)'}
                      {t.actor && t.actor.id !== t.approver?.id ? ` · done by ${t.actor.name}` : ''}
                    </p>
                    {t.flagged && (
                      <p className="text-xs text-s-red mt-1 break-words">
                        Flagged{t.flagged.by ? ` by ${t.flagged.by.name}` : ''}: {t.flagged.note}
                      </p>
                    )}
                  </div>
                  {canFlag && (
                    t.flagged ? (
                      <button onClick={() => unflag.mutate(t.id)} disabled={unflag.isPending}
                        className="rounded-lg border border-s-border text-s-muted px-3 py-2 text-xs font-semibold disabled:opacity-50 shrink-0">
                        Unflag
                      </button>
                    ) : (
                      <button onClick={() => { setFlagging(t); setNote(''); flag.reset() }}
                        className="rounded-lg bg-primary text-primary-on px-3 py-2 text-xs font-bold shrink-0">
                        Flag
                      </button>
                    )
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {unflag.error && <p role="alert" className="text-xs text-s-red mt-2">{errText(unflag.error)}</p>}

      {flagging && (
        <Modal
          title={`Flag ${flagging.typeLabel.toLowerCase()}${flagging.orderRef ? ` on #${flagging.orderRef}` : ''}`}
          onClose={() => setFlagging(null)}
          dirty={note.trim().length > 0}
          footer={(
            <div className="flex gap-2 justify-end">
              <button onClick={() => setFlagging(null)} className="rounded-lg border border-s-border text-s-muted px-4 py-2 text-sm">Cancel</button>
              <button onClick={() => flag.mutate({ id: flagging.id, text: note.trim() })} disabled={note.trim().length < 10 || flag.isPending}
                className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50">
                {flag.isPending ? 'Flagging…' : 'Flag'}
              </button>
            </div>
          )}
        >
          <p className="text-sm text-s-muted">
            {fmtPkrWhole(flagging.valueCents)} at {flagging.brand.name}, approved by {flagging.approver ? flagging.approver.name : 'a manager PIN (not recorded)'}.
            The flag goes on the exceptions list; the manager sees it on this ticket.
          </p>
          <label className="block text-xs text-s-muted">
            Note (at least 10 characters)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
              className={`${inp} w-full mt-1 resize-none`} placeholder="What should be looked at?" />
          </label>
          {flag.error && <p role="alert" className="text-xs text-s-red">{errText(flag.error)}</p>}
        </Modal>
      )}
    </div>
  )
}
