'use client'

// The brand kit editor (/storefront/kit/<brand>): one brand's look — colours,
// two fonts and four pictures — in one place. Left: a form built from the
// storefront's own list of that brand's colours, fonts and pictures
// (kitCatalog.ts, served at /api/storefront-brand-kit — nothing here knows a
// brand's palette). Right: the brand's real home page in the storefront's
// editor frame, painted with the UNSAVED kit (FrameDoc.kit), so every change
// shows before it is saved.
//
// It is a SiteLayout row like a page — `brand:<slug>:kit`, kind 'kit', the kit
// in settings.kit — so the flow is the page builder's: Save draft, Submit for
// approval, and only the CEO (role `admin`) approves (now or at a time),
// rejects, rolls back or deletes. There is no second approval engine. An empty
// field means "the brand's built-in look", so nothing here changes a brand
// until something is set and approved.

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { usePermissions } from '../../hooks/useCan'
import { useSectionCatalog } from '../../lib/sections'
import {
  cleanKit, cleanSettings, contentApi, fmtDateTime, fontFamiliesUsed, hasSavedDraft, isHex6, kitProblems, kitSlugOf, resolveLibraryFonts, seedBlocks,
  STOREFRONT_BRANDS_KEY, STOREFRONT_URL, storefrontPath,
  type BrandKit, type ConceptLite, type KitImageKey, type KitRoleKey, type LayoutEdit, type MediaAssetLite,
} from '../../lib/content'
import { ApproveDialog, RejectDialog } from './Builder'
import { ColorInput, Field, FontFaces, MediaInput, Section, useLibraryFonts } from './fields'
import { brandCatalog, storefrontAsset, useBrandKitCatalog, type KitCatalog } from './kitCatalog'
import { LiveCanvas, type FrameStatus, type LiveCanvasHandle } from './LiveCanvas'
import { StatusBadge } from './panels'
import { VersionsDrawer } from './VersionsDrawer'

const ROLES: Array<{ key: KitRoleKey; label: string; hint: string }> = [
  { key: 'accent', label: 'Website signal colour', hint: 'The one accent colour on the brand\'s website.' },
  { key: 'surfaceBg', label: 'Band / footer background', hint: 'Behind the coloured bands and the footer.' },
  { key: 'surfaceText', label: 'Band / footer text', hint: 'Text on those bands and the footer.' },
  { key: 'ordering', label: 'Ordering & ERP colour', hint: 'The brand\'s colour on ordering pages, in the admin and in the app.' },
]

const IMAGES: Array<{ key: KitImageKey; label: string; hint: string }> = [
  { key: 'logo', label: 'Logo', hint: 'The small mark used in lists, the top bar and receipts of the app.' },
  { key: 'wordmark', label: 'Wordmark', hint: 'The brand name as lettering. Wide, on a transparent background.' },
  { key: 'mascot', label: 'Mascot', hint: 'The brand character, shown large. Transparent background works best.' },
  { key: 'badge', label: 'Badge', hint: 'A round or square sticker-style mark, where the brand has one.' },
]

const libraryRef = (id: string) => `library:${id}`

function kitFrom(row: LayoutEdit | undefined): BrandKit {
  const src = row ? (row.draftSettings != null ? row.draftSettings : row.settings) : null
  return src?.kit ? { ...src.kit, v: 1 } : { v: 1 }
}

export function KitEditor({ brand }: { brand: string }) {
  const router = useRouter()
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const isAdmin = me?.role === 'admin'
  const slug = kitSlugOf(brand)
  const homeSlug = `brand:${brand}`

  const edit = useQuery<LayoutEdit>({ queryKey: ['site-layout-edit', slug], queryFn: () => contentApi.edit(slug) })
  const home = useQuery<LayoutEdit>({ queryKey: ['site-layout-edit', homeSlug], queryFn: () => contentApi.edit(homeSlug) })
  const concepts = useQuery<ConceptLite[]>({ queryKey: STOREFRONT_BRANDS_KEY, queryFn: contentApi.brands })
  const kitCatalog = useBrandKitCatalog()
  const sections = useSectionCatalog()
  const libraryFonts = useLibraryFonts().data
  const library = useMemo(() => libraryFonts ?? [], [libraryFonts])

  const concept = concepts.data?.find((c) => c.slug === brand)
  const brandName = concept?.name ?? brand
  const cat = brandCatalog(kitCatalog.data, brand)
  const layoutTenant = edit.data?.tenantId ?? concept?.tenantId ?? null
  // Fonts of THIS brand's company only (the API refuses another company's).
  const companyFonts = useMemo(
    () => library.filter((f) => f.kind === 'font' && f.fontFamily && (!layoutTenant || f.tenantId === undefined || f.tenantId === layoutTenant)),
    [library, layoutTenant],
  )

  const [kit, setKit] = useState<BrandKit | null>(null)
  const [dirty, setDirty] = useState(false)
  const seq = useRef(0)
  const [showVersions, setShowVersions] = useState(false)
  const [dialog, setDialog] = useState<null | 'approve' | 'reject'>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null)
  const canvasRef = useRef<LiveCanvasHandle>(null)
  const [frame, setFrame] = useState<FrameStatus>({ connection: 'connecting', updating: false, error: null, stale: false })

  // Load once; later refetches must not clobber what is being edited.
  if (!kit && edit.data) setKit(kitFrom(edit.data))

  const change = (fn: (k: BrandKit) => BrandKit) => {
    seq.current += 1
    setKit((k) => (k ? fn(k) : k))
    setDirty(true)
  }
  const setIn = <G extends 'palette' | 'roles' | 'fonts' | 'images'>(group: G, key: string, value: string | undefined) =>
    change((k) => {
      const next = { ...(k[group] as Record<string, string> | undefined) }
      if (value === undefined || value === '') delete next[key]
      else next[key] = value
      return { ...k, [group]: next } as BrandKit
    })

  const problems = useMemo(() => (kit ? kitProblems(kit) : []), [kit])

  // ─── What the live frame is sent: the brand's home page + the draft kit ──

  const homeRow = home.data
  const designReady = !!homeRow && (sections.data || sections.isError || homeRow.blocks != null)
  const homeBlocks = useMemo(
    () => (homeRow ? homeRow.blocks ?? (sections.data ? seedBlocks(homeSlug) : []) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [homeRow, sections.data],
  )
  const homeDoc = useMemo(() => ({
    title: homeRow?.title ?? `${brandName} home`,
    blocks: homeBlocks,
    settings: cleanSettings(homeRow?.settings ?? {}, false),
  }), [homeRow, homeBlocks, brandName])
  const frameKit = useMemo(() => (kit ? { brand, kit: cleanKit(kit) } : undefined), [brand, kit])
  const frameFonts = useMemo(() => {
    const out = resolveLibraryFonts(fontFamiliesUsed(homeDoc.blocks, homeDoc.settings), library, layoutTenant)
    // A kit font `library:<assetId>` is sent under its asset family AND under
    // the reference itself, so the frame can resolve it either way.
    for (const ref of [kit?.fonts?.display, kit?.fonts?.body]) {
      const id = ref?.startsWith('library:') ? ref.slice('library:'.length) : null
      const asset = id ? companyFonts.find((f) => f.id === id) : undefined
      if (asset?.fontFamily && asset.url) {
        out.push({ family: asset.fontFamily, url: asset.url }, { family: libraryRef(asset.id), url: asset.url })
      }
    }
    return out
  }, [homeDoc, library, layoutTenant, kit?.fonts?.display, kit?.fonts?.body, companyFonts])
  const noLabels = useMemo(() => ({}) as Record<string, string>, [])
  const noop = () => {}

  // ─── Server actions (same flow as the page builder) ──────────────────────

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['site-layout-edit', slug] })
    void qc.invalidateQueries({ queryKey: ['site-layouts'] })
    void qc.invalidateQueries({ queryKey: ['site-layout-versions', slug] })
    // A publish keeps the brand's ordering colour and logo in step.
    void qc.invalidateQueries({ queryKey: ['concepts'] })
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!kit) throw new Error('Nothing to save')
      if (problems.length) throw new Error(problems[0])
      const at = seq.current
      await contentApi.saveDraft(slug, { title: `${brandName} brand kit`, kind: 'kit', blocks: [], settings: cleanSettings({ kit }, false) })
      return at
    },
    onSuccess: (at) => { if (seq.current === at) setDirty(false); invalidate() },
  })

  const row = edit.data
  const hasDraft = hasSavedDraft(row?.draftStatus)
  const submitted = row?.draftStatus === 'pending' || row?.draftStatus === 'scheduled'
  // A submitted kit is approved AS SUBMITTED: unsaved edits on top are saved
  // by the CEO first (making them his own draft).
  const approveBlocked = submitted && dirty
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
    setKit(kitFrom(fresh)); setDirty(false)
  }

  const onSave = () => run('save', () => save.mutateAsync(), 'Draft saved.')
  const onSubmit = () => run('submit', async () => { await ensureSaved(); await contentApi.submit(slug) }, 'Sent to the CEO for approval.')
  const onDiscard = () => {
    if (!confirm('Discard the draft? The editor goes back to what is live now.')) return
    void run('discard', async () => {
      if (hasDraft) await contentApi.discardDraft(slug)
      await reloadFromServer()
    }, 'Draft discarded.')
  }
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
    if (!confirm('Remove this brand kit entirely? The brand goes back to its built-in look and the kit history is removed.')) return
    void run('delete', async () => {
      await contentApi.remove(slug)
      setDirty(false)
      router.push('/storefront?tab=kit')
    })
  }

  // ─── Pane geometry: the two panes fill the screen under the header ───────

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
  const paneStyle = { '--sf-stick': `${geom.stick}px`, '--sf-pane': `${geom.pane}px` } as React.CSSProperties
  const pane = 'lg:sticky lg:top-[var(--sf-stick)] lg:h-[var(--sf-pane)]'

  const path = storefrontPath(homeSlug)
  const unknownBrand = concepts.isSuccess && !concept

  return (
    <div ref={rootRef} className="min-h-full bg-s-bg text-s-text">
      <FontFaces fonts={companyFonts} />

      <header ref={headerRef} className="sticky top-0 z-20 bg-s-bg/95 backdrop-blur border-b border-s-border px-6 py-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <Link href="/storefront?tab=kit" className="text-xs text-s-muted hover:text-s-text">&larr; Storefront / Brand kit</Link>
            <h1 className="text-lg font-bold truncate">Brand kit — {brandName}</h1>
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-s-muted">
              <span>{row?.liveVersion ? `Live: version ${row.liveVersion}` : 'Nothing published yet: the brand uses its built-in look'}</span>
              {path && row?.liveVersion && (
                <a href={`${STOREFRONT_URL}${path}`} target="_blank" rel="noopener noreferrer" className="text-primary-ink hover:underline">View live</a>
              )}
              {row && <StatusBadge row={row} />}
              {dirty && <span className="s-badge-amber">Unsaved changes</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {flash && <span className={`text-xs ${flash.ok ? 'text-success' : 'text-s-red'}`}>{flash.text}</span>}
            <button type="button" onClick={() => setShowVersions(true)} className="s-btn-ghost text-xs">Versions</button>
            <button type="button" onClick={onDiscard} disabled={(!hasDraft && !dirty) || !!busy} className="s-btn-ghost text-xs">Discard draft</button>
            <button type="button" onClick={onSave} disabled={!kit || !dirty || !!busy || problems.length > 0} className="s-btn-secondary text-xs"
              title={problems[0]}>{busy === 'save' ? 'Saving...' : 'Save draft'}</button>
            <button type="button" onClick={onSubmit} disabled={!kit || !!busy || problems.length > 0 || (submitted && !dirty)} className="s-btn-primary text-xs"
              title={problems[0] ?? (submitted && !dirty
                ? (row?.draftStatus === 'pending' ? 'Already sent to the CEO. Change something to send a new version.' : 'Already approved. Change something to send a new version.')
                : !hasDraft && !dirty ? 'Saves this kit as a draft, then sends it to the CEO.' : undefined)}>
              {busy === 'submit' ? 'Submitting...' : 'Submit for approval'}
            </button>
            {isAdmin && submitted && (
              <button type="button" onClick={() => setDialog('reject')} disabled={!!busy} className="s-btn-danger text-xs">Reject</button>
            )}
            {isAdmin && (
              <button type="button" onClick={() => setDialog('approve')} disabled={!kit || !!busy || problems.length > 0 || (!hasDraft && !dirty) || approveBlocked} className="s-btn-primary text-xs"
                title={problems[0] ?? (approveBlocked
                  ? 'This kit was sent for approval and you have unsaved changes on top. Approve it as sent (discard your changes), or save your changes first and approve those.'
                  : !hasDraft && !dirty ? 'Nothing to approve: no draft and no changes.' : undefined)}>
                Approve
              </button>
            )}
            {isAdmin && row?.id && (
              <button type="button" onClick={onDelete} disabled={!!busy} className="s-btn-ghost text-xs text-s-red">Remove kit</button>
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
      {kitCatalog.isError && (
        <div role="status" className="mx-6 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-s-amber/40 bg-s-amber-dim px-4 py-2 text-xs text-s-amber">
          <span className="flex-1 min-w-[16rem]">
            {(kitCatalog.error as Error).message} The brand&apos;s colours and built-in fonts are listed once it answers. Library fonts, pictures and saving still work.
          </span>
          <button type="button" onClick={() => { void kitCatalog.refetch(); canvasRef.current?.reload() }} disabled={kitCatalog.isFetching} className="s-btn-secondary text-xs">
            {kitCatalog.isFetching ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}
      {unknownBrand && <p className="p-6 text-sm text-s-red">There is no brand called &ldquo;{brand}&rdquo; that you can edit.</p>}
      {edit.isLoading && <p className="p-6 text-sm text-s-muted">Loading...</p>}
      {edit.isError && <p className="p-6 text-sm text-s-red">Could not load this brand kit: {(edit.error as Error).message}</p>}

      {row && kit && !unknownBrand && (
        <div style={paneStyle} className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[420px_minmax(0,1fr)]">
          {/* The form */}
          <aside className={`s-card flex flex-col overflow-hidden max-h-[80vh] lg:max-h-none ${pane}`}>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-1">
              {cat.note && <p className="mb-3 rounded-lg bg-s-bg-soft px-3 py-2 text-[11px] text-s-muted">{cat.note}</p>}
              <p className="mb-3 text-[11px] text-s-muted">
                Leave a field empty to keep the brand&apos;s built-in look. Nothing here reaches the site until the CEO approves it.
              </p>
              {problems.length > 0 && (
                <ul className="mb-3 rounded-lg border border-s-red/40 bg-s-red-dim px-3 py-2 text-[11px] text-s-red list-disc pl-6" role="alert">
                  {problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              )}

              <Section title="Colours">
                {kitCatalog.isLoading && <p className="text-xs text-s-muted">Loading the brand&apos;s colours...</p>}
                {!kitCatalog.isLoading && cat.palette.length === 0 && (
                  <p className="text-xs text-s-muted">
                    {kitCatalog.isError
                      ? 'The brand\'s colour list comes from the storefront, which didn\'t answer.'
                      : 'This brand has no named colours. Use the four colours below.'}
                  </p>
                )}
                {cat.palette.map((p) => (
                  <ColourRow key={p.key} label={p.label} def={p.default} value={kit.palette?.[p.key]} onChange={(v) => setIn('palette', p.key, v)} />
                ))}
              </Section>

              <Section title="Website colours">
                {ROLES.map((r) => (
                  <ColourRow key={r.key} label={r.label} hint={r.hint}
                    def={r.key === 'ordering' ? cat.roles.ordering ?? (isHex6(concept?.primaryColor) ? concept?.primaryColor ?? undefined : undefined) : cat.roles[r.key]}
                    value={kit.roles?.[r.key]} onChange={(v) => setIn('roles', r.key, v)} />
                ))}
              </Section>

              <Section title="Fonts">
                <Field label="Heading font">
                  <KitFontSelect value={kit.fonts?.display} def={cat.fonts.display} catalog={kitCatalog.data} company={companyFonts}
                    onChange={(v) => setIn('fonts', 'display', v)} />
                </Field>
                <Field label="Body font">
                  <KitFontSelect value={kit.fonts?.body} def={cat.fonts.body} catalog={kitCatalog.data} company={companyFonts}
                    onChange={(v) => setIn('fonts', 'body', v)} />
                </Field>
                <p className="text-[11px] text-s-dim">A font set on one page (Pages, Page tab) still wins on that page.</p>
              </Section>

              <Section title="Pictures">
                {IMAGES.map((im) => {
                  const def = storefrontAsset(cat.images[im.key])
                  return (
                    <Field key={im.key} label={im.label} hint={im.hint}>
                      <MediaInput kind="image" value={kit.images?.[im.key]} onChange={(v) => setIn('images', im.key, v)}
                        placeholder={cat.images[im.key] ? `Built-in: ${cat.images[im.key]}` : 'https://...'} />
                      {!kit.images?.[im.key] && def && (
                        <div className="mt-2 flex items-center gap-2 text-[11px] text-s-muted">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={def} alt="" className="h-10 w-16 rounded border border-s-border bg-s-elevated object-contain" />
                          <span>Built-in picture in use.</span>
                        </div>
                      )}
                      {kit.images?.[im.key] && (
                        <button type="button" onClick={() => setIn('images', im.key, undefined)} className="mt-1 text-[11px] text-primary-ink hover:underline">Use the built-in picture</button>
                      )}
                    </Field>
                  )
                })}
              </Section>
            </div>
          </aside>

          {/* The brand's real home page, painted with the unsaved kit */}
          <section className={`min-w-0 h-[70vh] min-h-[480px] lg:min-h-[480px] ${pane}`} aria-label="Live page">
            {designReady
              ? (
                <LiveCanvas ref={canvasRef} slug={homeSlug} doc={homeDoc} variant="a" fonts={frameFonts} labels={noLabels} kit={frameKit}
                  selection={{ id: null, source: 'admin', nonce: 0 }} hover={{ id: null, source: 'admin' }}
                  onSelect={noop} onHover={noop}
                  onOpenContext={(target) => {
                    if (dirty && !confirm('You have unsaved changes on this kit. Leave without saving them?')) return
                    router.push(`/storefront/pages/${encodeURIComponent(target)}`)
                  }}
                  onMotionPreviewEnded={noop} onRendered={noop} onStatus={setFrame} onReconnect={noop} />
              )
              : (
                <div className="flex h-full items-center justify-center rounded-xl border border-s-border bg-s-bg-soft p-6">
                  <p className="max-w-md text-center text-sm text-s-muted">
                    {home.isError ? `The ${brandName} home page could not be loaded.` : 'Loading the page...'}
                  </p>
                </div>
              )}
            {frame.connection === 'live' && <span className="sr-only">Live preview connected</span>}
          </section>
        </div>
      )}

      {showVersions && (
        <VersionsDrawer slug={slug} isAdmin={isAdmin} liveVersion={row?.liveVersion ?? null}
          onClose={() => setShowVersions(false)}
          onRolledBack={() => { setFlash({ ok: true, text: 'Rolled back. The old version is live again.' }); invalidate(); void reloadFromServer() }} />
      )}
      {dialog === 'approve' && <ApproveDialog busy={busy === 'approve'} savesFirst={dirty || !hasDraft} onCancel={() => setDialog(null)} onApprove={onApprove} />}
      {dialog === 'reject' && <RejectDialog busy={busy === 'reject'} onCancel={() => setDialog(null)} onReject={onReject} />}
    </div>
  )
}

// ─── Form pieces ─────────────────────────────────────────────────────────────

/** One colour: swatch of what is in use now, the picker + hex box, and a
 *  "Default" button once it has been changed. The swatch is DATA (the brand's
 *  own colour), so it is drawn with an inline background. */
function ColourRow({ label, hint, def, value, onChange }: {
  label: string
  hint?: string
  def: string | undefined
  value: string | undefined
  onChange: (v: string | undefined) => void
}) {
  const shown = isHex6(value) ? value : def
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="flex items-center gap-2 min-w-0">
          <span className="h-4 w-4 shrink-0 rounded-full border border-s-border" style={shown ? { background: shown } : undefined} aria-hidden />
          <span className="text-[11px] text-s-muted font-semibold uppercase tracking-wider truncate">{label}</span>
        </span>
        {value
          ? <button type="button" onClick={() => onChange(undefined)} className="text-[11px] text-primary-ink hover:underline shrink-0">Default{def ? ` (${def})` : ''}</button>
          : <span className="text-[11px] text-s-dim shrink-0">Default{def ? ` · ${def}` : ''}</span>}
      </div>
      <ColorInput value={value} onChange={onChange} placeholder={def ?? '#000000'} fallback={def} />
      {value && !isHex6(value) && <p className="text-[11px] text-s-red mt-1">Use six digits, like #1a2b3c.</p>}
      {hint && <p className="text-[11px] text-s-dim mt-1">{hint}</p>}
    </div>
  )
}

/** Heading / body font: "Brand default", the built-in fonts the storefront
 *  lists, and the Library fonts of this brand's company (`library:<assetId>`). */
function KitFontSelect({ value, def, catalog, company, onChange }: {
  value: string | undefined
  def: string | undefined
  catalog: KitCatalog | undefined
  company: MediaAssetLite[]
  onChange: (v: string | undefined) => void
}) {
  const builtin = catalog?.fonts ?? []
  const label = (id: string | undefined) => (id ? builtin.find((f) => f.id === id)?.label ?? id : undefined)
  const known = value ? builtin.some((f) => f.id === value) || company.some((f) => libraryRef(f.id) === value) : true
  const preview = !value
    ? builtin.find((f) => f.id === def)?.stack
    : value.startsWith('library:')
      ? company.find((f) => libraryRef(f.id) === value)?.fontFamily ?? undefined
      : builtin.find((f) => f.id === value)?.stack
  return (
    <div className="space-y-1">
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className="s-select">
        <option value="">{def ? `Brand default (${label(def)})` : 'Brand default'}</option>
        {builtin.length > 0 && (
          <optgroup label="Built-in">
            {builtin.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </optgroup>
        )}
        {company.length > 0 && (
          <optgroup label="Library fonts">
            {company.map((f) => <option key={f.id} value={libraryRef(f.id)}>{f.fontFamily}</option>)}
          </optgroup>
        )}
        {value && !known && <option value={value}>{value} (not available)</option>}
      </select>
      {preview && <p className="text-sm text-s-text truncate" style={{ fontFamily: preview }}>The quick brown fox, 0123</p>}
    </div>
  )
}
