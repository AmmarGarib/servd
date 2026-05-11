'use client'

// PortfolioWriteGuardModal — the global "pick a company for this action"
// prompt. Mounted once in AppShell. Opens whenever a button triggers the
// `useEnsureTenant` hook while in portfolio view.

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '../../lib/api'
import { onPortfolioWriteRequest, resolvePortfolioWrite } from '../../hooks/useEnsureTenant'

interface Tenant {
  id: string
  name: string
  slug: string
  industry: string | null
  role?: string
}

export function PortfolioWriteGuardModal() {
  const qc = useQueryClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState<string | undefined>(undefined)
  const [picking, setPicking] = useState<string | null>(null)   // tenant id mid-switch

  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<Tenant[]>('/tenants/mine'),
    staleTime: 30_000,
    enabled: open,                 // only fetch when actually shown
  })

  // Subscribe to "open me" events from useEnsureTenant.
  useEffect(() => {
    return onPortfolioWriteRequest((intentText) => {
      setIntent(intentText)
      setOpen(true)
    })
  }, [])

  const switchTo = useMutation({
    mutationFn: (id: string) => api.post(`/tenants/switch/${id}`, {}),
    onMutate: (id) => setPicking(id),
    onSettled: () => setPicking(null),
    onSuccess: () => {
      // Exit portfolio mode locally so the next render reflects the picked
      // tenant. (The TenantSwitcher already does this on its own switch path
      // — replicating here so the guard can short-circuit without going
      // through the switcher.)
      if (typeof window !== 'undefined') {
        localStorage.removeItem('servd_view_all_tenants')
        window.dispatchEvent(new CustomEvent('servd:view-all-changed', { detail: { on: false } }))
      }
      qc.invalidateQueries()
      setOpen(false)
      router.refresh()
      // Resolve AFTER cache invalidation so the caller's mutation sees fresh data.
      // Microtask gap is enough; React Query handles the rest.
      queueMicrotask(() => resolvePortfolioWrite('switched'))
    },
    onError: () => {
      // Don't auto-resolve — let the user retry / cancel.
    },
  })

  function cancel() {
    setOpen(false)
    resolvePortfolioWrite('cancelled')
  }

  if (!open) return null

  return (
    <div role="dialog" aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={cancel}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl"
        style={{ background: '#0e1014', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="px-6 pt-6 pb-4 border-b border-white/[0.06]">
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-kds-green">Portfolio mode</p>
          <h2 className="text-xl font-black text-white/95 mt-1">Which company is this for?</h2>
          <p className="text-xs text-white/45 mt-1.5">
            {intent
              ? <>You&rsquo;re trying to <strong className="text-white/85">{intent}</strong>. Pick the company it should land in — we&rsquo;ll switch you to it for the rest of this session.</>
              : <>You&rsquo;re viewing all your companies. Writes have to land in one of them — pick which.</>}
          </p>
        </div>

        <div className="px-6 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {tenants.length === 0 && (
            <p className="text-xs text-white/40 text-center py-6">Loading your companies…</p>
          )}
          {tenants.map((t) => {
            const busy = picking === t.id
            return (
              <button
                key={t.id}
                onClick={() => switchTo.mutate(t.id)}
                disabled={picking != null}
                className="w-full text-left rounded-xl px-4 py-3 transition-all flex items-center justify-between gap-3 disabled:opacity-40"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-sm text-white/90 truncate">{t.name}</p>
                  <p className="text-[11px] text-white/40 mt-0.5">
                    {t.industry ?? 'Restaurant'} · {t.role ?? 'member'} · <span className="font-mono">{t.slug}</span>
                  </p>
                </div>
                <span className="text-xs text-kds-green font-bold whitespace-nowrap">
                  {busy ? 'Switching…' : 'Use this →'}
                </span>
              </button>
            )
          })}
        </div>

        <div className="px-6 py-4 flex justify-between items-center border-t border-white/[0.06]">
          <p className="text-[11px] text-white/35">
            Switches your session — you can flip back to portfolio anytime.
          </p>
          <button onClick={cancel}
            className="rounded-lg px-4 py-2 text-xs font-bold text-white/55 hover:text-white">
            Cancel
          </button>
        </div>

        {switchTo.isError && (
          <p className="px-6 pb-4 text-[11px] text-rose-300">
            Couldn&rsquo;t switch — try again or refresh.
          </p>
        )}
      </div>
    </div>
  )
}
