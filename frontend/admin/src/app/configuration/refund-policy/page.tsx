'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Policy {
  id: string
  cashierVoidLimitCents: number
  cashierCompLimitCents: number
  cashierRefundLimitCents: number
  managerVoidLimitCents: number
  managerCompLimitCents: number
  managerRefundLimitCents: number
  requireReason: boolean
  requirePhotoEvidence: boolean
  notifyOwnerAboveCents: number | null
  approverEmail: string | null
  notes: string | null
}

export default function RefundPolicyPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<Policy>({
    queryKey: ['refund-policy'],
    queryFn: () => api.get('/setup/refund-policy'),
  })

  const [form, setForm] = useState<Partial<Policy>>({})

  useEffect(() => { if (data) setForm(data) }, [data])

  const save = useMutation({
    mutationFn: () => api.patch('/setup/refund-policy', form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['refund-policy'] }) },
  })

  if (isLoading) return <div className="p-8 text-white/60">Loading…</div>

  function patch<K extends keyof Policy>(k: K, v: Policy[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">⚖️ Refund / void / comp policy</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Per-role caps for voids, comps, and refunds. Anything above the cap requires manager override.
          Owner notifications fire above the threshold.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-6">
        <Section title="Cashier limits" desc="What cashiers can do without manager approval">
          <Money label="Void limit (paisa)" value={form.cashierVoidLimitCents ?? 0} onChange={(v) => patch('cashierVoidLimitCents', v)} />
          <Money label="Comp limit (paisa)" value={form.cashierCompLimitCents ?? 0} onChange={(v) => patch('cashierCompLimitCents', v)} />
          <Money label="Refund limit (paisa)" value={form.cashierRefundLimitCents ?? 0} onChange={(v) => patch('cashierRefundLimitCents', v)} />
        </Section>

        <Section title="Manager limits" desc="Higher cap before owner approval kicks in">
          <Money label="Void limit (paisa)" value={form.managerVoidLimitCents ?? 0} onChange={(v) => patch('managerVoidLimitCents', v)} />
          <Money label="Comp limit (paisa)" value={form.managerCompLimitCents ?? 0} onChange={(v) => patch('managerCompLimitCents', v)} />
          <Money label="Refund limit (paisa)" value={form.managerRefundLimitCents ?? 0} onChange={(v) => patch('managerRefundLimitCents', v)} />
        </Section>

        <Section title="Audit trail">
          <Toggle label="Require reason" hint="Force a reason when voiding/comping/refunding" checked={!!form.requireReason} onChange={(v) => patch('requireReason', v)} />
          <Toggle label="Require photo evidence" hint="Make staff snap a photo of damaged item" checked={!!form.requirePhotoEvidence} onChange={(v) => patch('requirePhotoEvidence', v)} />
        </Section>

        <Section title="Owner alert">
          <Money label="Notify owner above (paisa)" value={form.notifyOwnerAboveCents ?? 0} onChange={(v) => patch('notifyOwnerAboveCents', v || null)} optional />
          <div>
            <label className="text-xs text-white/55">Approver email</label>
            <input value={form.approverEmail ?? ''} onChange={(e) => patch('approverEmail', e.target.value || null)} placeholder="owner@yourbrand.pk" className={fieldCls + ' mt-1'} />
          </div>
        </Section>

        <div>
          <label className="text-xs text-white/55">Notes</label>
          <textarea value={form.notes ?? ''} onChange={(e) => patch('notes', e.target.value || null)} rows={2}
            className={fieldCls + ' mt-1'} placeholder="Internal notes / SOP reference" />
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.05]">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
      {desc && <p className="text-xs text-white/35 mt-0.5">{desc}</p>}
      <div className="mt-4 space-y-3">{children}</div>
    </div>
  )
}

function Money({ label, value, onChange, optional }: { label: string; value: number | null; onChange: (v: number) => void; optional?: boolean }) {
  return (
    <div>
      <label className="text-xs text-white/55">{label}{optional && <span className="text-white/30"> (0 = off)</span>}</label>
      <input type="number" value={value ?? 0} onChange={(e) => onChange(parseInt(e.target.value) || 0)} className={fieldCls + ' mt-1'} />
      <p className="text-[10px] text-white/30 mt-1">≈ PKR {((value ?? 0) / 100).toFixed(0)}</p>
    </div>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-primary mt-0.5" />
      <div>
        <p className="text-sm text-white/85">{label}</p>
        {hint && <p className="text-[11px] text-white/40">{hint}</p>}
      </div>
    </label>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
