'use client'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

interface Concept { id: string; name: string; isActive: boolean }

interface Tier {
  key: string
  name: string
  emoji: string
  monthlyPKR: number
  perLocationPKR: number
  features: string[]
  highlight?: boolean
}

const TIERS: Tier[] = [
  {
    key: 'starter',
    name: 'Starter',
    emoji: '🌱',
    monthlyPKR: 4_999,
    perLocationPKR: 0,
    features: [
      '1 location included',
      'POS + KDS + Storefront',
      'Foodpanda integration',
      'Basic CRM (5,000 customers)',
      'Email support',
    ],
  },
  {
    key: 'growth',
    name: 'Growth',
    emoji: '🚀',
    monthlyPKR: 12_999,
    perLocationPKR: 2_500,
    highlight: true,
    features: [
      'Up to 3 locations included',
      'Everything in Starter',
      'Careem + WhatsApp ordering',
      'Recipe costing + inventory auto-86',
      'Demand forecasting (with weather)',
      'Course pacing + voice KDS',
      'Loyalty program + segments',
      'WhatsApp support (Mon–Sat)',
    ],
  },
  {
    key: 'chain',
    name: 'Chain',
    emoji: '🏢',
    monthlyPKR: 34_999,
    perLocationPKR: 1_500,
    features: [
      'Unlimited locations',
      'Everything in Growth',
      'Multi-brand chain rollup',
      'Custom roles + audit log retention',
      'API tokens for partner / mobile app',
      'FBR e-invoice + sales tax automation',
      'Dedicated WhatsApp + onboarding manager',
      '99.9% SLA',
    ],
  },
]

export default function BillingPage() {
  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  // Default suggested plan based on # of concepts
  const suggested = concepts.length <= 1 ? 'starter' : concepts.length <= 3 ? 'growth' : 'chain'

  // Current plan placeholder — read from settings table later
  const currentPlan: 'starter' | 'growth' | 'chain' = 'starter'
  const trialDaysLeft = 12

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div>
          <h1 className="text-2xl font-black text-white/90">💳 Subscription & Billing</h1>
          <p className="text-sm text-white/40 mt-1">
            Plan, invoices, payment method. Pay monthly or annually (10% off).
          </p>
        </div>
      </header>

      <div className="px-7 py-6 max-w-5xl space-y-7">
        {/* Current plan summary */}
        <div className="rounded-2xl p-5"
          style={{ background: 'linear-gradient(135deg, rgba(0,212,177,0.08), rgba(99,102,241,0.05))', border: '1px solid rgba(0,212,177,0.2)' }}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-kds-green/70">Current plan</p>
              <p className="text-2xl font-black text-white/95 mt-1">
                {TIERS.find((t) => t.key === currentPlan)?.emoji} {TIERS.find((t) => t.key === currentPlan)?.name}
              </p>
              <p className="text-sm text-white/55 mt-1">
                Free trial · <strong className="text-amber-400">{trialDaysLeft} days left</strong>
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-white/45">Active locations</p>
              <p className="text-3xl font-black text-white/90">{concepts.filter((c) => c.isActive).length}</p>
              <p className="text-xs text-white/35">{concepts.length} total concepts</p>
            </div>
          </div>
        </div>

        {/* Plan cards */}
        <section>
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h2 className="text-sm font-black uppercase tracking-[0.24em] text-white/60">Choose a plan</h2>
              <p className="text-xs text-white/35 mt-0.5">Suggested: {TIERS.find((t) => t.key === suggested)?.name} for {concepts.length} location{concepts.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {TIERS.map((t) => (
              <div
                key={t.key}
                className="relative rounded-2xl p-5 flex flex-col"
                style={{
                  background: t.highlight
                    ? 'linear-gradient(135deg, rgba(0,212,177,0.08), rgba(99,102,241,0.05))'
                    : 'rgba(255,255,255,0.025)',
                  border: t.highlight ? '1px solid rgba(0,212,177,0.35)' : '1px solid rgba(255,255,255,0.06)',
                }}
              >
                {t.highlight && (
                  <span className="absolute -top-2.5 left-5 rounded-full px-2.5 py-0.5 text-[10px] font-black tracking-wider"
                    style={{ background: '#00D4B1', color: '#000' }}>
                    MOST POPULAR
                  </span>
                )}
                <p className="text-3xl mb-2">{t.emoji}</p>
                <p className="text-xl font-black text-white/95">{t.name}</p>
                <div className="mt-3 mb-1">
                  <span className="text-3xl font-black text-white/95">PKR {t.monthlyPKR.toLocaleString()}</span>
                  <span className="text-xs text-white/45">/mo</span>
                </div>
                {t.perLocationPKR > 0 && (
                  <p className="text-xs text-white/45">+ PKR {t.perLocationPKR.toLocaleString()}/extra location</p>
                )}

                <ul className="space-y-1.5 mt-5 mb-5 flex-1">
                  {t.features.map((f, i) => (
                    <li key={i} className="text-xs text-white/65 leading-relaxed flex gap-2">
                      <span className="text-kds-green shrink-0">✓</span><span>{f}</span>
                    </li>
                  ))}
                </ul>

                <button
                  disabled
                  className="w-full rounded-xl py-2.5 text-sm font-black disabled:cursor-not-allowed"
                  style={
                    currentPlan === t.key
                      ? { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.45)' }
                      : t.highlight
                      ? { background: '#00D4B1', color: '#000' }
                      : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.85)' }
                  }
                >
                  {currentPlan === t.key ? 'Current plan' : 'Switch — coming soon'}
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Annual savings */}
        <div className="rounded-2xl p-4"
          style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.2)' }}>
          <p className="text-xs font-bold text-[#6366F1]">💰 Save 10% with annual billing</p>
          <p className="text-xs text-white/55 mt-0.5">
            Pay yearly upfront → 10% off the monthly price + 30-day grace period after term ends.
          </p>
        </div>

        {/* Payment + invoices */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-2xl p-5"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-sm font-bold text-white/85">Payment method</p>
            <p className="text-xs text-white/45 mt-1">No payment method on file — you&apos;re still in trial.</p>
            <button disabled className="mt-3 rounded-lg border border-white/10 px-4 py-2 text-xs text-white/45 cursor-not-allowed">
              Add card — coming soon
            </button>
          </div>
          <div className="rounded-2xl p-5"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-sm font-bold text-white/85">Invoices</p>
            <p className="text-xs text-white/45 mt-1">No invoices yet. Once you upgrade, downloadable PDFs appear here.</p>
            <button disabled className="mt-3 rounded-lg border border-white/10 px-4 py-2 text-xs text-white/45 cursor-not-allowed">
              View invoices — coming soon
            </button>
          </div>
        </section>

        {/* Talk to sales */}
        <div className="rounded-2xl p-5 text-center"
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-sm font-bold text-white/85">Need a custom plan?</p>
          <p className="text-xs text-white/45 mt-1 max-w-md mx-auto">
            Multi-city chains, white-label, on-prem — we do all of it. Talk to our team.
          </p>
          <a
            href="https://wa.me/923000000000?text=Hi,%20I'd%20like%20to%20talk%20about%20a%20custom%20servd%20plan"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-3 rounded-xl bg-[#25D366] text-white px-5 py-2.5 text-sm font-black hover:opacity-90"
          >
            📱 WhatsApp sales
          </a>
        </div>
      </div>
    </div>
  )
}
