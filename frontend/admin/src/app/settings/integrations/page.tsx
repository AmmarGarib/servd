'use client'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { NavIcon } from '../../../components/ui/NavIcon'

// Facebook / Instagram are connected PER BRAND (owner C18, 2026-10-26) on
// Calendar → Social pages: Marketing connects, the CEO approves. This page only
// shows the summary (GET /social-connections — hints only, never a token).
interface SocialOverview {
  configured: boolean
  redirectUri: string
  brands: Array<{ conceptId: string; name: string; approved: { pageName: string | null } | null; pending: { pageName: string | null } | null }>
}


export default function IntegrationsPage() {
  const { data: social } = useQuery<SocialOverview>({
    queryKey: ['social-connections'],
    queryFn: () => api.get<SocialOverview>('/social-connections'),
  })

  // The Email (SMTP) screen is the CEO's and IT's (auth/routes.ts:
  // CONNECTOR_ADMINS read while holding `api_whatsapp`, CEO write; the
  // sidebar lists it under Dev → API). Other holders of `integrations` would
  // only meet a 403 there, so the card shows exactly when the page itself
  // opens — the same rule as the sidebar and the page guard.
  const { data: me } = usePermissions()
  const showEmail = !!me && canOpenPath('/configuration/email', me.role, me.modules ?? [])

  return (
    <div className="min-h-screen bg-s-bg p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-black text-s-text">Integrations</h1>
        <p className="text-sm text-s-muted mt-1">Connect external services to enable social posting and more.</p>
      </div>

      <div className="space-y-4 max-w-2xl mx-auto">
        {/* Meta / Facebook + Instagram — per brand, on Calendar → Social pages */}
        <div className="rounded-xl border border-s-border bg-s-surface p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-primary-ink"><NavIcon name="facebook" size={32} /></span>
              <div>
                <h2 className="font-bold text-s-text">Facebook & Instagram</h2>
                <p className="text-sm text-s-muted">One page per brand. Marketing connects it; the CEO approves it before anything posts.</p>
              </div>
            </div>
            <Link href="/calendar/social" className="rounded-xl bg-primary text-primary-on px-4 py-2 text-sm font-bold hover:bg-primary-hover shrink-0">
              Social pages
            </Link>
          </div>
          {social && !social.configured && (
            <div className="mt-4 rounded-lg border border-s-amber/30 bg-s-amber/5 p-3 text-xs space-y-1.5">
              <p className="font-bold text-s-amber"><NavIcon name="warn" size={13} className="mr-1 inline" />Meta App not configured</p>
              <p className="text-s-muted">
                Set <code className="bg-s-border px-1 rounded">FACEBOOK_APP_ID</code> and
                <code className="bg-s-border px-1 rounded ml-1">FACEBOOK_APP_SECRET</code> on the API, and register this redirect URI in the Meta App:
                <code className="bg-s-border px-1 rounded ml-1 break-all">{social.redirectUri}</code>
              </p>
            </div>
          )}
          {social && social.brands.length > 0 && (
            <ul className="mt-4 space-y-1 text-xs">
              {social.brands.map((b) => (
                <li key={b.conceptId} className="flex items-center justify-between rounded-lg bg-s-bg px-3 py-2">
                  <span className="font-semibold text-s-text">{b.name}</span>
                  <span className={b.approved ? 'text-success' : b.pending ? 'text-s-amber' : 'text-s-muted'}>
                    {b.approved ? (b.approved.pageName ?? 'Connected') : b.pending ? 'Waiting for the CEO' : 'Not connected'}
                  </span>
                </li>
              ))}
            </ul>
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
            <span className="text-secondary"><NavIcon name="factory" size={32} /></span>
            <div>
              <h2 className="font-bold text-s-text">Supplier Portal <span className="ml-2 rounded-full bg-purple-500/20 px-2 py-0.5 text-xs text-purple-700">SaaS</span></h2>
              <p className="text-sm text-s-muted mt-0.5">
                Give your suppliers a private chat portal. Generate invite links from Supplier Chat.
                Each supplier gets a unique URL — no login required.
              </p>
              <p className="text-xs text-purple-700 mt-2">
                <NavIcon name="bulb" size={13} className="mr-1 inline" />This can be white-labelled and sold as a SaaS add-on to other restaurants.
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
