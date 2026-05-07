'use client'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface SocialStatus {
  facebook: { connected: boolean; pageName?: string; pageId?: string }
  instagram: { connected: boolean; userId?: string }
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
    queryFn: async () => {
      const [fbPageId, fbPageName, igUserId] = await Promise.all([
        api.get<{ value: string } | null>('/settings/fb_page_id').catch(() => null),
        api.get<{ value: string } | null>('/settings/fb_page_name').catch(() => null),
        api.get<{ value: string } | null>('/settings/ig_user_id').catch(() => null),
      ])
      return {
        facebook:  { connected: !!fbPageId, pageName: fbPageName?.value, pageId: fbPageId?.value },
        instagram: { connected: !!igUserId, userId: igUserId?.value },
      }
    },
  })

  function connectMeta() {
    window.location.href = `${API_URL}/api/v1/integrations/social/connect`
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
              className={`rounded-xl px-4 py-2 text-sm font-bold transition-colors ${
                status?.facebook.connected
                  ? 'border border-kds-border text-kds-subtext hover:border-kds-red hover:text-kds-red'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {status?.facebook.connected ? 'Reconnect' : 'Connect'}
            </button>
          </div>

          {status?.facebook.connected && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3 rounded-lg bg-kds-bg p-3">
                <span className="text-xl">📘</span>
                <div>
                  <p className="text-sm font-semibold text-kds-text">Facebook Page</p>
                  <p className="text-xs text-kds-green">✓ {status.facebook.pageName} (ID: {status.facebook.pageId})</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg bg-kds-bg p-3">
                <span className="text-xl">📸</span>
                <div>
                  <p className="text-sm font-semibold text-kds-text">Instagram Business</p>
                  {status.instagram.connected
                    ? <p className="text-xs text-kds-green">✓ Connected (User ID: {status.instagram.userId})</p>
                    : <p className="text-xs text-kds-amber">⚠ No Instagram Business account found on this Page</p>
                  }
                </div>
              </div>
            </div>
          )}

          {!status?.facebook.connected && (
            <div className="mt-4 rounded-lg bg-kds-bg p-3 text-xs text-kds-subtext space-y-1">
              <p className="font-semibold text-kds-text">Requirements before connecting:</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>A Facebook Page for your restaurant</li>
                <li>An Instagram Business account linked to that Page</li>
                <li>Set <code className="bg-kds-border px-1 rounded">FACEBOOK_APP_ID</code> and <code className="bg-kds-border px-1 rounded">FACEBOOK_APP_SECRET</code> in your backend .env</li>
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

        {/* FBR PRAL */}
        <div className="rounded-xl border border-kds-border bg-kds-card p-5">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">🧾</span>
              <div>
                <h2 className="font-bold text-kds-text">FBR PRAL (Tax Invoicing)</h2>
                <p className="text-sm text-kds-subtext">Automatic electronic invoice submission on every completed sale.</p>
              </div>
            </div>
            <span className="rounded-full border border-kds-green px-3 py-1 text-xs text-kds-green font-bold">Active</span>
          </div>
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
