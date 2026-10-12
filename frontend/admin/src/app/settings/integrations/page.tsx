'use client'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { canOpenPath } from '../../../lib/moduleCatalog'

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

  // The Email (SMTP) screen is the CEO's and IT's (auth/routes.ts:
  // CONNECTOR_ADMINS read while holding `api_whatsapp`, CEO write; the
  // sidebar lists it under Dev → API). Other holders of `integrations` would
  // only meet a 403 there, so the card shows exactly when the page itself
  // opens — the same rule as the sidebar and the page guard.
  const { data: me } = usePermissions()
  const showEmail = !!me && canOpenPath('/configuration/email', me.role, me.modules ?? [])

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
    <div className="min-h-screen bg-s-bg p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-black text-s-text">Integrations</h1>
        <p className="text-sm text-s-muted mt-1">Connect external services to enable social posting and more.</p>
      </div>

      {socialConnected && (
        <div className="mb-6 rounded-xl border border-accent bg-accent-dim p-4">
          <p className="font-bold text-success">✓ Connected to Facebook Page: {decodeURIComponent(socialConnected)}</p>
          <p className="text-sm text-s-muted mt-1">Instagram and Facebook posting are now enabled in the Content Calendar.</p>
        </div>
      )}
      {socialError && (
        <div className="mb-6 rounded-xl border border-s-red bg-s-red/10 p-4">
          <p className="font-bold text-s-red">⚠ Connection failed: {decodeURIComponent(socialError)}</p>
          <p className="text-sm text-s-muted mt-1">Try again or check your Facebook App settings.</p>
        </div>
      )}
      {connectErr && (
        <div className="mb-6 rounded-xl border border-s-red bg-s-red/10 p-4">
          <p className="font-bold text-s-red">⚠ Could not start Meta connect</p>
          <p className="text-sm text-s-muted mt-1">{connectErr}</p>
          <p className="text-xs text-s-muted/70 mt-2">
            Most often this means <code className="bg-s-border px-1 rounded">FACEBOOK_APP_ID</code> /
            <code className="bg-s-border px-1 rounded ml-1">FACEBOOK_APP_SECRET</code> aren&apos;t set in the backend .env.
          </p>
        </div>
      )}

      <div className="space-y-4 max-w-2xl mx-auto">
        {/* Meta / Facebook + Instagram */}
        <div className="rounded-xl border border-s-border bg-s-surface p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">📘</span>
              <div>
                <h2 className="font-bold text-s-text">Facebook & Instagram</h2>
                <p className="text-sm text-s-muted">Schedule and publish posts directly from the Content Calendar.</p>
              </div>
            </div>
            <button
              onClick={connectMeta}
              disabled={connecting || status?.configured === false}
              className={`rounded-xl px-4 py-2 text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                status?.connected
                  ? 'border border-s-border text-s-muted hover:border-s-red hover:text-s-red'
                  : 'bg-primary text-primary-on hover:bg-primary-hover'
              }`}
            >
              {connecting ? 'Opening Meta…' : status?.connected ? 'Reconnect' : 'Connect'}
            </button>
          </div>

          {/* Env-config gate — short-circuit before "not connected" so the
              operator sees the actual blocker (missing .env values) rather
              than discovering it on click. Links to the runbook. */}
          {status && !status.configured && (
            <div className="mt-4 rounded-lg border border-s-amber/30 bg-s-amber/5 p-3 text-xs space-y-1.5">
              <p className="font-bold text-s-amber">⚠ Meta App not configured</p>
              <p className="text-s-muted">
                <code className="bg-s-border px-1 rounded">FACEBOOK_APP_ID</code> and
                <code className="bg-s-border px-1 rounded ml-1">FACEBOOK_APP_SECRET</code> aren&apos;t
                set in <code className="bg-s-border px-1 rounded">backend/.env</code>. You need
                to create a Meta App at developers.facebook.com first — this is a one-time
                manual step that has no programmatic path.
              </p>
              <p className="text-s-muted pt-1">
                <a href="https://github.com/AmmarGarib/servd/blob/main/docs/META_SETUP.md"
                  target="_blank" rel="noreferrer"
                  className="text-primary-ink underline">
                  Follow the META_SETUP runbook →
                </a>
              </p>
              <p className="text-s-muted pt-1">
                Register this redirect URI in the Meta App:
                <code className="bg-s-border px-1 rounded ml-1 break-all">{status.redirectUri}</code>
              </p>
            </div>
          )}

          {status?.connected && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3 rounded-lg bg-s-bg p-3">
                <span className="text-xl">📘</span>
                <div>
                  <p className="text-sm font-semibold text-s-text">Facebook Page</p>
                  <p className="text-xs text-success">
                    ✓ {status.page?.name ?? 'Page'} (ID: {status.page?.id})
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg bg-s-bg p-3">
                <span className="text-xl">📸</span>
                <div>
                  <p className="text-sm font-semibold text-s-text">Instagram Business</p>
                  {status.ig
                    ? <p className="text-xs text-success">✓ Connected (User ID: {status.ig.userId})</p>
                    : <p className="text-xs text-s-amber">⚠ No Instagram Business account found on this Page</p>
                  }
                </div>
              </div>
            </div>
          )}

          {status?.configured && !status.connected && (
            <div className="mt-4 rounded-lg bg-s-bg p-3 text-xs text-s-muted space-y-1">
              <p className="font-semibold text-s-text">Before clicking Connect:</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>A Facebook Page for your restaurant (you must be Page admin)</li>
                <li>An Instagram Business account linked to that Page</li>
                <li>This redirect URI registered in your Meta App: <code className="bg-s-border px-1 rounded break-all">{status.redirectUri}</code></li>
              </ul>
            </div>
          )}
        </div>

        {/* Dev → API holds exactly two connectors (spec §10): the WhatsApp
            gateway and the POS connector (the fiscal POS that files FBR / SRB,
            and the card machine). Their status and setup live there only —
            this page used to carry FBR / SRB direct-filing cards, which are
            gone with the direct filers. */}
        <div className="rounded-xl border border-s-border bg-s-surface p-5">
          <h2 className="font-bold text-s-text">WhatsApp and POS are in Dev → API</h2>
          <p className="text-sm text-s-muted mt-1">
            The WhatsApp gateway (signup and sign-in codes, password resets, order messages) and the POS connector
            (the fiscal POS that files FBR / SRB, and the card machine) each have their own page.
          </p>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Link href="/connectors/whatsapp" className="rounded-lg bg-s-bg p-3 hover:bg-s-border/40 transition-colors">
              <p className="text-sm font-semibold text-s-text">WhatsApp connector</p>
              <p className="text-xs text-s-muted mt-0.5">Gateway URL and key, delivery check, test send.</p>
            </Link>
            <Link href="/connectors/pos" className="rounded-lg bg-s-bg p-3 hover:bg-s-border/40 transition-colors">
              <p className="text-sm font-semibold text-s-text">POS connector</p>
              <p className="text-xs text-s-muted mt-0.5">Fiscal POS (FBR / SRB), POS IDs, submissions, card machine.</p>
            </Link>
          </div>
        </div>

        {/* Email (SMTP) — the backup channel when WhatsApp is down. */}
        <div className="rounded-xl border border-s-border bg-s-surface p-5">
          <h2 className="font-bold text-s-text">{showEmail ? 'Email and webhooks' : 'Webhooks'}</h2>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {showEmail && (
              <Link href="/configuration/email" className="rounded-lg bg-s-bg p-3 hover:bg-s-border/40 transition-colors">
                <p className="text-sm font-semibold text-s-text">Email (SMTP)</p>
                <p className="text-xs text-s-muted mt-0.5">The backup channel when WhatsApp is down, with a test send.</p>
              </Link>
            )}
            <Link href="/configuration/webhooks" className="rounded-lg bg-s-bg p-3 hover:bg-s-border/40 transition-colors">
              <p className="text-sm font-semibold text-s-text">Webhooks</p>
              <p className="text-xs text-s-muted mt-0.5">Order events sent to your own systems.</p>
            </Link>
          </div>
        </div>

        {/* Supplier Portal — SaaS pitch */}
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-5">
          <div className="flex items-start gap-3">
            <span className="text-3xl">🏭</span>
            <div>
              <h2 className="font-bold text-s-text">Supplier Portal <span className="ml-2 rounded-full bg-purple-500/20 px-2 py-0.5 text-xs text-purple-700">SaaS</span></h2>
              <p className="text-sm text-s-muted mt-0.5">
                Give your suppliers a private chat portal. Generate invite links from Supplier Chat.
                Each supplier gets a unique URL — no login required.
              </p>
              <p className="text-xs text-purple-700 mt-2">
                💡 This can be white-labelled and sold as a SaaS add-on to other restaurants.
                Each restaurant&apos;s suppliers only see their own conversations.
              </p>
            </div>
          </div>
          <a href="/procurement/chat"
            className="mt-4 inline-block rounded-xl border border-purple-500/40 px-4 py-2 text-sm font-bold text-purple-700 hover:bg-purple-500/10 transition-colors">
            Go to Supplier Chat →
          </a>
        </div>
      </div>
    </div>
  )
}
