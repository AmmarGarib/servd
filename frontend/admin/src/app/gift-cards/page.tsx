'use client'

// Gift cards (Finance). The register a page at a time, the 2080 books check,
// selling a card (back office: managers + finance; a promotional card is a
// manager's call, with a reason), and the managers-only void that says what
// happens to the money. Every rule is the server's (backend
// modules/giftCards/books.ts); this page only hides buttons that would 403.

import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { api } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { useAuthStore } from '../../store/auth'
import { useManagerRoles } from '../../lib/roles'
import { useActiveCompany } from '../../lib/connectorsApi'
import { BankAccountSelect } from '../../components/finance/BankAccountSelect'

type Status = 'active' | 'redeemed_full' | 'expired' | 'voided'
type Method = 'cash' | 'card' | 'bank_transfer'
type Disposition = 'refund' | 'payment_not_received' | 'forfeit'

interface GiftCard {
  id: string; tenantId: string | null; code: string
  kind: 'sold' | 'promotional'
  issuedAmountCents: number; balanceCents: number
  status: Status
  paymentMethod: Method | null
  buyerEmail: string | null; recipientName: string | null
  expiresAt: string | null; expiredAt: string | null; createdAt: string
  voidedAt: string | null; voidDisposition: Disposition | null
}
interface Page { items: GiftCard[]; nextCursor: string | null; total: number }

interface CardHistory {
  card: Pick<GiftCard, 'id' | 'tenantId' | 'code' | 'kind' | 'issuedAmountCents' | 'balanceCents' | 'status' | 'createdAt' | 'expiresAt' | 'expiredAt' | 'voidedAt' | 'voidDisposition' | 'paymentMethod'> & { voidReason: string | null }
  redemptions: Array<{ id: string; amountCents: number; balanceAfter: number; redeemedAt: string; reversedAt: string | null; order: { id: string; placedAt: string; status: string } | null }>
}

interface BooksCheck {
  tenantId: string; companyName: string
  ledgerCents: number; cardBalancesCents: number; expectedCents: number; differenceCents: number; unexplainedCents: number
  awaitingSale: { count: number; cents: number }
  spentWithoutOrder: { count: number; cents: number }
  issueNotBooked: { count: number; cents: number; items: Array<{ id: string; code: string; issuedAmountCents: number; createdAt: string; status: Status }> }
  voidedHoldingValue: { count: number; cents: number; items: Array<{ id: string; code: string; kind?: 'sold' | 'promotional'; balanceCents: number; voidedAt: string | null }> }
}

const STATUS_BADGE: Record<Status, string> = {
  active:        's-badge-green',
  redeemed_full: 's-badge-muted',
  expired:       's-badge-amber',
  voided:        's-badge-red',
}
const STATUS_LABEL: Record<Status, string> = { active: 'Active', redeemed_full: 'Spent', expired: 'Expired', voided: 'Voided' }
const METHOD_LABEL: Record<Method, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer' }
const DISPOSITION_LABEL: Record<Disposition, string> = {
  refund: 'Refunded', payment_not_received: 'Payment never received', forfeit: 'Unused value forfeited',
}
const PAGE_SIZE = 100
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const errText = (e: unknown) => (e as { message?: string } | null)?.message ?? 'Something went wrong'
/** A voided card can be settled again only when a refund put value back on it. */
const canVoid = (c: { status: Status; balanceCents: number }) => c.status !== 'voided' || c.balanceCents > 0

export default function GiftCardsPage() {
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  const managers = useManagerRoles()
  const financeTeam = useManagerRoles('finance')
  const isManager = managers.has(role)
  const canSell = financeTeam.has(role)
  // The books' audit trail is the CEO's and management's (accounting_audit);
  // everyone else reads a card's history in the row below instead.
  const canReadBooksTrail = useAuthStore((s) => s.isRole('admin', 'management'))

  const [status, setStatus] = useState<Status | ''>('')
  const [showNew, setShowNew] = useState(false)
  const [issuedCode, setIssuedCode] = useState<string | null>(null)
  const [voiding, setVoiding] = useState<VoidTarget | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [redeemCode, setRedeemCode] = useState('')
  const [redeemAmt, setRedeemAmt] = useState('')
  const [redeemOrder, setRedeemOrder] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const list = useInfiniteQuery({
    queryKey: ['gift-cards', 'list', status],
    queryFn: ({ pageParam }) => api.get<Page>(`/gift-cards?limit=${PAGE_SIZE}${status ? `&status=${status}` : ''}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const cards = list.data?.pages.flatMap((p) => p.items) ?? []
  const total = list.data?.pages[0]?.total ?? 0
  const refresh = () => void qc.invalidateQueries({ queryKey: ['gift-cards'] })

  // A card is always spent against an order (the one redeem engine lowers
  // that order's bill by what the card paid; a till sale the card fully
  // covers is closed). Cards of another company are not found (decision 14).
  const redeem = useMutation({
    mutationFn: () => api.post<{ appliedCents: number; remainingDueCents: number; completed: boolean }>('/gift-cards/redeem', {
      code: redeemCode,
      orderId: redeemOrder.trim(),
      ...(redeemAmt ? { amountCents: Math.round(Number(redeemAmt) * 100) } : {}),
    }),
    onSuccess: (r) => {
      setFeedback({ ok: true, msg: `Applied ${fmtPkr(r.appliedCents)}. ${r.completed ? 'Bill settled.' : `Still due: ${fmtPkr(r.remainingDueCents)}.`}` })
      refresh()
      setRedeemCode(''); setRedeemAmt(''); setRedeemOrder('')
    },
    onError: (e) => setFeedback({ ok: false, msg: errText(e) }),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-success">Finance</p>
          <h1 className="text-xl font-bold text-s-text">Gift cards</h1>
        </div>
        {canSell && <button onClick={() => { setIssuedCode(null); setShowNew(true) }} className="s-btn-primary text-xs">+ Issue card</button>}
      </header>

      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
        {issuedCode && (
          <div className="s-card p-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-s-text">Card issued: <span className="font-mono font-bold">{issuedCode}</span> — give this code to the customer.</p>
            <button onClick={() => setIssuedCode(null)} className="s-btn-ghost text-xs">Dismiss</button>
          </div>
        )}

        <BooksCheckPanel
          canBook={canSell}
          canSettle={isManager}
          onSettle={(t) => setVoiding(t)}
          onChanged={refresh}
        />

        {/* Quick redeem */}
        <div className="s-card p-4">
          <h2 className="text-sm font-bold mb-1">Apply a card to an order</h2>
          <p className="text-xs text-s-muted mb-3">At the till, use the gift-card tender on the bill. Here: the order it pays for, and optionally how much (blank = as much as the card and the bill allow).</p>
          <div className="flex gap-2 flex-wrap items-end">
            <label className="flex-1 min-w-[200px]">
              <span className="block text-xs text-s-muted mb-1">Order ID</span>
              <input value={redeemOrder} onChange={(e) => setRedeemOrder(e.target.value)} placeholder="order id" className="s-input font-mono" />
            </label>
            <label className="flex-1 min-w-[160px]">
              <span className="block text-xs text-s-muted mb-1">Card code</span>
              <input value={redeemCode} onChange={(e) => setRedeemCode(e.target.value)} placeholder="GS-XXXX-XXXX" className="s-input font-mono uppercase" />
            </label>
            <label className="w-32">
              <span className="block text-xs text-s-muted mb-1">Amount (PKR)</span>
              <input type="number" min={1} inputMode="decimal" value={redeemAmt} onChange={(e) => setRedeemAmt(e.target.value)} className="s-input" />
            </label>
            <button onClick={() => redeem.mutate()} disabled={!redeemCode.trim() || !redeemOrder.trim() || redeem.isPending} className="s-btn-primary text-sm">
              {redeem.isPending ? 'Applying…' : 'Apply'}
            </button>
          </div>
          {feedback && <p className={`text-xs mt-2 ${feedback.ok ? 'text-success' : 'text-s-red'}`}>{feedback.msg}</p>}
        </div>

        {/* Register */}
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-s-text">
              Cards{list.data ? ` · showing ${cards.length} of ${total}` : ''}
            </span>
            <label className="flex items-center gap-2 text-xs text-s-muted">
              Status
              <select value={status} onChange={(e) => { setStatus(e.target.value as Status | ''); setOpenId(null) }} className="s-select py-1 text-xs w-auto">
                <option value="">All</option>
                {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-s-muted">
                <tr>
                  <th className="px-4 py-2 text-left">Code</th>
                  <th className="px-4 py-2 text-left">Recipient</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="px-4 py-2 text-right">Issued</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Issued on</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading && <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-s-muted">Loading…</td></tr>}
                {list.isError && <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-s-red">{errText(list.error)}</td></tr>}
                {!list.isLoading && !list.isError && cards.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-s-muted">{status ? 'No cards with this status.' : 'No gift cards issued yet.'}</td></tr>
                )}
                {cards.map((c) => (
                  <Fragment key={c.id}>
                    <tr className={`border-t border-s-border cursor-pointer ${openId === c.id ? 'bg-s-bg-soft' : 'hover:bg-s-bg-soft'}`}
                      onClick={() => setOpenId(openId === c.id ? null : c.id)} aria-expanded={openId === c.id}>
                      <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">
                        {c.code}
                        {c.kind === 'promotional' && <span className="ml-2 s-badge-purple text-[10px]">Promo</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-s-text">
                        {c.recipientName ?? '—'}
                        {c.buyerEmail && <p className="text-[11px] text-s-dim">via {c.buyerEmail}</p>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs">{fmtPkr(c.balanceCents)}</td>
                      <td className="px-4 py-2 text-right text-xs text-s-muted">{fmtPkr(c.issuedAmountCents)}</td>
                      <td className="px-4 py-2"><span className={`${STATUS_BADGE[c.status]} text-[10px]`}>{STATUS_LABEL[c.status]}</span></td>
                      <td className="px-4 py-2 text-xs text-s-muted whitespace-nowrap">{fmtDate(c.createdAt)}</td>
                    </tr>
                    {openId === c.id && (
                      <tr className="border-t border-s-border/50">
                        <td colSpan={6} className="p-0">
                          <CardHistoryPanel id={c.id} canVoid={isManager} onVoid={(t) => setVoiding(t)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {list.hasNextPage && (
            <div className="px-4 py-3 border-t border-s-border text-center">
              <button onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage} className="s-btn-secondary text-xs">
                {list.isFetchingNextPage ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - cards.length)} more`}
              </button>
            </div>
          )}
        </div>

        <p className="text-xs text-s-muted">
          Click a card for what was spent from it, what refunds put back and how it was paid.
          {canReadBooksTrail && <> Who issued or voided it is in the <Link href="/accounting/audit-log?action=giftcard" className="text-primary-ink hover:underline">audit log</Link>.</>}
        </p>
      </div>

      {showNew && (
        <NewGiftCardModal
          canGivePromo={isManager}
          onClose={() => setShowNew(false)}
          onCreated={(code) => { setIssuedCode(code); setShowNew(false); refresh() }}
        />
      )}
      {voiding && (
        <VoidModal
          target={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => { setVoiding(null); refresh(); void qc.invalidateQueries({ queryKey: ['gift-card-history'] }) }}
        />
      )}
    </div>
  )
}

// ── The 2080 books check ─────────────────────────────────────────────────────
// What the ledger says the company owes card holders (2080) against what the
// cards say. Value spent on an order whose sale is not booked yet (an open
// order, a till bill before its drawer closes) is still owed in 2080, so it
// is added to the cards' side.
function BooksCheckPanel({ canBook, canSettle, onSettle, onChanged }: {
  canBook: boolean
  canSettle: boolean
  onSettle: (t: VoidTarget) => void
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ['gift-cards', 'reconcile'],
    queryFn: () => api.get<{ companies: BooksCheck[] }>('/gift-cards/reconcile'),
  })
  const companies = q.data?.companies ?? []
  const off = companies.filter((c) => c.differenceCents !== 0 || c.voidedHoldingValue.count > 0)

  return (
    <div className="s-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold">Books check — Gift Card Liability (2080)</h2>
          <p className="text-xs text-s-muted">
            {q.isLoading ? 'Checking…'
              : q.isError ? errText(q.error)
              : companies.length === 0 ? 'No company in view.'
              : off.length === 0 ? 'The books and the cards agree.'
              : `${off.length === 1 ? 'One company needs' : `${off.length} companies need`} a look.`}
          </p>
        </div>
        {companies.length > 0 && (
          <button onClick={() => setOpen(!open)} className="s-btn-secondary text-xs" aria-expanded={open}>{open ? 'Hide' : 'Show'} detail</button>
        )}
      </div>
      {open && companies.map((c) => (
        <CompanyCheck key={c.tenantId} c={c} showName={companies.length > 1} canBook={canBook} canSettle={canSettle} onSettle={onSettle} onChanged={onChanged} />
      ))}
    </div>
  )
}

function CompanyCheck({ c, showName, canBook, canSettle, onSettle, onChanged }: {
  c: BooksCheck; showName: boolean; canBook: boolean; canSettle: boolean
  onSettle: (t: VoidTarget) => void; onChanged: () => void
}) {
  const [booking, setBooking] = useState<string | null>(null)
  const agrees = c.differenceCents === 0
  return (
    <div className="mt-3 border-t border-s-border pt-3 space-y-2 text-xs">
      {showName && <p className="font-bold text-s-text">{c.companyName}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        <Row label="2080 in the books" value={fmtPkr(c.ledgerCents)} />
        <Row label="Card balances" value={fmtPkr(c.cardBalancesCents)} />
        {c.awaitingSale.count > 0 && <Row label={`Spent on ${c.awaitingSale.count} order(s) not booked yet`} value={fmtPkr(c.awaitingSale.cents)} />}
        {c.spentWithoutOrder.count > 0 && <Row label={`Spent with no order (${c.spentWithoutOrder.count}, old redeem)`} value={fmtPkr(c.spentWithoutOrder.cents)} />}
        <Row label="2080 should hold" value={fmtPkr(c.expectedCents)} />
        <Row label="Difference" value={<span className={agrees ? 'text-success font-bold' : 'text-s-red font-bold'}>{agrees ? 'None' : fmtPkr(c.differenceCents)}</span>} />
      </div>
      {!agrees && (
        <p className="text-s-muted">
          {c.issueNotBooked.count > 0 && <>Cards whose sale never reached the books explain {fmtPkr(-c.issueNotBooked.cents)}. </>}
          {c.unexplainedCents !== 0
            ? <span className="text-s-red">{fmtPkr(c.unexplainedCents)} is not explained by the cards — check Reconciliation → Exceptions for a refused posting, or ask finance to look at 2080 in the general ledger.</span>
            : 'Nothing else is off.'}
        </p>
      )}

      {c.issueNotBooked.count > 0 && (
        <div>
          <p className="font-bold text-s-text mt-2">Sale not in the books ({c.issueNotBooked.count})</p>
          <p className="text-s-muted mb-1">Sold before the sale and its entry were one step. Book each one the way it was paid.</p>
          {c.issueNotBooked.items.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 border-t border-s-border/50">
              <span className="font-mono">{i.code}</span>
              <span>{fmtPkr(i.issuedAmountCents)}</span>
              <span className="text-s-muted">{fmtDate(i.createdAt)}</span>
              {canBook && booking !== i.id && <button onClick={() => setBooking(i.id)} className="s-btn-ghost text-xs">Book the sale</button>}
              {booking === i.id && (
                <BookIssueForm cardId={i.id} tenantId={c.tenantId} onCancel={() => setBooking(null)} onDone={() => { setBooking(null); onChanged() }} />
              )}
            </div>
          ))}
        </div>
      )}

      {c.voidedHoldingValue.count > 0 && (
        <div>
          <p className="font-bold text-s-text mt-2">Voided cards holding money ({c.voidedHoldingValue.count} · {fmtPkr(c.voidedHoldingValue.cents)})</p>
          <p className="text-s-muted mb-1">A refund put value back on a card that had been voided (or it was voided before voids moved the money). Nobody can spend it — a manager pays it out.</p>
          {c.voidedHoldingValue.items.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 border-t border-s-border/50">
              <span className="font-mono">{i.code}</span>
              <span>{fmtPkr(i.balanceCents)}</span>
              {canSettle && (
                <button onClick={() => onSettle({ id: i.id, tenantId: c.tenantId, code: i.code, kind: i.kind ?? 'sold', balanceCents: i.balanceCents, settling: true })} className="s-btn-ghost text-xs">
                  Settle
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-s-muted">{label}</span>
      <span className="font-mono text-s-text">{value}</span>
    </div>
  )
}

function BookIssueForm({ cardId, tenantId, onCancel, onDone }: { cardId: string; tenantId: string; onCancel: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<Method>('cash')
  const [bankAccountId, setBankAccountId] = useState('')
  const book = useMutation({
    mutationFn: () => api.post(`/gift-cards/${cardId}/book-issue`, {
      paymentMethod: method,
      ...(method === 'bank_transfer' && bankAccountId ? { bankAccountId } : {}),
    }, { tenantId }),
    onSuccess: onDone,
  })
  return (
    <div className="w-full flex flex-wrap items-end gap-2 py-1">
      <label className="block">
        <span className="block text-[11px] text-s-muted mb-1">Paid by</span>
        <select value={method} onChange={(e) => setMethod(e.target.value as Method)} className="s-select py-1 text-xs w-auto">
          {(Object.keys(METHOD_LABEL) as Method[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </select>
      </label>
      {method === 'bank_transfer' && (
        <div className="min-w-[180px]">
          <BankAccountSelect id={`bank-${cardId}`} tenantId={tenantId} value={bankAccountId} onChange={setBankAccountId} className="s-select py-1 text-xs" />
        </div>
      )}
      <button onClick={() => book.mutate()} disabled={book.isPending} className="s-btn-primary text-xs">{book.isPending ? 'Booking…' : 'Book'}</button>
      <button onClick={onCancel} className="s-btn-ghost text-xs">Cancel</button>
      {book.isError && <p className="w-full text-s-red">{errText(book.error)}</p>}
    </div>
  )
}

// ── One card ─────────────────────────────────────────────────────────────────
// GET /gift-cards/:id/redemptions (the card's company only). A reversed line
// is a redemption a refund put back on the card.
function CardHistoryPanel({ id, canVoid: mayVoid, onVoid }: { id: string; canVoid: boolean; onVoid: (t: VoidTarget) => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['gift-card-history', id],
    queryFn: () => api.get<CardHistory>(`/gift-cards/${id}/redemptions`),
  })
  if (isLoading) return <p className="px-4 py-3 text-xs text-s-muted">Loading history…</p>
  if (error || !data) return <p className="px-4 py-3 text-xs text-s-red">{errText(error) || 'Could not load this card'}</p>
  const c = data.card
  return (
    <div className="px-4 py-3 bg-s-bg-soft/40 text-xs space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-s-muted">
          {c.kind === 'promotional' ? 'Promotional (given away)' : `Sold${c.paymentMethod ? ` · paid by ${METHOD_LABEL[c.paymentMethod].toLowerCase()}` : ''}`}
          {' · '}issued {fmtPkr(c.issuedAmountCents)} on {fmtDate(c.createdAt)} · balance {fmtPkr(c.balanceCents)}
          {c.expiresAt && <> · {c.expiredAt ? `expired ${fmtDate(c.expiredAt)}` : `expires ${fmtDate(c.expiresAt)}`}</>}
          {c.voidedAt && <> · voided {fmtDate(c.voidedAt)}{c.voidDisposition ? ` (${DISPOSITION_LABEL[c.voidDisposition].toLowerCase()})` : ''}{c.voidReason ? ` — ${c.voidReason}` : ''}</>}
        </p>
        {mayVoid && canVoid(c) && c.tenantId && (
          <button
            onClick={() => onVoid({ id: c.id, tenantId: c.tenantId!, code: c.code, kind: c.kind, balanceCents: c.balanceCents, settling: c.status === 'voided' })}
            className="s-btn-danger text-xs"
          >
            {c.status === 'voided' ? 'Settle' : 'Void card'}
          </button>
        )}
      </div>
      {c.status === 'voided' && c.balanceCents > 0 && (
        <p className="text-s-red">A refund put {fmtPkr(c.balanceCents)} back on this voided card. Nobody can spend it — settle it to pay the customer.</p>
      )}
      {data.redemptions.length === 0 && <p className="text-s-muted">Not spent yet.</p>}
      {data.redemptions.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-x-3">
          <span className="font-mono">-{fmtPkr(r.amountCents)}</span>
          <span className="text-s-muted">{new Date(r.redeemedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          {r.order && <Link href={`/orders/${r.order.id}`} className="text-primary-ink hover:underline">order</Link>}
          <span className="text-s-muted">balance after {fmtPkr(r.balanceAfter)}</span>
          {r.reversedAt && <span className="text-s-muted">· put back by a refund {new Date(r.reversedAt).toLocaleDateString('en-GB')}</span>}
        </div>
      ))}
    </div>
  )
}

// ── Void ─────────────────────────────────────────────────────────────────────

interface VoidTarget {
  id: string; tenantId: string; code: string
  kind: 'sold' | 'promotional'
  balanceCents: number
  /** A voided card holding value a refund put back. */
  settling: boolean
}

function VoidModal({ target, onClose, onDone }: { target: VoidTarget; onClose: () => void; onDone: () => void }) {
  const promo = target.kind === 'promotional'
  const [disposition, setDisposition] = useState<Disposition>(promo ? 'forfeit' : 'refund')
  const [refundMethod, setRefundMethod] = useState<Method>('cash')
  const [bankAccountId, setBankAccountId] = useState('')
  const [reason, setReason] = useState('')

  const submit = useMutation({
    mutationFn: () => api.post(`/gift-cards/${target.id}/void`, {
      reason: reason.trim(),
      disposition,
      ...(disposition === 'refund' ? { refundMethod, ...(refundMethod === 'bank_transfer' && bankAccountId ? { bankAccountId } : {}) } : {}),
    }, { tenantId: target.tenantId }),
    onSuccess: onDone,
  })

  const options: Array<{ value: Disposition; label: string; hint: string; disabled?: boolean }> = promo
    ? [{ value: 'forfeit', label: 'Forfeit the unused value', hint: 'It goes back to Marketing & Promo — the card was given away.' }]
    : [
        { value: 'refund', label: 'Refund the customer', hint: 'Pay the balance back in cash, by card or by bank transfer.' },
        { value: 'payment_not_received', label: 'Payment never received', hint: 'Take the balance back off the account the sale was booked to (a bounced transfer, a reversed card payment).' },
        { value: 'forfeit', label: 'Keep the money', hint: 'Not available yet — waiting for the owner and the accountant to decide how unused card money is booked and taxed.', disabled: true },
      ]

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="void-title" className="fixed inset-0 z-50 bg-secondary/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-s-surface rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex justify-between gap-3">
          <div>
            <h2 id="void-title" className="text-lg font-bold">{target.settling ? 'Settle voided card' : 'Void gift card'}</h2>
            <p className="text-xs text-s-muted font-mono">{target.code} · {fmtPkr(target.balanceCents)} on the card</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-2xl leading-none text-s-muted">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <fieldset className="space-y-2">
            <legend className="text-xs text-s-muted mb-1">What happens to the {fmtPkr(target.balanceCents)}</legend>
            {options.map((o) => (
              <label key={o.value} className={`flex gap-2 items-start ${o.disabled ? 'opacity-50' : 'cursor-pointer'}`}>
                <input type="radio" name="disposition" value={o.value} checked={disposition === o.value} disabled={o.disabled}
                  onChange={() => setDisposition(o.value)} className="mt-1" />
                <span><span className="block text-sm text-s-text">{o.label}</span><span className="block text-xs text-s-muted">{o.hint}</span></span>
              </label>
            ))}
          </fieldset>
          {disposition === 'refund' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block">
                <span className="block text-xs text-s-muted mb-1">Paid back by</span>
                <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as Method)} className="s-select">
                  <option value="cash">Cash (from the safe)</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                </select>
              </label>
              {refundMethod === 'bank_transfer' && (
                <BankAccountSelect id="void-bank" tenantId={target.tenantId} value={bankAccountId} onChange={setBankAccountId} className="s-select" />
              )}
            </div>
          )}
          <label className="block">
            <span className="block text-xs text-s-muted mb-1">Reason</span>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="s-input" placeholder="e.g. customer asked for the balance back" />
          </label>
          {submit.isError && <p className="text-xs text-s-red">{errText(submit.error)}</p>}
        </div>
        <div className="px-5 py-3 border-t border-s-border flex justify-end gap-2">
          <button onClick={onClose} className="s-btn-secondary text-sm">Cancel</button>
          <button onClick={() => submit.mutate()} disabled={submit.isPending || reason.trim().length < 3} className="s-btn-danger text-sm">
            {submit.isPending ? 'Working…' : target.settling ? 'Settle' : 'Void card'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Issue ────────────────────────────────────────────────────────────────────

function NewGiftCardModal({ canGivePromo, onClose, onCreated }: { canGivePromo: boolean; onClose: () => void; onCreated: (code: string) => void }) {
  const company = useActiveCompany()
  const [kind, setKind] = useState<'sold' | 'promotional'>('sold')
  const [amount, setAmount] = useState('2000')
  const [recipient, setRecipient] = useState('')
  const [recEmail, setRecEmail] = useState('')
  const [buyerEmail, setBuyerEmail] = useState('')
  const [message, setMessage] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<Method>('cash')
  const [bankAccountId, setBankAccountId] = useState('')
  const [reason, setReason] = useState('')

  const rupees = Number(amount)
  const amountCents = Number.isFinite(rupees) ? Math.round(rupees * 100) : 0
  const amountOk = amountCents >= 10_000 && amountCents <= 10_000_000
  const promo = kind === 'promotional'

  const create = useMutation({
    mutationFn: () => api.post<{ code: string }>('/gift-cards', {
      kind,
      issuedAmountCents: amountCents,
      recipientName: recipient.trim() || null,
      recipientEmail: recEmail.trim() || null,
      buyerEmail: buyerEmail.trim() || null,
      message: message.trim() || null,
      // The end of the chosen day in Karachi.
      expiresAt: expiresOn ? new Date(`${expiresOn}T23:59:59.999+05:00`).toISOString() : null,
      ...(promo
        ? { reason: reason.trim() }
        : { paymentMethod, ...(paymentMethod === 'bank_transfer' && bankAccountId ? { bankAccountId } : {}) }),
    }, company ? { tenantId: company.id } : undefined),
    onSuccess: (c) => onCreated(c.code),
  })

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="issue-title" className="fixed inset-0 z-50 bg-secondary/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-s-surface rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex justify-between gap-3">
          <div>
            <h2 id="issue-title" className="text-lg font-bold">Issue gift card</h2>
            {company && <p className="text-xs text-s-muted">For {company.name}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-2xl leading-none text-s-muted">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          {canGivePromo && (
            <div className="flex gap-2" role="radiogroup" aria-label="Card type">
              {(['sold', 'promotional'] as const).map((k) => (
                <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                  className={kind === k ? 's-btn-primary text-xs' : 's-btn-secondary text-xs'}>
                  {k === 'sold' ? 'Sold' : 'Promotional (free)'}
                </button>
              ))}
            </div>
          )}
          <label className="block">
            <span className="block text-xs text-s-muted mb-1">Amount (PKR 100 – 100,000)</span>
            <input type="number" min={100} max={100000} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="s-input" />
          </label>
          <label className="block">
            <span className="block text-xs text-s-muted mb-1">Recipient name</span>
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} className="s-input" />
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-xs text-s-muted mb-1">Recipient email</span>
              <input type="email" value={recEmail} onChange={(e) => setRecEmail(e.target.value)} className="s-input" />
            </label>
            <label className="block">
              <span className="block text-xs text-s-muted mb-1">Buyer email</span>
              <input type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} className="s-input" />
            </label>
          </div>
          <label className="block">
            <span className="block text-xs text-s-muted mb-1">Message (optional)</span>
            <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} className="s-input" />
          </label>
          <label className="block">
            <span className="block text-xs text-s-muted mb-1">Expires on (optional)</span>
            <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className="s-input" />
          </label>
          {promo ? (
            <label className="block">
              <span className="block text-xs text-s-muted mb-1">Why is it being given?</span>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="s-input" placeholder="e.g. influencer visit, service recovery" />
              <span className="block text-[11px] text-s-muted mt-1">Booked to Marketing &amp; Promo. No money is taken.</span>
            </label>
          ) : (
            <div className="space-y-2">
              <label className="block">
                <span className="block text-xs text-s-muted mb-1">Paid by</span>
                <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as Method)} className="s-select">
                  <option value="cash">Cash (into the safe)</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                </select>
              </label>
              {paymentMethod === 'cash' && (
                <p className="text-[11px] text-s-muted">Back-office cash only: the money goes to the safe, not a till drawer. Cards are not sold at the till.</p>
              )}
              {paymentMethod === 'bank_transfer' && (
                <BankAccountSelect id="issue-bank" tenantId={company?.id} value={bankAccountId} onChange={setBankAccountId} className="s-select" />
              )}
            </div>
          )}
          {create.isError && <p className="text-xs text-s-red">{errText(create.error)}</p>}
        </div>
        <div className="px-5 py-3 border-t border-s-border flex justify-end gap-2">
          <button onClick={onClose} className="s-btn-secondary text-sm">Cancel</button>
          <button onClick={() => create.mutate()} disabled={create.isPending || !amountOk || (promo && reason.trim().length < 3)} className="s-btn-primary text-sm">
            {create.isPending ? 'Issuing…' : `Issue · ${amountOk ? fmtPkr(amountCents) : 'PKR —'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
