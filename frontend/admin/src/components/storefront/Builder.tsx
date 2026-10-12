'use client'

// The storefront page builder, shared by pages (/storefront/pages/[slug]) and
// pop-ups (/storefront/popups/[key]). Left: Layers (the page's elements, for
// picking and reordering) and Add (the element palette). Centre: the REAL
// page — the storefront's /editor-frame showing the unsaved working copy as
// it is edited (LiveCanvas), with phone / tablet / desktop sizes; clicking an
// element there selects it here. Right: element inspector (incl. scroll
// effects), page settings, pop-up rules.
//
// Every edit is a DRAFT (PUT /site-layouts/:slug/draft). Nothing reaches the
// storefront until the CEO (role `admin`) approves it, optionally at a
// scheduled "publish at" time. The live frame shows the working copy only to
// this editor (it renders what is posted to it); it saves and publishes
// nothing. A page with no draft starts from the live blocks, or from the
// page's design: its default sections from the storefront's section
// catalogue (lib/sections.ts), i.e. what it shows today.
//
// The editor opens even when the storefront is down: Layers, the inspector
// and saving work from the API alone; the live page, the page's design and
// section forms say they are waiting for the storefront.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { usePermissions } from '../../hooks/useCan'
import { BLOCK_CATALOG, blockLabel, canNest, type Block } from '../../lib/blocks'
import { isCatalogLoaded, makeBlock, SECTION_KEY, sectionPaletteItems, sectionSpec, storefrontHost, useSectionCatalog, type PaletteItem } from '../../lib/sections'
import {
  cleanSettings, contentApi, DEFAULT_POPUP_RULES, fmtDateTime, fontFamiliesUsed, fromLocalInput, hasSavedDraft, isBuiltInPage, kindForSlug,
  previewUrl, resolveLibraryFonts, seedBlocks, storefrontPath, STOREFRONT_BRANDS_KEY, STOREFRONT_URL,
  type ConceptLite, type LayoutEdit, type PageSettings, type Variant,
} from '../../lib/content'
import { Canvas, Palette } from './Canvas'
import { BlockInspector } from './BlockInspector'
import { FontFaces, useLibraryFonts } from './fields'
import { LiveCanvas, type FrameStatus, type LiveCanvasHandle, type SelectionSource } from './LiveCanvas'
import type { MotionPreviewControl } from './MotionPicker'
import { PageSettingsPanel, PopupRulesPanel, StatusBadge } from './panels'
import { VersionsDrawer } from './VersionsDrawer'
import { blockIds, findBlock, forEachBlock, insertAt, locate, updateBlock, type Slot } from './tree'

interface Doc { title: string; blocks: Block[]; settings: PageSettings }
type RightTab = 'element' | 'page' | 'rules'
type LeftTab = 'layers' | 'add'

function defaultTitle(slug: string): string {
  const [prefix, a, b] = slug.split(':')
  if (prefix === 'servd') return `servd ${a === 'header' ? 'top bar' : a === 'feedback' ? 'feedback button' : a}`
  if (prefix === 'brand') return b ? `${a} ${b === 'header' ? 'top bar' : b}` : `${a} home`
  if (slug.startsWith('page:')) return slug.slice(5)
  if (slug.startsWith('popup:')) return 'Pop-up'
  return slug
}

export function Builder({ slug }: { slug: string }) {
  const router = useRouter()
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const isAdmin = me?.role === 'admin'
  const kind = kindForSlug(slug)
  const isPopup = kind === 'popup'
  const backHref = `/storefront?tab=${isPopup ? 'popups' : 'pages'}`
  const brandSlug = slug.startsWith('brand:') ? slug.split(':')[1] ?? null : null

  const edit = useQuery<LayoutEdit>({ queryKey: ['site-layout-edit', slug], queryFn: () => contentApi.edit(slug) })
  // The storefront's section catalogue: palette, forms and the page's design.
  // Pop-ups use no sections, so they never fetch it (or wait on it). A page
  // opens without it when it already has saved elements (see below).
  const catalog = useSectionCatalog({ enabled: !isPopup })
  const libraryFonts = useLibraryFonts().data
  const fonts = useMemo(() => libraryFonts ?? [], [libraryFonts])
  // Brands: the pop-up rules' brand list, and a brand page's company (which
  // Library fonts the live page would load).
  const concepts = useQuery<ConceptLite[]>({ queryKey: STOREFRONT_BRANDS_KEY, queryFn: contentApi.brands, enabled: isPopup || !!brandSlug })

  const [doc, setDoc] = useState<Doc | null>(null)
  const [dirty, setDirty] = useState(false)
  const seq = useRef(0)
  const [variant, setVariant] = useState<Variant>('a')
  const [selection, setSelection] = useState<{ id: string | null; source: SelectionSource; nonce: number }>({ id: null, source: 'admin', nonce: 0 })
  const selectedId = selection.id
  const [hover, setHover] = useState<{ id: string | null; source: SelectionSource }>({ id: null, source: 'admin' })
  const [tab, setTab] = useState<RightTab>('element')
  const [leftTab, setLeftTab] = useState<LeftTab>('layers')
  const [showVersions, setShowVersions] = useState(false)
  const [dialog, setDialog] = useState<null | 'approve' | 'reject'>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null)

  // The live frame's state, and what it last drew.
  const canvasRef = useRef<LiveCanvasHandle>(null)
  const [frame, setFrame] = useState<FrameStatus>({ connection: 'connecting', updating: false, error: null, stale: false })
  const [renderedIds, setRenderedIds] = useState<Set<string> | null>(null)
  const [previewReset, setPreviewReset] = useState(0)

  const docFrom = (row: LayoutEdit, useDraft: boolean): Doc => {
    const fromDraft = useDraft && row.draftBlocks != null
    const blocks = fromDraft ? row.draftBlocks! : row.blocks ?? seedBlocks(slug)
    let settings: PageSettings = (fromDraft ? row.draftSettings : row.settings) ?? {}
    if (isPopup && !settings.popup) settings = { ...settings, popup: DEFAULT_POPUP_RULES() }
    return { title: row.title ?? defaultTitle(slug), blocks, settings }
  }

  /** Saved elements to open with (a draft, or what is live), so the page
   *  needs no design from the storefront to start. */
  const hasSavedBlocks = (row: LayoutEdit) => row.draftBlocks != null || row.blocks != null

  // Load once per slug; later refetches must not clobber local edits. A page
  // with nothing saved starts from its design, which comes from the
  // storefront's catalogue: it waits for it. A page with saved elements opens
  // as soon as the catalogue has answered — or failed.
  useEffect(() => {
    if (doc || !edit.data) return
    if (isPopup || catalog.data || (catalog.isError && hasSavedBlocks(edit.data))) setDoc(docFrom(edit.data, true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.data, catalog.data, catalog.isError])

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

  const activeBlocks = useMemo(() => (doc ? (variant === 'b' ? doc.settings.ab?.blocks ?? [] : doc.blocks) : []), [doc, variant])
  const setActive = (next: Block[]) => change((d) => (
    variant === 'b' && d.settings.ab
      ? { ...d, settings: { ...d.settings, ab: { ...d.settings.ab, blocks: next } } }
      : { ...d, blocks: next }
  ))
  const select = (id: string | null, source: SelectionSource = 'admin') => {
    setSelection((s) => ({ id, source, nonce: s.nonce + 1 }))
    if (id) setTab('element')
  }
  const switchVariant = (v: Variant) => { setVariant(v); select(null) }
  const selected = selectedId ? findBlock(activeBlocks, selectedId) : null

  // Palette: this page's sections first (its design), then the general
  // elements. A top bar takes sections only; pop-ups take elements only. A
  // widget (servd:feedback, the floating feedback button) takes only the
  // sections made for it: it is mounted after the footer on every page, so
  // anything else would show up there site-wide. Its elements get no Style or
  // Animation controls either (BlockInspector noStyle): an entrance animation
  // keeps the fixed button invisible until it "scrolls into view".
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const offered = isPopup ? [] : sectionPaletteItems(slug)
    const sections = kind === 'widget'
      ? offered.filter((i) => sectionSpec(i.key.slice(SECTION_KEY.length))?.pages.includes(slug))
      : offered
    const general = kind === 'header' || kind === 'widget' ? [] : BLOCK_CATALOG
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

  // ─── What the live frame is sent ─────────────────────────────────────────

  const brandTenant = brandSlug ? concepts.data?.find((c) => c.slug === brandSlug)?.tenantId ?? null : null
  const layoutTenant = edit.data?.tenantId ?? brandTenant
  const frameFonts = useMemo(
    () => (doc ? resolveLibraryFonts(fontFamiliesUsed(doc.blocks, doc.settings), fonts, layoutTenant) : []),
    [doc, fonts, layoutTenant],
  )
  const frameLabels = useMemo(() => {
    const out: Record<string, string> = {}
    forEachBlock(activeBlocks, (b) => {
      out[b.id] = b.type === 'section' ? sectionSpec(b.variant as string | undefined)?.label ?? 'Section' : blockLabel(b.type)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBlocks, catalog.data])

  // Visible elements the live page drew nothing for (empty, or no data yet).
  const missingIds = useMemo(() => {
    if (!renderedIds || frame.connection !== 'live' || frame.updating || frame.stale || frame.error) return null
    const out = new Set<string>()
    const hiddenParents = new Set<string>()
    forEachBlock(activeBlocks, (b, parentId) => {
      if (b.hidden) { hiddenParents.add(b.id); return }
      if (parentId && hiddenParents.has(parentId)) return
      if (!renderedIds.has(b.id)) out.add(b.id)
    })
    return out.size ? out : null
  }, [renderedIds, frame, activeBlocks])

  // A Layers row follows a selection made in the page.
  const reveal = selection.source === 'frame' && selection.id ? { id: selection.id, nonce: selection.nonce } : null

  // The newest edit couldn't be sent (too large): a preview running on the
  // older page ends, and the slider shows "live" until the page catches up.
  useEffect(() => {
    if (!frame.stale) return
    if (selectedId) canvasRef.current?.previewMotion(selectedId, null)
    setPreviewReset((n) => n + 1)
  }, [frame.stale]) // eslint-disable-line react-hooks/exhaustive-deps

  const motionPreview: MotionPreviewControl = {
    // Only on a page that shows the newest edit: not while it is being drawn,
    // and not when the newest edit was too large to send (the page is older).
    ready: frame.connection === 'live' && !frame.updating && !frame.stale,
    reason: frame.connection !== 'live'
      ? 'Preview needs the live page.'
      : frame.updating
        ? 'Updating the page…'
        : frame.stale
          ? 'The page is too large to preview, so it doesn’t show your latest change.'
          : null,
    resetNonce: previewReset,
    onPreview: (id, progress) => canvasRef.current?.previewMotion(id, progress),
  }

  const onFrameSelect = (id: string | null) => {
    // Only elements of the layout being edited (and its active variant).
    select(id && blockIds(activeBlocks).has(id) ? id : null, 'frame')
  }
  const onFrameHover = (id: string | null) => {
    setHover((h) => (h.id === id && h.source === 'frame' ? h : { id, source: 'frame' }))
  }
  const onLayersHover = (id: string | null) => {
    setHover((h) => (h.id === id ? h : { id, source: 'admin' }))
  }
  const openContext = (target: string) => {
    if (dirty && !confirm('You have unsaved changes on this page. Leave without saving them?')) return
    router.push(`/storefront/pages/${encodeURIComponent(target)}`)
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
  // A saved working copy exists (draft / pending / scheduled). The API says
  // 'none' for an untouched page — a truthy string, so never `!!draftStatus`.
  const hasDraft = hasSavedDraft(row?.draftStatus)
  // Sent to the CEO (or already approved for later): what Reject acts on.
  // Approve also takes a plain saved draft (the API accepts 'draft' on
  // purpose), so the CEO can edit and publish in one step.
  const submitted = row?.draftStatus === 'pending' || row?.draftStatus === 'scheduled'
  // Approving a submitted draft approves it AS SUBMITTED: with unsaved edits
  // on top, the CEO saves them first (that makes them his own draft), so
  // someone's submission is never silently approved with other content.
  const approveBlocked = submitted && dirty
  // Submit, Preview and Approve work from a saved draft: an untouched page
  // (no draft yet) or unsaved edits are saved first.
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
    // With nothing saved, the page starts from its design: without the
    // storefront's catalogue there is none to start from yet.
    const canOpen = isPopup || isCatalogLoaded() || hasSavedBlocks(fresh)
    setDoc(canOpen ? docFrom(fresh, true) : null); setDirty(false); setVariant('a'); select(null)
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

  // A submitted draft is approved as submitted (Approve is disabled while
  // there are unsaved edits on top of it); the CEO's own edits to a plain
  // draft or an untouched page are saved first, then published.
  const onApprove = (publishAt?: string) => run('approve', async () => {
    if (!approveBlocked) await ensureSaved()
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

  const retryStorefront = () => {
    void catalog.refetch()
    canvasRef.current?.reload()
  }

  // ─── Pane geometry: the three panes fill the screen under the header ─────

  const rootRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const [geom, setGeom] = useState({ stick: 88, pane: 640 })
  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    const measure = () => {
      const scroller = rootRef.current?.closest('main')
      const top = scroller ? scroller.getBoundingClientRect().top : 0
      const stick = header.offsetHeight + 12
      const pane = Math.max(480, Math.floor(window.innerHeight - top - stick - 12))
      setGeom((g) => (g.stick === stick && g.pane === pane ? g : { stick, pane }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(header)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  // ─── Render ──────────────────────────────────────────────────────────────

  const path = storefrontPath(slug)
  const ab = doc?.settings.ab
  const rules = doc?.settings.popup
  const host = storefrontHost()
  const catalogDown = !isPopup && catalog.isError && !catalog.data
  const waitingForDesign = !doc && !!row && !isPopup && !catalog.isError
  const blockedByStorefront = !doc && !!row && catalogDown
  const partName = kind === 'header' ? 'top bar' : kind === 'widget' ? 'feedback button' : 'page'

  const toolbarExtra = (
    <>
      {ab && (
        <span className="inline-flex items-center gap-1">
          <span className="text-s-muted">Showing</span>
          {(['a', 'b'] as const).map((v) => (
            <button key={v} type="button" onClick={() => switchVariant(v)} aria-pressed={variant === v}
              className={`px-2 py-1 rounded-lg border ${variant === v ? 'border-s-teal text-primary-ink bg-s-teal-dim/40' : 'border-s-border text-s-muted'}`}>
              {v.toUpperCase()} {v === 'a' ? `(${100 - ab.splitPct}%)` : `(${ab.splitPct}%)`}
            </button>
          ))}
        </span>
      )}
      {isPopup && rules && (
        <span className="text-[11px] text-s-muted">
          {rules.display === 'bar' ? 'Bar' : rules.display === 'corner' ? 'Corner card' : 'Modal'} pop-up. Keep it short: a heading, a line and one action.
        </span>
      )}
    </>
  )

  const paneStyle = { '--sf-stick': `${geom.stick}px`, '--sf-pane': `${geom.pane}px` } as React.CSSProperties
  const pane = 'lg:sticky lg:top-[var(--sf-stick)] lg:h-[var(--sf-pane)]'

  return (
    <div ref={rootRef} className="min-h-full bg-s-bg text-s-text">
      <FontFaces fonts={fonts} />

      <header ref={headerRef} className="sticky top-0 z-20 bg-s-bg/95 backdrop-blur border-b border-s-border px-6 py-3">
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
            <button type="button" onClick={onPreview} disabled={!doc || !!busy} className="s-btn-secondary text-xs"
              title="Opens the saved draft in a new tab, as visitors will see it.">{busy === 'preview' ? 'Opening...' : 'Preview in new tab'}</button>
            <button type="button" onClick={onDiscard} disabled={(!hasDraft && !dirty) || !!busy} className="s-btn-ghost text-xs">Discard draft</button>
            <button type="button" onClick={onSave} disabled={!doc || !dirty || !!busy} className="s-btn-secondary text-xs">{busy === 'save' ? 'Saving...' : 'Save draft'}</button>
            <button type="button" onClick={onSubmit} disabled={!doc || !!busy || (submitted && !dirty)} className="s-btn-primary text-xs"
              title={submitted && !dirty
                ? (row?.draftStatus === 'pending' ? 'Already sent to the CEO. Change something to send a new version.' : 'Already approved. Change something to send a new version.')
                : !hasDraft && !dirty ? 'Saves this page as a draft, then sends it to the CEO.' : undefined}>
              {busy === 'submit' ? 'Submitting...' : 'Submit for approval'}
            </button>
            {isAdmin && submitted && (
              <button type="button" onClick={() => setDialog('reject')} disabled={!!busy} className="s-btn-danger text-xs">Reject</button>
            )}
            {isAdmin && (
              <button type="button" onClick={() => setDialog('approve')} disabled={!doc || !!busy || (!hasDraft && !dirty) || approveBlocked} className="s-btn-primary text-xs"
                title={approveBlocked
                  ? 'This draft was sent for approval and you have unsaved changes on top. Approve it as sent (discard your changes), or save your changes first and approve those.'
                  : !hasDraft && !dirty ? 'Nothing to approve: no draft and no changes.' : undefined}>
                Approve
              </button>
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
      {catalogDown && doc && (
        <div role="status" className="mx-6 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-s-amber/40 bg-s-amber-dim px-4 py-2 text-xs text-s-amber">
          <span className="flex-1 min-w-[16rem]">
            The storefront ({host}) didn&apos;t answer, so the live page, the page&apos;s design and section forms can&apos;t load. You can still
            pick, reorder, hide and delete elements, edit general elements and save your draft.
          </span>
          <button type="button" onClick={retryStorefront} disabled={catalog.isFetching} className="s-btn-secondary text-xs">
            {catalog.isFetching ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}

      {edit.isLoading && <p className="p-6 text-sm text-s-muted">Loading...</p>}
      {edit.isError && <p className="p-6 text-sm text-s-red">Could not load this {isPopup ? 'pop-up' : 'page'}: {(edit.error as Error).message}</p>}

      {row && (
        <div style={paneStyle} className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[260px_minmax(0,1fr)_380px]">
          {/* Layers | Add */}
          <aside className={`s-card flex flex-col overflow-hidden max-h-[70vh] lg:max-h-none ${pane}`} onClick={() => select(null)}>
            <div className="flex border-b border-s-border text-xs shrink-0" onClick={(e) => e.stopPropagation()}>
              {([['layers', 'Layers'], ['add', 'Add']] as Array<[LeftTab, string]>).map(([k, label]) => (
                // Dragging an element from Add onto the Layers tab opens it, so it can be dropped in place.
                <button key={k} type="button" onClick={() => setLeftTab(k)} aria-pressed={leftTab === k}
                  onDragEnter={() => { if (k === 'layers') setLeftTab('layers') }}
                  className={`flex-1 px-3 py-2 font-semibold ${leftTab === k ? 'text-primary-ink border-b-2 border-s-teal' : 'text-s-muted hover:text-s-text'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2">
              {waitingForDesign && <p className="p-2 text-xs text-s-muted">Loading the page&apos;s design...</p>}
              {blockedByStorefront && (
                <div className="space-y-2 p-2" role="alert">
                  <p className="text-xs text-s-text">
                    This page hasn&apos;t been edited yet. Its design comes from the storefront, which didn&apos;t answer, so it opens once the
                    storefront is back.
                  </p>
                  <button type="button" onClick={(e) => { e.stopPropagation(); retryStorefront() }} disabled={catalog.isFetching} className="s-btn-primary text-xs">
                    {catalog.isFetching ? 'Retrying...' : 'Retry'}
                  </button>
                </div>
              )}
              {/* Both tabs stay mounted: a drag that starts in Add must survive the switch to Layers. */}
              {doc && (
                <div className={leftTab === 'layers' ? '' : 'hidden'}>
                  {activeBlocks.length === 0 && !isPopup && isBuiltInPage(slug) && (
                    <p className="mb-2 rounded-lg bg-s-bg-soft px-2 py-1.5 text-[11px] text-s-muted">With no elements, the site shows this page&apos;s built-in design.</p>
                  )}
                  <Canvas compact blocks={activeBlocks} onChange={setActive} selectedId={selectedId} onSelect={(id) => select(id)} items={paletteItems}
                    hoverId={hover.id} onHover={onLayersHover} reveal={reveal} missingIds={missingIds} />
                </div>
              )}
              {doc && (
                <div className={leftTab === 'add' ? '' : 'hidden'} onClick={(e) => e.stopPropagation()}>
                  <Palette items={paletteItems} onAdd={addFromPalette}
                    empty={catalogDown
                      ? `The storefront (${host}) didn't answer, so this ${partName}'s sections can't be added right now.`
                      : undefined} />
                </div>
              )}
            </div>
          </aside>

          {/* The live page */}
          <section className={`min-w-0 h-[70vh] min-h-[480px] lg:min-h-[480px] ${pane}`} aria-label="Live page">
            {doc
              ? (
                <LiveCanvas ref={canvasRef} slug={slug} doc={doc} variant={variant} fonts={frameFonts} labels={frameLabels}
                  selection={selection} hover={hover} toolbarExtra={toolbarExtra}
                  onSelect={onFrameSelect} onHover={onFrameHover} onOpenContext={openContext}
                  onMotionPreviewEnded={() => setPreviewReset((n) => n + 1)}
                  onRendered={(_rev, ok, _error, ids) => { if (ok) setRenderedIds(new Set(ids)) }}
                  onStatus={setFrame}
                  onReconnect={() => setPreviewReset((n) => n + 1)} />
              )
              : (
                <div className="flex h-full items-center justify-center rounded-xl border border-s-border bg-s-bg-soft p-6">
                  <p className="max-w-md text-center text-sm text-s-muted">
                    {blockedByStorefront
                      ? `The live page can't be shown right now. The storefront at ${host} didn't answer.`
                      : 'Loading the page...'}
                  </p>
                </div>
              )}
          </section>

          {/* Inspector */}
          <aside className={`s-card flex flex-col overflow-hidden ${pane}`}>
            <div className="flex border-b border-s-border text-xs shrink-0">
              {([['element', 'Element'], ['page', isPopup ? 'Pop-up' : 'Page'], ...(isPopup ? [['rules', 'Rules']] : [])] as Array<[RightTab, string]>).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setTab(k)}
                  className={`flex-1 px-3 py-2 font-semibold ${tab === k ? 'text-primary-ink border-b-2 border-s-teal' : 'text-s-muted hover:text-s-text'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {!doc && <p className="p-6 text-center text-sm text-s-muted">Nothing to edit yet.</p>}
              {doc && tab === 'element' && (selected
                ? <BlockInspector key={selected.id} block={selected} fonts={fonts} noStyle={kind === 'widget'}
                    kind={kind} slug={slug} motionPreview={motionPreview}
                    onChange={(next) => setActive(updateBlock(activeBlocks, next))} />
                : <p className="p-6 text-center text-sm text-s-muted">Click an element on the page, or in Layers, to edit it.</p>)}
              {doc && tab === 'page' && (
                <PageSettingsPanel slug={slug} kind={kind} title={doc.title} onTitle={(t) => change((d) => ({ ...d, title: t }))}
                  settings={doc.settings} onChange={(s) => change((d) => ({ ...d, settings: s }))}
                  fonts={fonts} variant={variant} onVariant={switchVariant} blocksA={doc.blocks} />
              )}
              {doc && tab === 'rules' && rules && (
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
      {dialog === 'approve' && <ApproveDialog busy={busy === 'approve'} savesFirst={dirty || !hasDraft} onCancel={() => setDialog(null)} onApprove={onApprove} />}
      {dialog === 'reject' && <RejectDialog busy={busy === 'reject'} onCancel={() => setDialog(null)} onReject={onReject} />}
    </div>
  )
}

function ApproveDialog({ busy, savesFirst, onCancel, onApprove }: { busy: boolean; savesFirst: boolean; onCancel: () => void; onApprove: (publishAt?: string) => void }) {
  const [at, setAt] = useState('')
  const iso = fromLocalInput(at)
  const future = iso && new Date(iso).getTime() > Date.now() ? iso : undefined
  return (
    <Modal title="Approve and publish" onClose={onCancel}>
      {savesFirst && <p className="text-xs text-s-amber">Your changes are saved into the draft first.</p>}
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
