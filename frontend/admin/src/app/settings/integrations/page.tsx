'use client'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

// Mirrors GET /api/v1/integrations/social/status. `configured` tells us
// whether the backend has FACEBOOK_APP_ID/SECRET set — the operator's
// first failure mode — so the UI can route them to the env step instead
// of pretending the integration is just "not connected yet".
interface SocialStatus {
  configured: boolean
  connected:  boolean
  page:        { id: string; name: string | null } | null
  ig:          { userId: string } | null
  redirectUri: string
}

// FBR PRAL — Pakistan tax invoicing. State unfolds in 3 stages:
//   - not configured: env vars missing (FBR_USERNAME / FBR_PASSWORD)
//   - configured, 0 concepts registered: env set but no concept has an
//     fbrPosId yet (PRAL hasn't issued POSIDs for your brands)
//   - configured + concepts registered: integration is genuinely usable;
//     invoicesSubmitted tells you whether anything has flowed through.
interface FbrStatus {
  configured:         boolean
  mode:               'production' | 'sandbox'
  conceptsRegistered: number
  invoicesSubmitted:  number
}

export default function IntegrationsPage() {
  const [searchParams, setSearchParams] = useState<URLSearchParams | null>(null)

  useEffect(() => {
    setSearchParams(new URLSearchParams(window.location.search))
  }, [])

  const socialConnected = searchParams?.get('social_connected')
  const socialError     = searchParams?.get('social_error')

  const { data: status } = useQuery<SocialStatus>({
    queryKey: ['social-status'],
    queryFn: () => api.get<SocialStatus>('/integrations/social/status'),
  })
  const { data: fbr } = useQuery<FbrStatus>({
    queryKey: ['fbr-status'],
    queryFn: () => api.get<FbrStatus>('/integrations/fbr/status'),
  })

  const [connecting, setConnecting] = useState(false)
  const [connectErr, setConnectErr] = useState<string | null>(null)

  // The connect endpoint sits behind requireAuth — a plain top-level
  // navigation drops the Authorization header and gets a 401 back. Fetch
  // the OAuth URL via our authenticated api client, *then* navigate the
  // browser to Facebook's dialog. Same UX, headers preserved.
  async function connectMeta() {
    setConnectErr(null)
    setConnecting(true)
    try {
      const { url } = await api.get<{ url: string }>('/integrations/social/connect')
      window.location.href = url
    } catch (err) {
      setConnecting(false)
      setConnectErr(err instanceof Error ? err.message : 'Failed to start Meta connect')
    }
  }

  return (
    <div className="min-h-screen bg-kds-bg p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-black text-kds-text">Integrations</h1>
        <p className="text-sm text-kds-subtext mt-1">Connect external services to enable social posting and more.</p>
      </div>

      {socialConnected && (
        <div className="mb-6 rounded-xl border border-kds-green bg-kds-green/10 p-4">
          <p className="font-bold text-kds-green">✓ Connected to Facebook Page: {decodeURIComponent(socialConnected)}</p>
          <p className="text-sm text-kds-subtext mt-1">Instagram and Facebook posting are now enabled in the Content Calendar.</p>
        </div>
      )}
      {socialError && (
        <div className="mb-6 rounded-xl border border-kds-red bg-kds-red/10 p-4">
          <p className="font-bold text-kds-red">⚠ Connection failed: {decodeURIComponent(socialError)}</p>
          <p className="text-sm text-kds-subtext mt-1">Try again or check your Facebook App settings.</p>
        </div>
      )}
      {connectErr && (
        <div className="mb-6 rounded-xl border border-kds-red bg-kds-red/10 p-4">
          <p className="font-bold text-kds-red">⚠ Could not start Meta connect</p>
          <p className="text-sm text-kds-subtext mt-1">{connectErr}</p>
          <p className="text-xs text-kds-subtext/70 mt-2">
            Most often this means <code className="bg-kds-border px-1 rounded">FACEBOOK_APP_ID</code> /
            <code className="bg-kds-border px-1 rounded ml-1">FACEBOOK_APP_SECRET</code> aren&apos;t set in the backend .env.
          </p>
        </div>
      )}

      <div className="space-y-4 max-w-2xl">
        {/* Meta / Facebook + Instagram */}
        <div className="rounded-xl border border-kds-border bg-kds-card p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">📘</span>
              <div>
                <h2 className="font-bold text-kds-text">Facebook & Instagram</h2>
                <p className="text-sm text-kds-subtext">Schedule and publish posts directly from the Content Calendar.</p>
              </div>
            </div>
            <button
              onClick={connectMeta}
              disabled={connecting || status?.configured === false}
              className={`rounded-xl px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                status?.connected
                  ? 'border border-kds-border text-kds-subtext hover:border-kds-red hover:text-kds-red'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {connecting ? 'Opening Meta…' : status?.connected ? 'Reconnect' : 'Connect'}
            </button>
          </div>

          {/* Env-config gate — short-circuit before "not connected" so the
              operator sees the actual blocker (missing .env values) rather
              than discovering it on click. Links to the runbook. */}
          {status && !status.configured && (
            <div className="mt-4 rounded-lg border border-kds-amber/30 bg-kds-amber/5 p-3 text-xs space-y-1.5">
              <p className="font-bold text-kds-amber">⚠ Meta App not configured</p>
              <p className="text-kds-subtext">
                <code className="bg-kds-border px-1 rounded">FACEBOOK_APP_ID</code> and
                <code className="bg-kds-border px-1 rounded ml-1">FACEBOOK_APP_SECRET</code> aren&apos;t
                set in <code className="bg-kds-border px-1 rounded">backend/.env</code>. You need
                to create a Meta App at developers.facebook.com first — this is a one-time
                manual step that has no programmatic path.
              </p>
              <p className="text-kds-subtext pt-1">
                <a href="https://github.com/AmmarGarib/servd/blob/main/docs/META_SETUP.md"
                  target="_blank" rel="noreferrer"
                  className="text-kds-green underline">
                  Follow the META_SETUP runbook →
                </a>
              </p>
              <p className="text-kds-subtext pt-1">
                Register this redirect URI in the Meta App:
                <code className="bg-kds-border px-1 rounded ml-1 break-all">{status.redirectUri}</code>
              </p>
            </div>
          )}

          {status?.connected && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3 rounded-lg bg-kds-bg p-3">
                <span className="text-xl">📘</span>
                <div>
                  <p className="text-sm font-semibold text-kds-text">Facebook Page</p>
                  <p className="text-xs text-kds-green">
                    ✓ {status.page?.name ?? 'Page'} (ID: {status.page?.id})
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg bg-kds-bg p-3">
                <span className="text-xl">📸</span>
                <div>
                  <p className="text-sm font-semibold text-kds-text">Instagram Business</p>
                  {status.ig
                    ? <p className="text-xs text-kds-green">✓ Connected (User ID: {status.ig.userId})</p>
                    : <p className="text-xs text-kds-amber">⚠ No Instagram Business account found on this Page</p>
                  }
                </div>
              </div>
            </div>
          )}

          {status?.configured && !status.connected && (
            <div className="mt-4 rounded-lg bg-kds-bg p-3 text-xs text-kds-subtext space-y-1">
              <p className="font-semibold text-kds-text">Before clicking Connect:</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>A Facebook Page for your restaurant (you must be Page admin)</li>
                <li>An Instagram Business account linked to that Page</li>
                <li>This redirect URI registered in your Meta App: <code className="bg-kds-border px-1 rounded break-all">{status.redirectUri}</code></li>
              </ul>
            </div>
          )}
        </div>

        {/* WhatsApp — already built */}
        <div className="rounded-xl border border-kds-border bg-kds-card p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">💬</span>
              <div>
                <h2 className="font-bold text-kds-text">WhatsApp Business</h2>
                <p className="text-sm text-kds-subtext">Customer ordering via WhatsApp. Requires Meta WhatsApp Business API.</p>
              </div>
            </div>
            <span className="rounded-full border border-kds-border px-3 py-1 text-xs text-kds-subtext">
              {process.env['NEXT_PUBLIC_WHATSAPP_ENABLED'] === 'true' ? '✓ Active' : 'Env-gated'}
            </span>
          </div>
          <div className="mt-3 rounded-lg bg-kds-bg p-3 text-xs text-kds-subtext">
            Set <code className="bg-kds-border px-1 rounded">WHATSAPP_TOKEN</code>, <code className="bg-kds-border px-1 rounded">WHATSAPP_PHONE_NUMBER_ID</code>, and <code className="bg-kds-border px-1 rounded">WHATSAPP_VERIFY_TOKEN</code> in your backend .env to enable.
          </div>
        </div>

        {/* FBR PRAL — status reflects real config + per-concept POSID
            registration + actual submissions. No more hardcoded "Active". */}
        <div className="rounded-xl border border-kds-border bg-kds-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-3xl">🧾</span>
              <div>
                <h2 className="font-bold text-kds-text">FBR PRAL (Tax Invoicing)</h2>
                <p className="text-sm text-kds-subtext">Real-time electronic invoice submission to PRAL on every completed sale.</p>
              </div>
            </div>
            {/* Badge — three states. Not configured = grey, Sandbox = amber,
                Live = green (only if real production credentials are set). */}
            {fbr && (
              fbr.configured ? (
                <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-bold ${
                  fbr.mode === 'production'
                    ? 'border-kds-green text-kds-green'
                    : 'border-kds-amber text-kds-amber'
                }`}>
                  {fbr.mode === 'production' ? '✓ Live' : 'Sandbox'}
                </span>
              ) : (
                <span className="shrink-0 rounded-full border border-kds-border px-3 py-1 text-xs text-kds-subtext font-bold">
                  Not configured
                </span>
              )
            )}
          </div>

          {/* Truthful detail panel: tell the operator what's missing and
              what's been done. */}
          {fbr && !fbr.configured && (
            <div className="mt-4 rounded-lg bg-kds-bg p-3 text-xs text-kds-subtext space-y-1">
              <p className="font-semibold text-kds-text">Not registered with FBR yet</p>
              <p>
                Set <code className="bg-kds-border px-1 rounded">FBR_USERNAME</code> and
                <code className="bg-kds-border px-1 rounded ml-1">FBR_PASSWORD</code> in
                <code className="bg-kds-border px-1 rounded ml-1">backend/.env</code> after registering
                your business with PRAL (https://e.fbr.gov.pk → POS Registration).
                Defaults to sandbox; set <code className="bg-kds-border px-1 rounded">FBR_ENV=production</code> when you go live.
              </p>
              <p className="text-kds-subtext/80 pt-1">
                Required for Tier-1 businesses under SRO 1307(I)/2022. Until configured,
                completed orders run without electronic invoicing.
              </p>
            </div>
          )}
          {fbr && fbr.configured && (
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-kds-bg p-3">
                <p className="text-[10px] uppercase tracking-wider text-kds-subtext font-bold">Concepts registered</p>
                <p className="text-lg font-black text-kds-text mt-0.5">
                  {fbr.conceptsRegistered}
                  {fbr.conceptsRegistered === 0 && <span className="text-xs font-normal text-kds-amber ml-2">⚠ none yet</span>}
                </p>
                <p className="text-[10px] text-kds-subtext/70 mt-0.5">
                  Each Concept needs a POSID from PRAL to submit invoices.
                </p>
              </div>
              <div className="rounded-lg bg-kds-bg p-3">
                <p className="text-[10px] uppercase tracking-wider text-kds-subtext font-bold">Invoices submitted</p>
                <p className="text-lg font-black text-kds-text mt-0.5">{fbr.invoicesSubmitted}</p>
                <p className="text-[10px] text-kds-subtext/70 mt-0.5">
                  Lifetime count with an FBR invoice number.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Supplier Portal — SaaS pitch */}
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-5">
          <div className="flex items-start gap-3">
            <span className="text-3xl">🏭</span>
            <div>
              <h2 className="font-bold text-kds-text">Supplier Portal <span className="ml-2 rounded-full bg-purple-500/20 px-2 py-0.5 text-xs text-purple-300">SaaS</span></h2>
              <p className="text-sm text-kds-subtext mt-0.5">
                Give your suppliers a private chat portal. Generate invite links from Supplier Chat.
                Each supplier gets a unique URL — no login required.
              </p>
              <p className="text-xs text-purple-300 mt-2">
                💡 This can be white-labelled and sold as a SaaS add-on to other restaurants.
                Each restaurant&apos;s suppliers only see their own conversations.
              </p>
            </div>
          </div>
          <a href="/procurement/chat"
            className="mt-4 inline-block rounded-xl border border-purple-500/40 px-4 py-2 text-sm font-bold text-purple-300 hover:bg-purple-500/10 transition-colors">
            Go to Supplier Chat →
          </a>
        </div>
      </div>
    </div>
  )
}
