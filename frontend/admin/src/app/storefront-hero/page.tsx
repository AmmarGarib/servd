'use client'
// Landing Hero editor.
//
// Configures the scroll-expansion hero on the public storefront home page
// (servd-app.garibsons.app). Stored — like the rest of the storefront CMS —
// as a SiteLayout under the slug `servd:hero`, holding a single `scrollHero`
// block. The storefront reads it on each render; empty → food placeholders.

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const SLUG = 'servd:hero'

interface HeroForm {
  mediaType: 'image' | 'video'
  bgImageSrc: string
  mediaSrc: string
  posterSrc: string
  title: string
  date: string
  scrollToExpand: string
  textBlend: boolean
  overview: string
  conclusion: string
}

const EMPTY: HeroForm = {
  mediaType: 'image',
  bgImageSrc: '',
  mediaSrc: '',
  posterSrc: '',
  title: '',
  date: '',
  scrollToExpand: 'Scroll to explore',
  textBlend: true,
  overview: '',
  conclusion: '',
}

interface LayoutRow {
  slug: string
  title: string | null
  blocks: Array<Record<string, unknown>> | null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function formFromLayout(row: LayoutRow | undefined): HeroForm {
  const block = Array.isArray(row?.blocks)
    ? row!.blocks.find((b) => b?.['type'] === 'scrollHero')
    : undefined
  if (!block) return EMPTY
  return {
    mediaType: block['mediaType'] === 'video' ? 'video' : 'image',
    bgImageSrc: str(block['bgImageSrc']),
    mediaSrc: str(block['mediaSrc']),
    posterSrc: str(block['posterSrc']),
    title: str(block['title']),
    date: str(block['date']),
    scrollToExpand: str(block['scrollToExpand']) || 'Scroll to explore',
    textBlend: block['textBlend'] !== false,
    overview: str(block['overview']),
    conclusion: str(block['conclusion']),
  }
}

// Presigned R2 upload (mirrors the brand-editor logo uploader).
async function uploadToR2(file: File): Promise<string> {
  const token = useAuthStore.getState().token
  const qs = new URLSearchParams({
    filename: file.name,
    contentType: file.type,
    category: 'marketing',
  })
  const res = await fetch(`${API_URL}/api/v1/media/upload-url?${qs.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to get upload URL')
  const { uploadUrl, publicUrl } = (await res.json()) as { uploadUrl: string; publicUrl: string }
  const put = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
  if (!put.ok) throw new Error('Upload to storage failed')
  return publicUrl
}

export default function StorefrontHeroPage() {
  const qc = useQueryClient()
  const [form, setForm] = useState<HeroForm>(EMPTY)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const { data: row, isLoading } = useQuery<LayoutRow>({
    queryKey: ['site-layout', SLUG],
    queryFn: () => api.get<LayoutRow>(`/site-layouts/${SLUG}`),
  })

  // react-query v5 dropped onSuccess — sync the form when the row arrives.
  useEffect(() => {
    if (row) setForm(formFromLayout(row))
  }, [row])

  const save = useMutation({
    mutationFn: () =>
      api.put(`/site-layouts/${SLUG}`, {
        title: 'Landing hero',
        blocks: [
          {
            id: 'hero',
            type: 'scrollHero',
            mediaType: form.mediaType,
            bgImageSrc: form.bgImageSrc.trim(),
            mediaSrc: form.mediaSrc.trim(),
            posterSrc: form.posterSrc.trim(),
            title: form.title.trim(),
            date: form.date.trim(),
            scrollToExpand: form.scrollToExpand.trim(),
            textBlend: form.textBlend,
            overview: form.overview.trim(),
            conclusion: form.conclusion.trim(),
          },
        ],
      }),
    onSuccess: () => {
      setSavedAt(Date.now())
      void qc.invalidateQueries({ queryKey: ['site-layout', SLUG] })
    },
  })

  const reset = useMutation({
    mutationFn: () => api.delete(`/site-layouts/${SLUG}`),
    onSuccess: () => {
      setForm(EMPTY)
      void qc.invalidateQueries({ queryKey: ['site-layout', SLUG] })
    },
  })

  const up = (patch: Partial<HeroForm>) => setForm((f) => ({ ...f, ...patch }))

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Marketing</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Landing Hero</h1>
        <p className="text-sm text-white/40 mt-1">
          The scroll-expansion hero at the top of the public storefront home page. Pick a background
          picture and the photo/video that expands as visitors scroll.
        </p>
      </header>

      <div className="max-w-3xl mx-auto p-7 space-y-5">
        {isLoading ? (
          <p className="text-sm text-white/40">Loading…</p>
        ) : (
          <>
            {/* Media type */}
            <Section title="Hero media" subtitle="The element that expands as the visitor scrolls.">
              <Field label="Type">
                <div className="flex gap-4 mt-1">
                  {(['image', 'video'] as const).map((t) => (
                    <label key={t} className="flex items-center gap-2 text-sm text-white/75 cursor-pointer">
                      <input
                        type="radio"
                        name="mediaType"
                        checked={form.mediaType === t}
                        onChange={() => up({ mediaType: t })}
                        className="accent-kds-green"
                      />
                      <span className="capitalize">{t}</span>
                    </label>
                  ))}
                </div>
              </Field>

              {form.mediaType === 'image' ? (
                <MediaField
                  label="Foreground image"
                  hint="The photo that expands to fill the screen. Landscape works best."
                  accept="image/*"
                  value={form.mediaSrc}
                  onChange={(v) => up({ mediaSrc: v })}
                />
              ) : (
                <>
                  <MediaField
                    label="Video"
                    hint="MP4/WebM upload, a direct video URL, or a YouTube link (watch?v=… or /embed/…). Autoplays muted + looped."
                    accept="video/mp4,video/webm,video/quicktime"
                    value={form.mediaSrc}
                    onChange={(v) => up({ mediaSrc: v })}
                  />
                  <MediaField
                    label="Video poster (optional)"
                    hint="Still image shown while the video loads."
                    accept="image/*"
                    value={form.posterSrc}
                    onChange={(v) => up({ posterSrc: v })}
                  />
                </>
              )}
            </Section>

            {/* Background */}
            <Section title="Background" subtitle="Full-bleed image behind the hero. Fades out as the media expands.">
              <MediaField
                label="Background image"
                hint="A moody, full-screen food or restaurant shot reads best."
                accept="image/*"
                value={form.bgImageSrc}
                onChange={(v) => up({ bgImageSrc: v })}
              />
            </Section>

            {/* Copy */}
            <Section title="Text" subtitle="Headline + supporting copy. Leave blank to use food placeholders.">
              <Field label="Title" hint="The big headline. The first word animates apart from the rest.">
                <input className="s-input w-full" value={form.title} onChange={(e) => up({ title: e.target.value })}
                  placeholder="Seven kitchens one table" />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Eyebrow label" hint="Small line above the title.">
                  <input className="s-input w-full" value={form.date} onChange={(e) => up({ date: e.target.value })}
                    placeholder="GS Foods · Karachi" />
                </Field>
                <Field label="Scroll hint" hint="The 'scroll to expand' prompt.">
                  <input className="s-input w-full" value={form.scrollToExpand} onChange={(e) => up({ scrollToExpand: e.target.value })}
                    placeholder="Scroll to explore" />
                </Field>
              </div>
              <Field label="Intro (shown after the hero expands)">
                <textarea className="s-input w-full resize-none" rows={3} value={form.overview} onChange={(e) => up({ overview: e.target.value })}
                  placeholder="One operator, our own riders, zero aggregator commission…" />
              </Field>
              <Field label="Sub-intro (optional)">
                <textarea className="s-input w-full resize-none" rows={2} value={form.conclusion} onChange={(e) => up({ conclusion: e.target.value })}
                  placeholder="Simmer, Stax, Flipd and more — order direct…" />
              </Field>
              <Field label="Text blend">
                <label className="flex items-center gap-2 mt-1 text-xs text-white/65 cursor-pointer">
                  <input type="checkbox" checked={form.textBlend} onChange={(e) => up({ textBlend: e.target.checked })} className="accent-kds-green" />
                  Blend the title against the background (mix-blend) for contrast
                </label>
              </Field>
            </Section>

            {/* Actions */}
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50"
              >
                {save.isPending ? 'Saving…' : 'Save hero'}
              </button>
              <button
                onClick={() => { if (confirm('Reset the hero to food placeholders?')) reset.mutate() }}
                disabled={reset.isPending}
                className="rounded-xl px-4 py-2.5 text-sm font-bold text-white/70 hover:text-white border border-white/10 hover:border-white/25 disabled:opacity-50"
              >
                {reset.isPending ? 'Resetting…' : 'Reset to placeholders'}
              </button>
              <Link href="https://servd-app.garibsons.app" target="_blank" rel="noreferrer"
                className="text-xs text-white/45 hover:text-white underline underline-offset-4">
                Open storefront ↗
              </Link>
              {savedAt && Date.now() - savedAt < 4000 && <span className="text-sm text-kds-green">✓ Saved — live now</span>}
              {save.isError && <span className="text-sm text-red-400">{(save.error as Error)?.message ?? 'Save failed'}</span>}
            </div>

            <div className="rounded-xl p-4 text-xs text-white/55"
              style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.18)' }}>
              💡 Changes go live on the next storefront page load — no rebuild needed. The hero takes
              over scrolling until it&rsquo;s fully expanded, so keep the media impactful.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function MediaField({
  label, hint, accept, value, onChange,
}: {
  label: string
  hint?: string
  accept: string
  value: string
  onChange: (v: string) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState('')
  const isVideo = accept.startsWith('video')

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true); setErr('')
    try {
      const url = await uploadToR2(file)
      onChange(url)
    } catch {
      setErr('Upload failed — check R2 setup in Configuration → Integrations')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  return (
    <Field label={label} hint={hint}>
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <input
            className="s-input w-full"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="https://…  (or upload →)"
          />
          <label className="inline-block cursor-pointer rounded-lg bg-white/5 hover:bg-white/10 px-3 py-1.5 text-xs font-bold text-white/85">
            {uploading ? 'Uploading…' : '📤 Upload file'}
            <input type="file" accept={accept} className="sr-only" onChange={onFile} />
          </label>
          {err && <p className="text-[10px] text-kds-red">{err}</p>}
        </div>
        {value && (
          <div className="h-16 w-24 shrink-0 rounded-lg overflow-hidden border border-white/10 bg-black/30 flex items-center justify-center">
            {isVideo ? (
              <video src={value} className="h-full w-full object-cover" muted playsInline />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={value} alt="preview" className="h-full w-full object-cover" />
            )}
          </div>
        )}
      </div>
    </Field>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5 space-y-4"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div>
        <h3 className="font-black text-white/90">{title}</h3>
        {subtitle && <p className="text-xs text-white/45 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-white/55 block mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-white/35 mt-1">{hint}</p>}
    </div>
  )
}
