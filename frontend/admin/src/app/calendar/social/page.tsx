'use client'
// Social pages per brand (owner C18, 2026-10-26: "Approval goes thru me,
// marketing can connect"). Marketing connects each brand's Facebook / Instagram
// page; the connection waits for the CEO in the approvals inbox and nothing
// posts with it until then — the brand's previously approved page keeps posting.
// API: GET /social-connections, POST /social-connections/:conceptId/connect.
// Tokens are never sent to the browser (a short hint only).
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { NavIcon } from '../../../components/ui/NavIcon'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'
import { usePermissions } from '../../../hooks/useCan'

interface Conn {
  id: string
  pageId: string
  pageName: string | null
  igUserId: string | null
  tokenHint: string | null
  requestedAt: string
  decidedAt: string | null
  decisionNote: string | null
}
interface BrandRow {
  conceptId: string
  name: string
  isActive: boolean
  approved: Conn | null
  pending: Conn | null
  rejected: Conn | null
}
interface Overview {
  configured: boolean
  redirectUri: string
  legacy: { id: string; pageName: string | null; tokenHint: string | null; requestedAt: string } | null
  brands: BrandRow[]
}

function PageLine({ c, tone }: { c: Conn; tone: 'ok' | 'wait' | 'bad' }) {
  const cls = tone === 'ok' ? 'text-success' : tone === 'wait' ? 'text-s-amber' : 'text-s-red'
  return (
    <p className={`text-xs ${cls}`}>
      <NavIcon name={tone === 'ok' ? 'check' : 'warn'} size={13} className="mr-1 inline" />
      {c.pageName ?? 'Page'} (ID {c.pageId}){c.igUserId ? ' · Instagram linked' : ' · no Instagram business account'}
      {c.tokenHint ? ` · key ${c.tokenHint}` : ''}
    </p>
  )
}

export default function SocialPagesPage() {
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const { data: me } = usePermissions()

  useEffect(() => {
    const qs = new URLSearchParams(window.location.search)
    const ok = qs.get('social_connected')
    const err = qs.get('social_error')
    if (ok) setFlash({ ok: true, text: qs.get('status') === 'approved' ? `Connected and approved: ${ok}` : `Connected: ${ok}. It waits for the CEO's approval before anything posts to it.` })
    else if (err) setFlash({ ok: false, text: `Connection failed: ${err}` })
  }, [])

  const { data, isLoading, error } = useQuery<Overview>({
    queryKey: ['social-connections'],
    queryFn: () => api.get<Overview>('/social-connections'),
  })

  // The connect endpoint needs the Authorization header, so fetch the OAuth URL first, then navigate.
  async function connect(conceptId: string) {
    setFlash(null)
    setBusy(conceptId)
    try {
      const { url } = await api.post<{ url: string }>(`/social-connections/${conceptId}/connect`, {})
      window.location.href = url
    } catch (e) {
      setBusy(null)
      setFlash({ ok: false, text: e instanceof Error ? e.message : 'Could not start the Meta connection' })
    }
  }

  const canConnect = me?.role !== 'it'

  return (
    <div className="min-h-screen bg-s-bg p-6">
      <div className="mb-6 max-w-3xl mx-auto">
        <Link href="/calendar" className="text-s-muted text-sm hover:text-s-text">← Calendar</Link>
        <h1 className="text-2xl font-black text-s-text mt-0.5">Social pages</h1>
        <p className="text-sm text-s-muted mt-1">
          Each brand posts to its own Facebook page (and the Instagram business account linked to it).
          A new or changed page waits for the CEO&apos;s approval; until then the brand&apos;s approved page keeps posting.
        </p>
      </div>

      <div className="max-w-3xl mx-auto space-y-4">
        {flash && (
          <div role="status" className={`rounded-xl border p-4 text-sm ${flash.ok ? 'border-accent bg-accent-dim text-success' : 'border-s-red bg-s-red/10 text-s-red'}`}>
            {flash.text}
          </div>
        )}
        {data && !data.configured && (
          <div className="rounded-xl border border-s-amber/30 bg-s-amber/5 p-4 text-xs space-y-1">
            <p className="font-bold text-s-amber"><NavIcon name="warn" size={13} className="mr-1 inline" />Meta App not configured</p>
            <p className="text-s-muted">IT must set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET on the API and register this redirect address in the Meta App:</p>
            <code className="bg-s-border px-1 rounded break-all">{data.redirectUri}</code>
          </div>
        )}
        {data?.legacy && (
          <div className="rounded-xl border border-s-amber/30 bg-s-amber/5 p-4 text-sm">
            <p className="font-bold text-s-amber"><NavIcon name="warn" size={13} className="mr-1 inline" />The old servd-wide page is no longer used</p>
            <p className="text-s-muted mt-1">
              {data.legacy.pageName ?? 'The page'} was connected for all of servd. Pages are now per brand, so it posts for no brand.
              Connect each brand below and approve it.
            </p>
          </div>
        )}
        {error && <p className="text-sm text-s-red">{(error as Error).message}</p>}
        {isLoading ? (
          <p className="text-s-muted text-sm">Loading…</p>
        ) : !data || data.brands.length === 0 ? (
          <CompactEmptyState message="No brands" detail="Brands of your company appear here" />
        ) : data.brands.map((b) => (
          <div key={b.conceptId} className="rounded-xl border border-s-border bg-s-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-[14rem] flex-1 items-center gap-3">
                <span className="text-primary-ink"><NavIcon name="facebook" size={26} /></span>
                <div className="min-w-0">
                  <p className="font-bold text-s-text">{b.name}{!b.isActive && <span className="ml-2 text-xs text-s-muted">(inactive)</span>}</p>
                  {b.approved ? <PageLine c={b.approved} tone="ok" /> : <p className="text-xs text-s-muted">No approved page — nothing posts for this brand.</p>}
                  {b.pending && (
                    <div className="mt-1">
                      <p className="text-xs font-semibold text-s-amber">Waiting for the CEO&apos;s approval</p>
                      <PageLine c={b.pending} tone="wait" />
                    </div>
                  )}
                  {b.rejected && (
                    <div className="mt-1">
                      <p className="text-xs font-semibold text-s-red">Not approved{b.rejected.decisionNote ? `: ${b.rejected.decisionNote}` : ''}</p>
                      <PageLine c={b.rejected} tone="bad" />
                    </div>
                  )}
                </div>
              </div>
              {canConnect && (
                <button type="button" onClick={() => connect(b.conceptId)} disabled={busy !== null || data.configured === false}
                  className="rounded-xl bg-primary text-primary-on px-4 py-2 text-sm font-bold hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed shrink-0">
                  {busy === b.conceptId ? 'Opening Meta…' : b.approved || b.pending ? 'Reconnect' : 'Connect'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
