'use client'
// The storefront content Library (decision 41): images, videos, fonts and copy
// snippets in ONE place. The old /media page redirects here. Used two ways:
//   manage — the hub's Library tab: upload, add copy, edit, delete, filter
//   pick   — inside the page builder: same grid, narrowed to `kinds`, click to pick
//
// Uploads use the R2 presigned flow: GET /media/upload-url pre-creates the
// MediaAsset row and returns a presigned PUT; the file then goes straight to
// R2. If the PUT fails the pre-created row is removed so no dead tile appears.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

export type LibraryAsset = {
  id: string
  kind: 'image' | 'video' | 'font' | 'copy'
  name: string
  url: string
  filename: string
  contentType: string
  tags: string[]
  conceptId: string | null
  text: string | null
  fontFamily: string | null
  createdAt: string
}

type Kind = LibraryAsset['kind']
const ALL_KINDS: Kind[] = ['image', 'video', 'font', 'copy']
const KIND_LABEL: Record<Kind, string> = { image: 'Images', video: 'Videos', font: 'Fonts', copy: 'Copy' }
const VIDEO_MAX_BYTES = 50 * 1024 * 1024

interface ConceptLite { id: string; name: string; slug: string }

// Browsers often report '' for font files, so fall back to the extension.
const FONT_TYPES: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' }

function contentTypeFor(file: File): string {
  if (file.type) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return FONT_TYPES[ext] ?? 'application/octet-stream'
}

function kindFor(contentType: string, filename: string): Kind | null {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType === 'video/mp4' || contentType === 'video/webm') return 'video'
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (contentType.startsWith('font/') || contentType.includes('font') || ext in FONT_TYPES) return 'font'
  return null
}

function acceptFor(kinds: Kind[]): string {
  const parts: string[] = []
  if (kinds.includes('image')) parts.push('image/*')
  if (kinds.includes('video')) parts.push('video/mp4', 'video/webm')
  if (kinds.includes('font')) parts.push('.woff2', '.woff', '.ttf', '.otf', 'font/woff2', 'font/woff', 'font/ttf', 'font/otf')
  return parts.join(',')
}

/** "Amarante-Regular.woff2" -> "Amarante". Editable afterwards. */
function familyFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '')
  const trimmed = base.replace(/[-_ ]?(thin|hairline|extralight|ultralight|light|regular|book|normal|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique|variable|vf|\d{3})+$/gi, '')
  return (trimmed || base).replace(/[-_]+/g, ' ').trim()
}

function parseTags(input: string): string[] {
  return Array.from(new Set(input.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)))
}

/** Quote a value for CSS, stripping anything that could close the <style>. */
function cssString(s: string): string {
  return `"${s.replace(/[<>\n\r]/g, '').replace(/["\\]/g, '\\$&')}"`
}

function previewFamily(a: LibraryAsset): string {
  return a.fontFamily?.trim() || `servd-lib-${a.id}`
}

// The list endpoint moved from { data, hasMore } to a bare array; accept both,
// and fill the library fields legacy rows do not have.
type RawAsset = Partial<LibraryAsset> & { id: string; url: string; filename: string; contentType: string; createdAt: string }
function normalise(raw: RawAsset[] | { data: RawAsset[] } | undefined): LibraryAsset[] {
  const rows = Array.isArray(raw) ? raw : (raw?.data ?? [])
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind ?? kindFor(r.contentType, r.filename) ?? 'image',
    name: r.name || r.filename || 'Untitled',
    url: r.url ?? '',
    filename: r.filename ?? '',
    contentType: r.contentType ?? '',
    tags: r.tags ?? [],
    conceptId: r.conceptId ?? null,
    text: r.text ?? null,
    fontFamily: r.fontFamily ?? null,
    createdAt: r.createdAt,
  }))
}

export function LibraryPanel({
  mode = 'manage',
  kinds,
  onPick,
}: {
  mode?: 'manage' | 'pick'
  kinds?: Array<LibraryAsset['kind']>
  onPick?: (asset: LibraryAsset) => void
}) {
  const allowedKinds = kinds && kinds.length > 0 ? kinds : ALL_KINDS
  const qc = useQueryClient()

  const [kind, setKind] = useState<Kind | 'all'>(allowedKinds.length === 1 ? allowedKinds[0]! : 'all')
  const [brand, setBrand] = useState<string>('')          // '' = every brand
  const [tag, setTag] = useState<string>('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  const [editing, setEditing] = useState<LibraryAsset | null>(null)
  const [addingCopy, setAddingCopy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const { data: concepts = [] } = useQuery<ConceptLite[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get<ConceptLite[]>('/concepts'),
  })
  const brandName = useMemo(() => new Map(concepts.map((c) => [c.id, c.name])), [concepts])

  const params = new URLSearchParams()
  if (kind !== 'all') params.set('kind', kind)
  if (brand) params.set('conceptId', brand)
  if (tag) params.set('tag', tag)
  if (q) params.set('q', q)
  const qs = params.toString()

  const { data: raw, isLoading, isError } = useQuery<RawAsset[] | { data: RawAsset[] }>({
    queryKey: ['media', 'library', qs],
    queryFn: () => api.get(`/media${qs ? `?${qs}` : ''}`),
  })

  // Filter client-side too, so the grid is right even if a filter is not
  // honoured server-side, and pick mode never shows a kind it cannot use.
  const assets = useMemo(() => {
    const needle = q.toLowerCase()
    return normalise(raw).filter((a) =>
      allowedKinds.includes(a.kind)
      && (kind === 'all' || a.kind === kind)
      && (!tag || a.tags.includes(tag))
      && (!needle || a.name.toLowerCase().includes(needle) || a.filename.toLowerCase().includes(needle)
        || (a.text ?? '').toLowerCase().includes(needle) || a.tags.some((t) => t.includes(needle))),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, kind, tag, q, allowedKinds.join(',')])

  const tagOptions = useMemo(() => {
    const set = new Set<string>()
    for (const a of assets) for (const t of a.tags) set.add(t)
    if (tag) set.add(tag)
    return Array.from(set).sort()
  }, [assets, tag])

  // One @font-face per font asset so the tile previews the real family.
  const fontCss = useMemo(() => assets
    .filter((a) => a.kind === 'font' && a.url)
    .map((a) => `@font-face{font-family:${cssString(previewFamily(a))};src:url(${cssString(a.url)});font-display:swap}`)
    .join('\n'), [assets])

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['media'] })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/media/${id}`),
    onSuccess: invalidate,
    onError: (e: Error) => alert(e.message || 'Could not delete'),
  })

  function copyToClipboard(a: LibraryAsset) {
    const value = a.kind === 'copy' ? (a.text ?? '') : a.url
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(a.id)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const uploadKinds = allowedKinds.filter((k) => k !== 'copy')
  const kindTabs: Array<Kind | 'all'> = allowedKinds.length > 1 ? ['all', ...allowedKinds] : allowedKinds

  return (
    <div className="space-y-4">
      {fontCss && <style>{fontCss}</style>}

      {/* Add */}
      <div className="flex flex-wrap items-start gap-3">
        {uploadKinds.length > 0 && (
          <UploadBar kinds={uploadKinds} concepts={concepts} defaultBrand={brand} onDone={invalidate} />
        )}
        {allowedKinds.includes('copy') && (
          <button
            onClick={() => setAddingCopy(true)}
            className="rounded-xl border border-s-border bg-s-surface px-4 py-2 text-sm font-semibold text-s-text hover:border-primary"
          >
            New copy snippet
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {kindTabs.length > 1 && kindTabs.map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              k === kind ? 'bg-primary text-primary-on' : 'bg-s-surface text-s-muted hover:text-s-text'
            }`}
          >
            {k === 'all' ? 'All' : KIND_LABEL[k]}
          </button>
        ))}
        <select
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          className="rounded-lg border border-s-border bg-s-surface px-2 py-1.5 text-xs text-s-text focus:border-primary focus:outline-none"
        >
          <option value="">All brands</option>
          {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, tag, text"
          className="min-w-[12rem] flex-1 rounded-lg border border-s-border bg-s-surface px-3 py-1.5 text-xs text-s-text focus:border-primary focus:outline-none"
        />
      </div>
      {tagOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-s-muted">Tags</span>
          {tagOptions.map((t) => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? '' : t)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                tag === t ? 'bg-primary text-primary-on' : 'border border-s-border text-s-muted hover:text-s-text'
              }`}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      {isLoading && <p className="text-sm text-s-muted">Loading library…</p>}
      {isError && <p className="text-sm text-s-red">Could not load the library.</p>}
      {!isLoading && !isError && assets.length === 0 && (
        <div className="rounded-xl border border-dashed border-s-border py-14 text-center">
          <p className="text-sm font-semibold text-s-text">Nothing here yet</p>
          <p className="mt-1 text-xs text-s-muted">
            {q || tag || brand ? 'No asset matches these filters.' : 'Upload a file or add a copy snippet to start the library.'}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
        {assets.map((a) => {
          const body = (
            <>
              <AssetPreview asset={a} />
              <div className="space-y-1 p-2.5 text-left">
                <p className="truncate text-xs font-semibold text-s-text" title={a.name}>{a.name}</p>
                <p className="truncate text-[10px] text-s-muted">
                  {KIND_LABEL[a.kind].replace(/s$/, '')}
                  {' · '}
                  {a.conceptId ? (brandName.get(a.conceptId) ?? 'Brand') : 'Any brand'}
                  {a.kind === 'font' && a.fontFamily ? ` · ${a.fontFamily}` : ''}
                </p>
                {a.tags.length > 0 && (
                  <p className="truncate text-[10px] text-s-muted">{a.tags.map((t) => `#${t}`).join(' ')}</p>
                )}
              </div>
            </>
          )
          if (mode === 'pick') {
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onPick?.(a)}
                className="overflow-hidden rounded-xl border border-s-border bg-s-surface transition-colors hover:border-primary focus:border-primary focus:outline-none"
                title={`Use ${a.name}`}
              >
                {body}
              </button>
            )
          }
          return (
            <div key={a.id} className="group relative overflow-hidden rounded-xl border border-s-border bg-s-surface">
              {body}
              <div className="flex gap-1 border-t border-s-border p-1.5">
                <button onClick={() => copyToClipboard(a)}
                  className="flex-1 rounded-md py-1 text-[11px] font-semibold text-s-muted hover:bg-s-bg hover:text-s-text">
                  {copied === a.id ? 'Copied' : a.kind === 'copy' ? 'Copy text' : 'Copy URL'}
                </button>
                <button onClick={() => setEditing(a)}
                  className="flex-1 rounded-md py-1 text-[11px] font-semibold text-s-muted hover:bg-s-bg hover:text-s-text">
                  Edit
                </button>
                <button
                  onClick={() => { if (confirm(`Remove "${a.name}" from the library? Pages that use it will lose it.`)) remove.mutate(a.id) }}
                  className="rounded-md px-2 py-1 text-[11px] font-semibold text-s-red hover:bg-s-red/10">
                  Delete
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {editing && (
        <EditAssetModal asset={editing} concepts={concepts} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate() }} />
      )}
      {addingCopy && (
        <CopySnippetModal concepts={concepts} defaultBrand={brand} onClose={() => setAddingCopy(false)} onSaved={() => { setAddingCopy(false); invalidate() }} />
      )}
    </div>
  )
}

// ─── Tile preview ──────────────────────────────────────────────────────────────

function AssetPreview({ asset: a }: { asset: LibraryAsset }) {
  if (a.kind === 'image') {
    return <img src={a.url} alt={a.name} loading="lazy" className="h-32 w-full bg-s-bg object-cover" />
  }
  if (a.kind === 'video') {
    return (
      <video
        src={a.url}
        muted
        loop
        playsInline
        preload="metadata"
        onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
        onMouseLeave={(e) => e.currentTarget.pause()}
        className="h-32 w-full bg-black object-cover"
      />
    )
  }
  if (a.kind === 'font') {
    return (
      <div className="flex h-32 flex-col justify-center gap-1 bg-s-bg px-3 text-s-text"
        style={{ fontFamily: `${cssString(previewFamily(a))}, sans-serif` }}>
        <span className="text-3xl leading-none">Aa Bb</span>
        <span className="truncate text-xs">the quick brown fox jumps</span>
      </div>
    )
  }
  return (
    <div className="h-32 overflow-hidden bg-s-bg px-3 py-2.5">
      <p className="line-clamp-5 whitespace-pre-line text-xs text-s-text">{a.text || 'Empty snippet'}</p>
    </div>
  )
}

// ─── Upload ────────────────────────────────────────────────────────────────────

function UploadBar({ kinds, concepts, defaultBrand, onDone }: {
  kinds: Kind[]
  concepts: ConceptLite[]
  defaultBrand: string
  onDone: () => void
}) {
  const [brand, setBrand] = useState(defaultBrand)
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  async function uploadOne(file: File) {
    const contentType = contentTypeFor(file)
    const kind = kindFor(contentType, file.name)
    if (!kind || !kinds.includes(kind)) throw new Error(`${file.name}: not a supported ${kinds.join(' / ')} file`)
    if (kind === 'video' && file.size > VIDEO_MAX_BYTES) throw new Error(`${file.name}: videos must be 50 MB or less — trim or compress it first`)

    const name = file.name.replace(/\.[^.]+$/, '')
    const tagList = parseTags(tags)
    const fontFamily = kind === 'font' ? familyFromFilename(file.name) : undefined
    const params = new URLSearchParams({ filename: file.name, contentType, category: 'general', kind, name })
    if (tagList.length) params.set('tags', tagList.join(','))
    if (brand) params.set('conceptId', brand)
    if (fontFamily) params.set('fontFamily', fontFamily)

    const { uploadUrl, assetId } = await api.get<{ uploadUrl: string; publicUrl: string; assetId?: string }>(`/media/upload-url?${params}`)
    const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': contentType } }).catch(() => null)
    if (!put || !put.ok) {
      if (assetId) await api.delete(`/media/${assetId}`).catch(() => undefined)
      throw new Error(`${file.name}: upload to storage failed`)
    }
    // Library fields ride on the create step; set them again in case this
    // API build only stores the file fields there.
    if (assetId) {
      await api.patch(`/media/${assetId}`, {
        name, tags: tagList, conceptId: brand || null, ...(fontFamily ? { fontFamily } : {}),
      }).catch(() => undefined)
    }
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    setError('')
    const failures: string[] = []
    for (const [i, file] of files.entries()) {
      setBusy(`Uploading ${i + 1} of ${files.length}…`)
      try { await uploadOne(file) } catch (err) { failures.push((err as Error).message) }
    }
    setBusy(null)
    if (failures.length) setError(failures.join(' · '))
    if (inputRef.current) inputRef.current.value = ''
    onDone()
  }

  const label = kinds.length === 1 ? `Upload ${KIND_LABEL[kinds[0]!].toLowerCase()}` : 'Upload files'

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2 rounded-xl border border-s-border bg-s-surface p-2">
      <label className={`cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-on hover:opacity-90 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
        {busy ?? label}
        <input ref={inputRef} type="file" multiple accept={acceptFor(kinds)} className="sr-only" onChange={(e) => void handleFiles(e)} />
      </label>
      <select value={brand} onChange={(e) => setBrand(e.target.value)}
        className="rounded-lg border border-s-border bg-s-bg px-2 py-2 text-xs text-s-text focus:border-primary focus:outline-none"
        title="Brand the upload is for">
        <option value="">For any brand</option>
        {concepts.map((c) => <option key={c.id} value={c.id}>For {c.name}</option>)}
      </select>
      <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags, comma separated"
        className="min-w-[10rem] flex-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-xs text-s-text focus:border-primary focus:outline-none" />
      <span className="text-[10px] text-s-muted">
        {[kinds.includes('image') && 'images', kinds.includes('video') && 'MP4/WebM up to 50 MB', kinds.includes('font') && 'WOFF2/WOFF/TTF/OTF'].filter(Boolean).join(' · ')}
      </span>
      {error && <p className="basis-full text-xs text-s-red">{error}</p>}
    </div>
  )
}

// ─── Modals ────────────────────────────────────────────────────────────────────

const inputCls = 'mt-1 w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none'

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className="max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-2xl border border-s-border bg-s-surface p-5"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-s-text">{title}</h2>
          <button onClick={onClose} className="text-sm text-s-muted hover:text-s-text" aria-label="Close">Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function BrandSelect({ value, onChange, concepts }: { value: string; onChange: (v: string) => void; concepts: ConceptLite[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">Any brand</option>
      {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  )
}

function EditAssetModal({ asset, concepts, onClose, onSaved }: {
  asset: LibraryAsset; concepts: ConceptLite[]; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(asset.name)
  const [tags, setTags] = useState(asset.tags.join(', '))
  const [brand, setBrand] = useState(asset.conceptId ?? '')
  const [fontFamily, setFontFamily] = useState(asset.fontFamily ?? '')
  const [text, setText] = useState(asset.text ?? '')

  const save = useMutation({
    mutationFn: () => api.patch(`/media/${asset.id}`, {
      name: name.trim() || asset.filename,
      tags: parseTags(tags),
      conceptId: brand || null,
      ...(asset.kind === 'font' ? { fontFamily: fontFamily.trim() || null } : {}),
      ...(asset.kind === 'copy' ? { text } : {}),
    }),
    onSuccess: onSaved,
  })

  return (
    <Modal title={`Edit ${asset.kind === 'copy' ? 'snippet' : asset.kind}`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-xs text-s-muted">Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </label>
        {asset.kind === 'copy' && (
          <label className="block text-xs text-s-muted">Text
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} className={`${inputCls} resize-y`} />
          </label>
        )}
        {asset.kind === 'font' && (
          <label className="block text-xs text-s-muted">Font family
            <input value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} placeholder="e.g. Amarante" className={inputCls} />
            <span className="mt-1 block text-[10px]">The name pages use to pick this font. Keep it the same across a family&apos;s weights.</span>
          </label>
        )}
        <label className="block text-xs text-s-muted">Brand
          <BrandSelect value={brand} onChange={setBrand} concepts={concepts} />
        </label>
        <label className="block text-xs text-s-muted">Tags
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ramadan, hero, menu" className={inputCls} />
        </label>
        {asset.kind !== 'copy' && (
          <p className="truncate text-[10px] text-s-muted" title={asset.url}>{asset.filename} · {asset.contentType}</p>
        )}
      </div>
      {save.isError && <p className="text-xs text-s-red">{(save.error as Error).message || 'Save failed'}</p>}
      <div className="flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-xl border border-s-border py-2 text-sm text-s-muted hover:text-s-text">Cancel</button>
        <button onClick={() => save.mutate()} disabled={save.isPending}
          className="flex-1 rounded-xl bg-primary py-2 text-sm font-bold text-primary-on hover:opacity-90 disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}

function CopySnippetModal({ concepts, defaultBrand, onClose, onSaved }: {
  concepts: ConceptLite[]; defaultBrand: string; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [tags, setTags] = useState('')
  const [brand, setBrand] = useState(defaultBrand)

  const create = useMutation({
    mutationFn: () => api.post('/media/copy', {
      name: name.trim(), text, tags: parseTags(tags), ...(brand ? { conceptId: brand } : {}),
    }),
    onSuccess: onSaved,
  })
  const canSave = name.trim().length > 0 && text.trim().length > 0

  return (
    <Modal title="New copy snippet" onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-xs text-s-muted">Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ramadan hero line" className={inputCls} />
        </label>
        <label className="block text-xs text-s-muted">Text
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} className={`${inputCls} resize-y`} />
        </label>
        <label className="block text-xs text-s-muted">Brand
          <BrandSelect value={brand} onChange={setBrand} concepts={concepts} />
        </label>
        <label className="block text-xs text-s-muted">Tags
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ramadan, hero" className={inputCls} />
        </label>
      </div>
      {create.isError && <p className="text-xs text-s-red">{(create.error as Error).message || 'Could not save'}</p>}
      <div className="flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-xl border border-s-border py-2 text-sm text-s-muted hover:text-s-text">Cancel</button>
        <button onClick={() => create.mutate()} disabled={!canSave || create.isPending}
          className="flex-1 rounded-xl bg-primary py-2 text-sm font-bold text-primary-on hover:opacity-90 disabled:opacity-50">
          {create.isPending ? 'Saving…' : 'Add snippet'}
        </button>
      </div>
    </Modal>
  )
}
