'use client'
import Link from 'next/link'

const FEATURES = [
  { emoji: '🍳', title: 'Kitchen Display System',
    body: 'Real-time tickets, course pacing, voice control, photo-on-bump, Urdu mode. Built for the noise + speed of a Pakistani kitchen line.' },
  { emoji: '💳', title: 'Point of Sale + Online ordering',
    body: 'One pipeline for POS, storefront, Foodpanda, Careem, WhatsApp orders. Auto-86 across every channel when stock hits zero.' },
  { emoji: '📊', title: 'Demand forecasting',
    body: '4-week rolling average + day-of-week + weather overlay (rainy = +20% biryani sales). Auto prep-list per station for tomorrow.' },
  { emoji: '🧾', title: 'FBR-compliant invoicing',
    body: 'PRAL e-invoice submission every 5 min. STRN/NTN handling, sales tax return CSVs, audit-ready ledgers.' },
  { emoji: '👥', title: 'Granular permissions',
    body: 'Owner, manager, cashier, cook, rider, marketing — every cell of the matrix is editable. Bring your agency in safely.' },
  { emoji: '🏢', title: 'Multi-brand, multi-location',
    body: 'Run a multi-concept kitchen out of one place; or many places out of one brand. Filter accounting by both axes.' },
  { emoji: '🔮', title: 'Anomaly alerts',
    body: 'Ticket times spiking? Voids elevated? Aggregator silent for 4h? You hear about it before customers complain.' },
  { emoji: '🛡', title: 'Battle-tested order pipeline',
    body: '27-test smoke suite covers ingestion, station routing, course pacing, inventory race-safety, lifecycle, idempotency.' },
  { emoji: '🚀', title: '60-second onboarding',
    body: 'Pick a template — Biryani, Burger, Cafe, Fine Dining, Cloud Kitchen — get a real menu, recipes, stations seeded.' },
]

const PLANS = [
  { name: 'Starter', emoji: '🌱', price: '4,999', features: [
    '1 location · POS + KDS + Storefront', 'Foodpanda integration', 'Basic CRM (5,000 customers)', 'Email support',
  ] },
  { name: 'Growth', emoji: '🚀', price: '12,999', highlight: true, features: [
    'Up to 3 locations', 'Foodpanda + Careem + WhatsApp', 'Recipe costing + auto-86', 'Demand forecasting (with weather)',
    'Voice KDS + course pacing', 'Loyalty + segments', 'WhatsApp support (Mon–Sat)',
  ] },
  { name: 'Chain', emoji: '🏢', price: '34,999', features: [
    'Unlimited locations', 'Multi-brand chain rollup', 'Custom roles + audit retention', 'API tokens for partners',
    'FBR e-invoice automation', 'Dedicated onboarding manager', '99.9% SLA',
  ] },
]

export default function WelcomePage() {
  return (
    <main className="min-h-screen overflow-x-hidden" style={{ background: '#090a0e' }}>
      {/* Top nav */}
      <header className="px-6 py-5 flex items-center justify-between max-w-[1200px] mx-auto">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg flex items-center justify-center text-sm font-black text-black"
            style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)' }}>S</div>
          <span className="font-black text-white/90 text-lg tracking-tight">servd</span>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <a href="#features" className="text-white/55 hover:text-white hidden sm:inline">Features</a>
          <a href="#pricing" className="text-white/55 hover:text-white hidden sm:inline">Pricing</a>
          <Link href="/login" className="text-white/55 hover:text-white">Sign in</Link>
          <Link href="/signup" className="rounded-xl bg-kds-green px-4 py-2 text-xs font-black text-black hover:opacity-90">
            Start free
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="px-6 pt-12 pb-20 text-center max-w-[1100px] mx-auto relative">
        {/* Ambient glow */}
        <div className="absolute pointer-events-none -z-10 inset-0">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full blur-3xl opacity-30"
            style={{ background: 'radial-gradient(circle, rgba(0,212,177,0.4) 0%, transparent 70%)' }} />
        </div>

        <p className="text-xs font-black uppercase tracking-[0.32em] text-white/40 mb-4">
          The operating system for Pakistani kitchens
        </p>
        <h1 className="text-4xl sm:text-6xl font-black text-white/95 leading-tight tracking-tight">
          Run your kitchen like<br/>
          <span style={{
            background: 'linear-gradient(90deg, #00D4B1, #6366F1)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>it's 2030.</span>
        </h1>
        <p className="text-base sm:text-lg text-white/55 mt-6 max-w-2xl mx-auto leading-relaxed">
          POS, KDS, online ordering, accounting, FBR — one platform that learns from your data and tells you what to prep tomorrow.
          Built for biryani houses, cafes, cloud kitchens, fine dining.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
          <Link href="/signup"
            className="rounded-xl bg-kds-green text-black px-7 py-3.5 text-sm font-black hover:opacity-90 shadow-lg shadow-[#00D4B1]/30">
            Start free 14-day trial →
          </Link>
          <a href="#features" className="rounded-xl border border-white/15 px-7 py-3.5 text-sm font-bold text-white/85 hover:bg-white/5">
            See features
          </a>
        </div>
        <p className="text-xs text-white/35 mt-6">
          No credit card · Cancel any time · Pre-loaded with your menu
        </p>

        {/* Trust strip */}
        <div className="mt-16 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs font-bold uppercase tracking-wider text-white/30">
          <span>🇵🇰 FBR-compliant</span>
          <span>اردو KDS</span>
          <span>Foodpanda + Careem</span>
          <span>27 / 27 smoke tests passing</span>
        </div>
      </section>

      {/* Features grid */}
      <section id="features" className="px-6 py-16 max-w-[1100px] mx-auto">
        <div className="text-center mb-12">
          <p className="text-xs font-black uppercase tracking-[0.32em] text-white/40 mb-3">What you get</p>
          <h2 className="text-3xl sm:text-4xl font-black text-white/95">Every tool in your kitchen, one login.</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl p-5"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-2xl mb-3">{f.emoji}</p>
              <p className="font-black text-white/90">{f.title}</p>
              <p className="text-sm text-white/55 mt-1.5 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-16 max-w-[1100px] mx-auto">
        <div className="text-center mb-12">
          <p className="text-xs font-black uppercase tracking-[0.32em] text-white/40 mb-3">Pricing</p>
          <h2 className="text-3xl sm:text-4xl font-black text-white/95">Pay for the kitchens you run.</h2>
          <p className="text-sm text-white/50 mt-3">Annual billing saves 10%. PKR pricing — talk to us for USD.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {PLANS.map((p) => (
            <div key={p.name}
              className="rounded-2xl p-6 flex flex-col"
              style={{
                background: p.highlight
                  ? 'linear-gradient(135deg, rgba(0,212,177,0.08), rgba(99,102,241,0.05))'
                  : 'rgba(255,255,255,0.025)',
                border: p.highlight ? '1.5px solid rgba(0,212,177,0.45)' : '1px solid rgba(255,255,255,0.06)',
                position: 'relative',
              }}>
              {p.highlight && (
                <span className="absolute -top-3 left-6 text-[10px] font-black tracking-wider px-2.5 py-0.5 rounded-full bg-kds-green text-black">
                  MOST POPULAR
                </span>
              )}
              <p className="text-2xl">{p.emoji}</p>
              <p className="text-xl font-black text-white/95 mt-2">{p.name}</p>
              <div className="my-4">
                <span className="text-3xl font-black text-white/95">PKR {p.price}</span>
                <span className="text-sm text-white/40">/mo</span>
              </div>
              <ul className="space-y-2 flex-1 mb-5">
                {p.features.map((f, i) => (
                  <li key={i} className="text-xs text-white/65 leading-relaxed flex gap-2">
                    <span className="text-kds-green shrink-0">✓</span><span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link href="/signup"
                className="block text-center rounded-xl py-3 text-sm font-black"
                style={p.highlight
                  ? { background: '#00D4B1', color: '#000' }
                  : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.85)', border: '1px solid rgba(255,255,255,0.1)' }}>
                Start {p.name}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* CTA strip */}
      <section className="px-6 py-20 text-center max-w-[1100px] mx-auto">
        <div className="rounded-3xl p-10 sm:p-14"
          style={{
            background: 'linear-gradient(135deg, rgba(0,212,177,0.12), rgba(99,102,241,0.08))',
            border: '1px solid rgba(0,212,177,0.25)',
          }}>
          <h2 className="text-3xl sm:text-4xl font-black text-white/95">Ready to take your first order?</h2>
          <p className="text-sm sm:text-base text-white/60 mt-3 max-w-md mx-auto">
            Sign up, pick a template, watch your menu populate. You'll be running your kitchen on servd before lunch.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup"
              className="rounded-xl bg-kds-green text-black px-7 py-3.5 text-sm font-black hover:opacity-90">
              Start free trial →
            </Link>
            <a href="https://wa.me/923000000000?text=Hi%20servd%20team%2C%20I%27d%20like%20a%20demo"
              target="_blank" rel="noopener noreferrer"
              className="rounded-xl border border-white/15 px-7 py-3.5 text-sm font-bold text-white/85 hover:bg-white/5">
              📱 Talk to sales
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-6 py-10 border-t border-white/[0.05] text-center">
        <p className="text-xs text-white/35">
          servd &middot; Built in Lahore for Pakistani kitchens · {new Date().getFullYear()}
        </p>
      </footer>
    </main>
  )
}
