'use client'
// One card: brief, links, files (by name), comments, people, the linked dish / promo / campaign, and — for the
// marketing lead and the CEO — the stage buttons. An intern edits the title, brief and links of their own cards,
// comments and uploads; the API refuses them anything else.
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError, deleteWithUndo } from '@/lib/api'
import { Button, ErrorBanner, Field, Input, LinkButton, SidePanel, Textarea } from '@/components/finance/ui'
import { CardStaffFields, linesToLinks, staffPayload, type StaffFields } from './CardFields'
import { OUTCOME_LABEL, STAGES, STAGE_LABEL, STAGE_TONE, TYPE_LABEL, fmtDay, pktYmd, type BoardMe, type CardDetail, type Stage } from './data'

export function CardPanel({ id, me, onClose, onChanged }: { id: string; me: BoardMe; onClose: () => void; onChanged: () => void }) {
  const { data: card, refetch, error } = useQuery<CardDetail>({ queryKey: ['mkb', 'card', id], queryFn: () => api.get(`/marketing-board/cards/${id}`), retry: false })
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [links, setLinks] = useState('')
  const [staff, setStaff] = useState<StaffFields | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!card) return
    setTitle(card.title); setBrief(card.brief ?? ''); setLinks(card.referenceLinks.join('\n'))
    setStaff({
      type: card.type, deadline: pktYmd(card.deadline), priority: card.priority, ownerId: card.owner?.id ?? '',
      resourceIds: card.resources.map((r) => r.id),
      linkKind: card.menuItem ? 'menu_item' : card.promoCode ? 'promo' : card.campaign ? 'campaign' : '',
      linkId: card.menuItem?.id ?? card.promoCode?.id ?? card.campaign?.id ?? '',
    })
  }, [card])

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setErr(null)
    try { await fn(); await refetch(); onChanged() } catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong') } finally { setBusy(null) }
  }

  const save = () => run('save', () => api.patch(`/marketing-board/cards/${id}`, {
    title: title.trim(), brief: brief.trim() || null, referenceLinks: linesToLinks(links),
    ...(!me.intern && staff ? staffPayload(staff) : {}),
  }))
  const moveTo = (stage: Stage) => run(`stage:${stage}`, () => api.post(`/marketing-board/cards/${id}/stage`, { stage }))
  const addComment = () => run('comment', async () => { await api.post(`/marketing-board/cards/${id}/comments`, { body: comment.trim() }); setComment('') })
  const upload = (file: File) => run('upload', async () => {
    const q = new URLSearchParams({ filename: file.name, contentType: file.type || 'application/octet-stream' })
    const { uploadUrl } = await api.get<{ uploadUrl: string }>(`/marketing-board/cards/${id}/upload-url?${q}`)
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } }).catch(() => null)
    if (!put || !put.ok) throw new ApiError(0, 'UPLOAD_FAILED', `${file.name}: file storage did not accept the upload — ask IT to check the storage settings.`)
  })
  const unlink = (linkId: string) => run(`unlink:${linkId}`, () => api.delete(`/marketing-board/cards/${id}/files/${linkId}`))
  const remove = () => {
    if (!card || !window.confirm('Move this card to the Trash?')) return
    void run('delete', async () => {
      if (me.canUndoDelete) await deleteWithUndo(`/marketing-board/cards/${id}`, { trashType: 'content_event', id, label: card.title, onRestored: onChanged })
      else await api.delete(`/marketing-board/cards/${id}`)
      onClose()
    })
  }

  if (error) {
    return <SidePanel title="Card" onClose={onClose}><ErrorBanner message="This card is not available to you." /></SidePanel>
  }
  if (!card || !staff) return <SidePanel title="Card" onClose={onClose}><p className="text-sm text-s-muted">Loading…</p></SidePanel>

  return (
    <SidePanel title={card.title} subtitle={`${card.board?.name ?? ''} · ${TYPE_LABEL[card.type]}`} onClose={onClose} wide>
      <div className="space-y-5">
        {err && <ErrorBanner message={err} />}

        {/* Stage + timing */}
        <section aria-label="Stage" className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${STAGE_TONE[card.stage]}`} aria-hidden="true" />
            <span className="font-bold">{STAGE_LABEL[card.stage]}</span>
            <span className="text-s-muted">· due {fmtDay(card.deadline)}</span>
            <span className={`font-semibold ${card.outcome === 'late' || card.outcome === 'published_late' ? 'text-s-red' : card.outcome === 'on_time' ? 'text-success' : 'text-s-muted'}`}>· {OUTCOME_LABEL[card.outcome]}</span>
            <span className="text-s-muted">· {card.revisionCount} revision{card.revisionCount === 1 ? '' : 's'}</span>
          </div>
          {me.lead && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Move to stage">
              {STAGES.map((s) => (
                <button key={s} type="button" disabled={s === card.stage || !!busy} onClick={() => void moveTo(s)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold disabled:cursor-default ${s === card.stage ? 'border-accent bg-accent text-accent-on' : 'border-s-border hover:border-primary/50'}`}>
                  {STAGE_LABEL[s]}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Content */}
        <section aria-label="Content" className="space-y-3">
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
          <Field label="Brief"><Textarea rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={10000} /></Field>
          <Field label="Reference links" hint="One per line, starting with https://">
            <Textarea rows={3} value={links} onChange={(e) => setLinks(e.target.value)} />
          </Field>
          {card.referenceLinks.length > 0 && (
            <ul className="space-y-1 text-sm">
              {card.referenceLinks.map((l) => <li key={l} className="truncate"><a href={l} target="_blank" rel="noopener noreferrer" className="text-primary-ink underline">{l}</a></li>)}
            </ul>
          )}
          {me.intern ? (
            <div className="rounded-lg border border-s-border p-3 text-sm">
              <p><span className="text-s-muted">Owner:</span> {card.owner?.name ?? 'None'}</p>
              <p><span className="text-s-muted">Working on it:</span> {card.resources.map((r) => r.name).join(', ') || 'Nobody'}</p>
              {(card.menuItem || card.promoCode || card.campaign) && (
                <p><span className="text-s-muted">Linked to:</span> {card.menuItem?.name ?? card.promoCode?.code ?? card.campaign?.name}</p>
              )}
            </div>
          ) : (
            <CardStaffFields boardId={card.boardId} value={staff} onChange={setStaff} />
          )}
          <Button onClick={() => void save()} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
        </section>

        {/* Files */}
        <section aria-label="Files" className="space-y-2">
          <h3 className="text-sm font-bold">Files</h3>
          {card.files.length === 0 && <p className="text-xs text-s-muted">No files yet.</p>}
          <ul className="space-y-1.5">
            {card.files.map((f) => (
              <li key={f.id} className="flex items-center gap-2 rounded-lg border border-s-border px-3 py-2 text-sm">
                <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-semibold text-primary-ink hover:underline">{f.name}</a>
                <span className="shrink-0 text-xs text-s-muted">{f.kind}</span>
                {!me.intern && <LinkButton tone="danger" onClick={() => void unlink(f.id)} disabled={!!busy}>Remove</LinkButton>}
              </li>
            ))}
          </ul>
          <label className="s-btn-secondary inline-flex cursor-pointer items-center px-3 py-2 text-sm">
            {busy === 'upload' ? 'Uploading…' : 'Upload a file'}
            <input type="file" accept="image/*,video/*" className="sr-only" disabled={!!busy}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f) }} />
          </label>
          <p className="text-xs text-s-muted">Files go to the media library and stay listed on this card by name.</p>
        </section>

        {/* Comments */}
        <section aria-label="Comments" className="space-y-2">
          <h3 className="text-sm font-bold">Comments and review notes</h3>
          {card.comments.length === 0 && <p className="text-xs text-s-muted">No comments yet.</p>}
          <ol className="space-y-2">
            {card.comments.map((c) => (
              <li key={c.id} className="rounded-lg bg-s-elevated px-3 py-2">
                <p className="text-xs text-s-muted"><span className="font-semibold text-s-text">{c.author.name}</span> · {new Date(c.createdAt).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{c.body}</p>
              </li>
            ))}
          </ol>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment or review note" aria-label="New comment" maxLength={4000} />
          <Button variant="secondary" onClick={() => void addComment()} disabled={!comment.trim() || busy === 'comment'}>Post comment</Button>
        </section>

        {me.canDelete && (
          <div className="border-t border-s-border pt-4">
            <Button variant="danger" onClick={remove} disabled={!!busy}>Move to Trash</Button>
          </div>
        )}
      </div>
    </SidePanel>
  )
}
