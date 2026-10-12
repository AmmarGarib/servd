'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '../../lib/api'
import { fmtPkr, fmtPkrShort } from '../../lib/money'
import { useBrandFilter } from '../../store/brandFilter'
import { useAuthStore } from '../../store/auth'

interface PoolSummary {
  id: string; name: string
  periodStart: string; periodEnd: string
  totalTipsCents: number
  status: 'draft' | 'posted' | 'paid'
  _count: { members: number }
}

interface PoolMember {
  id: string; userId: string; userName: string
  hoursWorked: number; roleWeight: number; shareUnits: number
  shareCents: number
}

interface ExcludedHours {
  name: string; userId: string | null; employeeId: string | null
  hours: number; reason: 'no_branch' | 'still_on_shift' | 'no_login'
}

/** What posting would refuse on, computed when the draft is opened. */
interface PoolReview {
  excluded: ExcludedHours[]
  missing: Array<{ userId: string; name: string; hours: number }>
  /** Kiosk-only staff (no login) who worked the window at the brand: posting
   *  waits for them unless each is left out by name, with a reason. */
  kioskStaff?: ExcludedHours[]
  totalTipsNow: number
  blockers: string[]
}

interface PoolDetail extends PoolSummary {
  members: PoolMember[]
  review: PoolReview | null
}

const REASON: Record<ExcludedHours['reason'], string> = {
  no_branch: 'no known branch — set it in HR, then compute again',
  still_on_shift: 'still clocked in',
  no_login: 'kiosk staff, no login — give them a login linked to their HR record, then delete this draft and compute again',
}

/** The last full business day (06:00 to 06:00 Karachi) — a pool is computed
 *  once its window is over, so every tip and every shift is in it. */
function lastBusinessDay(): { start: string; end: string } {
  const pkt = new Date(Date.now() + 5 * 3_600_000)
  const endDay = new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate() - (pkt.getUTCHours() < 6 ? 1 : 0)))
  const startDay = new Date(endDay.getTime() - 86_400_000)
  return { start: `${startDay.toISOString().slice(0, 10)}T06:00`, end: `${endDay.toISOString().slice(0, 10)}T06:00` }
}

export default function TipPoolsPage() {
  const qc = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  // Kiosk-only staff the approver leaves out of this pool on purpose, and why.
  const [leaveOut, setLeaveOut] = useState<string[]>([])
  const [leaveOutReason, setLeaveOutReason] = useState('')

  const list = useQuery({
    queryKey: ['tip-pools'],
    queryFn: () => api.get<PoolSummary[]>('/tip-pools'),
  })

  const detail = useQuery({
    queryKey: ['tip-pool', openId],
    queryFn: () => api.get<PoolDetail>(`/tip-pools/${openId}`),
    enabled: !!openId,
  })

  const post = useMutation({
    mutationFn: (id: string) => api.post(`/tip-pools/${id}/post`, leaveOut.length
      ? { leaveOutKioskStaff: { employeeIds: leaveOut, reason: leaveOutReason.trim() } }
      : {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tip-pools'] }); void qc.invalidateQueries({ queryKey: ['tip-pool', openId] }) },
  })
  const pay = useMutation({
    mutationFn: (id: string) => api.post(`/tip-pools/${id}/pay`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tip-pools'] }); void qc.invalidateQueries({ queryKey: ['tip-pool', openId] }) },
  })
  // A draft can be thrown away and computed again (a tip is pooled once, so a
  // second pool over the same hours is refused while the draft exists).
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/tip-pools/${id}`),
    onSuccess: () => { setOpenId(null); void qc.invalidateQueries({ queryKey: ['tip-pools'] }) },
  })
  const actionError = (post.error ?? pay.error ?? remove.error) as { message?: string } | null
  // Tip pools are the 'payroll' module (Module Access): without it the API
  // refuses, so say so rather than show an empty page.
  const noAccess = list.error instanceof ApiError && list.error.status === 403
  // Posting a pool (locks the split) and marking it paid (the journal) are the
  // approvers' — the CEO and co-owners (APPROVERS on the API). HR, finance and
  // the managers draft and review; they see who signs it off instead of a
  // button that would answer 403.
  const canApprove = useAuthStore((s) => s.isRole('admin', 'owner'))

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/hr/payroll" className="text-xs text-s-muted hover:text-s-text">← Payroll</Link>
          <h1 className="text-xl font-bold text-s-text">Tip pools</h1>
          <p className="text-xs text-s-muted">Pool a brand&apos;s customer tips and split them by the company&apos;s rules — who is in the pool, the weights and the split are set in <Link href="/configuration/operations" className="underline">Configuration → Operations</Link>. Hours are the punches made at the brand&apos;s branches; a forgotten clock-out counts nothing until HR corrects it. Each tip is pooled once, so a brand&apos;s pools cannot overlap.</p>
        </div>
        {!noAccess && <button onClick={() => setShowNew(true)} className="s-btn-primary text-xs">+ New pool</button>}
      </header>

      <div className="p-6 max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-bold">All pools</div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Period</th>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-right">Total tips</th>
                <th className="px-4 py-2 text-right">Members</th>
                <th className="px-4 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.map((p) => (
                <tr key={p.id} className={`border-t border-s-border cursor-pointer ${openId === p.id ? 'bg-s-bg-soft' : 'hover:bg-s-bg-soft'}`}
                  onClick={() => { setOpenId(p.id); setLeaveOut([]); setLeaveOutReason('') }}>
                  <td className="px-4 py-2 text-xs">
                    <p>{p.periodStart.slice(0, 10)} → {p.periodEnd.slice(0, 10)}</p>
                  </td>
                  <td className="px-4 py-2 text-s-text">{p.name}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{fmtPkr(p.totalTipsCents)}</td>
                  <td className="px-4 py-2 text-right text-xs text-s-muted">{p._count.members}</td>
                  <td className="px-4 py-2"><span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full ${
                    p.status === 'paid' ? 'bg-primary text-primary-on' : p.status === 'posted' ? 'bg-s-amber text-[#fff]' : 'bg-s-elevated text-s-muted'
                  }`}>{p.status}</span></td>
                </tr>
              ))}
              {list.data && list.data.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-s-muted">No pools yet.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>

        {noAccess && (
          <div className="s-card p-6 text-sm text-s-muted lg:col-span-2">Tip pools need the Payroll module. Ask the CEO to grant it in Module Access.</div>
        )}
        <aside>
          {!openId && (
            <div className="s-card p-6 text-center text-sm text-s-muted">Select a pool to inspect.</div>
          )}
          {openId && detail.data && (
            <div className="s-card overflow-hidden sticky top-24">
              <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
                <p className="text-xs text-s-muted">{detail.data.periodStart.slice(0,10)} → {detail.data.periodEnd.slice(0,10)}</p>
                <h2 className="text-base font-bold">{detail.data.name}</h2>
                <p className="text-xs text-s-muted mt-0.5">Total: <strong>{fmtPkr(detail.data.totalTipsCents)}</strong></p>
              </div>
              <div className="divide-y divide-s-border max-h-[60vh] overflow-y-auto">
                {detail.data.members.map((m) => (
                  <div key={m.id} className="px-4 py-2 flex justify-between items-center text-sm">
                    <div>
                      <p className="font-semibold">{m.userName}</p>
                      <p className="text-[11px] text-s-muted">
                        {m.hoursWorked.toFixed(1)}h · weight {m.roleWeight} · {m.shareUnits.toFixed(2)} share units
                      </p>
                    </div>
                    <span className="font-mono text-xs">{detail.data.status === 'draft' ? '—' : fmtPkrShort(m.shareCents)}</span>
                  </div>
                ))}
                {detail.data.members.length === 0 && <p className="px-4 py-3 text-xs text-s-muted">No eligible staff in this period.</p>}
              </div>
              {detail.data.review && (detail.data.review.blockers.length > 0 || detail.data.review.excluded.length > 0) && (
                <div className="px-4 py-3 border-t border-s-border space-y-2 text-xs">
                  {detail.data.review.blockers.length > 0 && (
                    <div>
                      <p className="font-bold text-s-red">Cannot post yet</p>
                      <ul className="list-disc pl-4 text-s-muted">
                        {detail.data.review.blockers.map((b) => <li key={b}>{b}</li>)}
                      </ul>
                    </div>
                  )}
                  {detail.data.review.excluded.length > 0 && (
                    <div>
                      <p className="font-bold">Hours not in the pool</p>
                      <ul className="text-s-muted">
                        {detail.data.review.excluded.map((x) => (
                          <li key={`${x.reason}:${x.userId ?? x.employeeId}`}>{x.name} · {x.hours.toFixed(1)}h · {REASON[x.reason]}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {(detail.data.review.kioskStaff?.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      <p className="font-bold">Kiosk staff not in this pool</p>
                      <p className="text-s-muted">They worked this window at the brand but have no servd login, so the pool cannot pay them, and posting without them gives their share to everyone else. Give them a login linked to their HR record, delete this draft and compute again. Only if they are not in the tip pool, tick them and say why:</p>
                      {detail.data.review.kioskStaff!.map((k) => k.employeeId && (
                        <label key={k.employeeId} className="flex items-center gap-2">
                          <input type="checkbox" checked={leaveOut.includes(k.employeeId)}
                            onChange={(e) => setLeaveOut((cur) => e.target.checked ? [...cur, k.employeeId!] : cur.filter((x) => x !== k.employeeId))} />
                          <span>{k.name} · {k.hours.toFixed(1)}h</span>
                        </label>
                      ))}
                      {leaveOut.length > 0 && (
                        <input value={leaveOutReason} onChange={(e) => setLeaveOutReason(e.target.value)} placeholder="Why they are not in the pool (recorded in the audit log)"
                          className="w-full bg-s-surface border border-s-border rounded px-2 py-1" />
                      )}
                    </div>
                  )}
                  {detail.data.review.totalTipsNow !== detail.data.totalTipsCents && (
                    <p className="text-s-muted">Tips in the window now: <strong>{fmtPkr(detail.data.review.totalTipsNow)}</strong> — posting uses this figure.</p>
                  )}
                </div>
              )}
              <div className="px-4 py-3 border-t border-s-border flex gap-2">
                {detail.data.status === 'draft' && (
                  <>
                    {canApprove ? (
                      <button onClick={() => post.mutate(detail.data.id)} disabled={post.isPending} className="s-btn-primary text-xs flex-1">
                        {post.isPending ? 'Posting…' : 'Post & lock distribution'}
                      </button>
                    ) : (
                      <span className="text-xs text-s-muted flex-1 self-center">The CEO or an owner posts this pool.</span>
                    )}
                    <button onClick={() => { if (confirm('Delete this draft pool? You can compute it again.')) remove.mutate(detail.data.id) }} disabled={remove.isPending} className="s-btn-secondary text-xs">
                      {remove.isPending ? 'Deleting…' : 'Delete draft'}
                    </button>
                  </>
                )}
                {detail.data.status === 'posted' && (canApprove ? (
                  <button onClick={() => pay.mutate(detail.data.id)} disabled={pay.isPending} className="s-btn-primary text-xs flex-1">
                    {pay.isPending ? 'Paying…' : 'Mark paid (post JE)'}
                  </button>
                ) : (
                  <span className="text-xs text-s-muted w-full text-center">Posted — the CEO or an owner marks it paid.</span>
                ))}
                {detail.data.status === 'paid' && <span className="text-xs text-primary-ink w-full text-center">Paid out ✓</span>}
              </div>
              {actionError?.message && <p className="px-4 pb-3 text-xs text-s-red">{actionError.message}</p>}
            </div>
          )}
        </aside>
      </div>

      {showNew && <NewPoolModal onClose={() => setShowNew(false)} onCreated={() => { void qc.invalidateQueries({ queryKey: ['tip-pools'] }); setShowNew(false) }} />}
    </div>
  )
}

function NewPoolModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data: concepts = [] } = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Array<{ id: string; name: string }>>('/concepts') })
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [name, setName] = useState(`Pool · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`)
  const [start, setStart] = useState(() => lastBusinessDay().start)
  const [end,   setEnd]   = useState(() => lastBusinessDay().end)
  const [err, setErr] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => api.post('/tip-pools', {
      conceptId,
      name,
      periodStart: new Date(`${start}:00+05:00`).toISOString(),
      periodEnd:   new Date(`${end}:00+05:00`).toISOString(),
    }),
    onSuccess: onCreated,
    onError: (e: { message?: string }) => setErr(e.message ?? 'Failed'),
  })

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-secondary/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-s-surface rounded-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex justify-between">
          <h2 className="text-lg font-bold">New tip pool</h2>
          <button onClick={onClose} className="text-2xl leading-none text-s-muted">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-s-muted">Brand</span>
            <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5">
              <option value="">Choose the brand whose tips these are…</option>
              {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-s-muted">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-s-muted">Start</span>
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </label>
            <label className="block">
              <span className="text-xs text-s-muted">End</span>
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </label>
          </div>
          <p className="text-[11px] text-s-muted">Adds up this brand&apos;s tips in the window and the hours staff punched at its branches, then splits them by the company&apos;s tip-pool rules. The window must be over (every tip and shift in it), and cannot overlap another pool of the brand. Anyone whose hours cannot be counted is listed on the draft.</p>
          {err && <p className="text-xs text-s-red">{err}</p>}
        </div>
        <div className="px-5 py-3 border-t border-s-border flex justify-end gap-2">
          <button onClick={onClose} className="s-btn-secondary text-sm">Cancel</button>
          <button onClick={() => create.mutate()} disabled={create.isPending || !conceptId} className="s-btn-primary text-sm">
            {create.isPending ? 'Computing…' : 'Compute pool'}
          </button>
        </div>
      </div>
    </div>
  )
}
