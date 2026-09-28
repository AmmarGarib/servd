'use client'

// Published versions of a page or pop-up, newest first, with A/B stats per
// version. The CEO can roll back to any version (republished as a new one);
// everyone else sees the history read-only.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { contentApi, fmtDateTime, type LayoutStat, type LayoutVersion } from '../../lib/content'

export function VersionsDrawer({ slug, isAdmin, liveVersion, onClose, onRolledBack }: {
  slug: string
  isAdmin: boolean
  liveVersion: number | null
  onClose: () => void
  onRolledBack: () => void
}) {
  const qc = useQueryClient()
  const versions = useQuery<LayoutVersion[]>({ queryKey: ['site-layout-versions', slug], queryFn: () => contentApi.versions(slug) })
  const stats = useQuery<LayoutStat[]>({ queryKey: ['site-layout-stats', slug], queryFn: () => contentApi.stats(slug) })

  const rollback = useMutation({
    mutationFn: (version: number) => contentApi.rollback(slug, version),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['site-layout-versions', slug] })
      void qc.invalidateQueries({ queryKey: ['site-layouts'] })
      onRolledBack()
    },
  })

  const rows = [...(versions.data ?? [])].sort((a, b) => b.version - a.version)

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <aside className="h-full w-full max-w-md bg-s-surface border-l border-s-border flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-s-text">Versions</h2>
            <p className="text-[11px] text-s-muted">{isAdmin ? 'Roll back republishes an old version as a new one.' : 'Read-only. The CEO can roll back.'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-s-muted hover:text-s-text"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {versions.isLoading && <p className="text-xs text-s-muted">Loading...</p>}
          {versions.isError && <p className="text-xs text-s-red">Could not load versions.</p>}
          {!versions.isLoading && rows.length === 0 && <p className="text-xs text-s-muted">Nothing has been published yet.</p>}
          {rollback.isError && <p className="text-xs text-s-red">{(rollback.error as Error).message}</p>}
          {rows.map((v) => {
            const vs = (stats.data ?? []).filter((s) => s.version === v.version)
            const live = v.version === liveVersion
            return (
              <div key={v.version} className={`rounded-xl border p-3 ${live ? 'border-s-teal' : 'border-s-border'}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-s-text">
                    Version {v.version} {live && <span className="s-badge-teal ml-1">Live</span>}
                  </p>
                  {isAdmin && !live && (
                    <button type="button" disabled={rollback.isPending} className="s-btn-secondary text-xs py-1"
                      onClick={() => { if (confirm(`Roll back to version ${v.version}? It goes live immediately as a new version.`)) rollback.mutate(v.version) }}>
                      Roll back
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-s-muted mt-1">
                  {fmtDateTime(v.publishedAt)}
                  {v.publishedBy && <> · by {v.publishedBy.name}</>}
                  {v.approvedBy && <> · approved by {v.approvedBy.name}</>}
                </p>
                {v.note && <p className="text-[11px] text-s-muted mt-1">{v.note}</p>}
                <p className="text-[11px] text-s-dim mt-1">
                  {v.blocks.length} element{v.blocks.length === 1 ? '' : 's'}
                  {v.settings?.ab && <> · A/B split {v.settings.ab.splitPct}% to B</>}
                </p>
                {vs.length > 0 && (
                  <table className="w-full mt-2 text-[11px]">
                    <thead>
                      <tr className="text-s-muted text-left"><th className="font-medium">Variant</th><th className="font-medium text-right">Views</th><th className="font-medium text-right">Conversions</th><th className="font-medium text-right">Rate</th></tr>
                    </thead>
                    <tbody>
                      {vs.sort((a, b) => a.variant.localeCompare(b.variant)).map((s) => (
                        <tr key={s.variant} className="text-s-text">
                          <td className="uppercase">{s.variant}</td>
                          <td className="text-right tabular-nums">{s.views.toLocaleString()}</td>
                          <td className="text-right tabular-nums">{s.conversions.toLocaleString()}</td>
                          <td className="text-right tabular-nums">{s.views ? `${((s.conversions / s.views) * 100).toFixed(1)}%` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      </aside>
    </div>
  )
}
