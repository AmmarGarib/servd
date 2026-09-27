'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Cfg {
  id: string
  serviceChargePct: number
  serviceChargeAppliesToChannels: string[]
  tipPoolEnabled: boolean
  tipPoolDistribution: 'equal' | 'by_hours' | 'by_role_weight'
  tipPoolRoleWeights: Record<string, number> | null
  invoiceSequenceReset: 'yearly' | 'monthly' | 'never'
  invoiceCreditNotePrefix: string | null
  withholdingTaxEnabled: boolean
  withholdingTaxPct: number
  withholdingTaxRecoverable: boolean
  geofenceEnforced: boolean
  geofenceRadiusMetres: number
  selfieRequiredAtClockIn: boolean
}

// Who is in the tip pool and at what weight (decision 36). Mirrors
// TIP_POOL_DEFAULT_WEIGHTS in backend/src/lib/setup-config.ts — these only
// fill the editor for a role the company has not set.
const TIP_ROLES: Array<{ key: string; label: string; fallback: number }> = [
  { key: 'foh', label: 'Servers', fallback: 1 },
  { key: 'cashier', label: 'Cashiers', fallback: 0.75 },
  { key: 'barista', label: 'Baristas (HR designation)', fallback: 0.75 },
  { key: 'kitchen', label: 'Kitchen', fallback: 0.5 },
  { key: 'boh', label: 'Line cooks (BOH)', fallback: 0.5 },
  { key: 'expediter', label: 'Expediters', fallback: 0.5 },
  { key: 'foh_management', label: 'Floor managers', fallback: 0 },
  { key: 'boh_management', label: 'Head chefs', fallback: 0 },
]

const CHANNELS = ['pos', 'storefront', 'whatsapp']

export default function OperationsPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<Cfg>({ queryKey: ['operations-config'], queryFn: () => api.get('/setup/operations-config') })
  const [form, setForm] = useState<Partial<Cfg>>({})
  useEffect(() => { if (data) setForm(data) }, [data])
  const save = useMutation({
    mutationFn: () => api.patch('/setup/operations-config', form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operations-config'] }),
  })
  const saveError = save.error as Error | null

  if (isLoading) return <div className="p-8 text-white/60">Loading…</div>
  function patch<K extends keyof Cfg>(k: K, v: Cfg[K]) { setForm((p) => ({ ...p, [k]: v })) }

  const channels = form.serviceChargeAppliesToChannels ?? []
  function toggleChannel(ch: string) {
    const next = channels.includes(ch) ? channels.filter((c) => c !== ch) : [...channels, ch]
    patch('serviceChargeAppliesToChannels', next)
  }

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">⚙️ Operations rules</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Service charge, tip pool distribution, invoice numbering, withholding tax — the rules the platform enforces in the background.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-6">
        <Section title="Service charge" desc="Auto-added to subtotal for selected channels">
          <Field label="Rate (0.05 = 5%)">
            <input type="number" step="0.005" min={0} max={1} value={form.serviceChargePct ?? 0} onChange={(e) => patch('serviceChargePct', parseFloat(e.target.value) || 0)} className={fieldCls} />
            <p className="text-[10px] text-white/30 mt-1">{((form.serviceChargePct ?? 0) * 100).toFixed(1)}%</p>
          </Field>
          <div>
            <label className="text-xs text-white/55">Applies to channels</label>
            <p className="text-[10px] text-white/30 mt-0.5">Empty = applies to all</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {CHANNELS.map((ch) => (
                <button key={ch} type="button" onClick={() => toggleChannel(ch)}
                  className="text-xs font-semibold px-3 py-1 rounded-full"
                  style={channels.includes(ch)
                    ? { background: 'rgba(0,212,177,0.15)', color: '#00D4B1', border: '1px solid rgba(0,212,177,0.4)' }
                    : { background: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  {ch}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Tip pool">
          <Toggle label="Enable tip pooling" checked={!!form.tipPoolEnabled} onChange={(v) => patch('tipPoolEnabled', v)} />
          <Field label="Distribution method">
            <select value={form.tipPoolDistribution ?? 'equal'} onChange={(e) => patch('tipPoolDistribution', e.target.value as Cfg['tipPoolDistribution'])} className={fieldCls}>
              <option value="equal">Equal split among everyone clocked in</option>
              <option value="by_hours">Weighted by hours worked</option>
              <option value="by_role_weight">Weighted by role (kitchen vs cashier)</option>
            </select>
          </Field>
          <div>
            <label className="text-xs text-white/55">Who is in the pool, and their weight</label>
            <p className="text-[10px] text-white/30 mt-0.5">0 = not in the pool. Weights multiply hours when the split is by role; with the other splits they only decide who is in.</p>
            <div className="grid grid-cols-2 gap-2 mt-2">
              {TIP_ROLES.map((r) => (
                <label key={r.key} className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <span className="text-xs text-white/70">{r.label}</span>
                  <input type="number" step="0.05" min={0} max={10} className="w-20 rounded bg-white/[0.03] border border-white/[0.08] px-2 py-1 text-sm text-white/85 text-right"
                    value={form.tipPoolRoleWeights?.[r.key] ?? r.fallback}
                    onChange={(e) => patch('tipPoolRoleWeights', { ...Object.fromEntries(TIP_ROLES.map((x) => [x.key, form.tipPoolRoleWeights?.[x.key] ?? x.fallback])), ...(form.tipPoolRoleWeights ?? {}), [r.key]: Math.max(0, parseFloat(e.target.value) || 0) })} />
                </label>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Clock-in" desc="One rule for the whole company. Staff may clock in at any of the company's branches; the map pins set under Configuration → Locations are the fence.">
          <Toggle label="Only allow clock-in on-site (geofence)" checked={!!form.geofenceEnforced} onChange={(v) => patch('geofenceEnforced', v)} />
          <Field label="Fence radius (metres)">
            <input type="number" min={10} max={5000} step={10} value={form.geofenceRadiusMetres ?? 150} onChange={(e) => patch('geofenceRadiusMetres', parseInt(e.target.value, 10) || 150)} className={fieldCls} />
          </Field>
          <Toggle label="Require a selfie at clock-in" checked={!!form.selfieRequiredAtClockIn} onChange={(v) => patch('selfieRequiredAtClockIn', v)} />
          <p className="text-[10px] text-white/40">
            A branch with no map pin cannot be clocked in at while the fence is on — <Link href="/configuration/locations" className="underline">set the pins</Link> first.
          </p>
        </Section>

        <Section title="Tax invoice numbering">
          <Field label="Sequence reset">
            <select value={form.invoiceSequenceReset ?? 'yearly'} onChange={(e) => patch('invoiceSequenceReset', e.target.value as Cfg['invoiceSequenceReset'])} className={fieldCls}>
              <option value="yearly">Reset every fiscal year</option>
              <option value="monthly">Reset every month</option>
              <option value="never">Never reset (continuous)</option>
            </select>
          </Field>
          <Field label="Credit-note prefix">
            <input value={form.invoiceCreditNotePrefix ?? ''} onChange={(e) => patch('invoiceCreditNotePrefix', e.target.value || null)} placeholder="CN-" className={fieldCls} />
          </Field>
        </Section>

        <Section title="Withholding tax (Section 153, etc.)">
          <Toggle label="Enable withholding" checked={!!form.withholdingTaxEnabled} onChange={(v) => patch('withholdingTaxEnabled', v)} />
          <Field label="Rate (0.045 = 4.5%)">
            <input type="number" step="0.001" min={0} max={1} value={form.withholdingTaxPct ?? 0} onChange={(e) => patch('withholdingTaxPct', parseFloat(e.target.value) || 0)} className={fieldCls} />
            <p className="text-[10px] text-white/30 mt-1">{((form.withholdingTaxPct ?? 0) * 100).toFixed(2)}%</p>
          </Field>
          <Toggle label="Recoverable (asset, not expense)" checked={!!form.withholdingTaxRecoverable} onChange={(v) => patch('withholdingTaxRecoverable', v)} />
        </Section>

        <div className="flex justify-end items-center gap-3 pt-4 border-t border-white/[0.05]">
          {saveError && <p className="text-xs text-red-400 mr-auto">{saveError.message}</p>}
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save changes'}
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
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-kds-green" /><span className="text-sm text-white/85">{label}</span></label>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
