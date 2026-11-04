'use client'
// My tasks (owner, 2026-11-04): every marketing board card and content-calendar entry you are on. Tick "Done" when
// you finish; it leaves your list only once leadership ticks "Approved by leadership". Leadership (the CEO, the
// marketing lead, or whoever set a calendar task) also sees what is waiting for them. Personal: /me is open to every
// login; GET /my-tasks returns only the caller's own tasks (and, for leadership, those waiting on them).
import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { ErrorBanner } from '@/components/finance/ui'

interface Person { id: string; name: string | null }
interface Task {
  id: string; kind: 'card' | 'calendar'; title: string; brief: string | null; deadline: string
  board: { id: string; name: string } | null; brand: { id: string; name: string } | null
  stageLabel: string | null; myRole: 'owner' | 'assignee' | 'resource'
  owner: Person | null; resources: Person[]; createdBy: Person | null
  status: 'open' | 'awaiting_approval' | 'done'
  doneAt: string | null; doneBy: Person | null; approvedAt: string | null; approvedBy: Person | null
  overdue: boolean; link: string
}
interface TaskList { open: Task[]; awaitingApproval: Task[]; done: Task[]; toApprove: Task[]; canApprove: boolean }

const day = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', timeZone: 'Asia/Karachi' })
const whereOf = (t: Task) => (t.board ? `${t.board.name} board${t.stageLabel ? ` · ${t.stageLabel}` : ''}` : `Content calendar${t.brand ? ` · ${t.brand.name}` : ''}`)

export default function MyTasksPage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<TaskList>({ queryKey: ['my-tasks'], queryFn: () => api.get('/my-tasks') })
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setErr(null)
    try { await fn(); await qc.invalidateQueries({ queryKey: ['my-tasks'] }) }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong') }
    finally { setBusy(null) }
  }
  const markDone = (t: Task, done: boolean) => run(`done:${t.id}`, () => api.post(`/my-tasks/${t.id}/done`, { done }))
  const approve = (t: Task, approved: boolean) => run(`ok:${t.id}`, () => api.post(`/my-tasks/${t.id}/approve`, { approved }))

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
      <p className="text-xs font-bold uppercase tracking-wider text-success">Me</p>
      <h1 className="mt-1 text-2xl font-black text-white">My tasks</h1>
      <p className="mt-1 text-sm text-white/50">Board cards and calendar entries you are on. Tick Done when you finish — a task leaves your list once leadership approves it.</p>

      {err && <div className="mt-4"><ErrorBanner message={err} /></div>}
      {isLoading && <p className="mt-6 text-sm text-white/40">Loading…</p>}
      {error && <div className="mt-4"><ErrorBanner message="Could not load your tasks." /></div>}

      {data && (
        <div className="mt-5 space-y-6">
          {data.canApprove && (
            <Section title="Waiting for your approval" count={data.toApprove.length} empty="Nothing is waiting for you.">
              {data.toApprove.map((t) => (
                <Row key={t.id} t={t}>
                  <p className="text-xs text-white/50">Done by {t.doneBy?.name ?? 'someone'}{t.doneAt ? ` · ${day(t.doneAt)}` : ''}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" disabled={!!busy} onClick={() => void approve(t, true)} className="s-btn-primary px-3 py-1.5 text-xs">
                      {busy === `ok:${t.id}` ? 'Approving…' : 'Approve'}
                    </button>
                    <button type="button" disabled={!!busy} onClick={() => void markDone(t, false)} className="s-btn-secondary px-3 py-1.5 text-xs">Send back</button>
                  </div>
                </Row>
              ))}
            </Section>
          )}

          <Section title="To do" count={data.open.length} empty="Nothing on your list.">
            {data.open.map((t) => (
              <Row key={t.id} t={t}>
                <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" className="h-4 w-4" checked={false} disabled={!!busy} onChange={() => void markDone(t, true)} />
                  {busy === `done:${t.id}` ? 'Saving…' : 'Done'}
                </label>
              </Row>
            ))}
          </Section>

          <Section title="Waiting for leadership" count={data.awaitingApproval.length} empty="Nothing waiting.">
            {data.awaitingApproval.map((t) => (
              <Row key={t.id} t={t}>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
                  <label className="inline-flex cursor-pointer items-center gap-2 font-semibold">
                    <input type="checkbox" className="h-4 w-4" checked disabled={!!busy} onChange={() => void markDone(t, false)} />
                    Done
                  </label>
                  <label className="inline-flex items-center gap-2 text-white/50">
                    <input type="checkbox" className="h-4 w-4" checked={false} disabled readOnly />
                    Approved by leadership
                  </label>
                </div>
              </Row>
            ))}
          </Section>

          <div>
            <button type="button" onClick={() => setShowDone((v) => !v)} className="text-sm font-semibold text-primary-ink hover:underline">
              {showDone ? 'Hide' : 'Show'} completed in the last 30 days ({data.done.length})
            </button>
            {showDone && (
              <div className="mt-3 space-y-2">
                {data.done.length === 0 && <p className="text-sm text-white/40">None yet.</p>}
                {data.done.map((t) => (
                  <Row key={t.id} t={t} muted>
                    <p className="text-xs text-success">Approved{t.approvedBy?.name ? ` by ${t.approvedBy.name}` : ''}{t.approvedAt ? ` · ${day(t.approvedAt)}` : ''}</p>
                  </Row>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="text-sm font-bold text-white">{title} <span className="text-white/40">({count})</span></h2>
      <div className="mt-2 space-y-2">
        {count === 0 ? <p className="rounded-xl px-3 py-3 text-sm text-white/40" style={{ border: '1px dashed rgb(var(--fg-rgb) / 0.12)' }}>{empty}</p> : children}
      </div>
    </section>
  )
}

function Row({ t, muted, children }: { t: Task; muted?: boolean; children?: React.ReactNode }) {
  const people = [t.owner, ...t.resources].filter((p): p is Person => !!p).map((p) => p.name).filter(Boolean)
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)', opacity: muted ? 0.75 : 1 }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link href={t.link} className="break-words font-semibold text-white hover:underline">{t.title}</Link>
          <p className="text-xs text-white/50">{whereOf(t)}{people.length ? ` · ${Array.from(new Set(people)).join(', ')}` : ''}</p>
        </div>
        <span className={`shrink-0 text-xs font-semibold ${t.overdue ? 'text-s-red' : 'text-white/60'}`}>{t.overdue ? 'Overdue · ' : 'Due '}{day(t.deadline)}</span>
      </div>
      {children}
    </div>
  )
}
