'use client'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { api } from '../../lib/api'
import { NavIcon } from '../ui/NavIcon'

interface ChecklistItem {
  key: string
  title: string
  desc: string
  href: string
  done: boolean
}

interface Concept { id: string; name: string; isActive: boolean }
interface Station { id: string }
interface User    { id: string; isActive: boolean }
interface Supplier { id: string }
interface MenuCategory { id: string; items?: { id: string }[] }

/**
 * Dashboard-resident checklist that nudges operators through first-run setup.
 * Auto-hides once 100% complete (with a confetti moment) and is dismissible
 * if the operator wants to dismiss the nag once they're past the basics.
 *
 * Pass `forceShow` to bypass the dismissed/complete auto-hide — used by the
 * dedicated /setup page so operators can always come back to it.
 */
export function OnboardingChecklist({ forceShow = false }: { forceShow?: boolean } = {}) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('servd_onboarding_dismissed') === '1'
  })

  // Reuse existing list endpoints — no new backend
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })
  const conceptId = concepts[0]?.id

  const { data: stations = [] } = useQuery<Station[]>({
    queryKey: ['stations'],
    queryFn: () => api.get('/stations'),
  })
  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/auth/users'),
  })
  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ['procurement-suppliers'],
    queryFn: () => api.get('/procurement/suppliers'),
  })
  const { data: categories = [] } = useQuery<MenuCategory[]>({
    queryKey: ['menu', conceptId],
    queryFn: () => api.get(`/menu/${conceptId}`),
    enabled: !!conceptId,
  })

  const hasMenuItems = categories.some((c) => (c.items?.length ?? 0) > 0)

  const items: ChecklistItem[] = [
    { key: 'concept',   title: 'Add a brand / concept',    desc: 'Set the name, tax rate, and visibility',
      href: '/onboarding', done: concepts.length > 0 },
    { key: 'station',   title: 'Set up kitchen stations',  desc: 'Define grill, fryer, expediter, etc.',
      href: '/settings', done: stations.length > 0 },
    { key: 'staff',     title: 'Invite staff & assign roles', desc: 'Manager, cook, cashier — set their PINs',
      href: '/settings', done: users.length > 1 },
    { key: 'menu',      title: 'Build your menu',          desc: 'Add at least one category + 3 items',
      href: '/menu', done: hasMenuItems },
    { key: 'supplier',  title: 'Onboard your first supplier', desc: 'Open a chat thread + portal invite',
      href: '/procurement/chat', done: suppliers.length > 0 },
    { key: 'integrations', title: 'Hook up integrations',  desc: 'R2 storage, WhatsApp, Keenu — at least one',
      href: '/settings/integrations', done: false /* unknown without query */ },
  ]

  const completed = items.filter((i) => i.done).length
  const pct = Math.round((completed / items.length) * 100)
  const allDone = completed === items.length

  if (!forceShow && (dismissed || allDone)) return null

  function dismiss() {
    if (typeof window !== 'undefined') localStorage.setItem('servd_onboarding_dismissed', '1')
    setDismissed(true)
  }

  return (
    <section
      className="relative rounded-2xl p-5 overflow-hidden"
      style={{
        background: 'linear-gradient(135deg, rgb(var(--ink-rgb) / 0.08) 0%, rgb(var(--erp-primary-rgb) / 0.05) 100%)',
        border: '1px solid rgb(var(--ink-rgb) / 0.18)',
        animationName: 'ops-revealUp', animationDuration: '0.5s', animationFillMode: 'both',
      }}
    >
      {/* Ambient orb */}
      <div
        className="absolute pointer-events-none"
        style={{
          top: '-30px', right: '-30px', width: '180px', height: '180px',
          background: 'radial-gradient(circle, rgb(var(--ink-rgb) / 0.12) 0%, transparent 70%)',
          animation: 'ops-glowPulse 9s ease-in-out infinite',
        }}
      />

      <div className="relative z-10">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-white/40 mb-1">First-run setup</p>
            <h2 className="text-lg font-black text-white/90">Finish setting up servd</h2>
            <p className="text-xs text-white/45 mt-0.5">{completed} of {items.length} done · {pct}%</p>
          </div>
          {!forceShow && (
            <button
              onClick={dismiss}
              className="text-xs text-white/30 hover:text-white/60 transition-colors"
              title="Hide this checklist"
            >
              Dismiss
            </button>
          )}
        </div>

        {/* Progress bar */}
        <div className="h-1.5 rounded-full mb-5 overflow-hidden" style={{ background: 'rgb(var(--fg-rgb) / 0.06)' }}>
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${pct}%`, background: 'var(--erp-primary)' }}
          />
        </div>

        {/* Items */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={`flex items-start gap-3 rounded-xl p-3 transition-all hover:-translate-y-0.5 ${
                item.done ? 'opacity-65 hover:opacity-100' : ''
              }`}
              style={{
                background: item.done ? 'rgb(var(--erp-accent-rgb) / 0.08)' : 'rgb(var(--fg-rgb) / 0.025)',
                border: `1px solid ${item.done ? 'rgb(var(--erp-accent-rgb) / 0.3)' : 'rgb(var(--fg-rgb) / 0.06)'}`,
              }}
            >
              <span
                className={`shrink-0 h-5 w-5 rounded-full flex items-center justify-center text-[11px] font-black ${
                  item.done ? 'bg-primary text-primary-on' : 'border border-white/20 text-white/30'
                }`}
              >
                {item.done ? <NavIcon name="check" size={12} /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-bold ${item.done ? 'text-white/65 line-through decoration-white/30' : 'text-white/85'}`}>
                  {item.title}
                </p>
                <p className="text-[11px] text-white/45 mt-0.5 leading-tight">{item.desc}</p>
              </div>
              {!item.done && (
                <span className="shrink-0 text-[11px] font-bold text-primary-ink">→</span>
              )}
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}
