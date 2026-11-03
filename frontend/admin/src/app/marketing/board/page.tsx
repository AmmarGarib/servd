'use client'
// Marketing → Board (owner, 2026-11-03). One board per brand (Simmer, Stackd, Flipd Burgers) plus platforms
// (beanzbakes — an Instagram account, never a brand). Six stage columns; only the CEO and the marketing lead drag
// cards between them. Interns see this same page with only their own cards (the API filters) — "My cards".
import { Suspense, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'
import { Button, ErrorBanner } from '@/components/finance/ui'
import { STAGES, STAGE_LABEL, STAGE_TONE, TYPE_LABEL, fmtDay, initials, type Board, type BoardMe, type Card, type Stage } from './data'
import { NewCardDialog } from './NewCardDialog'
import { CardPanel } from './CardPanel'

export default function MarketingBoardPage() {
  return <Suspense fallback={null}><BoardInner /></Suspense>
}

function BoardInner() {
  const qc = useQueryClient()
  const router = useRouter()
  const params = useSearchParams()
  const openCardId = params.get('card')
  const [boardId, setBoardId] = useState<string | null>(params.get('board'))
  const [creating, setCreating] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<Stage | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const { data: me } = useQuery<BoardMe>({ queryKey: ['mkb', 'me'], queryFn: () => api.get('/marketing-board/me') })
  const { data: boards = [] } = useQuery<Board[]>({ queryKey: ['mkb', 'boards'], queryFn: () => api.get('/marketing-board/boards') })
  const current = boards.find((b) => b.id === boardId) ?? (me?.intern ? null : boards[0] ?? null)
  const { data: cards = [], isLoading } = useQuery<Card[]>({
    queryKey: ['mkb', 'cards', current?.id ?? 'all'],
    queryFn: () => api.get(`/marketing-board/cards${current ? `?boardId=${current.id}` : ''}`),
    enabled: boards.length > 0 || !!me?.intern,
  })
  const byStage = useMemo(() => {
    const m = new Map<Stage, Card[]>(STAGES.map((s) => [s, []]))
    for (const c of cards) m.get(c.stage)?.push(c)
    return m
  }, [cards])

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: Stage }) => api.post<Card>(`/marketing-board/cards/${id}/stage`, { stage }),
    onSuccess: () => { setErr(null); void qc.invalidateQueries({ queryKey: ['mkb'] }) },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not move the card'),
  })

  const brands = boards.filter((b) => b.kind === 'brand')
  const platforms = boards.filter((b) => b.kind === 'platform')
  const canDrag = !!me?.lead
  const openCard = (id: string | null) => {
    const q = new URLSearchParams(params.toString())
    if (id) q.set('card', id); else q.delete('card')
    router.replace(`/marketing/board${q.toString() ? `?${q}` : ''}`)
  }
  const pickBoard = (id: string | null) => {
    setBoardId(id)
    const q = new URLSearchParams(params.toString())
    if (id) q.set('board', id); else q.delete('board')
    router.replace(`/marketing/board${q.toString() ? `?${q}` : ''}`)
  }

  function chip(b: Board | null, label: string, count: number) {
    const active = (current?.id ?? null) === (b?.id ?? null)
    return (
      <button key={b?.id ?? 'all'} type="button" onClick={() => pickBoard(b?.id ?? null)} aria-pressed={active}
        className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-semibold ${active ? 'border-accent bg-accent text-accent-on' : 'border-s-border text-s-text hover:border-primary/50'}`}>
        {label}{count > 0 && <span className="ml-1.5 text-xs opacity-75">{count}</span>}
      </button>
    )
  }

  return (
    <div className="flex min-h-full flex-col bg-s-bg text-s-text">
      <div className="border-b border-s-border bg-s-surface px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-success">Marketing</p>
            <h1 className="text-xl font-black">{me?.intern ? 'My cards' : 'Board'}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!me?.intern && <Link href="/marketing/weekly" className="s-btn-secondary px-3 py-2 text-sm">Published vs slipped</Link>}
            {!me?.intern && <Link href="/calendar" className="s-btn-secondary px-3 py-2 text-sm">Calendar</Link>}
            {me?.canCreate && current && !current.archivedAt && <Button onClick={() => setCreating(true)}>New card</Button>}
          </div>
        </div>
        {/* Board switcher: the brands, then the platforms (an account such as beanzbakes is never a brand). */}
        <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1" role="group" aria-label="Boards">
          {me?.intern && chip(null, 'All my cards', 0)}
          {brands.map((b) => chip(b, b.name, b.openCards))}
          {platforms.length > 0 && <span className="ml-2 shrink-0 text-xs font-bold uppercase tracking-wider text-s-muted">Platforms</span>}
          {platforms.map((b) => chip(b, b.name, b.openCards))}
        </div>
        {!canDrag && !me?.intern && me && <p className="mt-2 text-xs text-s-muted">Only the marketing lead and the CEO move cards between stages.</p>}
      </div>

      {err && <div className="px-4 pt-3 sm:px-6"><ErrorBanner message={err} /></div>}

      {boards.length === 0 && !me?.intern ? (
        <div className="p-6"><CompactEmptyState message="No boards yet." detail="Boards for each brand are set up automatically; the marketing lead can add a platform board." /></div>
      ) : (
        <div className="flex flex-1 gap-3 overflow-x-auto p-4 sm:p-6" aria-busy={isLoading}>
          {STAGES.map((stage) => {
            const list = byStage.get(stage) ?? []
            return (
              <section key={stage} aria-label={STAGE_LABEL[stage]}
                onDragOver={canDrag ? (e) => { e.preventDefault(); setOverStage(stage) } : undefined}
                onDragLeave={canDrag ? () => setOverStage((s) => (s === stage ? null : s)) : undefined}
                onDrop={canDrag ? (e) => {
                  e.preventDefault(); setOverStage(null)
                  const id = e.dataTransfer.getData('text/plain') || dragId
                  const card = cards.find((c) => c.id === id)
                  if (card && card.stage !== stage) move.mutate({ id: card.id, stage })
                  setDragId(null)
                } : undefined}
                className={`flex w-[78vw] max-w-[300px] shrink-0 flex-col rounded-xl border bg-s-surface sm:w-[270px] ${overStage === stage ? 'border-accent ring-2 ring-accent/40' : 'border-s-border'}`}>
                <header className="flex items-center gap-2 border-b border-s-border px-3 py-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${STAGE_TONE[stage]}`} aria-hidden="true" />
                  <h2 className="text-sm font-bold">{STAGE_LABEL[stage]}</h2>
                  <span className="ml-auto text-xs text-s-muted">{list.length}</span>
                </header>
                <div className="flex flex-1 flex-col gap-2 p-2">
                  {list.length === 0 && <p className="px-1 py-3 text-center text-xs text-s-muted">No cards</p>}
                  {list.map((c) => (
                    <article key={c.id} draggable={canDrag}
                      onDragStart={canDrag ? (e) => { e.dataTransfer.setData('text/plain', c.id); setDragId(c.id) } : undefined}
                      onClick={() => openCard(c.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(c.id) } }}
                      tabIndex={0} role="button" aria-label={`Open ${c.title}`}
                      className={`cursor-pointer rounded-lg border border-s-border bg-s-bg p-2.5 text-left hover:border-primary/50 ${canDrag ? 'active:cursor-grabbing' : ''} ${dragId === c.id ? 'opacity-50' : ''}`}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary-ink">{TYPE_LABEL[c.type]}</span>
                        {(c.priority === 'high' || c.priority === 'urgent') && (
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${c.priority === 'urgent' ? 'bg-s-red/15 text-s-red' : 'bg-s-amber/15 text-s-amber'}`}>{c.priority === 'urgent' ? 'Urgent' : 'High'}</span>
                        )}
                        {!current && c.board && <span className="truncate text-[11px] text-s-muted">{c.board.name}</span>}
                      </div>
                      <p className="mt-1.5 break-words text-sm font-semibold leading-snug">{c.title}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className={`text-xs font-semibold ${c.outcome === 'late' || c.outcome === 'published_late' ? 'text-s-red' : c.outcome === 'on_time' ? 'text-success' : 'text-s-muted'}`}>
                          {c.outcome === 'late' ? 'Late · ' : ''}{fmtDay(c.deadline)}
                        </span>
                        {c.revisionCount > 0 && <span className="text-[11px] text-s-muted">{c.revisionCount} rev.</span>}
                        <span className="ml-auto flex -space-x-1.5">
                          {c.resources.slice(0, 4).map((p) => (
                            <span key={p.id} title={p.name ?? ''} className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-s-bg bg-primary text-[10px] font-bold text-primary-on">{initials(p.name)}</span>
                          ))}
                          {c.resources.length > 4 && <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-s-bg bg-s-elevated text-[10px] font-bold text-s-text">+{c.resources.length - 4}</span>}
                        </span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {creating && current && (
        <NewCardDialog board={current} lead={!!me?.lead} onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); void qc.invalidateQueries({ queryKey: ['mkb'] }); openCard(id) }} />
      )}
      {openCardId && me && (
        <CardPanel id={openCardId} me={me} onClose={() => openCard(null)} onChanged={() => void qc.invalidateQueries({ queryKey: ['mkb'] })} />
      )}
    </div>
  )
}
