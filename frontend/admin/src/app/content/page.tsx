'use client'

// Content editor index — shows every page the operator can edit. Includes
// quick links to start editing the servd home and each brand microsite,
// plus a list of any layouts already saved in the DB.

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'

interface Concept { id: string; name: string; slug: string }
interface LayoutRow { id: string; slug: string; title: string | null; updatedAt: string; publishedAt: string | null }

const STORE_FRONT_URL = process.env['NEXT_PUBLIC_STOREFRONT_URL'] ?? 'http://localhost:3002'

export default function ContentIndexPage() {
  const concepts = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })
  const layouts = useQuery({
    queryKey: ['site-layouts'],
    queryFn: () => api.get<LayoutRow[]>('/site-layouts'),
  })

  const known = new Set((layouts.data ?? []).map((l) => l.slug))

  const allEditable = [
    { slug: 'servd:home', label: 'servd home', preview: '/' },
    // Food imagery for the home 3D scroll band. Add an image/gallery block here;
    // those photos become the textures the camera flies through on the landing.
    { slug: 'servd:home-experience', label: 'servd home — food experience', preview: '/' },
    ...(concepts.data ?? []).map((c) => ({
      slug: `brand:${c.slug}`,
      label: `${c.name} — home`,
      preview: `/brand/${c.slug}`,
    })),
  ]

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <p className="text-xs text-s-muted">Marketing</p>
        <h1 className="text-xl font-bold text-s-text">Content editor</h1>
        <p className="text-xs text-s-muted mt-1">Edit any storefront page block-by-block. Save to publish — storefront refetches within 30s.</p>
      </header>

      <div className="p-6 max-w-3xl mx-auto space-y-3">
        {allEditable.map((p) => {
          const saved = layouts.data?.find((l) => l.slug === p.slug)
          return (
            <Link key={p.slug} href={`/content/${encodeURIComponent(p.slug)}`}
              className="s-card-hover s-card flex items-center justify-between p-4 hover:bg-s-bg-soft transition-colors">
              <div>
                <p className="text-base font-semibold text-s-text">{p.label}</p>
                <p className="text-xs text-s-muted font-mono mt-0.5">{p.slug}</p>
                {saved ? (
                  <p className="text-[11px] text-s-muted mt-1">
                    {(saved.title ?? p.label)} · last edited {new Date(saved.updatedAt).toLocaleString()}
                  </p>
                ) : (
                  <p className="text-[11px] text-s-dim mt-1">Using built-in defaults — click to customise.</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <a target="_blank" rel="noopener noreferrer"
                   href={`${STORE_FRONT_URL}${p.preview}`}
                   onClick={(e) => e.stopPropagation()}
                   className="text-xs text-s-teal hover:underline">
                  Preview ↗
                </a>
                <span className="text-s-muted text-lg">→</span>
              </div>
              {void known}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
