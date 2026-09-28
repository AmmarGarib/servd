'use client'

// Storefront: the ONE place storefront content is edited (owner decision 41).
// Tabs (?tab=): Pages | Pop-ups | Library | Approvals. Every change is a draft;
// nothing reaches the storefront until the CEO approves it.

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { contentApi } from '../../lib/content'
import { PagesPanel, PopupsPanel } from '../../components/storefront/ListPanels'
import { LibraryPanel } from '../../components/storefront/LibraryPanel'
import { ApprovalsPanel } from '../../components/storefront/ApprovalsPanel'

const TABS = [
  { id: 'pages', label: 'Pages' },
  { id: 'popups', label: 'Pop-ups' },
  { id: 'library', label: 'Library' },
  { id: 'approvals', label: 'Approvals' },
] as const
type TabId = (typeof TABS)[number]['id']

function StorefrontHub() {
  const router = useRouter()
  const params = useSearchParams()
  const raw = params.get('tab')
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : 'pages'
  const pending = useQuery({
    queryKey: ['site-layouts', 'all'],
    queryFn: () => contentApi.list({ status: 'all' }),
    select: (rows) => rows.filter((r) => r.draftStatus === 'pending').length,
  })

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <header className="border-b border-s-border px-6 pt-5">
        <p className="text-xs text-s-muted">Marketing</p>
        <h1 className="text-2xl font-black">Storefront</h1>
        <p className="text-sm text-s-muted mt-1">
          Build pages and pop-ups for the storefront. Every change is a draft until the CEO approves it.
        </p>
        <nav className="flex gap-1 mt-4 -mb-px">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => router.replace(`/storefront?tab=${t.id}`)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 ${tab === t.id ? 'border-s-teal text-s-teal' : 'border-transparent text-s-muted hover:text-s-text'}`}>
              {t.label}
              {t.id === 'approvals' && !!pending.data && <span className="s-badge-amber ml-2">{pending.data}</span>}
            </button>
          ))}
        </nav>
      </header>
      <div className="max-w-6xl mx-auto p-6">
        {tab === 'pages' && <PagesPanel />}
        {tab === 'popups' && <PopupsPanel />}
        {tab === 'library' && <LibraryPanel mode="manage" />}
        {tab === 'approvals' && <ApprovalsPanel />}
      </div>
    </div>
  )
}

export default function StorefrontPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-s-muted">Loading...</p>}>
      <StorefrontHub />
    </Suspense>
  )
}
