'use client'
import Link from 'next/link'
import { useAuthStore } from '../store/auth'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { STOREFRONT_URL } from '../lib/content'

const FEATURES = [
  { icon: '🖥', title: 'Kitchen Display', desc: 'Real-time order routing to every station. No tickets, no misses.' },
  { icon: '💳', title: 'Point of Sale', desc: 'Fast POS with split payments, modifiers, and shift management.' },
  { icon: '📱', title: 'Online Ordering', desc: 'Branded storefronts per concept. Delivery, pickup, dine-in.' },
  { icon: '👥', title: 'CRM & Loyalty', desc: 'Segments, wallet, campaigns, and tiered loyalty built in.' },
  { icon: '📊', title: 'Live Analytics', desc: 'P&L, food cost, and revenue — updated in real time.' },
  { icon: '🏭', title: 'Inventory & Recipes', desc: 'Purchase orders, recipe costing, and stock alerts.' },
]


export default function LandingPage() {
  const user = useAuthStore((s) => s.user)
  const router = useRouter()

  useEffect(() => {
    // Signed-in users land on their own workspace home (/w picks it).
    if (user) router.replace('/w')
  }, [user, router])

  return (
    <div className="min-h-screen bg-s-bg overflow-hidden">

      {/* ── Nav ─────────────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-s-bg/80 backdrop-blur border-b border-s-border/50 px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-xs font-black text-primary-on">S</span>
          </div>
          <span className="text-sm font-black text-s-text tracking-tight">servd</span>
        </div>
        <div className="flex items-center gap-3">
          <a href={STOREFRONT_URL}
            className="text-xs text-s-muted hover:text-s-text transition-colors">
            Order Online →
          </a>
          <Link href="/login"
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-s-border bg-s-surface hover:border-primary/40 hover:text-primary-ink text-s-muted transition-all">
            Staff Login
          </Link>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      <section className="relative pt-32 pb-24 px-6 text-center overflow-hidden">
        {/* Ambient glows */}
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[600px] h-[300px] rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(ellipse, rgb(var(--erp-primary-rgb) / 0.08) 0%, transparent 70%)' }} />
        <div className="absolute top-40 left-1/4 w-64 h-64 rounded-full pointer-events-none"
          style={{ background: 'rgb(var(--ink-rgb) / 0.06)', filter: 'blur(60px)' }} />
        <div className="absolute top-40 right-1/4 w-48 h-48 rounded-full pointer-events-none"
          style={{ background: 'rgb(var(--erp-primary-rgb) / 0.05)', filter: 'blur(50px)' }} />

        <div className="relative max-w-3xl mx-auto animate-fade-in">
          <div className="inline-flex items-center gap-2 rounded-full border border-s-teal/20 bg-s-teal-dim/40 px-3 py-1 mb-6">
            <span className="h-1.5 w-1.5 rounded-full bg-s-teal animate-pulse" />
            <span className="text-xs font-medium text-success">Restaurant operations platform</span>
          </div>

          <h1 className="text-5xl sm:text-6xl font-black text-s-text leading-[1.05] tracking-tight mb-5">
            The complete OS<br />
            <span className="text-primary-ink">for your restaurant</span>
          </h1>

          <p className="text-lg text-s-muted leading-relaxed max-w-xl mx-auto mb-10">
            KDS, POS, online ordering, CRM, inventory, and accounting — unified in one platform.
            Built for multi-concept restaurant groups.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link href="/login"
              className="inline-flex items-center gap-2 rounded-xl bg-primary text-primary-on font-black px-6 py-3 text-sm hover:opacity-90 transition-opacity">
              Staff Portal →
            </Link>
            <a href={STOREFRONT_URL}
              className="inline-flex items-center gap-2 rounded-xl border border-s-border bg-s-surface text-s-text font-semibold px-6 py-3 text-sm hover:border-primary/40 transition-all">
              Customer Ordering
              <span className="text-s-dim text-xs">↗</span>
            </a>
          </div>
        </div>
      </section>

      {/* ── Feature grid ────────────────────────────────────────────────────── */}
      <section className="px-6 pb-20 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div key={f.title}
              className="s-card p-5 hover:border-s-teal/30 hover:bg-s-elevated transition-all group cursor-default"
              style={{ animationDelay: `${i * 60}ms` }}>
              <div className="h-10 w-10 rounded-xl bg-s-elevated border border-s-border flex items-center justify-center text-xl mb-4 group-hover:scale-110 transition-transform">
                {f.icon}
              </div>
              <h3 className="font-bold text-s-text mb-1">{f.title}</h3>
              <p className="text-sm text-s-muted leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Two portals ─────────────────────────────────────────────────────── */}
      <section className="px-6 pb-24 max-w-4xl mx-auto">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">

          {/* Staff portal */}
          <div className="rounded-2xl border border-s-teal/20 bg-s-teal-dim/20 p-6">
            <div className="h-12 w-12 rounded-xl bg-s-teal/10 border border-s-teal/20 flex items-center justify-center text-2xl mb-4">⚙</div>
            <h2 className="text-lg font-black text-s-text mb-1">Staff Portal</h2>
            <p className="text-sm text-s-muted mb-5 leading-relaxed">
              Dashboard, KDS, POS, reports, CRM, inventory — everything your team needs to run the operation.
            </p>
            <div className="flex flex-col gap-2">
              <Link href="/login"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-on font-black px-4 py-2.5 text-sm hover:opacity-90 transition-opacity">
                Sign In to Operations →
              </Link>
              <Link href="/kds/login"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-s-teal/20 text-primary-ink font-semibold px-4 py-2.5 text-sm hover:bg-s-teal-dim transition-all text-xs">
                Kitchen Display (PIN)
              </Link>
            </div>
          </div>

          {/* Customer portal */}
          <div className="rounded-2xl border border-s-indigo/20 bg-s-indigo-dim/20 p-6">
            <div className="h-12 w-12 rounded-xl bg-s-indigo/10 border border-s-indigo/20 flex items-center justify-center text-2xl mb-4">🛍</div>
            <h2 className="text-lg font-black text-s-text mb-1">Online Ordering</h2>
            <p className="text-sm text-s-muted mb-5 leading-relaxed">
              Browse menus, place orders, track live status, and earn loyalty points — from any device.
            </p>
            <div className="flex flex-col gap-2">
              <a href={STOREFRONT_URL}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-secondary text-secondary-on font-black px-4 py-2.5 text-sm hover:opacity-90 transition-opacity">
                Order Now →
              </a>
              <a href={`${STOREFRONT_URL}/login`}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-s-indigo/20 text-s-indigo font-semibold px-4 py-2.5 text-sm hover:bg-s-indigo-dim transition-all text-xs">
                Customer Sign In
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-s-border px-6 py-6 flex items-center justify-between text-xs text-s-dim">
        <span className="font-bold text-s-muted">servd</span>
        <span>Built for GS Foods · Multi-concept hospitality OS</span>
      </footer>

    </div>
  )
}
