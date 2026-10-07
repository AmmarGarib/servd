'use client'
import Link from 'next/link'
import { useState } from 'react'

const SUPPORT_WHATSAPP = '923000000000'   // placeholder — set to your real support number

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'How do I bump an item on the KDS without touching the screen?',
    a: 'Open the KDS → tap the 🎙 icon in the top-right to enable voice control. Then say "bump 47" (where 47 is the last 2 digits of the order ID). You can also say "hold 23", "fire 12", "recall 8".',
  },
  {
    q: 'A customer\'s receipt didn\'t print. What now?',
    a: 'Open the order in the Orders page, click the order, and use "Print Receipt" — that opens a browser print dialog and works with any USB or networked printer. To wire up an automatic network printer, go to Configuration → Receipt Printer.',
  },
  {
    q: 'How does auto-86 work?',
    a: 'When the recipe-driven inventory worker deducts an ingredient and it drops to zero, every menu item whose recipe uses that ingredient is automatically marked unavailable across POS and the storefront. You\'ll see an alert on the dashboard and the items go grey on the menu editor.',
  },
  {
    q: 'How do I add a supplier and start chatting with them?',
    a: 'Suppliers → Supplier Chat → "+ Add". A 3-step wizard walks you through: (1) name + category + phone, (2) one-tap WhatsApp invite with their portal link, (3) pick a message template and send. Whole flow is ~30 seconds.',
  },
  {
    q: 'My demand forecast looks off — why?',
    a: 'The forecast uses 28 days of completed-order history, grouped by day-of-week, then overlays weather (rainy = +20%, hot = +5%). If you\'ve been live less than 2 weeks, confidence will be "low" and numbers are directional only. Two factors not yet modelled: month-end paydays and Ramadan/holiday spikes.',
  },
  {
    q: 'Where do I configure tax / FBR?',
    a: 'Configuration → Tax & FBR. Per-item override is set in Menu Editor → Edit item → Tax Classification (standard / reduced / zero / exempt / custom). Submission to FBR runs every 5 minutes via a background worker.',
  },
  {
    q: 'Can I run the KDS in Urdu?',
    a: 'Yes. Tap "اردو" in the KDS top bar. To translate item names + cooking instructions, edit each menu item and fill in nameUrdu / instructionsUrdu, or fill stepsUrdu in Recipe Costing.',
  },
  {
    q: 'A photo upload failed — what\'s wrong?',
    a: 'Photo uploads use Cloudflare R2. If R2 isn\'t configured, uploads fail silently. Go to Settings → Integrations and check the R2 status pill. You\'ll need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL.',
  },
  {
    q: 'How do course pacing and "fires in 4:32" work?',
    a: 'When an order has multiple items with different cook times (from Recipe.laborMinutes), shorter items are scheduled to auto-fire later so everything plates together. Example: burger (12 min) fires now, fries (4 min) fire 8 min later. You see the countdown on un-fired items.',
  },
  {
    q: 'Can I export sales as CSV for my accountant?',
    a: 'Yes — Reports → Sales → "Export CSV" gives line-by-line transactions in the date range. For the FBR-style monthly summary, use Accounting → Sales Tax Return.',
  },
]

export default function HelpPage() {
  const [search, setSearch] = useState('')
  const filtered = FAQ.filter((f) =>
    !search.trim() ||
    f.q.toLowerCase().includes(search.toLowerCase()) ||
    f.a.toLowerCase().includes(search.toLowerCase())
  )

  const waSupportUrl = `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent('Hi servd team, I need help with: ')}`

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      {/* Header */}
      <header className="px-7 py-7 border-b border-white/[0.05]">
        <div className="max-w-3xl">
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Help center</p>
          <h1 className="text-2xl font-black text-white/90 mt-1">How can we help?</h1>
          <p className="text-sm text-white/40 mt-1.5">
            Search the FAQ, or talk to a human via WhatsApp — we usually reply within an hour during business hours.
          </p>
        </div>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-7">
        {/* Quick-help cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <a
            href={waSupportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-2xl p-4 transition-all hover:-translate-y-0.5"
            style={{ background: 'linear-gradient(135deg, rgba(37,211,102,0.12), rgba(37,211,102,0.04))', border: '1px solid rgba(37,211,102,0.3)' }}
          >
            <p className="text-2xl mb-2">📱</p>
            <p className="font-bold text-sm text-white/85">WhatsApp support</p>
            <p className="text-xs text-white/45 mt-0.5">Fastest path — chat with our team</p>
            <p className="text-[11px] text-[#25D366] font-bold mt-2">Open chat →</p>
          </a>

          <a
            href="mailto:servd@gsfoods.pk"
            className="rounded-2xl p-4 transition-all hover:-translate-y-0.5"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}
          >
            <p className="text-2xl mb-2">✉</p>
            <p className="font-bold text-sm text-white/85">Email us</p>
            <p className="text-xs text-white/45 mt-0.5">servd@gsfoods.pk</p>
            <p className="text-[11px] text-white/45 font-bold mt-2">Reply within 24h →</p>
          </a>

          <Link
            href="/configuration"
            className="rounded-2xl p-4 transition-all hover:-translate-y-0.5"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}
          >
            <p className="text-2xl mb-2">🎛</p>
            <p className="font-bold text-sm text-white/85">Configuration Hub</p>
            <p className="text-xs text-white/45 mt-0.5">Find every settings tab in one place</p>
            <p className="text-[11px] text-white/45 font-bold mt-2">Open hub →</p>
          </Link>
        </div>

        {/* Search */}
        <div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search FAQ — try 'voice', 'tax', 'KDS', 'supplier'…"
            className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none"
            style={{
              background: 'rgb(var(--fg-rgb) / 0.03)',
              border: '1px solid rgb(var(--fg-rgb) / 0.08)',
              color: 'rgb(var(--fg-rgb) / 0.85)',
            }}
          />
        </div>

        {/* FAQ list */}
        <div className="space-y-2">
          {filtered.length === 0 && (
            <div className="rounded-xl p-6 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
              <p className="text-sm text-white/45">No matching FAQ. Try WhatsApp — we&apos;ll add it to the list once we answer.</p>
            </div>
          )}
          {filtered.map((f, i) => (
            <details
              key={i}
              className="rounded-xl group"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}
            >
              <summary className="cursor-pointer px-4 py-3 list-none flex items-center justify-between gap-3 hover:bg-white/[0.02] rounded-xl">
                <span className="text-sm font-semibold text-white/85 flex-1">{f.q}</span>
                <span className="text-xs text-white/40 group-open:rotate-90 transition-transform">▶</span>
              </summary>
              <div className="px-4 pb-4 text-sm text-white/65 leading-relaxed border-t border-white/[0.04] pt-3 mt-1">
                {f.a}
              </div>
            </details>
          ))}
        </div>

        {/* Support hours */}
        <div className="rounded-2xl p-4 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
          <p className="text-xs text-white/40">
            Support hours: Mon–Sat, 10:00–22:00 PKT · Sun on-call only
          </p>
        </div>
      </div>
    </div>
  )
}
