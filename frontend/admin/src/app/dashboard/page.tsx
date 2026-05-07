'use client'
import { useQuery } from '@tanstack/react-query'
import { useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ordersApi, api } from '../../lib/api'
import Link from 'next/link'
import { OnboardingChecklist } from '../../components/dashboard/OnboardingChecklist'
import { FirstRunTour } from '../../components/onboarding/FirstRunTour'

function fmt(cents: number) {
  return `PKR ${Math.round(cents / 100).toLocaleString()}`
}
function fmtK(cents: number) {
  const n = cents / 100
  if (n >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `PKR ${(n / 1_000).toFixed(0)}K`
  return `PKR ${n.toFixed(0)}`
}

const QUICK_LINKS = [
  { href: '/kds/all',    label: 'Kitchen KDS',  icon: '🖥',  accent: '#4F8EF7', dim: 'rgba(79,142,247,0.12)' },
  { href: '/pos',        label: 'Point of Sale', icon: '💳',  accent: '#00D4B1', dim: 'rgba(0,212,177,0.12)'  },
  { href: '/orders',     label: 'Orders',        icon: '📋',  accent: '#E8EAF0', dim: 'rgba(232,234,240,0.08)' },
  { href: '/crm',        label: 'CRM',           icon: '👥',  accent: '#6366F1', dim: 'rgba(99,102,241,0.12)'  },
  { href: '/accounting', label: 'Accounting',    icon: '📊',  accent: '#00D4B1', dim: 'rgba(0,212,177,0.12)'  },
  { href: '/inventory',  label: 'Inventory',     icon: '📦',  accent: '#F59E0B', dim: 'rgba(245,158,11,0.12)'  },
  { href: '/reports',    label: 'Reports',       icon: '📈',  accent: '#22C55E', dim: 'rgba(34,197,94,0.12)'   },
  { href: '/menu',       label: 'Menu Editor',   icon: '📝',  accent: '#A855F7', dim: 'rgba(168,85,247,0.12)'  },
]

function useTilt(intensity = 8) {
  const ref = useRef<HTMLDivElement>(null)
  const raf = useRef(0)
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const el = ref.current; if (!el) return
      const rect = el.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width - 0.5
      const y = (e.clientY - rect.top) / rect.height - 0.5
      el.style.transition = 'transform 0.08s ease-out'
      el.style.transform = `perspective(800px) rotateX(${y * -intensity}deg) rotateY(${x * intensity}deg) translateZ(6px) scale(1.02)`
    })
  }, [intensity])
  const onMouseLeave = useCallback(() => {
    cancelAnimationFrame(raf.current)
    const el = ref.current; if (el) {
      el.style.transition = 'transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)'
      el.style.transform = 'perspective(800px) rotateX(0) rotateY(0) translateZ(0) scale(1)'
    }
  }, [])
  return { ref, onMouseMove, onMouseLeave }
}

function QuickLinkCard({ item, index }: { item: typeof QUICK_LINKS[0]; index: number }) {
  const { ref, onMouseMove, onMouseLeave } = useTilt(6)
  return (
    <div ref={ref} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}
      style={{ transformStyle: 'preserve-3d', willChange: 'transform',
        animationName: 'ops-revealUp', animationDuration: '0.5s',
        animationTimingFunction: 'cubic-bezier(0.22,1,0.36,1)',
        animationDelay: `${0.28 + index * 0.04}s`, animationFillMode: 'both',
      }}>
      <Link href={item.href}
        className="flex flex-col items-center gap-2.5 rounded-xl p-3.5 group transition-all duration-200"
        style={{
          background: item.dim,
          border: `1px solid ${item.accent}18`,
        }}
        onMouseEnter={e => { e.currentTarget.style.border = `1px solid ${item.accent}44`; e.currentTarget.style.boxShadow = `0 0 16px ${item.accent}15` }}
        onMouseLeave={e => { e.currentTarget.style.border = `1px solid ${item.accent}18`; e.currentTarget.style.boxShadow = 'none' }}>
        <span className="text-2xl transition-transform duration-200 group-hover:scale-110 group-hover:-translate-y-0.5"
          style={{ animation: `ops-float ${5 + index * 0.3}s ease-in-out infinite`, animationDelay: `${index * 0.4}s` }}>
          {item.icon}
        </span>
        <span className="text-[10px] font-bold text-center leading-tight"
          style={{ color: item.accent }}>
          {item.label}
        </span>
      </Link>
    </div>
  )
}

export default function DashboardPage() {
  const router = useRouter()
  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]!

  // Empty-state redirect — fresh project, no concepts yet, push to wizard.
  // Uses a localStorage flag so users who explicitly skip aren't trapped.
  const { data: emptyCheck } = useQuery({
    queryKey: ['empty-check'],
    queryFn: () => api.get<{ id: string }[]>('/concepts'),
    staleTime: 60_000,
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!emptyCheck) return
    if (emptyCheck.length === 0 && localStorage.getItem('servd_skip_wizard') !== '1') {
      router.replace('/onboarding')
    }
  }, [emptyCheck, router])

  const { data: activeOrders } = useQuery({
    queryKey: ['orders', 'live'],
    queryFn: () => ordersApi.list({ status: 'received,confirmed,preparing,ready', limit: '200' }),
    refetchInterval: 8_000,
  })

  const { data: todaySales } = useQuery({
    queryKey: ['reports', 'sales', todayStr],
    queryFn: () => api.get<{ totals: { gross: number; net: number; orders: number } }>(
      `/reports/sales?dateFrom=${todayStr}T00:00:00Z&dateTo=${todayStr}T23:59:59Z`
    ),
    refetchInterval: 60_000,
  })

  const { data: inventoryAlerts } = useQuery({
    queryKey: ['inventory', 'alerts'],
    queryFn: () => api.get<{ id: string; name: string; currentStock: number; parLevel: number }[]>('/inventory/alerts'),
    refetchInterval: 300_000,
  })

  const { data: smartSegments } = useQuery({
    queryKey: ['smart-segments'],
    queryFn: () => api.get<{ summary: { totalCustomers: number; repeatRate: number }; segments: { key: string; count: number }[] }>('/crm/smart-segments'),
    refetchInterval: 300_000,
  })

  const { data: openComplaints } = useQuery({
    queryKey: ['complaints', 'open'],
    queryFn: () => api.get<{ stats: { open: number } }>('/complaints/stats'),
  })

  const { data: recentOrders } = useQuery({
    queryKey: ['orders', 'recent'],
    queryFn: () => ordersApi.list({ limit: '5', status: 'completed,cancelled,rejected' }),
    refetchInterval: 15_000,
  })

  const { data: concepts } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/concepts'),
  })
  const firstConceptId = concepts?.[0]?.id
  const { data: forecast } = useQuery({
    queryKey: ['dashboard-forecast', firstConceptId],
    queryFn: () => api.get<{ items: { name: string; forecasts: { date: string; predictedQty: number }[] }[] }>(
      `/reports/demand-forecast?conceptId=${firstConceptId}&days=1`
    ),
    enabled: !!firstConceptId,
    staleTime: 10 * 60 * 1000,
  })

  const live      = activeOrders?.data ?? []
  const received  = live.filter((o) => o.status === 'received').length
  const preparing = live.filter((o) => ['confirmed', 'preparing'].includes(o.status)).length
  const ready     = live.filter((o) => o.status === 'ready').length

  const newCustomers   = smartSegments?.segments.find((s) => s.key === 'new')?.count ?? 0
  const cartAbandoners = smartSegments?.segments.find((s) => s.key === 'cart_abandoners')?.count ?? 0

  const h        = today.getHours()
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const dateStr  = today.toLocaleDateString('en-PK', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="min-h-screen relative" style={{ background: '#090a0e' }}>

      {/* First-run tour overlay (shows once, dismissable) */}
      <FirstRunTour />

      {/* Ambient background glow */}
      <div className="fixed pointer-events-none select-none" style={{
        top: '-10vh', right: '-5vw',
        width: '55vw', height: '55vw',
        background: 'radial-gradient(circle, rgba(0,212,177,0.04) 0%, transparent 65%)',
        animation: 'ops-glowPulse 12s ease-in-out infinite',
      }} />
      <div className="fixed pointer-events-none select-none" style={{
        bottom: '5vh', left: '5vw',
        width: '40vw', height: '40vw',
        background: 'radial-gradient(circle, rgba(99,102,241,0.04) 0%, transparent 65%)',
        animation: 'ops-glowPulse 16s ease-in-out infinite reverse',
      }} />

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 px-7 py-4 flex items-center justify-between"
        style={{
          background: 'rgba(9,10,14,0.88)',
          backdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          boxShadow: '0 1px 0 rgba(0,212,177,0.04)',
        }}>
        <div style={{ animationName: 'ops-revealUp', animationDuration: '0.5s', animationFillMode: 'both' }}>
          <p className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.28)' }}>{greeting} · {dateStr}</p>
          <h1 className="text-xl font-black tracking-tight" style={{ color: '#E8EAF0' }}>Operations Dashboard</h1>
        </div>
        <div className="flex items-center gap-2.5">
          {inventoryAlerts && inventoryAlerts.length > 0 && (
            <Link href="/inventory"
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all hover:scale-105"
              style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#F59E0B' }}>
              ⚠ {inventoryAlerts.length} low stock
            </Link>
          )}
          {(openComplaints?.stats?.open ?? 0) > 0 && (
            <Link href="/complaints"
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-all hover:scale-105"
              style={{ background: 'rgba(255,77,79,0.1)', border: '1px solid rgba(255,77,79,0.25)', color: '#FF4D4F' }}>
              🎫 {openComplaints!.stats.open} complaints
            </Link>
          )}
        </div>
      </header>

      <div className="px-7 py-7 space-y-8 max-w-[1200px]">

        {/* ── Onboarding checklist (auto-hides when complete) ──────────────── */}
        <OnboardingChecklist />

        {/* ── Exception inbox snapshot (only renders when something's open) ── */}
        <ExceptionInboxWidget />

        {/* ── Live Queue ──────────────────────────────────────────────────── */}
        <section style={{ animationName: 'ops-revealUp', animationDuration: '0.5s', animationDelay: '0.05s', animationFillMode: 'both' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <div className="h-1.5 w-1.5 rounded-full"
                style={{ background: '#00D4B1', boxShadow: '0 0 8px #00D4B1', animation: 'ops-glowPulse 2s ease-in-out infinite' }} />
              <p className="text-[10px] font-black uppercase tracking-[0.3em]" style={{ color: 'rgba(255,255,255,0.3)' }}>Live Queue</p>
            </div>
            <Link href="/kds/all"
              className="text-xs font-bold transition-all hover:gap-2"
              style={{ color: '#00D4B1' }}>
              Open KDS →
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'New',        value: received,   accent: '#4F8EF7', dim: 'rgba(79,142,247,0.08)',  glow: 'rgba(79,142,247,0.2)'  },
              { label: 'Preparing',  value: preparing,  accent: '#F59E0B', dim: 'rgba(245,158,11,0.08)',  glow: 'rgba(245,158,11,0.2)'  },
              { label: 'Ready',      value: ready,      accent: '#00D4B1', dim: 'rgba(0,212,177,0.08)',   glow: 'rgba(0,212,177,0.2)'   },
              { label: 'Total Live', value: live.length, accent: '#E8EAF0', dim: 'rgba(255,255,255,0.04)', glow: 'rgba(255,255,255,0.1)' },
            ].map((item, i) => (
              <Link key={item.label} href="/orders"
                className="relative rounded-2xl p-5 overflow-hidden ops-grain group transition-all duration-200 hover:-translate-y-0.5"
                style={{
                  background: item.dim,
                  border: `1px solid ${item.accent}1a`,
                  animationName: 'ops-revealUp', animationDuration: '0.45s',
                  animationTimingFunction: 'cubic-bezier(0.22,1,0.36,1)',
                  animationDelay: `${0.08 + i * 0.06}s`, animationFillMode: 'both',
                }}
                onMouseEnter={e => { e.currentTarget.style.boxShadow = `0 0 24px ${item.glow}` }}
                onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none' }}>
                <div className="absolute top-3 right-3 h-1 w-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ background: item.accent, boxShadow: `0 0 6px ${item.accent}` }} />
                <p className="metric-value-xl tabular-nums"
                  style={{ color: item.accent, textShadow: `0 0 20px ${item.accent}33` }}>
                  {item.value}
                </p>
                <p className="text-[11px] font-semibold mt-2" style={{ color: 'rgba(255,255,255,0.35)' }}>{item.label}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* ── Today's Revenue ─────────────────────────────────────────────── */}
        <section style={{ animationName: 'ops-revealUp', animationDuration: '0.5s', animationDelay: '0.12s', animationFillMode: 'both' }}>
          <div className="flex items-center gap-2.5 mb-4">
            <p className="text-[10px] font-black uppercase tracking-[0.3em]" style={{ color: 'rgba(255,255,255,0.3)' }}>Today</p>
            <div className="h-px flex-1" style={{ background: 'rgba(255,255,255,0.04)' }} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* Gross — featured */}
            <Link href="/finance"
              className="relative rounded-2xl p-6 overflow-hidden ops-grain group transition-all duration-200 hover:-translate-y-0.5"
              style={{
                background: 'linear-gradient(135deg, rgba(0,212,177,0.07) 0%, rgba(99,102,241,0.05) 100%)',
                border: '1px solid rgba(0,212,177,0.15)',
                gridColumn: 'span 1',
              }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 0 28px rgba(0,212,177,0.12)' }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none' }}>
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                style={{ background: 'radial-gradient(ellipse at 80% 20%, rgba(0,212,177,0.08) 0%, transparent 60%)' }} />
              <p className="text-[10px] font-black uppercase tracking-[0.28em] mb-3" style={{ color: 'rgba(255,255,255,0.3)' }}>Gross Revenue</p>
              <p className="metric-value-xl text-gradient-brand">
                {todaySales?.totals?.gross != null ? fmtK(todaySales.totals.gross) : '—'}
              </p>
              <p className="text-xs mt-2 font-medium" style={{ color: 'rgba(255,255,255,0.22)' }}>All orders · today</p>
            </Link>

            <Link href="/finance"
              className="relative rounded-2xl p-6 overflow-hidden ops-grain group transition-all duration-200 hover:-translate-y-0.5"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 0 20px rgba(0,212,177,0.08)' }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none' }}>
              <p className="text-[10px] font-black uppercase tracking-[0.28em] mb-3" style={{ color: 'rgba(255,255,255,0.3)' }}>Net Revenue</p>
              <p className="metric-value-xl" style={{ color: '#00D4B1' }}>
                {todaySales?.totals?.net != null ? fmtK(todaySales.totals.net) : '—'}
              </p>
              <p className="text-xs mt-2 font-medium" style={{ color: 'rgba(255,255,255,0.22)' }}>After discounts</p>
            </Link>

            <Link href="/orders"
              className="relative rounded-2xl p-6 overflow-hidden ops-grain group transition-all duration-200 hover:-translate-y-0.5"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 0 20px rgba(255,255,255,0.06)' }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none' }}>
              <p className="text-[10px] font-black uppercase tracking-[0.28em] mb-3" style={{ color: 'rgba(255,255,255,0.3)' }}>Orders</p>
              <p className="metric-value-xl" style={{ color: '#E8EAF0' }}>
                {todaySales?.totals?.orders ?? '—'}
              </p>
              <p className="text-xs mt-2 font-medium" style={{ color: 'rgba(255,255,255,0.22)' }}>Completed today</p>
            </Link>
          </div>
        </section>

        {/* ── Two-column: CRM + Recent Orders ─────────────────────────────── */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2"
          style={{ animationName: 'ops-revealUp', animationDuration: '0.5s', animationDelay: '0.19s', animationFillMode: 'both' }}>

          {/* CRM Pulse */}
          <div className="relative rounded-2xl p-5 overflow-hidden ops-grain"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="absolute pointer-events-none"
              style={{ top: '-20px', right: '-20px', width: '120px', height: '120px',
                background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
                animation: 'ops-glowPulse 7s ease-in-out infinite',
              }} />
            <div className="relative z-10 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-[0.28em]" style={{ color: 'rgba(255,255,255,0.3)' }}>Customer Pulse</p>
                <Link href="/crm" className="text-xs font-bold transition-colors hover:text-white" style={{ color: '#00D4B1' }}>View CRM →</Link>
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                {[
                  { label: 'Total',         value: smartSegments?.summary.totalCustomers ?? '—', accent: '#E8EAF0' },
                  { label: 'New (30d)',      value: newCustomers,   accent: '#00D4B1' },
                  { label: 'Cart Abandoned', value: cartAbandoners, accent: '#F59E0B' },
                ].map((s) => (
                  <div key={s.label}
                    className="text-center rounded-xl p-3"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <p className="text-2xl font-black tabular-nums" style={{ color: s.accent }}>{s.value}</p>
                    <p className="text-[9.5px] font-semibold mt-1" style={{ color: 'rgba(255,255,255,0.28)' }}>{s.label}</p>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between text-xs pt-2"
                style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <span style={{ color: 'rgba(255,255,255,0.3)' }}>Repeat rate</span>
                <span className="font-black" style={{ color: '#00D4B1' }}>{smartSegments?.summary.repeatRate ?? '—'}%</span>
              </div>
            </div>
          </div>

          {/* Recent Orders */}
          <div className="relative rounded-2xl p-5 overflow-hidden ops-grain"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="relative z-10 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-[0.28em]" style={{ color: 'rgba(255,255,255,0.3)' }}>Recent Orders</p>
                <Link href="/orders" className="text-xs font-bold transition-colors hover:text-white" style={{ color: '#00D4B1' }}>All orders →</Link>
              </div>
              {(recentOrders?.data ?? []).length === 0 ? (
                <p className="text-sm text-center py-6" style={{ color: 'rgba(255,255,255,0.18)' }}>No recent orders</p>
              ) : (
                <div className="space-y-1">
                  {(recentOrders?.data ?? []).slice(0, 5).map((order, i) => (
                    <div key={order.id}
                      className="flex items-center justify-between py-2.5 rounded-xl px-2 transition-colors"
                      style={{ animationName: 'ops-revealUp', animationDuration: '0.35s',
                        animationDelay: `${0.22 + i * 0.04}s`, animationFillMode: 'both' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="font-mono text-[10px]" style={{ color: 'rgba(255,255,255,0.22)' }}>
                          #{order.id.slice(-5).toUpperCase()}
                        </span>
                        <span className="text-xs truncate" style={{ color: 'rgba(255,255,255,0.5)' }}>
                          {order.customerName ?? order.concept.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-bold" style={{ color: '#E8EAF0' }}>{fmt(order.totalCents)}</span>
                        <span className="text-[9px] font-black px-2 py-0.5 rounded-full" style={
                          order.status === 'completed'
                            ? { background: 'rgba(0,212,177,0.12)', color: '#00D4B1' }
                            : order.status === 'cancelled' || order.status === 'rejected'
                            ? { background: 'rgba(255,77,79,0.12)', color: '#FF4D4F' }
                            : { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)' }
                        }>{order.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Quick Access ────────────────────────────────────────────────── */}
        <section style={{ animationName: 'ops-revealUp', animationDuration: '0.5s', animationDelay: '0.24s', animationFillMode: 'both' }}>
          <div className="flex items-center gap-2.5 mb-4">
            <p className="text-[10px] font-black uppercase tracking-[0.3em]" style={{ color: 'rgba(255,255,255,0.3)' }}>Quick Access</p>
            <div className="h-px flex-1" style={{ background: 'rgba(255,255,255,0.04)' }} />
          </div>
          <div className="grid grid-cols-4 gap-2.5 sm:grid-cols-8">
            {QUICK_LINKS.map((item, i) => (
              <QuickLinkCard key={item.href} item={item} index={i} />
            ))}
          </div>
        </section>

        {/* ── Accounting Hub shortcut ──────────────────────────────────────── */}
        <section
          className="relative rounded-2xl p-6 overflow-hidden ops-grain"
          style={{
            background: 'linear-gradient(135deg, rgba(0,212,177,0.06) 0%, rgba(99,102,241,0.04) 100%)',
            border: '1px solid rgba(0,212,177,0.14)',
            animationName: 'ops-revealUp', animationDuration: '0.5s', animationDelay: '0.31s', animationFillMode: 'both',
          }}>
          <div className="absolute pointer-events-none" style={{
            top: '-30px', right: '-30px',
            width: '180px', height: '180px',
            background: 'radial-gradient(circle, rgba(0,212,177,0.08) 0%, transparent 70%)',
            animation: 'ops-glowPulse 9s ease-in-out infinite',
          }} />
          <div className="relative z-10">
            <div className="flex items-start justify-between mb-5">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.28em] mb-1" style={{ color: 'rgba(0,212,177,0.6)' }}>Finance</p>
                <p className="font-black text-lg" style={{ color: '#E8EAF0' }}>Accounting Hub</p>
                <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>P&L · Food Cost · Recipe Costing · Vendor Management</p>
              </div>
              <Link href="/accounting"
                className="text-xs font-black px-4 py-2 rounded-full transition-all hover:scale-105 hover:shadow-lg shrink-0"
                style={{
                  background: 'linear-gradient(135deg, #00D4B1, #6366F1)',
                  color: '#000',
                  boxShadow: '0 0 16px rgba(0,212,177,0.3)',
                }}>
                Open →
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {[
                { href: '/accounting',           label: 'P&L Overview',   icon: '📊' },
                { href: '/accounting/food-cost', label: 'Food Cost %',    icon: '🍽' },
                { href: '/accounting/recipes',   label: 'Recipe Costing', icon: '📐' },
                { href: '/accounting/vendors',   label: 'Vendors & POs',  icon: '🏭' },
              ].map((item) => (
                <Link key={item.href} href={item.href}
                  className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition-all hover:-translate-y-0.5"
                  style={{
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid rgba(0,212,177,0.1)',
                    color: 'rgba(255,255,255,0.45)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(0,212,177,0.3)'; e.currentTarget.style.color = '#00D4B1' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(0,212,177,0.1)'; e.currentTarget.style.color = 'rgba(255,255,255,0.45)' }}>
                  <span>{item.icon}</span>
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Tomorrow's Top Items */}
        {forecast && forecast.items.length > 0 && (
          <section style={{ animationName: 'ops-revealUp', animationDuration: '0.6s', animationTimingFunction: 'cubic-bezier(0.22,1,0.36,1)', animationDelay: '0.7s', animationFillMode: 'both' }}>
            <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-black uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.35)' }}>Tomorrow&apos;s Top Items</h2>
                  <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.2)' }}>AI demand forecast</p>
                </div>
                <Link href="/analytics/forecast"
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                  style={{ color: 'rgba(0,212,177,0.7)', background: 'rgba(0,212,177,0.06)', border: '1px solid rgba(0,212,177,0.1)' }}>
                  Full forecast →
                </Link>
              </div>
              <div className="space-y-2">
                {forecast.items
                  .map(item => ({ name: item.name, qty: item.forecasts[0]?.predictedQty ?? 0 }))
                  .sort((a, b) => b.qty - a.qty)
                  .slice(0, 5)
                  .map((item, i) => {
                    const maxQty = forecast.items[0] ? (forecast.items[0].forecasts[0]?.predictedQty ?? 1) : 1
                    const pct = maxQty > 0 ? Math.round((item.qty / maxQty) * 100) : 0
                    return (
                      <div key={i} className="flex items-center gap-3">
                        <span className="text-xs font-bold w-4 text-right shrink-0" style={{ color: 'rgba(255,255,255,0.2)' }}>{i + 1}</span>
                        <span className="text-sm font-semibold flex-1 truncate" style={{ color: 'rgba(255,255,255,0.75)' }}>{item.name}</span>
                        <div className="h-1.5 w-24 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #00D4B1, #6366F1)' }} />
                        </div>
                        <span className="text-xs font-bold w-8 text-right shrink-0" style={{ color: '#00D4B1' }}>{item.qty}</span>
                      </div>
                    )
                  })}
              </div>
            </div>
          </section>
        )}

      </div>
    </div>
  )
}

// Exception-inbox widget — surfaces only when there's an open flag. Owner sees
// it on the dashboard without having to navigate to /exceptions.
function ExceptionInboxWidget() {
  const { data: stats } = useQuery({
    queryKey: ['exception-stats-dashboard'],
    queryFn: () => api.get<{ open: number; acknowledged: number; last24h: number; byKind: { kind: string; count: number }[] }>('/crosschecks/exceptions/stats'),
    refetchInterval: 60_000,
  })
  if (!stats || stats.open === 0) return null

  const kindEmoji: Record<string, string> = {
    receiving_variance: '📦', short_shipment: '⚠️', price_drift: '💸',
    yield_low: '📉', shrinkage: '🕳', consecutive_voids: '🔄',
    high_value_void: '🚫', cash_variance: '💰', refund_above_threshold: '↩️',
    comp_above_threshold: '🎁', self_approval: '🛑',
  }

  return (
    <Link href="/exceptions" className="block rounded-2xl p-5 transition-colors"
      style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.3)' }}>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-3xl shrink-0">⚠️</span>
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-[0.24em] text-red-300/80">Owner inbox</p>
            <p className="text-lg font-black text-white/90">
              {stats.open} open exception{stats.open === 1 ? '' : 's'} · {stats.last24h} in last 24h
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {stats.byKind.slice(0, 6).map((b) => (
                <span key={b.kind} className="text-[11px] font-bold px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.75)' }}>
                  {kindEmoji[b.kind] ?? '⚠'} {b.kind.replace(/_/g, ' ')} · {b.count}
                </span>
              ))}
            </div>
          </div>
        </div>
        <span className="text-xs font-bold text-red-300/80">Open inbox →</span>
      </div>
    </Link>
  )
}
