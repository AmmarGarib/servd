'use client'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { ordersApi, api } from '../../lib/api'

interface SalesData { totals: { gross: number; net: number; orders: number; tax: number; commission: number } }
interface InventoryAlert { id: string; name: string; currentStock: number; parLevel: number }
interface Anomaly {
  severity: 'low' | 'medium' | 'high'
  category: string
  title: string
  detail: string
  actionUrl?: string
}
interface AnomaliesResp { flags: Anomaly[] }
interface OpenComplaints { stats: { open: number; inProgress: number } }

const SEVERITY_COLOR: Record<string, string> = { high: '#FF4D4F', medium: '#F59E0B', low: '#94A3B8' }

function fmtPKR(cents: number) {
  if (cents >= 1_00_000_00) return `PKR ${(cents / 1_00_000_00).toFixed(1)}L`
  if (cents >= 1_000_00)    return `PKR ${(cents / 1_000_00).toFixed(0)}K`
  return `PKR ${(cents / 100).toFixed(0)}`
}

export default function OwnerMobilePage() {
  const today = new Date().toISOString().slice(0, 10)

  const { data: sales } = useQuery<SalesData>({
    queryKey: ['mobile-sales-today'],
    queryFn: () => api.get(`/reports/sales?dateFrom=${today}T00:00:00Z&dateTo=${today}T23:59:59Z`),
    refetchInterval: 60_000,
  })

  const { data: liveOrders } = useQuery({
    queryKey: ['mobile-live-orders'],
    queryFn: () => ordersApi.list({ status: 'received,confirmed,preparing,ready', limit: '100' }),
    refetchInterval: 15_000,
  })

  const { data: alerts = [] } = useQuery<InventoryAlert[]>({
    queryKey: ['mobile-inventory-alerts'],
    queryFn: () => api.get('/inventory/alerts'),
    refetchInterval: 5 * 60_000,
  })

  const { data: anomalies } = useQuery<AnomaliesResp>({
    queryKey: ['mobile-anomalies'],
    queryFn: () => api.get('/ops/anomalies?hours=24'),
    refetchInterval: 60_000,
  })

  const { data: complaints } = useQuery<OpenComplaints>({
    queryKey: ['mobile-complaints'],
    queryFn: () => api.get('/complaints/stats'),
    refetchInterval: 60_000,
  })

  const liveCount = liveOrders?.data.length ?? 0
  const sortedFlags = (anomalies?.flags ?? []).slice(0, 5)

  return (
    <main className="min-h-screen pb-12" style={{ background: '#090a0e' }}>
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 px-5 py-4 flex items-center justify-between"
        style={{ background: 'rgba(9,10,14,0.92)', borderBottom: '1px solid rgba(255,255,255,0.05)', backdropFilter: 'blur(20px)' }}>
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg flex items-center justify-center text-xs font-black text-black"
            style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)' }}>S</div>
          <div>
            <p className="text-xs font-black tracking-tight text-white/85">servd</p>
            <p className="text-[10px] text-white/35 leading-none mt-0.5">Owner View</p>
          </div>
        </div>
        <Link href="/dashboard" className="text-xs text-white/45">Desktop ↗</Link>
      </header>

      {/* ── Today gross — hero stat ─────────────────────────────────── */}
      <section className="px-5 pt-6 pb-4">
        <p className="text-[10px] font-black uppercase tracking-[0.28em] text-white/30">Today</p>
        <p className="text-5xl font-black mt-2 leading-none"
          style={{
            background: 'linear-gradient(90deg, #00D4B1, #6366F1)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>
          {sales ? fmtPKR(sales.totals.gross) : '—'}
        </p>
        <p className="text-xs text-white/40 mt-2">
          {sales ? `${sales.totals.orders} orders · avg ${fmtPKR(sales.totals.orders > 0 ? sales.totals.gross / sales.totals.orders : 0)}` : 'Loading…'}
        </p>
      </section>

      {/* ── 3-up KPI strip ──────────────────────────────────────────── */}
      <section className="px-5 grid grid-cols-3 gap-2 mb-5">
        <KpiTile emoji="🔥" value={liveCount} label="Live orders" color="#F59E0B" href="/orders" />
        <KpiTile emoji="📦" value={alerts.length} label="Low stock" color={alerts.length > 0 ? '#FF4D4F' : '#00D4B1'} href="/inventory/alerts" />
        <KpiTile emoji="🎫" value={complaints?.stats.open ?? 0} label="Complaints" color={(complaints?.stats.open ?? 0) > 0 ? '#FF4D4F' : '#00D4B1'} href="/complaints" />
      </section>

      {/* ── Anomalies ───────────────────────────────────────────────── */}
      {sortedFlags.length > 0 && (
        <section className="px-5 mb-5">
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-white/40 mb-2">⚠ Needs attention</p>
          <div className="space-y-2">
            {sortedFlags.map((f, i) => (
              <Link key={i} href={f.actionUrl ?? '/ops'}
                className="block rounded-2xl p-4"
                style={{
                  background: `${SEVERITY_COLOR[f.severity]}10`,
                  border: `1px solid ${SEVERITY_COLOR[f.severity]}55`,
                }}>
                <div className="flex items-center justify-between">
                  <p className="font-bold text-sm text-white/90">{f.title}</p>
                  <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{ background: SEVERITY_COLOR[f.severity], color: '#000' }}>
                    {f.severity}
                  </span>
                </div>
                <p className="text-xs text-white/55 mt-1 leading-relaxed">{f.detail}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {sortedFlags.length === 0 && anomalies && (
        <section className="px-5 mb-5">
          <div className="rounded-2xl p-4 text-center"
            style={{ background: 'rgba(0,212,177,0.05)', border: '1px solid rgba(0,212,177,0.2)' }}>
            <p className="text-2xl">✅</p>
            <p className="font-bold text-kds-green mt-1">All clear</p>
            <p className="text-xs text-white/40 mt-0.5">No anomalies in the last 24h.</p>
          </div>
        </section>
      )}

      {/* ── Quick actions ───────────────────────────────────────────── */}
      <section className="px-5 mb-5">
        <p className="text-[10px] font-black uppercase tracking-[0.28em] text-white/40 mb-2">Quick actions</p>
        <div className="grid grid-cols-2 gap-2">
          <ActionTile href="/kds/all"           emoji="🖥" label="Open KDS" />
          <ActionTile href="/orders"            emoji="📋" label="Order list" />
          <ActionTile href="/ops"               emoji="⚡" label="Ops Center" />
          <ActionTile href="/reports"           emoji="📈" label="Reports" />
          <ActionTile href="/pos/shift"         emoji="🕐" label="Shift report" />
          <ActionTile href="/marketing"         emoji="🚀" label="Marketing" />
        </div>
      </section>

      {/* ── Footer note ─────────────────────────────────────────────── */}
      <footer className="px-5 mt-6 text-center">
        <p className="text-[10px] text-white/25">
          Auto-refreshing every 60s · Tap any card to drill in
        </p>
      </footer>
    </main>
  )
}

function KpiTile({ emoji, value, label, color, href }: { emoji: string; value: number; label: string; color: string; href: string }) {
  return (
    <Link href={href}
      className="rounded-2xl p-3 text-center"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <p className="text-base">{emoji}</p>
      <p className="text-2xl font-black mt-1 leading-none" style={{ color }}>{value}</p>
      <p className="text-[10px] text-white/40 mt-1">{label}</p>
    </Link>
  )
}

function ActionTile({ href, emoji, label }: { href: string; emoji: string; label: string }) {
  return (
    <Link href={href}
      className="rounded-2xl p-4 flex items-center gap-3"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <span className="text-2xl">{emoji}</span>
      <span className="text-sm font-bold text-white/85">{label}</span>
    </Link>
  )
}
