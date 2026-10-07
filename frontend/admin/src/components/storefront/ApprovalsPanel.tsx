'use client'
// Storefront approvals (decision 41): every page / pop-up change is a draft
// until the CEO (role `admin`) approves it. This lists what is waiting and
// what is approved-but-scheduled, links each to its builder, and gives the
// CEO Approve (now or at a time) / Send back (with a note) inline. Everyone
// else sees the queue read-only.
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { usePermissions } from '../../hooks/useCan'
import { STOREFRONT_URL } from '../../lib/content'


export interface SiteLayoutListRow {
  id: string
  slug: string
  kind: 'page' | 'hero' | 'footer' | 'popup'
  title: string | null
  tenantId: string | null
  draftStatus: 'none' | 'draft' | 'pending' | 'scheduled'
  liveVersion: number
  publishedAt: string | null
  publishAt: string | null
  submittedAt: string | null
  submittedBy: { id: string; name: string } | null
  reviewNote: string | null
  updatedAt: string
  draftUpdatedAt: string | null
}

/** Shared with the sidebar badge so both read one cache entry. */
export const PENDING_LAYOUTS_KEY = ['site-layouts', 'list', 'pending'] as const

export function builderHref(slug: string): string {
  if (slug.startsWith('popup:')) return `/storefront/popups/${encodeURIComponent(slug.slice('popup:'.length))}`
  return `/storefront/pages/${encodeURIComponent(slug)}`
}

function describeSlug(slug: string): string {
  if (slug === 'servd:home') return 'servd home page'
  if (slug === 'servd:hero') return 'Landing hero'
  const footer = slug.match(/^brand:(.+):footer$/)
  if (footer) return `${footer[1]} footer`
  if (slug.startsWith('brand:')) return `${slug.slice(6)} brand page`
  if (slug.startsWith('page:')) return `Page /pages/${slug.slice(5)}`
  if (slug.startsWith('popup:')) return `Pop-up ${slug.slice(6)}`
  return slug
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function ApprovalsPanel() {
  const { data: me } = usePermissions()
  const isCeo = me?.role === 'admin'

  const pending = useQuery<SiteLayoutListRow[]>({
    queryKey: PENDING_LAYOUTS_KEY,
    queryFn: () => api.get('/site-layouts?status=pending'),
    refetchInterval: 60_000,
  })
  const scheduled = useQuery<SiteLayoutListRow[]>({
    queryKey: ['site-layouts', 'list', 'scheduled'],
    queryFn: () => api.get('/site-layouts?status=scheduled'),
    refetchInterval: 60_000,
  })

  const pendingRows = [...(pending.data ?? [])].sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''))
  const scheduledRows = [...(scheduled.data ?? [])].sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''))

  return (
    <div className="space-y-8">
      {!isCeo && (
        <p className="rounded-xl border border-s-border bg-s-surface px-4 py-3 text-xs text-s-muted">
          Only the CEO can approve storefront changes. Submitted drafts wait here until they are approved or sent back.
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-s-muted">
          Waiting for approval{pendingRows.length > 0 ? ` (${pendingRows.length})` : ''}
        </h2>
        {pending.isLoading && <p className="text-sm text-s-muted">Loading…</p>}
        {pending.isError && <p className="text-sm text-s-red">Could not load the approval queue.</p>}
        {!pending.isLoading && !pending.isError && pendingRows.length === 0 && (
          <p className="rounded-xl border border-dashed border-s-border px-4 py-8 text-center text-sm text-s-muted">
            Nothing is waiting for approval.
          </p>
        )}
        {pendingRows.map((row) => <ApprovalRow key={row.id} row={row} isCeo={isCeo} />)}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-widest text-s-muted">
          Approved, scheduled to publish{scheduledRows.length > 0 ? ` (${scheduledRows.length})` : ''}
        </h2>
        {!scheduled.isLoading && !scheduled.isError && scheduledRows.length === 0 && (
          <p className="text-sm text-s-muted">No scheduled publishes.</p>
        )}
        {scheduled.isError && <p className="text-sm text-s-red">Could not load scheduled publishes.</p>}
        {scheduledRows.map((row) => <ApprovalRow key={row.id} row={row} isCeo={isCeo} />)}
      </section>
    </div>
  )
}

function ApprovalRow({ row, isCeo }: { row: SiteLayoutListRow; isCeo: boolean }) {
  const qc = useQueryClient()
  const [panel, setPanel] = useState<'none' | 'approve' | 'reject'>('none')
  const [when, setWhen] = useState<'now' | 'later'>('now')
  const [publishAt, setPublishAt] = useState('')
  const [note, setNote] = useState('')
  const [previewError, setPreviewError] = useState('')
  const path = `/site-layouts/${encodeURIComponent(row.slug)}`
  const isScheduled = row.draftStatus === 'scheduled'

  const done = () => {
    setPanel('none'); setNote(''); setPublishAt('')
    void qc.invalidateQueries({ queryKey: ['site-layouts'] })
  }
  const approve = useMutation({
    mutationFn: (body: { publishAt?: string }) => api.post(`${path}/approve`, body),
    onSuccess: done,
  })
  const reject = useMutation({
    mutationFn: () => api.post(`${path}/reject`, { note: note.trim() }),
    onSuccess: done,
  })

  const laterIso = publishAt ? new Date(publishAt) : null
  const laterValid = !!laterIso && !Number.isNaN(laterIso.getTime()) && laterIso.getTime() > Date.now()

  async function openPreview() {
    setPreviewError('')
    // Open synchronously so the popup blocker allows it, then point it at the draft.
    const w = window.open('', '_blank')
    try {
      const { token } = await api.post<{ token: string }>(`${path}/preview-token`, {})
      if (w) w.location.href = `${STOREFRONT_URL}/preview/${token}`
    } catch (e) {
      w?.close()
      setPreviewError((e as Error).message || 'Preview failed')
    }
  }

  const error = (approve.error ?? reject.error) as Error | null

  return (
    <div className="rounded-xl border border-s-border bg-s-surface">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-semibold text-s-text">{row.title || describeSlug(row.slug)}</p>
            <span className="rounded-full border border-s-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-s-muted">{row.kind}</span>
            {row.liveVersion === 0 && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary-ink">first publish</span>}
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-s-muted">{row.slug}</p>
          <p className="mt-1 text-xs text-s-muted">
            Submitted by {row.submittedBy?.name ?? 'unknown'} · {fmtWhen(row.submittedAt)}
            {row.liveVersion > 0 ? ` · live v${row.liveVersion}` : ''}
            {isScheduled ? ` · publishes ${fmtWhen(row.publishAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void openPreview()}
            className="rounded-lg border border-s-border px-3 py-1.5 text-xs text-s-muted hover:text-s-text">
            Preview
          </button>
          <Link href={builderHref(row.slug)}
            className="rounded-lg border border-s-border px-3 py-1.5 text-xs text-s-muted hover:text-s-text">
            Open in builder
          </Link>
          {isCeo && (
            <>
              <button onClick={() => setPanel(panel === 'approve' ? 'none' : 'approve')}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on hover:opacity-90">
                {isScheduled ? 'Publish now' : 'Approve'}
              </button>
              <button onClick={() => setPanel(panel === 'reject' ? 'none' : 'reject')}
                className="rounded-lg border border-s-red/50 px-3 py-1.5 text-xs font-semibold text-s-red hover:bg-s-red/10">
                Send back
              </button>
            </>
          )}
        </div>
      </div>

      {previewError && <p className="px-4 pb-3 text-xs text-s-red">{previewError}</p>}

      {isCeo && panel === 'approve' && (
        <div className="flex flex-wrap items-center gap-3 border-t border-s-border px-4 py-3">
          {isScheduled ? (
            <span className="text-xs text-s-muted">Publish this now instead of at {fmtWhen(row.publishAt)}?</span>
          ) : (
            <>
              <label className="flex items-center gap-1.5 text-xs text-s-text">
                <input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} className="accent-primary" />
                Publish now
              </label>
              <label className="flex items-center gap-1.5 text-xs text-s-text">
                <input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} className="accent-primary" />
                Publish at
              </label>
              {when === 'later' && (
                <input type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)}
                  className="rounded-lg border border-s-border bg-s-bg px-2 py-1 text-xs text-s-text focus:border-primary focus:outline-none" />
              )}
            </>
          )}
          <button
            onClick={() => approve.mutate(!isScheduled && when === 'later' && laterIso ? { publishAt: laterIso.toISOString() } : {})}
            disabled={approve.isPending || (!isScheduled && when === 'later' && !laterValid)}
            className="ml-auto rounded-lg bg-primary px-4 py-1.5 text-xs font-bold text-primary-on hover:opacity-90 disabled:opacity-40">
            {approve.isPending ? 'Approving…' : !isScheduled && when === 'later' ? 'Approve and schedule' : 'Approve and publish'}
          </button>
        </div>
      )}

      {isCeo && panel === 'reject' && (
        <div className="space-y-2 border-t border-s-border px-4 py-3">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} autoFocus
            placeholder="What needs to change? The author sees this note on their draft."
            className="w-full resize-y rounded-lg border border-s-border bg-s-bg px-3 py-2 text-xs text-s-text focus:border-primary focus:outline-none" />
          <div className="flex justify-end">
            <button onClick={() => reject.mutate()} disabled={reject.isPending || !note.trim()}
              className="rounded-lg border border-s-red/50 px-4 py-1.5 text-xs font-bold text-s-red hover:bg-s-red/10 disabled:opacity-40">
              {reject.isPending ? 'Sending…' : 'Send back to draft'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="px-4 pb-3 text-xs text-s-red">{error.message || 'Action failed'}</p>}
    </div>
  )
}
