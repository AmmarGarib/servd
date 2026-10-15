'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { usePermissions } from '../../../hooks/useCan'
import { Select } from '@/components/ui/Select'

// Withholding RATES live on Accounting → Sales tax return → Withholding rates
// (PUT /accounting/withholding/rates is their one writer); only the on/off
// switch stays here, so this page never sends withholdingTaxPct.
const WHT_RATES_HREF = '/accounting/sales-tax-return?tab=withholding-rates'

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
  withholdingTaxRecoverable: boolean
  /** Cash requests (H3): receipts are due within this many days of the payout (1–365). */
  cashAdvanceSettleDays: number
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
  const { data: me } = usePermissions()
  const canOpenRates = !!me && canOpenPath('/accounting/sales-tax-return', me.role, me.modules ?? [])
  const [form, setForm] = useState<Partial<Cfg>>({})
  useEffect(() => { if (data) setForm(data) }, [data])
  const save = useMutation({
    // Only the keys PATCH /setup/operations-config takes (never the id, never
    // the old withholdingTaxPct).
    mutationFn: () => {
      const body: Partial<Cfg> = {}
      for (const k of EDITABLE) if (form[k] !== undefined) (body as Record<string, unknown>)[k] = form[k]
      return api.patch('/setup/operations-config', body)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operations-config'] }),
  })
  const saveError = save.error as Error | null
  const settleDays = form.cashAdvanceSettleDays
  const settleDaysBad = settleDays !== undefined && (!Number.isInteger(settleDays) || settleDays < 1 || settleDays > 365)

  if (isLoading) return <div className="p-8 text-white/60">Loading…</div>
  function patch<K extends keyof Cfg>(k: K, v: Cfg[K]) { setForm((p) => ({ ...p, [k]: v })) }

  const channels = form.serviceChargeAppliesToChannels ?? []
  function toggleChannel(ch: string) {
    const next = channels.includes(ch) ? channels.filter((c) => c !== ch) : [...channels, ch]
    patch('serviceChargeAppliesToChannels', next)
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-4 sm:px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Operations rules</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Service charge, tip pool distribution, invoice numbering, withholding tax, cash requests — the rules the platform enforces in the background.
        </p>
      </header>

      <div className="px-4 sm:px-7 py-7 max-w-3xl mx-auto space-y-6">
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
                    ? { background: 'var(--erp-accent-dim)', color: 'var(--erp-success)', border: '1px solid var(--erp-accent)' }
                    : { background: 'rgb(var(--fg-rgb) / 0.03)', color: 'rgb(var(--fg-rgb) / 0.5)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
                  {ch}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Tip pool">
          <Toggle label="Enable tip pooling" checked={!!form.tipPoolEnabled} onChange={(v) => patch('tipPoolEnabled', v)} />
          <Field label="Distribution method">
            <Select value={form.tipPoolDistribution ?? 'equal'} onChange={(e) => patch('tipPoolDistribution', e.target.value as Cfg['tipPoolDistribution'])} className={fieldCls}>
              <option value="equal">Equal split among everyone clocked in</option>
              <option value="by_hours">Weighted by hours worked</option>
              <option value="by_role_weight">Weighted by role (kitchen vs cashier)</option>
            </Select>
          </Field>
          <div>
            <label className="text-xs text-white/55">Who is in the pool, and their weight</label>
            <p className="text-[10px] text-white/30 mt-0.5">0 = not in the pool. Weights multiply hours when the split is by role; with the other splits they only decide who is in.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
              {TIP_ROLES.map((r) => (
                <label key={r.key} className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
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
            <Select value={form.invoiceSequenceReset ?? 'yearly'} onChange={(e) => patch('invoiceSequenceReset', e.target.value as Cfg['invoiceSequenceReset'])} className={fieldCls}>
              <option value="yearly">Reset every fiscal year</option>
              <option value="monthly">Reset every month</option>
              <option value="never">Never reset (continuous)</option>
            </Select>
          </Field>
          <Field label="Credit-note prefix">
            <input value={form.invoiceCreditNotePrefix ?? ''} onChange={(e) => patch('invoiceCreditNotePrefix', e.target.value || null)} placeholder="CN-" className={fieldCls} />
          </Field>
        </Section>

        <Section title="Withholding tax (Section 153, etc.)">
          <Toggle label="Enable withholding" checked={!!form.withholdingTaxEnabled} onChange={(v) => patch('withholdingTaxEnabled', v)} />
          <div>
            <p className="text-xs text-white/55">Rates</p>
            <p className="text-xs text-white/45 mt-1">
              Each section&apos;s filer and non-filer rate (goods, services, rent and the rest) is set per company on{' '}
              {canOpenRates
                ? <Link href={WHT_RATES_HREF} className="font-semibold underline" style={{ color: 'var(--erp-primary)' }}>Accounting → Sales tax return → Withholding rates</Link>
                : <span className="font-semibold">Accounting → Sales tax return → Withholding rates</span>}.
              Bills, OpEx and CapEx payments take the rate from there.
            </p>
          </div>
          <Toggle label="Recoverable (asset, not expense)" checked={!!form.withholdingTaxRecoverable} onChange={(v) => patch('withholdingTaxRecoverable', v)} />
        </Section>

        <Section title="Cash requests" desc="Money paid out of a petty-cash box against a cash request is an advance until its receipts are uploaded.">
          <Field label="Receipts due within (days)">
            <input type="number" min={1} max={365} step={1} inputMode="numeric"
              value={settleDays === undefined ? 30 : Number.isNaN(settleDays) ? '' : settleDays}
              onChange={(e) => patch('cashAdvanceSettleDays', e.target.value === '' ? Number.NaN : Number(e.target.value))}
              className={fieldCls} />
            <p className="text-[10px] text-white/40 mt-1">
              1 to 365 days after the money is paid out. Whatever is still open after that becomes a staff advance or the director&apos;s current account.
            </p>
            {settleDaysBad && <p className="text-xs text-red-700 mt-1">Give a whole number of days from 1 to 365.</p>}
          </Field>
        </Section>

        <div className="flex justify-end items-center gap-3 pt-4 border-t border-white/[0.05]">
          {saveError && <p className="text-xs text-red-700 mr-auto">{errorText(saveError)}</p>}
          {save.isSuccess && !save.isPending && !saveError && <p className="text-xs text-success mr-auto">Saved.</p>}
          <button onClick={() => save.mutate()} disabled={save.isPending || settleDaysBad}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

const EDITABLE: Array<keyof Cfg> = [
  'serviceChargePct', 'serviceChargeAppliesToChannels', 'tipPoolEnabled', 'tipPoolDistribution', 'tipPoolRoleWeights',
  'invoiceSequenceReset', 'invoiceCreditNotePrefix', 'withholdingTaxEnabled', 'withholdingTaxRecoverable',
  'geofenceEnforced', 'geofenceRadiusMetres', 'selfieRequiredAtClockIn', 'cashAdvanceSettleDays',
]

function errorText(e: Error): string {
  const code = (e as Error & { code?: string }).code
  if (code === 'NO_LOCATED_BRANCH') return 'Set the map pin on at least one of this company\'s locations (Configuration → Locations) before switching the clock-in fence on.'
  if (code === 'FORBIDDEN') return 'Only the CEO or the owner can change these rules.'
  if (code === 'VALIDATION_ERROR') return 'One of the values is out of range — check the numbers and try again.'
  return e.message
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
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" /><span className="text-sm text-white/85">{label}</span></label>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
