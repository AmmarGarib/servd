'use client'
// Withholding rates (H8 / H28) — the income tax the company deducts from
// vendors, per section and per filer status, for the ACTIVE company.
//   GET /accounting/withholding/rates → { enabled, rates, defaultsUsed, maxBps, sections, canEdit }
//   PUT /accounting/withholding/rates { rates: { [section]: { filerBps, nonFilerBps } } }
// The API is the one writer (it also keeps the old single % in step); who may
// edit is its `canEdit` flag (admin + finance), never a role list here.
//   PUT /accounting/withholding/enabled { enabled, reason ≥10 } — the on/off
// switch for the ACTIVE company (owner, 2026-10-16: finance switches it on),
// audited; the CEO keeps the same switch on Configuration → Operations.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { NumberField } from '../../../components/ui/NumberField'

type Section = '153_1_a' | '153_1_b' | '153_1_c' | '155'
interface Rate { filerBps: number; nonFilerBps: number }
interface RatesResp {
  enabled: boolean
  rates: Record<Section, Rate>
  /** True while the company has never saved its own rates (the CA placeholders apply). */
  defaultsUsed: boolean
  maxBps: number
  sections: Array<{ key: Section; label: string }>
  canEdit: boolean
}

const ERROR_TEXT: Record<string, string> = {
  WHT_RATE_OUT_OF_RANGE: 'A rate must be between 0% and 50%.',
  BAD_WHT_SECTION: 'One of the sections is not a withholding section servd knows.',
  NOTHING_TO_SAVE: 'Change at least one rate before saving.',
  NO_ACTIVE_COMPANY: 'Pick a company first — withholding rates are set per company.',
  WHT_SWITCH_UNCHANGED: 'It is already switched that way — reload the page.',
  FORBIDDEN: 'Only the CEO and finance can change withholding rates.',
}
const errText = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null
  return (x?.code && ERROR_TEXT[x.code]) || x?.message || 'Something went wrong'
}

/** bps → the % typed (500 → "5"). */
const pctOf = (bps: number) => String(bps / 100)
/** The % typed → bps; null when it is not a number. */
const bpsOf = (pct: string): number | null => {
  if (pct.trim() === '') return null
  const n = Number(pct)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

export default function WithholdingRates() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['withholding-rates'],
    queryFn: () => api.get<RatesResp>('/accounting/withholding/rates'),
    meta: { inlineErrors: true },
  })
  const [form, setForm] = useState<Record<string, { filer: string; nonFiler: string }>>({})
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!q.data) return
    setForm(Object.fromEntries(q.data.sections.map((s) => [s.key, {
      filer: pctOf(q.data.rates[s.key].filerBps),
      nonFiler: pctOf(q.data.rates[s.key].nonFilerBps),
    }])))
  }, [q.data])

  const save = useMutation({
    mutationFn: (rates: Record<string, Rate>) => api.put<RatesResp>('/accounting/withholding/rates', { rates }),
    onSuccess: (r) => {
      qc.setQueryData(['withholding-rates'], r)
      setSaved(true)
    },
  })

  const [switchReason, setSwitchReason] = useState('')
  const [switchTried, setSwitchTried] = useState(false)
  const toggle = useMutation({
    mutationFn: (body: { enabled: boolean; reason: string }) => api.put<RatesResp>('/accounting/withholding/enabled', body),
    onSuccess: (r) => {
      qc.setQueryData(['withholding-rates'], r)
      setSwitchReason(''); setSwitchTried(false)
    },
  })

  if (q.isLoading) return <p className="text-s-muted text-sm">Loading…</p>
  if (q.isError || !q.data) return <p className="text-s-red text-sm">{errText(q.error)}</p>
  const d = q.data
  const max = d.maxBps

  // Only the sections whose rates changed are sent; the API merges them.
  const changed: Record<string, Rate> = {}
  let invalid = false
  for (const s of d.sections) {
    const f = form[s.key]
    if (!f) continue
    const filerBps = bpsOf(f.filer)
    const nonFilerBps = bpsOf(f.nonFiler)
    if (filerBps == null || nonFilerBps == null || filerBps < 0 || nonFilerBps < 0 || filerBps > max || nonFilerBps > max) { invalid = true; continue }
    const now = d.rates[s.key]
    if (filerBps !== now.filerBps || nonFilerBps !== now.nonFilerBps) changed[s.key] = { filerBps, nonFilerBps }
  }
  const dirty = Object.keys(changed).length > 0

  return (
    <div className="space-y-4">
      <div className="s-card p-4 space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={d.enabled ? 's-badge-green text-[10px]' : 's-badge-muted text-[10px]'}>{d.enabled ? 'Withholding is on' : 'Withholding is off'}</span>
          {d.defaultsUsed && <span className="s-badge-amber text-[10px]">Placeholder rates — not saved for this company yet</span>}
        </div>
        <p className="text-xs text-s-muted">
          Income tax withheld from vendors when a supplier bill is recorded, or when an OpEx or CapEx payment is made (s.153 / s.155).
          A filer on FBR&apos;s Active Taxpayers List pays the filer rate; a non-filer the higher rate; a supplier with a valid
          exemption certificate pays none. A vendor whose status is not known is charged the non-filer rate until it is confirmed, and flagged
          &quot;Check ATL status&quot;. The CEO also has this switch on{' '}
          <Link href="/configuration/operations" className="font-semibold underline" style={{ color: 'var(--erp-primary)' }}>Configuration → Operations</Link>.
        </p>
        {d.canEdit && (
          <div className="pt-2 border-t border-s-border space-y-2">
            <p className="text-xs font-semibold text-s-text">
              {d.enabled ? 'Switch withholding off for this company' : 'Switch withholding on for this company'}
            </p>
            <p className="text-[11px] text-s-muted">
              Applies to bills recorded and OpEx / CapEx payments made from now on; nothing already booked changes. Your reason is kept in the audit log.
            </p>
            <div className="flex flex-wrap items-start gap-2">
              <div className="flex-1 min-w-[16rem]">
                <input
                  value={switchReason}
                  onChange={(e) => setSwitchReason(e.target.value)}
                  placeholder="Reason (at least 10 characters), e.g. CA confirmed the rates"
                  aria-label="Reason for switching withholding"
                  className="w-full rounded-lg border border-s-border bg-s-surface px-3 py-2 text-sm text-s-text"
                />
                {switchTried && switchReason.trim().length < 10 && (
                  <p role="alert" className="text-[11px] text-s-red mt-1">Give a reason of at least 10 characters.</p>
                )}
              </div>
              <button
                type="button"
                className={d.enabled ? 's-btn-secondary text-sm' : 's-btn-primary text-sm'}
                disabled={toggle.isPending}
                onClick={() => {
                  setSwitchTried(true)
                  if (switchReason.trim().length < 10) return
                  toggle.mutate({ enabled: !d.enabled, reason: switchReason.trim() })
                }}
              >
                {toggle.isPending ? 'Saving…' : d.enabled ? 'Switch off' : 'Switch on'}
              </button>
            </div>
            {toggle.isError && <p role="alert" className="text-[11px] text-s-red">{errText(toggle.error)}</p>}
          </div>
        )}
        <p className="text-xs text-s-muted">
          The rates change with each Finance Act — confirm them with your CA. A change applies to documents recorded from then on; what is already booked is not restated.
        </p>
      </div>

      <div className="s-card overflow-hidden">
        <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-s-text">Rates by section</span>
          {!d.canEdit && <span className="text-[11px] text-s-muted">Read only — the CEO and finance change these.</span>}
        </div>
        <div className="divide-y divide-s-border">
          {d.sections.map((s) => {
            const f = form[s.key] ?? { filer: '', nonFiler: '' }
            return (
              <div key={s.key} className="px-4 py-3 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 sm:items-end">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-s-text">{s.label}</p>
                </div>
                <RateInput
                  label="Filer %"
                  value={f.filer}
                  readOnly={!d.canEdit}
                  max={max}
                  onChange={(v) => { setSaved(false); setForm((p) => ({ ...p, [s.key]: { ...f, filer: v } })) }}
                />
                <RateInput
                  label="Non-filer %"
                  value={f.nonFiler}
                  readOnly={!d.canEdit}
                  max={max}
                  onChange={(v) => { setSaved(false); setForm((p) => ({ ...p, [s.key]: { ...f, nonFiler: v } })) }}
                />
              </div>
            )
          })}
        </div>
        {d.canEdit && (
          <div className="px-4 py-3 border-t border-s-border flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="s-btn-primary text-sm"
              disabled={!dirty || invalid || save.isPending}
              onClick={() => save.mutate(changed)}
            >
              {save.isPending ? 'Saving…' : 'Save rates'}
            </button>
            {invalid && <span className="text-xs text-s-red">Each rate must be a number from 0 to {max / 100}%.</span>}
            {save.isError && <span className="text-xs text-s-red">{errText(save.error)}</span>}
            {saved && !dirty && !save.isError && <span className="text-xs text-success">Saved.</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function RateInput({ label, value, readOnly, max, onChange }: { label: string; value: string; readOnly: boolean; max: number; onChange: (v: string) => void }) {
  return (
    <label className="block sm:w-32">
      <span className="block text-[11px] font-bold uppercase tracking-wider text-s-muted mb-1">{label}</span>
      {readOnly
        ? <span className="block font-mono text-sm text-s-text py-1.5">{value === '' ? '—' : `${value}%`}</span>
        : (
          <NumberField
            decimals={2}
            min={0}
            max={max / 100}
            className="s-input"
            value={value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value)}
            onValueChange={(n) => onChange(n == null ? '' : String(n))}
          />
        )}
    </label>
  )
}
