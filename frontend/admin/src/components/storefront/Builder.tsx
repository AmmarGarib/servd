'use client'

// The storefront page builder, shared by pages (/storefront/pages/[slug]) and
// pop-ups (/storefront/popups/[key]). Left: element palette. Centre: canvas
// (drag and drop). Right: element inspector, page settings, pop-up rules.
//
// Every edit is a DRAFT (PUT /site-layouts/:slug/draft). Nothing reaches the
// storefront until the CEO (role `admin`) approves it, optionally at a
// scheduled "publish at" time. A page with no draft starts from the live
// blocks, or from the page's design: its default sections from the
// storefront's section catalogue (lib/sections.ts), i.e. what it shows today.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { usePermissions } from '../../hooks/useCan'
import { BLOCK_CATALOG, canNest, type Block } from '../../lib/blocks'
import { makeBlock, sectionPaletteItems, useSectionCatalog, type PaletteItem } from '../../lib/sections'
import {
  contentApi, DEFAULT_POPUP_RULES, fmtDateTime, fromLocalInput, kindForSlug, previewUrl, seedBlocks, storefrontPath, STOREFRONT_URL,
  type ConceptLite, type LayoutEdit, type PageSettings, type Variant,
} from '../../lib/content'
import { Canvas, Palette } from './Canvas'
import { BlockInspector } from './BlockInspector'
import { FontFaces, useLibraryFonts } from './fields'
import { PageSettingsPanel, PopupRulesPanel, StatusBadge } from './panels'
import { VersionsDrawer } from './VersionsDrawer'
import { findBlock, insertAt, locate, updateBlock, type Slot } from './tree'

interface Doc { title: string; blocks: Block[]; settings: PageSettings }
type RightTab = 'element' | 'page' | 'rules'

function defaultTitle(slug: string): string {
  const [prefix, a, b] = slug.split(':')
  if (prefix === 'servd') return `servd ${a === 'header' ? 'top bar' : a}`
  if (prefix === 'brand') return b ? `${a} ${b === 'header' ? 'top bar' : b}` : `${a} home`
  if (slug.startsWith('page:')) return slug.slice(5)
  if (slug.startsWith('popup:')) return 'Pop-up'
  return slug
}

function cleanSettings(s: PageSettings, isPopup: boolean): PageSettings {
  const out: PageSettings = {}
  if (s.fonts && (s.fonts.heading || s.fonts.body)) out.fonts = s.fonts
  if (s.ab) out.ab = { splitPct: Math.max(0, Math.min(100, Math.round(s.ab.splitPct))), blocks: s.ab.blocks }
  if (isPopup && s.popup) out.popup = { ...s.popup, pages: s.popup.pages.map((p) => p.trim()).filter(Boolean) }
  return out
}

export function Builder({ slug }: { slug: string }) {
  const router = useRouter()
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const isAdmin = me?.role === 'admin'
  const kind = kindForSlug(slug)
  const isPopup = kind === 'popup'
  const backHref = `/storefront?tab=${isPopup ? 'popups' : 'pages'}`

  const edit = useQuery<LayoutEdit>({ queryKey: ['site-layout-edit', slug], queryFn: () => contentApi.edit(slug) })
  // The storefront's section catalogue: palette, forms and the page's design.
  const catalog = useSectionCatalog()
  const fonts = useLibraryFonts().data ?? []
  const concepts = useQuery<ConceptLite[]>({ queryKey: ['concepts'], queryFn: () => api.get<ConceptLite[]>('/concepts'), enabled: isPopup })

  const [doc, setDoc] = useState<Doc | null>(null)
  const [dirty, setDirty] = useState(false)
  const seq = useRef(0)
  const [variant, setVariant] = useState<Variant>('a')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<RightTab>('element')
  const [showVersions, setShowVersions] = useState(false)
  const [dialog, setDialog] = useState<null | 'approve' | 'reject'>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null)

  const docFrom = (row: LayoutEdit, useDraft: boolean): Doc => {
    const fromDraft = useDraft && row.draftBlocks != null
    const blocks = fromDraft ? row.draftBlocks! : row.blocks ?? seedBlocks(slug)
    let settings: PageSettings = (fromDraft ? row.draftSettings : row.settings) ?? {}
    if (isPopup && !settings.popup) settings = { ...settings, popup: DEFAULT_POPUP_RULES() }
    return { title: row.title ?? defaultTitle(slug), blocks, settings }
  }

  // Load once per slug (after the catalogue, which seeds a page with nothing
  // saved); later refetches must not clobber local edits.
  useEffect(() => {
    if (edit.data && catalog.data && !doc) setDoc(docFrom(edit.data, true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.data, catalog.data])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const change = (fn: (d: Doc) => Doc) => {
    seq.current += 1
    setDoc((d) => (d ? fn(d) : d))
    setDirty(true)
  }

  const activeBlocks = doc ? (variant === 'b' ? doc.settings.ab?.blocks ?? [] : doc.blocks) : []
  const setActive = (next: Block[]) => change((d) => (
    variant === 'b' && d.settings.ab
      ? { ...d, settings: { ...d.settings, ab: { ...d.settings.ab, blocks: next } } }
      : { ...d, blocks: next }
  ))
  const select = (id: string | null) => { setSelectedId(id); if (id) setTab('element') }
  const selected = selectedId ? findBlock(activeBlocks, selectedId) : null

  // Palette: this page's sections first (its design), then the general
  // elements. A top bar takes sections only; pop-ups take elements only.
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const sections = isPopup ? [] : sectionPaletteItems(slug)
    const general = kind === 'header' ? [] : BLOCK_CATALOG
      .filter((s) => s.group !== 'Special')
      .map((s) => ({ key: s.type, label: s.label, description: s.description, icon: s.icon, group: s.group }))
    return [...sections, ...general]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, slug, isPopup, catalog.data])

  const addFromPalette = (key: string) => {
    const b = makeBlock(key)
    const t = key
    let slot: Slot = { parentId: null, col: 0, index: activeBlocks.length }
    const loc = selectedId ? locate(activeBlocks, selectedId) : null
    if (loc) {
      if (loc.parentId && canNest(t)) slot = { ...loc, index: loc.index + 1 }
      else if (loc.parentId) slot = { parentId: null, col: 0, index: activeBlocks.findIndex((x) => x.id === loc.parentId) + 1 }
      else slot = { parentId: null, col: 0, index: loc.index + 1 }
    }
    setActive(insertAt(activeBlocks, slot, b))
    select(b.id)
  }

  // ─── Server actions ──────────────────────────────────────────────────────

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['site-layout-edit', slug] })
    void qc.invalidateQueries({ queryKey: ['site-layouts'] })
    void qc.invalidateQueries({ queryKey: ['site-layout-versions', slug] })
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!doc) throw new Error('Nothing to save')
      const at = seq.current
      await contentApi.saveDraft(slug, { title: doc.title, kind, blocks: doc.blocks, settings: cleanSettings(doc.settings, isPopup) })
      return at
    },
    onSuccess: (at) => { if (seq.current === at) setDirty(false); invalidate() },
  })

  const row = edit.data
  const hasDraft = !!row?.draftStatus
  const ensureSaved = async () => { if (dirty || !hasDraft) await save.mutateAsync() }

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label); setFlash(null)
    try {
      await fn()
      if (ok) setFlash({ ok: true, text: ok })
      invalidate()
      return true
    } catch (e) {
      setFlash({ ok: false, text: (e as Error).message || 'Something went wrong' })
      return false
    } finally {
      setBusy(null)
    }
  }

  const reloadFromServer = async () => {
    const fresh = await contentApi.edit(slug)
    qc.setQueryData(['site-layout-edit', slug], fresh)
    setDoc(docFrom(fresh, true)); setDirty(false); setVariant('a'); setSelectedId(null)
  }

  const onSave = () => run('save', () => save.mutateAsync(), 'Draft saved.')

  const onPreview = async () => {
    const w = window.open('', '_blank')
    const okRun = await run('preview', async () => {
      await ensureSaved()
      const { token } = await contentApi.previewToken(slug)
      const url = previewUrl(token)
      if (w) { w.opener = null; w.location.href = url } else window.open(url, '_blank', 'noopener')
    })
    if (!okRun) w?.close()
  }

  const onSubmit = () => run('submit', async () => { await ensureSaved(); await contentApi.submit(slug) }, 'Sent to the CEO for approval.')

  const onDiscard = () => {
    if (!confirm('Discard the draft? The editor goes back to what is live now.')) return
    void run('discard', async () => {
      if (hasDraft) await contentApi.discardDraft(slug)
      await reloadFromServer()
    }, 'Draft discarded.')
  }

  const onApprove = (publishAt?: string) => run('approve', async () => {
    await ensureSaved()
    await contentApi.approve(slug, publishAt)
    setDialog(null)
  }, publishAt ? `Approved. Goes live ${fmtDateTime(publishAt)}.` : 'Approved and live.')

  const onReject = (note: string) => run('reject', async () => {
    await contentApi.reject(slug, note)
    setDialog(null)
  }, 'Sent back with your note.')

  const onDelete = () => {
    if (!confirm(isPopup
      ? 'Delete this pop-up entirely? It stops showing and its history is removed.'
      : 'Delete this page entirely? The storefront falls back to the built-in design and the history is removed.')) return
    void run('delete', async () => {
      await contentApi.remove(slug)
      setDirty(false)
      router.push(backHref)
    })
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  const path = storefrontPath(slug)
  const ab = doc?.settings.ab
  const rules = doc?.settings.popup

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <FontFaces fonts={fonts} />

      <header className="sticky top-0 z-20 bg-s-bg/95 backdrop-blur border-b border-s-border px-6 py-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <Link href={backHref} className="text-xs text-s-muted hover:text-s-text">&larr; Storefront / {isPopup ? 'Pop-ups' : 'Pages'}</Link>
            <h1 className="text-lg font-bold truncate">{doc?.title || defaultTitle(slug)}</h1>
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-s-muted">
              <span className="font-mono">{slug}</span>
              <span>·</span>
              <span>{row?.liveVersion ? `Live: version ${row.liveVersion}` : 'Nothing live yet'}</span>
              {path && row?.liveVersion && (
                <a href={`${STOREFRONT_URL}${path}`} target="_blank" rel="noopener noreferrer" className="text-primary-ink hover:underline">View live</a>
              )}
              {row && <StatusBadge row={row} />}
              {dirty && <span className="s-badge-amber">Unsaved changes</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {flash && <span className={`text-xs ${flash.ok ? 'text-primary-ink' : 'text-s-red'}`}>{flash.text}</span>}
            <button type="button" onClick={() => setShowVersions(true)} className="s-btn-ghost text-xs">Versions</button>
            <button type="button" onClick={onPreview} disabled={!doc || !!busy} className="s-btn-secondary text-xs">{busy === 'preview' ? 'Opening...' : 'Preview'}</button>
            <button type="button" onClick={onDiscard} disabled={(!hasDraft && !dirty) || !!busy} className="s-btn-ghost text-xs">Discard draft</button>
            <button type="button" onClick={onSave} disabled={!doc || !dirty || !!busy} className="s-btn-secondary text-xs">{busy === 'save' ? 'Saving...' : 'Save draft'}</button>
            <button type="button" onClick={onSubmit} disabled={!doc || !!busy || (row?.draftStatus === 'pending' && !dirty)} className="s-btn-primary text-xs">
              {busy === 'submit' ? 'Submitting...' : 'Submit for approval'}
            </button>
            {isAdmin && (row?.draftStatus === 'pending' || row?.draftStatus === 'scheduled') && (
              <button type="button" onClick={() => setDialog('reject')} disabled={!!busy} className="s-btn-danger text-xs">Reject</button>
            )}
            {isAdmin && (
              <button type="button" onClick={() => setDialog('approve')} disabled={!doc || !!busy || (!hasDraft && !dirty)} className="s-btn-primary text-xs">Approve</button>
            )}
            {isAdmin && row?.id && (
              <button type="button" onClick={onDelete} disabled={!!busy} className="s-btn-ghost text-xs text-s-red">Delete</button>
            )}
          </div>
        </div>
      </header>

      {row?.draftStatus === 'draft' && row.reviewNote && (
        <div className="mx-6 mt-3 rounded-lg border border-s-red/40 bg-s-red-dim px-4 py-2 text-xs text-s-red">
          The CEO sent this back: &ldquo;{row.reviewNote}&rdquo;
        </div>
      )}
      {row?.draftStatus === 'pending' && (
        <div className="mx-6 mt-3 rounded-lg border border-s-amber/40 bg-s-amber-dim px-4 py-2 text-xs text-s-amber">
          Waiting for CEO approval. Saving another change sends it back to draft.
        </div>
      )}
      {row?.draftStatus === 'scheduled' && (
        <div className="mx-6 mt-3 rounded-lg border border-s-blue/40 bg-s-blue-dim px-4 py-2 text-xs text-s-blue">
          Approved. Goes live {fmtDateTime(row.publishAt)}. Saving another change cancels the schedule.
        </div>
      )}

      {(edit.isLoading || catalog.isLoading) && <p className="p-6 text-sm text-s-muted">Loading...</p>}
      {catalog.isError && <p className="p-6 text-sm text-s-red">Could not load the storefront's sections from {STOREFRONT_URL}: {(catalog.error as Error).message}</p>}
      {edit.isError && <p className="p-6 text-sm text-s-red">Could not load this {isPopup ? 'pop-up' : 'page'}: {(edit.error as Error).message}</p>}

      {doc && (
        <div className={`grid grid-cols-1 gap-4 p-4 ${isPopup ? 'lg:grid-cols-[200px_minmax(0,1fr)_380px]' : 'lg:grid-cols-[200px_minmax(0,1fr)_400px]'}`}>
          <aside className="lg:sticky lg:top-24 self-start lg:max-h-[calc(100vh-7rem)] overflow-y-auto">
            <Palette items={paletteItems} onAdd={addFromPalette} />
          </aside>

          <main className="min-w-0" onClick={() => select(null)}>
            <div className={isPopup ? 'max-w-xl mx-auto' : ''}>
              {ab && (
                <div className="mb-3 flex items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
                  <span className="text-s-muted">Editing</span>
                  {(['a', 'b'] as const).map((v) => (
                    <button key={v} type="button" onClick={() => { setVariant(v); setSelectedId(null) }}
                      className={`px-3 py-1 rounded-lg border ${variant === v ? 'border-s-teal text-primary-ink bg-s-teal-dim/40' : 'border-s-border text-s-muted'}`}>
                      Variant {v.toUpperCase()} {v === 'a' ? `(${100 - ab.splitPct}%)` : `(${ab.splitPct}%)`}
                    </button>
                  ))}
                </div>
              )}
              {isPopup && rules && (
                <p className="mb-3 text-[11px] text-s-muted">
                  {rules.display === 'bar' ? 'Bar' : rules.display === 'corner' ? 'Corner card' : 'Modal'} pop-up. Keep it short: a heading, a line and one action.
                </p>
              )}
              <Canvas blocks={activeBlocks} onChange={setActive} selectedId={selectedId} onSelect={select} items={paletteItems} />
            </div>
          </main>

          <aside className="lg:sticky lg:top-24 self-start">
            <div className="s-card overflow-hidden">
              <div className="flex border-b border-s-border text-xs">
                {([['element', 'Element'], ['page', isPopup ? 'Pop-up' : 'Page'], ...(isPopup ? [['rules', 'Rules']] : [])] as Array<[RightTab, string]>).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setTab(k)}
                    className={`flex-1 px-3 py-2 font-semibold ${tab === k ? 'text-primary-ink border-b-2 border-s-teal' : 'text-s-muted hover:text-s-text'}`}>
                    {label}
                  </button>
                ))}
              </div>
              {tab === 'element' && (selected
                ? <BlockInspector key={selected.id} block={selected} fonts={fonts} onChange={(next) => setActive(updateBlock(activeBlocks, next))} />
                : <p className="p-6 text-center text-sm text-s-muted">Select an element on the canvas to edit it.</p>)}
              {tab === 'page' && (
                <PageSettingsPanel kind={kind} title={doc.title} onTitle={(t) => change((d) => ({ ...d, title: t }))}
                  settings={doc.settings} onChange={(s) => change((d) => ({ ...d, settings: s }))}
                  fonts={fonts} variant={variant} onVariant={(v) => { setVariant(v); setSelectedId(null) }} blocksA={doc.blocks} />
              )}
              {tab === 'rules' && rules && (
                <PopupRulesPanel rules={rules} concepts={concepts.data ?? []}
                  onChange={(r) => change((d) => ({ ...d, settings: { ...d.settings, popup: r } }))} />
              )}
            </div>
          </aside>
        </div>
      )}

      {showVersions && (
        <VersionsDrawer slug={slug} isAdmin={isAdmin} liveVersion={row?.liveVersion ?? null}
          onClose={() => setShowVersions(false)}
          onRolledBack={() => { setFlash({ ok: true, text: 'Rolled back. The old version is live again.' }); invalidate() }} />
      )}
      {dialog === 'approve' && <ApproveDialog busy={busy === 'approve'} dirty={dirty} onCancel={() => setDialog(null)} onApprove={onApprove} />}
      {dialog === 'reject' && <RejectDialog busy={busy === 'reject'} onCancel={() => setDialog(null)} onReject={onReject} />}
    </div>
  )
}

function ApproveDialog({ busy, dirty, onCancel, onApprove }: { busy: boolean; dirty: boolean; onCancel: () => void; onApprove: (publishAt?: string) => void }) {
  const [at, setAt] = useState('')
  const iso = fromLocalInput(at)
  const future = iso && new Date(iso).getTime() > Date.now() ? iso : undefined
  return (
    <Modal title="Approve and publish" onClose={onCancel}>
      {dirty && <p className="text-xs text-s-amber">Your unsaved changes are saved into the draft first.</p>}
      <label className="block">
        <span className="block text-[11px] text-s-muted font-semibold mb-1 uppercase tracking-wider">Publish at (optional)</span>
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="s-input" />
        <span className="block text-[11px] text-s-dim mt-1">Leave blank to publish now.</span>
      </label>
      {at && !future && <p className="text-xs text-s-red">Pick a time in the future, or clear it to publish now.</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="s-btn-ghost text-xs">Cancel</button>
        <button type="button" disabled={busy || (!!at && !future)} onClick={() => onApprove(future)} className="s-btn-primary text-xs">
          {busy ? 'Approving...' : future ? 'Approve and schedule' : 'Approve and publish now'}
        </button>
      </div>
    </Modal>
  )
}

function RejectDialog({ busy, onCancel, onReject }: { busy: boolean; onCancel: () => void; onReject: (note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <Modal title="Send back with a note" onClose={onCancel}>
      <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} className="s-input" placeholder="What needs to change?" autoFocus />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="s-btn-ghost text-xs">Cancel</button>
        <button type="button" disabled={busy || !note.trim()} onClick={() => onReject(note.trim())} className="s-btn-danger text-xs">
          {busy ? 'Sending...' : 'Reject'}
        </button>
      </div>
    </Modal>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-secondary/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="s-card w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-bold text-s-text">{title}</h2>
        {children}
      </div>
    </div>
  )
}
