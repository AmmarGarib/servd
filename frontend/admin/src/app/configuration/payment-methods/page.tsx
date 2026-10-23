'use client'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { NavIcon } from '../../../components/ui/NavIcon'

interface EnvVarStatus { name: string; set: boolean }

interface GatewayConfig {
  isEnabled: boolean
  isLive: boolean
  merchantId: string | null
  callbackUrl: string | null
  successUrl: string | null
  failureUrl: string | null
  notes: string | null
  updatedAt: string
}

interface Gateway {
  provider: 'cash' | 'keenu' | 'jazzcash' | 'easypaisa'
  label: string
  emoji: string
  description: string
  requiresMerchantId: boolean
  requiresCallback: boolean
  envVars: string[]
  fees: string
  docsUrl: string | null
  config: GatewayConfig | null
  envStatus: EnvVarStatus[]
  ready: boolean   // true when all required env vars are present
}

export default function PaymentMethodsPage() {
  const { data: gateways = [], isLoading } = useQuery<Gateway[]>({
    queryKey: ['payment-gateways'],
    queryFn: () => api.get('/payment-gateways'),
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div>
          <h1 className="text-2xl font-black text-white/90">Payment Methods</h1>
          <p className="text-sm text-white/40 mt-1 max-w-2xl">
            Connect each gateway you've signed up with. Secrets (API keys, hash keys) live in <code className="font-mono text-xs px-1 py-0.5 rounded bg-white/5">.env</code> — never paste them into a UI form.
          </p>
        </div>
      </header>

      <div className="px-7 py-6 max-w-3xl mx-auto space-y-5">
        {/* Setup overview */}
        <div className="rounded-2xl p-5"
          style={{ background: 'linear-gradient(135deg, rgb(var(--erp-primary-rgb) / 0.06), rgb(var(--ink-rgb) / 0.04))', border: '1px solid rgb(var(--erp-primary-rgb) / 0.18)' }}>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-primary-ink/70 mb-2">When you sign up with a gateway</p>
          <ol className="text-sm text-white/75 space-y-2 leading-relaxed">
            <li><span className="font-bold text-primary-ink">1.</span> The gateway gives you a <strong>merchant ID</strong> (or store ID), one or more <strong>secret keys</strong>, and a <strong>sandbox base URL</strong> for testing.</li>
            <li><span className="font-bold text-primary-ink">2.</span> Paste the secrets into your backend's <code className="font-mono text-xs px-1 py-0.5 rounded bg-white/10">.env</code> file using the variable names listed below — <em>never</em> commit these to git.</li>
            <li><span className="font-bold text-primary-ink">3.</span> Set the <strong>callback URL</strong> on the gateway's portal to <code className="font-mono text-xs px-1 py-0.5 rounded bg-white/10">https://&lt;your-domain&gt;/api/v1/webhooks/&lt;provider&gt;</code> so success/failure events reach servd.</li>
            <li><span className="font-bold text-primary-ink">4.</span> Toggle the gateway on below. Test in sandbox mode first; flip to live once a few test transactions reconcile.</li>
          </ol>
        </div>

        {isLoading && <p className="text-sm text-white/40">Loading…</p>}

        {gateways.map((gw) => (
          <GatewayCard key={gw.provider} gw={gw} />
        ))}
      </div>
    </div>
  )
}

function GatewayCard({ gw }: { gw: Gateway }) {
  const qc = useQueryClient()
  const [isEnabled, setIsEnabled] = useState(gw.config?.isEnabled ?? false)
  const [isLive, setIsLive] = useState(gw.config?.isLive ?? false)
  const [merchantId, setMerchantId] = useState(gw.config?.merchantId ?? '')
  const [callbackUrl, setCallbackUrl] = useState(gw.config?.callbackUrl ?? '')
  const [successUrl, setSuccessUrl] = useState(gw.config?.successUrl ?? '')
  const [failureUrl, setFailureUrl] = useState(gw.config?.failureUrl ?? '')
  const [notes, setNotes] = useState(gw.config?.notes ?? '')
  const [expanded, setExpanded] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Re-sync when the underlying gateway config changes (e.g. another admin updated it)
  useEffect(() => {
    setIsEnabled(gw.config?.isEnabled ?? false)
    setIsLive(gw.config?.isLive ?? false)
    setMerchantId(gw.config?.merchantId ?? '')
    setCallbackUrl(gw.config?.callbackUrl ?? '')
    setSuccessUrl(gw.config?.successUrl ?? '')
    setFailureUrl(gw.config?.failureUrl ?? '')
    setNotes(gw.config?.notes ?? '')
  }, [gw.config])

  const save = useMutation({
    mutationFn: () => api.patch(`/payment-gateways/${gw.provider}`, {
      isEnabled, isLive,
      merchantId: merchantId.trim() || null,
      callbackUrl: callbackUrl.trim() || null,
      successUrl: successUrl.trim() || null,
      failureUrl: failureUrl.trim() || null,
      notes: notes.trim() || null,
    }),
    onSuccess: () => {
      setSavedAt(Date.now())
      void qc.invalidateQueries({ queryKey: ['payment-gateways'] })
    },
  })

  const statusColor = isEnabled
    ? gw.ready ? 'var(--erp-success)' : 'var(--erp-warning)'
    : 'rgb(var(--fg-rgb) / 0.4)'
  const statusLabel = isEnabled
    ? gw.ready ? (isLive ? 'LIVE' : 'SANDBOX') : 'NEEDS SECRETS'
    : 'DISABLED'

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>

      {/* Card header */}
      <div className="px-5 py-4 flex items-start justify-between gap-3 border-b border-white/[0.04]">
        <div className="flex items-start gap-3 min-w-0">
          <span className="shrink-0 text-primary-ink"><NavIcon name="card" size={28} /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-black text-white/90">{gw.label}</h3>
              <span
                className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full"
                style={{ background: `color-mix(in srgb, ${statusColor} 12%, transparent)`, color: statusColor }}
              >
                {statusLabel}
              </span>
            </div>
            <p className="text-xs text-white/55 mt-1">{gw.description}</p>
            <p className="text-[11px] text-white/35 mt-1">{gw.fees}</p>
          </div>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 text-xs text-white/55 hover:text-white"
        >
          {expanded ? 'Collapse' : 'Configure'}
        </button>
      </div>

      {expanded && (
        <div className="p-5 space-y-5">
          {/* Required env vars */}
          {gw.envVars.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/55 mb-2">Required environment variables</p>
              <p className="text-xs text-white/45 mb-3">
                Set these in <code className="font-mono px-1 py-0.5 rounded bg-white/5">backend/.env</code>, then restart the backend. Status reflects whether the variable is currently set on the running server.
              </p>
              <div className="space-y-1.5">
                {gw.envStatus.map((e) => (
                  <div key={e.name} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2"
                    style={{ background: e.set ? 'var(--erp-accent-dim)' : 'color-mix(in srgb, var(--erp-warning) 5%, transparent)', border: `1px solid ${e.set ? 'rgb(var(--erp-accent-rgb) / 0.45)' : 'color-mix(in srgb, var(--erp-warning) 25%, transparent)'}` }}>
                    <code className="text-xs font-mono text-white/85">{e.name}</code>
                    <span className="text-[10px] font-black"
                      style={{ color: e.set ? 'var(--erp-success)' : 'var(--erp-warning)' }}>
                      {e.set ? 'SET' : 'NOT SET'}
                    </span>
                  </div>
                ))}
              </div>
              {gw.docsUrl && (
                <a href={gw.docsUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-block mt-3 text-xs text-primary-ink hover:underline">
                  Open {gw.label} merchant docs →
                </a>
              )}
            </div>
          )}

          {/* Toggles */}
          <div className="space-y-2">
            <label className="flex items-center justify-between rounded-lg px-3 py-2.5 cursor-pointer"
              style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div>
                <p className="text-sm font-bold text-white/85">Enable {gw.label}</p>
                <p className="text-xs text-white/45">Show this method on POS + storefront checkout</p>
              </div>
              <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} className="accent-accent h-5 w-5" />
            </label>

            {gw.envVars.length > 0 && (
              <label className="flex items-center justify-between rounded-lg px-3 py-2.5 cursor-pointer"
                style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                <div>
                  <p className="text-sm font-bold text-white/85">Live mode</p>
                  <p className="text-xs text-white/45">Off = sandbox / test transactions only. Flip on once you've reconciled a few sandbox runs.</p>
                </div>
                <input type="checkbox" checked={isLive} onChange={(e) => setIsLive(e.target.checked)} disabled={!gw.ready} className="accent-accent h-5 w-5 disabled:opacity-40" />
              </label>
            )}
          </div>

          {/* Non-secret config */}
          {gw.requiresMerchantId && (
            <div>
              <label className="text-xs text-white/55">Merchant / Store ID</label>
              <input value={merchantId} onChange={(e) => setMerchantId(e.target.value)}
                placeholder="MC-12345"
                className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-primary focus:outline-none font-mono" />
              <p className="text-[10px] text-white/35 mt-1">Public identifier the gateway gave you. Safe to store here (not a secret).</p>
            </div>
          )}

          {gw.requiresCallback && (
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="text-xs text-white/55">Callback URL (server-to-server webhook)</label>
                <input value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)}
                  placeholder={`https://your-domain.com/api/v1/webhooks/${gw.provider}`}
                  className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2.5 text-sm text-white/85 focus:border-primary focus:outline-none font-mono" />
                <p className="text-[10px] text-white/35 mt-1">
                  Paste this URL into the gateway's merchant portal so they POST payment results back to us.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/55">Success redirect</label>
                  <input value={successUrl} onChange={(e) => setSuccessUrl(e.target.value)}
                    placeholder="https://your-domain.com/checkout/success"
                    className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-xs text-white/85 focus:border-primary focus:outline-none font-mono" />
                </div>
                <div>
                  <label className="text-xs text-white/55">Failure redirect</label>
                  <input value={failureUrl} onChange={(e) => setFailureUrl(e.target.value)}
                    placeholder="https://your-domain.com/checkout/failed"
                    className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-xs text-white/85 focus:border-primary focus:outline-none font-mono" />
                </div>
              </div>
            </div>
          )}

          <div>
            <label className="text-xs text-white/55">Notes (internal)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              placeholder="e.g. negotiated rate 1.7%, support contact: ali@keenu.pk"
              className="w-full mt-1 rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-xs text-white/85 focus:border-primary focus:outline-none resize-none" />
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-white/[0.04]">
            <p className={`text-[10px] ${savedAt && Date.now() - savedAt < 4000 ? 'font-bold text-success' : 'text-white/35'}`}>
              {savedAt && Date.now() - savedAt < 4000 ? 'Saved' : gw.config?.updatedAt ? `Last saved ${new Date(gw.config.updatedAt).toLocaleString('en-PK')}` : 'Not saved yet'}
            </p>
            <button
              onClick={() => save.mutate()}
              disabled={save.isPending}
              className="rounded-xl bg-primary px-5 py-2 text-xs font-black text-primary-on hover:opacity-90 disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
