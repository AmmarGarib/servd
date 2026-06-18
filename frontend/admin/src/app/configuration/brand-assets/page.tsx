'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Cfg {
  id: string
  secondaryColors: string[]
  fontHeading: string | null
  fontBody: string | null
  brandVoiceNotes: string | null
  socialInstagramHandle: string | null
  socialTiktokHandle: string | null
  socialFacebookUrl: string | null
}

const FONT_OPTIONS = ['Inter', 'Playfair Display', 'Montserrat', 'Poppins', 'Lora', 'Libre Baskerville', 'Plus Jakarta Sans', 'Nastaliq Urdu']

export default function BrandAssetsPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<Cfg>({ queryKey: ['operations-config'], queryFn: () => api.get('/setup/operations-config') })
  const [form, setForm] = useState<Partial<Cfg>>({})
  useEffect(() => { if (data) setForm(data) }, [data])
  const save = useMutation({
    mutationFn: () => api.patch('/setup/operations-config', form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operations-config'] }),
  })

  if (isLoading) return <div className="p-8 text-white/60">Loading…</div>
  function patch<K extends keyof Cfg>(k: K, v: Cfg[K]) { setForm((p) => ({ ...p, [k]: v })) }

  const colors = form.secondaryColors ?? []
  function addColor() { patch('secondaryColors', [...colors, '#ffffff']) }
  function updateColor(i: number, v: string) { patch('secondaryColors', colors.map((c, idx) => idx === i ? v : c)) }
  function rmColor(i: number) { patch('secondaryColors', colors.filter((_, idx) => idx !== i)) }

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">🎨 Brand assets</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Extended brand palette, fonts, voice guidelines, social handles. Used across storefronts, receipts, and marketing collateral.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-6">
        <Section title="Secondary palette" desc="Beyond the primary brand color (set per concept)">
          <div className="space-y-2">
            {colors.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="color" value={c} onChange={(e) => updateColor(i, e.target.value)} className="w-12 h-10 rounded cursor-pointer bg-transparent" />
                <input value={c} onChange={(e) => updateColor(i, e.target.value)} className={fieldCls + ' font-mono flex-1'} />
                <button onClick={() => rmColor(i)} className="text-white/40 hover:text-red-400 px-2">✕</button>
              </div>
            ))}
            <button onClick={addColor} className="text-xs text-kds-green hover:underline">+ Add color</button>
          </div>
        </Section>

        <Section title="Typography">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Heading font">
              <select value={form.fontHeading ?? ''} onChange={(e) => patch('fontHeading', e.target.value || null)} className={fieldCls}>
                <option value="">System default</option>
                {FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
            <Field label="Body font">
              <select value={form.fontBody ?? ''} onChange={(e) => patch('fontBody', e.target.value || null)} className={fieldCls}>
                <option value="">System default</option>
                {FONT_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Field>
          </div>
        </Section>

        <Section title="Brand voice" desc="Tone-of-voice guidance for marketing copy and customer messaging">
          <Field label="Voice notes">
            <textarea value={form.brandVoiceNotes ?? ''} onChange={(e) => patch('brandVoiceNotes', e.target.value || null)} rows={5}
              placeholder="Warm, casual, punny but never corny. We avoid food-snob vocabulary. Always end DMs with the chef's first name." className={fieldCls} />
          </Field>
        </Section>

        <Section title="Social handles" desc="Surfaced in receipt footers + auto-included in marketing posts">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Instagram">
              <input value={form.socialInstagramHandle ?? ''} onChange={(e) => patch('socialInstagramHandle', e.target.value || null)} placeholder="@stax_kitchen" className={fieldCls} />
            </Field>
            <Field label="TikTok">
              <input value={form.socialTiktokHandle ?? ''} onChange={(e) => patch('socialTiktokHandle', e.target.value || null)} placeholder="@stax_kitchen" className={fieldCls} />
            </Field>
          </div>
          <Field label="Facebook URL">
            <input value={form.socialFacebookUrl ?? ''} onChange={(e) => patch('socialFacebookUrl', e.target.value || null)} placeholder="https://facebook.com/staxkitchen" className={fieldCls} />
          </Field>
        </Section>

        <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.05]">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save assets'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
      {desc && <p className="text-xs text-white/35 mt-0.5">{desc}</p>}
      <div className="mt-4 space-y-3">{children}</div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
