'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { Select } from '@/components/ui/Select'

interface Cfg {
  id: string
  paperWidthMm: number
  showLogo: boolean
  logoUrl: string | null
  headerText: string | null
  footerText: string | null
  legalDisclaimer: string | null
  showTaxBreakdown: boolean
  showFbrInvoice: boolean
  printerIp: string | null
  printerPort: number
  autoPrintOnOrder: boolean
  autoPrintOnPay: boolean
  drawerKickEnabled: boolean
  cashVarianceLimitCents: number
}

export default function ReceiptsPage() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<Cfg>({ queryKey: ['receipt-config'], queryFn: () => api.get('/setup/receipt-config') })
  const [form, setForm] = useState<Partial<Cfg>>({})
  useEffect(() => { if (data) setForm(data) }, [data])
  const save = useMutation({
    mutationFn: () => api.patch('/setup/receipt-config', form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['receipt-config'] }),
  })

  if (isLoading) return <div className="p-8 text-white/60">Loading…</div>
  function patch<K extends keyof Cfg>(k: K, v: Cfg[K]) { setForm((p) => ({ ...p, [k]: v })) }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Receipts &amp; cash drawer</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Receipt customisation, network printer config, drawer kick rules, and cash reconciliation tolerances.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-6">
        <Section title="Layout">
          <Field label="Paper width">
            <Select value={form.paperWidthMm ?? 80} onChange={(e) => patch('paperWidthMm', parseInt(e.target.value))} className={fieldCls}>
              <option value={58}>58 mm</option>
              <option value={80}>80 mm</option>
            </Select>
          </Field>
          <Toggle label="Show logo" checked={!!form.showLogo} onChange={(v) => patch('showLogo', v)} />
          <Field label="Logo URL">
            <input value={form.logoUrl ?? ''} onChange={(e) => patch('logoUrl', e.target.value || null)} placeholder="https://…" className={fieldCls} />
          </Field>
        </Section>

        <Section title="Text">
          <Field label="Header"><input value={form.headerText ?? ''} onChange={(e) => patch('headerText', e.target.value || null)} placeholder="Mubarak Biryani Co. — DHA Phase 5" className={fieldCls} /></Field>
          <Field label="Footer"><input value={form.footerText ?? ''} onChange={(e) => patch('footerText', e.target.value || null)} placeholder="Thank you, see you again!" className={fieldCls} /></Field>
          <Field label="Legal disclaimer"><textarea value={form.legalDisclaimer ?? ''} onChange={(e) => patch('legalDisclaimer', e.target.value || null)} rows={2} className={fieldCls} placeholder="Goods sold are not returnable" /></Field>
        </Section>

        <Section title="Tax compliance">
          <Toggle label="Show tax breakdown" checked={!!form.showTaxBreakdown} onChange={(v) => patch('showTaxBreakdown', v)} />
          {/* Same setting (showFbrInvoice): the number and QR now come from the fiscal POS, whichever authority it files with. */}
          <Toggle label="Show fiscal invoice number and QR" checked={!!form.showFbrInvoice} onChange={(v) => patch('showFbrInvoice', v)} />
        </Section>

        <Section title="Printer (ESC/POS)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Printer IP"><input value={form.printerIp ?? ''} onChange={(e) => patch('printerIp', e.target.value || null)} placeholder="192.168.1.50" className={fieldCls} /></Field>
            <Field label="Port"><input type="number" value={form.printerPort ?? 9100} onChange={(e) => patch('printerPort', parseInt(e.target.value) || 9100)} className={fieldCls} /></Field>
          </div>
          <Toggle label="Auto-print on order placement" checked={!!form.autoPrintOnOrder} onChange={(v) => patch('autoPrintOnOrder', v)} />
          <Toggle label="Auto-print on payment" checked={!!form.autoPrintOnPay} onChange={(v) => patch('autoPrintOnPay', v)} />
        </Section>

        <Section title="Cash drawer / reconciliation">
          <Toggle label="Kick drawer on cash payment" checked={!!form.drawerKickEnabled} onChange={(v) => patch('drawerKickEnabled', v)} />
          <Field label="Cash variance limit (paisa)">
            <input type="number" value={form.cashVarianceLimitCents ?? 20000} onChange={(e) => patch('cashVarianceLimitCents', parseInt(e.target.value) || 0)} className={fieldCls} />
            <p className="text-[10px] text-white/30 mt-1">Variances above this trigger a manager-review banner on shift close · ≈ PKR {((form.cashVarianceLimitCents ?? 0) / 100).toFixed(0)}</p>
          </Field>
        </Section>

        <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.05]">
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-accent" /><span className="text-sm text-white/85">{label}</span></label>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
