'use client'
// One on-account client — details, cards, unbilled bills, statements,
// write-offs and the 1110 tie-out.
//
// API: /accounting/customer-accounts/:id (receivables/customerAccounts.ts) and
// its statements (receivables/statements.ts). UI only: every rule is the
// server's. Every action follows the row's own capability flags (canApprove,
// canReject, canReactivate, and canEdit / canSuspend / canIssueStatement /
// canRemind when sent; a missing optional flag leaves that action shown and a
// refusal is shown in words) — this page keeps no role list. Reactivating a
// suspended client is the CEO's: shown only when the server sends
// canReactivate. The limit-change notice reads the PATCH response.
//
// Cards: issue and rotate show the one-time code in OnAccountCardPrint
// ("shown once — print now"); the code lives in state only while that dialog
// is open. Revoke asks for a reason. A charge whose sale is not booked yet
// reads "not billed yet" (it cannot go on a statement until the drawer closes).

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api, ApiError } from '../../../../../lib/api'
import { fmtPkrWhole, startOfMonthPktIso } from '../../../../../lib/money'
import { orderRef } from '../../../../../lib/orderRef'
import { useAuthStore } from '../../../../../store/auth'
import { OnAccountCardPrint } from '../../../../../components/finance/OnAccountCardPrint'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

type ClientStatus = 'pending' | 'active' | 'suspended' | 'closed'
interface CardRow { id: string; label: string; hint: string | null; issuedAt: string; revokedAt: string | null; revokedReason: string | null; lastUsedAt: string | null; active: boolean }
interface Charge {
  id: string; orderId: string; orderRef: string; brand: string | null; cardHint: string | null; reference: string | null
  chargedDay: string; amountCents: number; refundedCents: number; netCents: number; booked: boolean
}
interface Bill {
  id: string; kind: string; number: string; status: string; issueDate: string; dueDate: string
  periodFrom: string | null; periodTo: string | null; totalCents: number; paidCents: number; balanceCents: number
}
interface WriteOff {
  id: string; invoiceNumber: string | null; status: string; amountCents: number; recoveredCents: number; reason: string; requestedAt: string
}
interface Client {
  id: string; tenantId: string; companyName: string | null; number: string; legalName: string; tradeName: string | null
  ntn: string | null; strn: string | null; address: string | null; contactName: string | null; contactPhone: string | null
  contactEmail: string | null; status: ClientStatus; statusReason: string | null
  creditLimitCents: number; requestedCreditLimitCents: number | null; limitRequestedByName: string | null
  termsDays: number; overdueGraceDays: number; requiresReference: boolean; notes: string | null
  brands: Array<{ id: string; name: string | null }>
  unbilledCents: number; invoicesDueCents: number; exposureCents: number; availableCents: number
  /** Money owed back to the client (a refund after its statement was paid) — blocks closing. */
  creditCents?: number
  overdue: { number: string; dueDate: string; balanceCents: number } | null
  pending: 'new_client' | 'limit_increase' | null; approveBlockedReason: string | null
  canApprove: boolean; canReject: boolean
  /** Server capability flags (CEO-only reactivate). Optional until the API sends them; reactivate is hidden without its flag. */
  canReactivate?: boolean; canEdit?: boolean; canSuspend?: boolean; canIssueStatement?: boolean; canRemind?: boolean
  lastRemindedAt: string | null; updatedAt: string
  cards: CardRow[]
  unbilled: { charges: Charge[]; bookedCents: number; notBookedCents: number }
  bills: Bill[]; writeOffs: WriteOff[]
}
interface TieOut {
  companies: Array<{
    tenantId: string; gl1110: number; openInvoicesCents: number; openStatementsCents: number; unbilledBookedCents: number
    unbilledNotBookedCents: number; tillClearingOn1110Cents: number; differenceCents: number; cutoverAt: string | null
  }>
}
interface IssuedCard { code: string; label: string }

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }
const inp = 'w-full rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-primary'
const toPaisa = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong — try again')
const STATUS_COLOR: Record<ClientStatus, string> = {
  pending: 'var(--erp-warning)', active: 'var(--erp-success)', suspended: 'var(--erp-danger)', closed: 'rgb(var(--fg-rgb) / 0.4)',
}

function L({ t, children }: { t: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-[11px] font-bold text-white/50">{t}</span>{children}</label>
}
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl p-6 max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>
        <p className="text-lg font-black text-white/90 mb-4">{title}</p>
        {children}
      </div>
    </div>
  )
}
function Err({ msg }: { msg: string | null }) {
  return msg ? <p role="alert" className="mt-3 text-sm font-bold" style={{ color: 'var(--erp-danger)' }}>{msg}</p> : null
}
function Dlg({ title, busy, disabled, label, error, onGo, onClose, children }: {
  title: string; busy: boolean; disabled?: boolean; label: string; error: string | null; onGo: () => void; onClose: () => void; children: React.ReactNode
}) {
  return (
    <Modal title={title} onClose={onClose}>
      {children}
      <Err msg={error} />
      <div className="flex gap-2 mt-5">
        <button onClick={onGo} disabled={busy || disabled} className="rounded-lg bg-primary px-4 py-2 text-sm font-black text-primary-on disabled:opacity-50">
          {busy ? 'Working…' : label}
        </button>
        <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-bold text-white/60 hover:text-white">Cancel</button>
      </div>
    </Modal>
  )
}
const Btn = ({ onClick, children, danger }: { onClick: () => void; children: React.ReactNode; danger?: boolean }) => (
  <button onClick={onClick} className="rounded-lg px-3 py-1.5 text-xs font-black border border-white/15 hover:bg-white/5"
    style={{ color: danger ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.9)' }}>{children}</button>
)
const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th className={`py-2 pr-3 text-[10px] uppercase tracking-wider font-bold text-white/40 ${right ? 'text-right' : 'text-left'}`}>{children}</th>
)
const Td = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <td className={`py-2 pr-3 text-sm text-white/85 ${right ? 'text-right' : ''}`}>{children}</td>
)

/** The printable statement, fetched with the session and opened in a new tab. */
async function openStatementHtml(invoiceId: string): Promise<void> {
  const token = useAuthStore.getState().token
  const res = await fetch(`${API_URL}/api/v1/accounting/customer-accounts/statements/${invoiceId}/html`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error('The statement could not be opened')
  const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' }))
  if (!window.open(url, '_blank')) URL.revokeObjectURL(url)
}

/** Last day of the previous Karachi month. */
function previousMonthEnd(): string {
  const [y, m] = startOfMonthPktIso().split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10)
}

type Dialog =
  | { kind: 'edit' } | { kind: 'limit' } | { kind: 'suspend' } | { kind: 'statement' } | { kind: 'reject' }
  | { kind: 'card' } | { kind: 'rotate'; card: CardRow } | { kind: 'revoke'; card: CardRow }

export default function OnAccountClientPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [issued, setIssued] = useState<IssuedCard | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const base = `/accounting/customer-accounts/${id}`
  const { data: c, isLoading, error } = useQuery<Client>({ queryKey: ['oa-client', id], queryFn: () => api.get(base) })
  const tie = useQuery<TieOut>({ queryKey: ['oa-tie-out'], queryFn: () => api.get('/accounting/customer-accounts/tie-out') })
  const tieOut = tie.data?.companies.find((t) => t.tenantId === c?.tenantId)

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['oa-client', id] }); void qc.invalidateQueries({ queryKey: ['oa-tie-out'] }); void qc.invalidateQueries({ queryKey: ['oa-clients'] }) }
  const close = () => { setDialog(null); setErr(null) }
  const done = (msg: string) => { close(); setNotice(msg); refresh() }
  const fail = (e: unknown) => setErr(errText(e))

  // Simple one-shot actions.
  const act = useMutation({
    mutationFn: (a: { path: string; body?: unknown; method?: 'post' | 'patch'; ok: string | ((row: Client) => string) }) =>
      (a.method === 'patch' ? api.patch<Client>(`${base}${a.path}`, a.body ?? {}) : api.post<Client>(`${base}${a.path}`, a.body ?? {}))
        .then((row) => (typeof a.ok === 'function' ? a.ok(row) : a.ok)),
    onSuccess: (ok) => done(ok),
    onError: fail,
  })
  const remind = useMutation({
    mutationFn: () => api.post<{ sent: boolean; skipped?: string; to: string }>(`${base}/remind`, {}),
    onSuccess: (r) => { setNotice(r.sent ? `Reminder sent to ${r.to}.` : `Nothing was sent (${r.skipped === 'practice' ? 'practice copy' : 'test company'}).`); refresh() },
    onError: (e) => setNotice(errText(e)),
  })
  const issueCard = useMutation({
    mutationFn: (a: { label: string; rotate?: CardRow }) =>
      a.rotate
        ? api.post<{ code: string; card: CardRow }>(`${base}/cards/${a.rotate.id}/rotate`, {})
        : api.post<{ code: string; card: CardRow }>(`${base}/cards`, { label: a.label }),
    onSuccess: (r) => { setDialog(null); setIssued({ code: r.code, label: r.card.label }); refresh() },
    onError: fail,
  })
  const sendStatement = useMutation({
    mutationFn: (invoiceId: string) => api.post<{ sent: boolean; skipped?: string; to: string; number: string }>(`/accounting/customer-accounts/statements/${invoiceId}/send`, {}),
    onSuccess: (r) => setNotice(r.sent ? `${r.number} sent to ${r.to}.` : `Nothing was sent (${r.skipped === 'practice' ? 'practice copy' : 'test company'}).`),
    onError: (e) => setNotice(errText(e)),
  })

  if (isLoading) return <div className="p-7 text-sm text-white/40">Loading…</div>
  if (error || !c) return <div className="p-7 text-sm font-bold" style={{ color: 'var(--erp-danger)' }}>{errText(error ?? new Error('Client not found'))}</div>

  const statements = c.bills.filter((b) => b.kind === 'statement')
  const closed = c.status === 'closed'
  const activeCards = c.cards.filter((k) => k.active)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 md:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/accounting/receivables/clients" className="text-xs text-white/40 hover:text-white/70">← On-account clients</Link>
        <div className="flex flex-wrap items-start justify-between gap-4 mt-2">
          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-success">{c.number}{c.companyName ? ` · ${c.companyName}` : ''}</p>
            <h1 className="text-2xl font-black text-white/90">{c.legalName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase"
                style={{ background: `color-mix(in srgb, ${STATUS_COLOR[c.status]} 16%, transparent)`, color: STATUS_COLOR[c.status] }}>{c.status}</span>
              {c.statusReason && <span className="text-xs text-white/50">{c.statusReason}</span>}
              {c.overdue && (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase"
                  style={{ background: 'color-mix(in srgb, var(--erp-danger) 16%, transparent)', color: 'var(--erp-danger)' }}>
                  Overdue · {c.overdue.number} · {fmtPkrWhole(c.overdue.balanceCents)}
                </span>
              )}
            </div>
          </div>
          {!closed && (
            <div className="flex flex-wrap gap-2">
              {c.canEdit !== false && <Btn onClick={() => setDialog({ kind: 'edit' })}>Edit</Btn>}
              {c.canEdit !== false && <Btn onClick={() => setDialog({ kind: 'limit' })}>Change limit</Btn>}
              {c.status === 'active' && c.canSuspend !== false && <Btn danger onClick={() => setDialog({ kind: 'suspend' })}>Suspend</Btn>}
              {c.status === 'suspended' && c.canReactivate === true && <Btn onClick={() => act.mutate({ path: '', method: 'patch', body: { status: 'active' }, ok: 'Client reactivated.' })}>Reactivate</Btn>}
              {c.canIssueStatement !== false && <Btn onClick={() => setDialog({ kind: 'statement' })}>Issue statement</Btn>}
              {c.canRemind !== false && <Btn onClick={() => remind.mutate()}>Remind</Btn>}
            </div>
          )}
        </div>
      </header>

      <div className="px-4 md:px-7 py-6 max-w-6xl mx-auto space-y-6">
        {notice && (
          <div role="status" className="flex items-start justify-between gap-3 rounded-2xl p-4 text-sm"
            style={{ background: 'color-mix(in srgb, var(--erp-success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-success) 35%, transparent)' }}>
            <span className="text-white/85">{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 text-white/50 hover:text-white">×</button>
          </div>
        )}

        {c.pending && (
          <section className="rounded-2xl p-4" style={{ ...card, borderColor: 'color-mix(in srgb, var(--erp-warning) 40%, transparent)' }}>
            <p className="text-sm font-black text-white/90">
              {c.pending === 'new_client' ? 'Waiting for the CEO to approve this client.' : `Waiting for the CEO to approve a limit of ${fmtPkrWhole(c.requestedCreditLimitCents)}${c.limitRequestedByName ? `, asked by ${c.limitRequestedByName}` : ''}.`}
            </p>
            {c.approveBlockedReason && <p className="text-xs text-white/60 mt-1">{c.approveBlockedReason}</p>}
            {(c.canApprove || c.canReject) && (
              <div className="flex gap-2 mt-3">
                {c.canApprove && (
                  <button onClick={() => act.mutate({ path: '/approve', body: { expectedUpdatedAt: c.updatedAt, ...(c.pending === 'limit_increase' && c.requestedCreditLimitCents != null ? { creditLimitCents: c.requestedCreditLimitCents } : {}) }, ok: 'Approved.' })}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-black text-primary-on">Approve</button>
                )}
                {c.canReject && <Btn danger onClick={() => setDialog({ kind: 'reject' })}>Reject</Btn>}
              </div>
            )}
          </section>
        )}

        {(c.creditCents ?? 0) > 0 && (
          <section role="status" className="rounded-2xl p-4 text-sm"
            style={{ ...card, borderColor: 'color-mix(in srgb, var(--erp-warning) 40%, transparent)' }}>
            <p className="font-black" style={{ color: 'var(--erp-warning)' }}>In credit · {fmtPkrWhole(c.creditCents ?? 0)}</p>
            <p className="text-white/60 mt-1">A refund came after this client&apos;s statement was paid, so the company owes them this amount. Refund it to the client (Receivables → the statement → Refund) before closing the client.</p>
          </section>
        )}

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {([['Limit', c.creditLimitCents], ['Exposure', c.exposureCents], ['Available', c.availableCents], ['Unbilled', c.unbilledCents], ['On statements', c.invoicesDueCents]] as const).map(([l, v]) => (
            <div key={l} className="rounded-2xl p-4" style={card}>
              <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{l}</p>
              <p className="text-lg font-black text-white/90 mt-1">{fmtPkrWhole(v)}</p>
            </div>
          ))}
        </div>

        <section className="rounded-2xl p-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 text-sm" style={card}>
          {([
            ['Trade name', c.tradeName], ['NTN', c.ntn], ['STRN', c.strn], ['Address', c.address],
            ['Contact', [c.contactName, c.contactPhone].filter(Boolean).join(' · ') || null], ['Email', c.contactEmail],
            ['Terms', `${c.termsDays} days, ${c.overdueGraceDays} days grace`],
            ['Brands', c.brands.length ? c.brands.map((b) => b.name ?? b.id).join(', ') : 'Any brand of the company'],
            ['Reference on every bill', c.requiresReference ? 'Required' : 'Optional'], ['Notes', c.notes],
          ] as const).map(([l, v]) => (
            <div key={l} className="flex justify-between gap-4"><span className="text-white/45">{l}</span><span className="text-white/85 text-right">{v || '—'}</span></div>
          ))}
        </section>

        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-base font-black text-white/90">QR cards</h2>
            {c.status !== 'pending' && !closed && <Btn onClick={() => setDialog({ kind: 'card' })}>Issue card</Btn>}
          </div>
          <div className="rounded-2xl p-4 space-y-2" style={card}>
            {c.cards.length === 0 && <p className="text-sm text-white/50">No cards yet.</p>}
            {c.cards.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center gap-3 text-sm" style={{ opacity: k.active ? 1 : 0.55 }}>
                <span className="font-bold text-white/90">{k.label}</span>
                <span className="font-mono text-white/60">…{k.hint ?? '----'}</span>
                <span className="text-xs text-white/40">
                  {k.active ? (k.lastUsedAt ? `last used ${k.lastUsedAt.slice(0, 10)}` : 'not used yet') : `revoked${k.revokedReason ? `: ${k.revokedReason}` : ''}`}
                </span>
                {k.active && !closed && (
                  <span className="ml-auto flex gap-2">
                    <Btn onClick={() => setDialog({ kind: 'rotate', card: k })}>Rotate</Btn>
                    <Btn danger onClick={() => setDialog({ kind: 'revoke', card: k })}>Revoke</Btn>
                  </span>
                )}
              </div>
            ))}
            {activeCards.length === 0 && c.cards.length > 0 && <p className="text-xs text-white/50">No active card: nothing can be charged at the till.</p>}
          </div>
        </section>

        <section>
          <h2 className="text-base font-black text-white/90 mb-2">Unbilled bills</h2>
          <p className="text-xs text-white/50 mb-2">
            Booked {fmtPkrWhole(c.unbilled.bookedCents)} — goes on the next statement. Not billed yet {fmtPkrWhole(c.unbilled.notBookedCents)} — waits for the drawer to close.
          </p>
          <div className="rounded-2xl p-4 overflow-x-auto" style={card}>
            {c.unbilled.charges.length === 0 ? <p className="text-sm text-white/50">Nothing unbilled.</p> : (
              <table className="w-full min-w-[640px]">
                <thead><tr><Th>Order</Th><Th>Date</Th><Th>Brand</Th><Th>Card</Th><Th>Reference</Th><Th right>Amount</Th><Th right>Refunded</Th><Th>{' '}</Th></tr></thead>
                <tbody>
                  {c.unbilled.charges.map((ch) => (
                    <tr key={ch.id} className="border-t border-white/[0.05]">
                      <Td><span className="font-mono">{orderRef(ch.orderId)}</span></Td>
                      <Td>{ch.chargedDay}</Td><Td>{ch.brand ?? '—'}</Td>
                      <Td>{ch.cardHint ? `…${ch.cardHint}` : '—'}</Td><Td>{ch.reference ?? '—'}</Td>
                      <Td right>{fmtPkrWhole(ch.amountCents)}</Td><Td right>{ch.refundedCents ? fmtPkrWhole(ch.refundedCents) : '—'}</Td>
                      <Td>{ch.booked ? '' : <span className="text-xs font-bold" style={{ color: 'var(--erp-warning)' }}>not billed yet</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-base font-black text-white/90 mb-2">Statements</h2>
          <div className="rounded-2xl p-4 overflow-x-auto" style={card}>
            {statements.length === 0 ? <p className="text-sm text-white/50">No statements yet.</p> : (
              <table className="w-full min-w-[640px]">
                <thead><tr><Th>Number</Th><Th>Period to</Th><Th>Due</Th><Th>Status</Th><Th right>Total</Th><Th right>Owes</Th><Th>{' '}</Th></tr></thead>
                <tbody>
                  {statements.map((s) => (
                    <tr key={s.id} className="border-t border-white/[0.05]">
                      <Td>{s.number}</Td><Td>{s.periodTo?.slice(0, 10) ?? '—'}</Td><Td>{s.dueDate.slice(0, 10)}</Td><Td>{s.status}</Td>
                      <Td right>{fmtPkrWhole(s.totalCents)}</Td><Td right>{fmtPkrWhole(s.balanceCents)}</Td>
                      <Td>
                        <span className="flex flex-wrap gap-2">
                          <Btn onClick={() => { openStatementHtml(s.id).catch((e) => setNotice(errText(e))) }}>Print</Btn>
                          <Btn onClick={() => sendStatement.mutate(s.id)}>Send</Btn>
                          <Link href="/accounting/receivables" className="rounded-lg px-3 py-1.5 text-xs font-black border border-white/15 hover:bg-white/5 text-white/90">Open in Receivables</Link>
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-base font-black text-white/90 mb-2">Write-off history</h2>
          <div className="rounded-2xl p-4 overflow-x-auto" style={card}>
            {c.writeOffs.length === 0 ? <p className="text-sm text-white/50">No write-offs.</p> : (
              <table className="w-full min-w-[560px]">
                <thead><tr><Th>Bill</Th><Th>Status</Th><Th right>Amount</Th><Th right>Recovered</Th><Th>Reason</Th></tr></thead>
                <tbody>
                  {c.writeOffs.map((w) => (
                    <tr key={w.id} className="border-t border-white/[0.05]">
                      <Td>{w.invoiceNumber ?? '—'}</Td><Td>{w.status}</Td><Td right>{fmtPkrWhole(w.amountCents)}</Td>
                      <Td right>{fmtPkrWhole(w.recoveredCents)}</Td><Td>{w.reason}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {tieOut && (
          <section>
            <h2 className="text-base font-black text-white/90 mb-2">Tie-out (customer receivables 1110, whole company)</h2>
            <div className="rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm" style={card}>
              {([
                ['On 1110', tieOut.gl1110], ['Open invoices', tieOut.openInvoicesCents], ['Open statements', tieOut.openStatementsCents],
                ['Unbilled bills (booked)', tieOut.unbilledBookedCents], ['Till clearing still on 1110', tieOut.tillClearingOn1110Cents],
                ['Unbilled, not booked yet (info)', tieOut.unbilledNotBookedCents],
              ] as const).map(([l, v]) => <div key={l} className="flex justify-between text-white/65"><span>{l}</span><span>{fmtPkrWhole(v)}</span></div>)}
              <div className="flex justify-between font-black sm:col-span-2" style={{ color: tieOut.differenceCents === 0 ? 'var(--erp-success)' : 'var(--erp-danger)' }}>
                <span>Difference</span><span>{fmtPkrWhole(tieOut.differenceCents)}</span>
              </div>
            </div>
          </section>
        )}
      </div>

      {dialog?.kind === 'edit' && <EditDialog c={c} error={err} busy={act.isPending} onClose={close}
        onSave={(body) => act.mutate({ path: '', method: 'patch', body, ok: 'Details saved.' })} />}
      {dialog?.kind === 'limit' && <LimitDialog c={c} error={err} busy={act.isPending} onClose={close}
        onSave={(cents) => act.mutate({ path: '', method: 'patch', body: { creditLimitCents: cents }, ok: (row) => (row?.requestedCreditLimitCents != null ? 'Limit increase sent to the CEO.' : 'Limit changed.') })} />}
      {dialog?.kind === 'suspend' && <ReasonDialog title="Suspend client" label="Suspend" min={3} error={err} busy={act.isPending} onClose={close}
        onGo={(reason) => act.mutate({ path: '', method: 'patch', body: { status: 'suspended', reason }, ok: 'Client suspended.' })} />}
      {dialog?.kind === 'reject' && <ReasonDialog title="Reject" label="Reject" min={3} error={err} busy={act.isPending} onClose={close}
        onGo={(note) => act.mutate({ path: '/reject', body: { note }, ok: 'Rejected.' })} />}
      {dialog?.kind === 'revoke' && <ReasonDialog title={`Revoke ${dialog.card.label}`} label="Revoke card" min={3} error={err} busy={act.isPending} onClose={close}
        onGo={(reason) => act.mutate({ path: `/cards/${(dialog as { card: CardRow }).card.id}/revoke`, body: { reason }, ok: 'Card revoked.' })} />}
      {dialog?.kind === 'statement' && <StatementDialog error={err} busy={act.isPending} onClose={close}
        onGo={(periodTo) => act.mutate({ path: '/statements', body: { periodTo }, ok: 'Statement issued.' })} />}
      {dialog?.kind === 'card' && <LabelDialog error={err} busy={issueCard.isPending} onClose={close} onGo={(label) => issueCard.mutate({ label })} />}
      {dialog?.kind === 'rotate' && (
        <Dlg title={`Rotate ${dialog.card.label}`} label="Rotate card" busy={issueCard.isPending} error={err} onClose={close}
          onGo={() => issueCard.mutate({ label: dialog.card.label, rotate: dialog.card })}>
          <p className="text-sm text-white/70">The old code stops working at once and a new one is shown once for printing.</p>
        </Dlg>
      )}

      <OnAccountCardPrint
        code={issued?.code ?? null} clientName={c.legalName} accountNumber={c.number}
        cardLabel={issued?.label ?? ''} companyName={c.companyName} onClose={() => setIssued(null)}
      />
    </div>
  )
}

// ─── Dialogs ─────────────────────────────────────────────────────────────────

function ReasonDialog({ title, label, min, error, busy, onClose, onGo }: {
  title: string; label: string; min: number; error: string | null; busy: boolean; onClose: () => void; onGo: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Dlg title={title} label={label} busy={busy} error={error} disabled={reason.trim().length < min} onClose={onClose} onGo={() => onGo(reason.trim())}>
      <L t="Why"><textarea className={inp} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></L>
    </Dlg>
  )
}

function LabelDialog({ error, busy, onClose, onGo }: { error: string | null; busy: boolean; onClose: () => void; onGo: (label: string) => void }) {
  const [label, setLabel] = useState('')
  return (
    <Dlg title="Issue a card" label="Issue card" busy={busy} error={error} disabled={!label.trim()} onClose={onClose} onGo={() => onGo(label.trim())}>
      <L t="Card label (who carries it)"><input className={inp} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Finance desk" /></L>
      <p className="text-xs text-white/50 mt-2">The code is shown once — print now.</p>
    </Dlg>
  )
}

function StatementDialog({ error, busy, onClose, onGo }: { error: string | null; busy: boolean; onClose: () => void; onGo: (periodTo: string) => void }) {
  const [periodTo, setPeriodTo] = useState(previousMonthEnd())
  return (
    <Dlg title="Issue a statement" label="Issue statement" busy={busy} error={error} disabled={!/^\d{4}-\d{2}-\d{2}$/.test(periodTo)} onClose={onClose} onGo={() => onGo(periodTo)}>
      <L t="Charges up to (inclusive)"><input type="date" className={inp} value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} /></L>
      <p className="text-xs text-white/50 mt-2">Only bills already booked go on it. A statement is not a tax invoice.</p>
    </Dlg>
  )
}

function LimitDialog({ c, error, busy, onClose, onSave }: { c: Client; error: string | null; busy: boolean; onClose: () => void; onSave: (cents: number) => void }) {
  const [v, setV] = useState(String(c.creditLimitCents / 100))
  const cents = toPaisa(v)
  return (
    <Dlg title="Change credit limit" label="Save limit" busy={busy} error={error} disabled={cents <= 0 || cents === c.creditLimitCents} onClose={onClose} onGo={() => onSave(cents)}>
      <L t="Credit limit (PKR)"><input inputMode="decimal" className={inp} value={v} onChange={(e) => setV(e.target.value)} /></L>
      <p className="text-xs text-white/50 mt-2">A lower limit applies at once. A higher one waits for the CEO.</p>
    </Dlg>
  )
}

function EditDialog({ c, error, busy, onClose, onSave }: { c: Client; error: string | null; busy: boolean; onClose: () => void; onSave: (body: Record<string, unknown>) => void }) {
  const [f, setF] = useState({
    legalName: c.legalName, tradeName: c.tradeName ?? '', ntn: c.ntn ?? '', strn: c.strn ?? '', address: c.address ?? '',
    contactName: c.contactName ?? '', contactPhone: c.contactPhone ?? '', contactEmail: c.contactEmail ?? '',
    termsDays: String(c.termsDays), overdueGraceDays: String(c.overdueGraceDays), requiresReference: c.requiresReference, notes: c.notes ?? '',
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  const text = (k: 'legalName' | 'tradeName' | 'ntn' | 'strn' | 'address' | 'contactName' | 'contactPhone' | 'contactEmail', t: string) => (
    <L t={t}><input className={inp} value={f[k]} onChange={(e) => set(k, e.target.value)} /></L>
  )
  return (
    <Dlg title="Edit client" label="Save" busy={busy} error={error} disabled={f.legalName.trim().length < 2}
      onClose={onClose}
      onGo={() => onSave({ ...f, legalName: f.legalName.trim(), termsDays: Number(f.termsDays) || 30, overdueGraceDays: Number(f.overdueGraceDays) || 0 })}>
      <div className="space-y-3">
        {text('legalName', 'Legal name')}{text('tradeName', 'Trade name')}
        <div className="grid grid-cols-2 gap-3">{text('ntn', 'NTN')}{text('strn', 'STRN')}</div>
        {text('address', 'Address')}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">{text('contactName', 'Contact name')}{text('contactPhone', 'Contact phone')}{text('contactEmail', 'Contact email')}</div>
        <div className="grid grid-cols-2 gap-3">
          <L t="Terms (days)"><input inputMode="numeric" className={inp} value={f.termsDays} onChange={(e) => set('termsDays', e.target.value)} /></L>
          <L t="Overdue grace (days)"><input inputMode="numeric" className={inp} value={f.overdueGraceDays} onChange={(e) => set('overdueGraceDays', e.target.value)} /></L>
        </div>
        <label className="flex items-center gap-2 text-sm text-white/80">
          <input type="checkbox" checked={f.requiresReference} onChange={(e) => set('requiresReference', e.target.checked)} />
          Every bill needs a reference
        </label>
        <L t="Notes"><textarea className={inp} rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></L>
      </div>
    </Dlg>
  )
}
