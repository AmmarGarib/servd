'use client'

// PortfolioWriteGuardModal — fallback "pick a company for this action" prompt
// mounted once in AppShell. Fires when an api.post/patch from portfolio view
// reaches a path that isn't tenant-pinned (i.e. the caller didn't supply
// { tenantId } and the path isn't in the exclusion list).
//
// Behaviour changed 2026-05-13: picking a company NO LONGER switches the
// operator out of portfolio view. We just stash the picked tenantId on a
// short-lived global ref and resolve the awaiting fetch; api.ts attaches it
// as `x-servd-active-tenant` for the retried request. The operator stays
// looking at all companies; only the single write lands in the picked one.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { onPortfolioWriteRequest, resolvePortfolioWrite, setPickedTenantId } from '../../hooks/useEnsureTenant'

interface Tenant {
  id: string
  name: string
  slug: string
  industry: string | null
  role?: string
}

export function PortfolioWriteGuardModal() {
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState<string | undefined>(undefined)

  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<Tenant[]>('/tenants/mine'),
    staleTime: 30_000,
    enabled: open,                 // only fetch when actually shown
  })

  useEffect(() => {
    return onPortfolioWriteRequest((intentText) => {
      setIntent(intentText)
      setOpen(true)
    })
  }, [])

  function pick(id: string) {
    setPickedTenantId(id)
    setOpen(false)
    queueMicrotask(() => resolvePortfolioWrite('picked'))
  }

  function cancel() {
    setOpen(false)
    setPickedTenantId(null)
    resolvePortfolioWrite('cancelled')
  }

  if (!open) return null

  return (
    <div role="dialog" aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgb(61 31 59 / 0.5)' }}
      onClick={cancel}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        <div className="px-6 pt-6 pb-4 border-b border-white/[0.06]">
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-primary-ink">Portfolio mode</p>
          <h2 className="text-xl font-black text-white/95 mt-1">Which company is this for?</h2>
          <p className="text-xs text-white/45 mt-1.5">
            {intent
              ? <>You&rsquo;re trying to <strong className="text-white/85">{intent}</strong>. Pick the company it should land in — just this one write, no session switch.</>
              : <>Pick the company this change should land in. You&rsquo;ll stay viewing all companies — only this write goes to the picked one.</>}
          </p>
        </div>

        <div className="px-6 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {tenants.length === 0 && (
            <p className="text-xs text-white/40 text-center py-6">Loading your companies…</p>
          )}
          {tenants.map((t) => (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              className="w-full text-left rounded-xl px-4 py-3 transition-all flex items-center justify-between gap-3"
              style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-sm text-white/90 truncate">{t.name}</p>
                <p className="text-[11px] text-white/40 mt-0.5">
                  {t.industry ?? 'Restaurant'} · {t.role ?? 'member'} · <span className="font-mono">{t.slug}</span>
                </p>
              </div>
              <span className="text-xs text-primary-ink font-bold whitespace-nowrap">Use this →</span>
            </button>
          ))}
        </div>

        <div className="px-6 py-4 flex justify-between items-center border-t border-white/[0.06]">
          <p className="text-[11px] text-white/35">
            One-shot — you stay in portfolio view after.
          </p>
          <button onClick={cancel}
            className="rounded-lg px-4 py-2 text-xs font-bold text-white/55 hover:text-white">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
