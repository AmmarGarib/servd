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

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Modal } from './Modal'
import { onPortfolioWriteRequest, resolvePortfolioWrite, setPickedTenantId } from '../../hooks/useEnsureTenant'

interface Tenant {
  id: string
  name: string
  slug: string
  industry: string | null
  role?: string
  kind?: 'company' | 'head_office'
  access?: string
}

export function PortfolioWriteGuardModal() {
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState<string | undefined>(undefined)

  const { data: tenants = [] } = useQuery<Tenant[]>({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<Tenant[]>('/tenants/mine'),
    // Only companies the user belongs to: never a head office or a reached company.
    select: (rows) => rows.filter((t) => (t.kind ?? 'company') === 'company' && t.access !== 'head_office'),
    staleTime: 30_000,
    enabled: open,                 // only fetch when actually shown
  })

  // Navigating away (unmount) while the prompt is open must not leave the
  // awaiting write pending forever: resolve it as cancelled.
  const openRef = useRef(false)
  openRef.current = open
  useEffect(() => () => {
    if (openRef.current) { setPickedTenantId(null); resolvePortfolioWrite('cancelled') }
  }, [])

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
    <Modal title="Which company is this for?" onClose={cancel} zIndex={60}
      footer={
        <div className="flex justify-between items-center gap-3">
          <p className="text-[11px] text-white/35">One-shot — you stay in portfolio view after.</p>
          <button type="button" onClick={cancel}
            className="rounded-lg px-4 py-2 text-xs font-bold text-white/55 hover:text-white">
            Cancel
          </button>
        </div>
      }>
      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-primary-ink">Portfolio mode</p>
      <p className="text-xs text-white/45">
        {intent
          ? <>You&rsquo;re trying to <strong className="text-white/85">{intent}</strong>. Pick the company it should land in — just this one write, no session switch.</>
          : <>Pick the company this change should land in. You&rsquo;ll stay viewing all companies — only this write goes to the picked one.</>}
      </p>
      <div className="space-y-2">
        {tenants.length === 0 && (
          <p className="text-xs text-white/40 text-center py-6">Loading your companies…</p>
        )}
        {tenants.map((t) => (
          <button
            key={t.id}
            type="button"
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
    </Modal>
  )
}
