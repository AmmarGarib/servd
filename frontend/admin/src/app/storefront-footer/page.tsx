'use client'
// Brand Footers editor.
//
// Per-brand microsite footer copy + social links. Stored — like the landing
// hero — as a SiteLayout under `brand:<slug>:footer` holding a single
// `brandFooter` block. The storefront BrandFooter reads it and merges over
// concept-derived defaults; the brand colour is themed automatically, so these
// fields only control the words + links.

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'
import { brandPalette } from '../../lib/brandPalettes'

interface Concept { id: string; name: string; slug: string; primaryColor: string | null }

interface FooterForm {
  ctaEyebrow: string
  ctaHeadline: string
  ctaAccent: string
  tagline: string
  instagram: string
  tiktok: string
  facebook: string
  whatsapp: string
}

const EMPTY: FooterForm = {
  ctaEyebrow: '', ctaHeadline: '', ctaAccent: '', tagline: '',
  instagram: '', tiktok: '', facebook: '', whatsapp: '',
}

interface LayoutRow { slug: string; title: string | null; blocks: Array<Record<string, unknown>> | null }

function str(v: unknown): string { return typeof v === 'string' ? v : '' }

function formFromLayout(row: LayoutRow | undefined): FooterForm {
  const block = Array.isArray(row?.blocks)
    ? row!.blocks.find((b) => b?.['type'] === 'brandFooter')
    : undefined
  if (!block) return EMPTY
  const social = (block['social'] && typeof block['social'] === 'object')
    ? block['social'] as Record<string, unknown>
    : {}
  return {
    ctaEyebrow:  str(block['ctaEyebrow']),
    ctaHeadline: str(block['ctaHeadline']),
    ctaAccent:   str(block['ctaAccent']),
    tagline:     str(block['tagline']),
    instagram:   str(social['instagram']),
    tiktok:      str(social['tiktok']),
    facebook:    str(social['facebook']),
    whatsapp:    str(social['whatsapp']),
  }
}

export default function BrandFooterPage() {
  const qc = useQueryClient()
  const [slug, setSlug] = useState<string | null>(null)
  const [form, setForm] = useState<FooterForm>(EMPTY)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  // Default-select the first brand once the list loads.
  useEffect(() => {
    if (!slug && concepts.length > 0) setSlug(concepts[0]!.slug)
  }, [concepts, slug])

  const layoutSlug = slug ? `brand:${slug}:footer` : ''

  const { data: row, isLoading } = useQuery<LayoutRow>({
    queryKey: ['site-layout', layoutSlug],
    queryFn: () => api.get<LayoutRow>(`/site-layouts/${layoutSlug}`),
    enabled: !!slug,
  })

  useEffect(() => { setForm(formFromLayout(row)) }, [row])

  const save = useMutation({
    mutationFn: () => api.put(`/site-layouts/${layoutSlug}`, {
      title: `Footer · ${slug}`,
      blocks: [{
        id: 'footer', type: 'brandFooter',
        ctaEyebrow:  form.ctaEyebrow.trim(),
        ctaHeadline: form.ctaHeadline.trim(),
        ctaAccent:   form.ctaAccent.trim(),
        tagline:     form.tagline.trim(),
        social: {
          instagram: form.instagram.trim(),
          tiktok:    form.tiktok.trim(),
          facebook:  form.facebook.trim(),
          whatsapp:  form.whatsapp.trim(),
        },
      }],
    }),
    onSuccess: () => {
      setSavedAt(Date.now())
      void qc.invalidateQueries({ queryKey: ['site-layout', layoutSlug] })
    },
  })

  const reset = useMutation({
    mutationFn: () => api.delete(`/site-layouts/${layoutSlug}`),
    onSuccess: () => {
      setForm(EMPTY)
      void qc.invalidateQueries({ queryKey: ['site-layout', layoutSlug] })
    },
  })

  const up = (patch: Partial<FooterForm>) => setForm((f) => ({ ...f, ...patch }))
  const selected = concepts.find((c) => c.slug === slug)

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Storefront</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Brand Footers</h1>
        <p className="text-sm text-white/40 mt-1">
          Footer copy + social links for each brand microsite. The footer takes the brand colour
          automatically — these fields control the words. Blank fields fall back to the brand defaults.
        </p>
      </header>

      <div className="max-w-3xl mx-auto p-7 space-y-5">
        {/* Brand selector */}
        <div className="flex items-center gap-2 flex-wrap">
          {concepts.map((c) => (
            <button key={c.id} onClick={() => setSlug(c.slug)}
              className={`rounded-lg px-3 py-2 text-sm font-bold transition-colors ${c.slug === slug ? 'bg-kds-green text-black' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}>
              <span className="inline-block h-2.5 w-2.5 rounded-full mr-2 align-middle" style={{ background: brandPalette(c.slug)?.accent ?? c.primaryColor ?? '#888' }} />
              {c.name}
            </button>
          ))}
        </div>

        {!slug ? (
          <p className="text-sm text-white/40">Pick a brand to edit its footer.</p>
        ) : isLoading ? (
          <p className="text-sm text-white/40">Loading…</p>
        ) : (
          <>
            <Section title="Call to action" subtitle="The banner at the top of the footer.">
              <Field label="Eyebrow" hint="Small line above the headline.">
                <input className="s-input w-full" value={form.ctaEyebrow} onChange={(e) => up({ ctaEyebrow: e.target.value })}
                  placeholder={selected ? `${selected.name.toLowerCase()} · ready when you are` : ''} />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Headline" hint="Plain part.">
                  <input className="s-input w-full" value={form.ctaHeadline} onChange={(e) => up({ ctaHeadline: e.target.value })} placeholder="Hungry?" />
                </Field>
                <Field label="Headline accent" hint="Shown in the brand colour.">
                  <input className="s-input w-full" value={form.ctaAccent} onChange={(e) => up({ ctaAccent: e.target.value })} placeholder="Let's eat." />
                </Field>
              </div>
            </Section>

            <Section title="About" subtitle="Short blurb under the wordmark.">
              <Field label="Tagline">
                <textarea className="s-input w-full resize-none" rows={2} value={form.tagline} onChange={(e) => up({ tagline: e.target.value })}
                  placeholder={selected ? 'A line about the brand…' : ''} />
              </Field>
            </Section>

            <Section title="Social links" subtitle="Paste the full URL. Leave blank to hide that icon.">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Instagram"><input className="s-input w-full" value={form.instagram} onChange={(e) => up({ instagram: e.target.value })} placeholder="https://instagram.com/…" /></Field>
                <Field label="TikTok"><input className="s-input w-full" value={form.tiktok} onChange={(e) => up({ tiktok: e.target.value })} placeholder="https://tiktok.com/@…" /></Field>
                <Field label="Facebook"><input className="s-input w-full" value={form.facebook} onChange={(e) => up({ facebook: e.target.value })} placeholder="https://facebook.com/…" /></Field>
                <Field label="WhatsApp"><input className="s-input w-full" value={form.whatsapp} onChange={(e) => up({ whatsapp: e.target.value })} placeholder="https://wa.me/92…" /></Field>
              </div>
            </Section>

            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={() => save.mutate()} disabled={save.isPending}
                className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
                {save.isPending ? 'Saving…' : 'Save footer'}
              </button>
              <button onClick={() => { if (confirm('Reset this brand footer to defaults?')) reset.mutate() }} disabled={reset.isPending}
                className="rounded-xl px-4 py-2.5 text-sm font-bold text-white/70 hover:text-white border border-white/10 hover:border-white/25 disabled:opacity-50">
                {reset.isPending ? 'Resetting…' : 'Reset to defaults'}
              </button>
              {slug && (
                <Link href={`https://servd-app.garibsons.app/brand/${slug}`} target="_blank" rel="noreferrer"
                  className="text-xs text-white/45 hover:text-white underline underline-offset-4">Open {selected?.name} ↗</Link>
              )}
              {savedAt && Date.now() - savedAt < 4000 && <span className="text-sm text-kds-green">✓ Saved — live now</span>}
              {save.isError && <span className="text-sm text-red-400">{(save.error as Error)?.message ?? 'Save failed'}</span>}
            </div>

            <div className="rounded-xl p-4 text-xs text-white/55" style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.18)' }}>
              💡 Blank fields fall back to the brand’s defaults (name + description). Changes go live on the next storefront page load — no rebuild needed.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Helpers (shared shape with the Landing Hero editor) ───────────────────────

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
