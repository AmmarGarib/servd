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

/** A login holder (userId) or, with no servd login, an HR employee
 *  (employeeId) — kiosk / time-clock staff. */
interface PoolMember {
  id: string; userId: string | null; employeeId: string | null; userName: string
  hoursWorked: number; roleWeight: number; shareUnits: number
  shareCents: number; notes: string | null
  employee?: { employeeCode: string } | null
}

interface ExcludedHours {
  name: string; userId: string | null; employeeId: string | null
  hours: number; reason: 'no_branch' | 'still_on_shift' | 'no_role'
}

/** What posting would refuse on, computed when the draft is opened. */
interface PoolReview {
  excluded: ExcludedHours[]
  missing: Array<{ userId: string | null; employeeId: string | null; name: string; hours: number }>
  /** Staff with no login whose HR record names no tip-pool role and who
   *  worked the window at the brand: posting waits until each is added with
   *  a weight, or left out by name with a reason. */
  staffWithoutRole?: ExcludedHours[]
  totalTipsNow: number
  blockers: string[]
}

interface Candidate { employeeId: string; employeeCode: string; name: string; designation: string | null; hasLogin: boolean }

interface PoolDetail extends PoolSummary {
  members: PoolMember[]
  review: PoolReview | null
}

const REASON: Record<ExcludedHours['reason'], string> = {
  no_branch: 'no known branch — set it in HR, then compute again',
  still_on_shift: 'still clocked in',
  no_role: 'no login, and their HR designation does not say their tip-pool role — add them below with a weight, or leave them out',
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
  // Staff with no known role the approver leaves out of this pool on
  // purpose, and why.
  const [leaveOut, setLeaveOut] = useState<string[]>([])
  const [leaveOutReason, setLeaveOutReason] = useState('')
  // Weights typed for staff with no known role, by HR record.
  const [weights, setWeights] = useState<Record<string, string>>({})

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
      ? { leaveOutStaff: { employeeIds: leaveOut, reason: leaveOutReason.trim() } }
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
  // Add someone to the draft — staff with no known role, or anyone missed.
  const addMember = useMutation({
    mutationFn: (v: { poolId: string; employeeId: string; hoursWorked: number; roleWeight?: number }) =>
      api.post(`/tip-pools/${v.poolId}/members`, { employeeId: v.employeeId, hoursWorked: v.hoursWorked, ...(v.roleWeight != null && { roleWeight: v.roleWeight }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tip-pool', openId] })
      void qc.invalidateQueries({ queryKey: ['tip-pool-candidates', openId] })
      void qc.invalidateQueries({ queryKey: ['tip-pools'] })
    },
  })
  const actionError = (post.error ?? pay.error ?? remove.error ?? addMember.error) as { message?: string } | null
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
                  onClick={() => { setOpenId(p.id); setLeaveOut([]); setLeaveOutReason(''); setWeights({}) }}>
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
                        {m.employeeId && <>no login{m.employee?.employeeCode ? ` · ${m.employee.employeeCode}` : ''} · </>}
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
                  {(detail.data.review.staffWithoutRole?.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      <p className="font-bold">Staff with no known tip-pool role</p>
                      <p className="text-s-muted">They worked this window at the brand and have no servd login, and their HR designation does not say which role they work, so posting without them would give their share to everyone else. Add each with a weight (servers 1, cashiers 0.75, kitchen 0.5 by default). Only if they are not in the tip pool, tick them and say why:</p>
                      {detail.data.review.staffWithoutRole!.map((k) => k.employeeId && (
                        <div key={k.employeeId} className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-2 flex-1 min-w-[140px]">
                            <input type="checkbox" checked={leaveOut.includes(k.employeeId)}
                              onChange={(e) => setLeaveOut((cur) => e.target.checked ? [...cur, k.employeeId!] : cur.filter((x) => x !== k.employeeId))} />
                            <span>{k.name} · {k.hours.toFixed(1)}h</span>
                          </label>
                          <input value={weights[k.employeeId] ?? ''} onChange={(e) => setWeights((cur) => ({ ...cur, [k.employeeId!]: e.target.value }))}
                            inputMode="decimal" placeholder="weight" aria-label={`Weight for ${k.name}`}
                            className="w-16 bg-s-surface border border-s-border rounded px-2 py-1" />
                          <button type="button" className="s-btn-secondary text-xs"
                            disabled={addMember.isPending || !(Number(weights[k.employeeId]) > 0)}
                            onClick={() => addMember.mutate({ poolId: detail.data.id, employeeId: k.employeeId!, hoursWorked: k.hours, roleWeight: Number(weights[k.employeeId!]) })}>
                            Add to pool
                          </button>
                        </div>
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
              {detail.data.status === 'draft' && (
                <AddMember poolId={detail.data.id} pending={addMember.isPending}
                  onAdd={(v) => addMember.mutate({ poolId: detail.data.id, ...v })} />
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
                {detail.data.status === 'paid' && <span className="text-xs text-primary-ink w-full text-center">Paid out</span>}
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

/** Add anyone of the pool's company to a draft by hand — staff with no
 *  login included. Hours as worked; the weight defaults to their role's. */
function AddMember({ poolId, pending, onAdd }: { poolId: string; pending: boolean; onAdd: (v: { employeeId: string; hoursWorked: number; roleWeight?: number }) => void }) {
  const [open, setOpen] = useState(false)
  const [employeeId, setEmployeeId] = useState('')
  const [hours, setHours] = useState('')
  const [weight, setWeight] = useState('')
  const candidates = useQuery({
    queryKey: ['tip-pool-candidates', poolId],
    queryFn: () => api.get<Candidate[]>(`/tip-pools/${poolId}/candidates`),
    enabled: open,
  })
  if (!open) {
    return (
      <div className="px-4 py-2 border-t border-s-border">
        <button type="button" onClick={() => setOpen(true)} className="text-xs underline text-s-muted hover:text-s-text">Add someone to this pool</button>
      </div>
    )
  }
  const h = Number(hours)
  const w = weight.trim() === '' ? undefined : Number(weight)
  return (
    <div className="px-4 py-3 border-t border-s-border space-y-2 text-xs">
      <p className="font-bold">Add someone</p>
      <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label="Employee"
        className="w-full bg-s-surface border border-s-border rounded px-2 py-1">
        <option value="">Choose an employee…</option>
        {candidates.data?.map((c) => (
          <option key={c.employeeId} value={c.employeeId}>
            {c.name} · {c.employeeCode}{c.designation ? ` · ${c.designation}` : ''}{c.hasLogin ? '' : ' · no login'}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" placeholder="hours worked" aria-label="Hours worked"
          className="flex-1 bg-s-surface border border-s-border rounded px-2 py-1" />
        <input value={weight} onChange={(e) => setWeight(e.target.value)} inputMode="decimal" placeholder="weight (optional)" aria-label="Weight"
          className="flex-1 bg-s-surface border border-s-border rounded px-2 py-1" />
      </div>
      {candidates.error && <p className="text-s-red">{(candidates.error as { message?: string }).message ?? 'Could not load staff'}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => setOpen(false)} className="s-btn-secondary text-xs">Cancel</button>
        <button type="button" className="s-btn-primary text-xs"
          disabled={pending || !employeeId || !(h >= 0) || hours.trim() === '' || (w !== undefined && !(w > 0))}
          onClick={() => { onAdd({ employeeId, hoursWorked: h, ...(w !== undefined && { roleWeight: w }) }); setEmployeeId(''); setHours(''); setWeight('') }}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>
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
