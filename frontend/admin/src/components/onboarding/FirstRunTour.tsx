'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

interface TourStep {
  emoji: string
  title: string
  body: string
  cta?: { label: string; href: string }
}

const STEPS: TourStep[] = [
  {
    emoji: '👋',
    title: 'Welcome to servd',
    body: "You're looking at the Operations Dashboard — your live cockpit. Orders, revenue, low-stock alerts, top items — all on one screen, no clicks needed.",
  },
  {
    emoji: '🖥',
    title: 'Kitchen runs on the KDS',
    body: 'The Kitchen Display System replaces paper tickets. Tap items to bump, hold, or recall. Tap a dish to see cooking steps + ingredient list. Voice control: say "bump 47".',
    cta: { label: 'Peek at the KDS', href: '/kds' },
  },
  {
    emoji: '💳',
    title: 'POS for in-store + waiter ordering',
    body: 'Cashiers use /pos. Waiters use /pos/waiter (mobile-first, table-aware). Both feed the same order pipeline as the online storefront and WhatsApp.',
    cta: { label: 'Open POS', href: '/pos' },
  },
  {
    emoji: '🎛',
    title: 'One place to configure everything',
    body: 'Tax rates, payment methods, loyalty, hours, integrations, audit log — all live in the Configuration Hub. The dashboard checklist nudges you through what\'s left.',
    cta: { label: 'Open Configuration Hub', href: '/configuration' },
  },
  {
    emoji: '💬',
    title: 'Suppliers chat in one thread',
    body: 'Skip WhatsApp scramble across staff phones. Add a supplier, send them a portal link via WhatsApp, and every order conversation lives in one searchable thread.',
    cta: { label: 'Open Supplier Chat', href: '/procurement/chat' },
  },
  {
    emoji: '🎉',
    title: "That's the tour",
    body: "Need help? Tap the Help link anytime. The first-run checklist on the dashboard will walk you through the rest. Let's go.",
  },
]

const STORAGE_KEY = 'servd_tour_seen_v1'

/**
 * Modal overlay shown on first login. Dismissable, stored in localStorage so
 * it doesn't reappear. Skipping is one click — never trap the user.
 */
export function FirstRunTour() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (localStorage.getItem(STORAGE_KEY)) return
    // Small delay so it doesn't compete with first-paint
    const t = setTimeout(() => setOpen(true), 600)
    return () => clearTimeout(t)
  }, [])

  function dismiss() {
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, '1')
    setOpen(false)
  }

  if (!open) return null
  const s = STEPS[step]
  if (!s) return null
  const isLast = step === STEPS.length - 1

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(6px)' }}
      onClick={dismiss}
    >
      <div
        className="relative w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl"
        style={{
          background: 'linear-gradient(180deg, #14161e 0%, #0d0f15 100%)',
          border: '1px solid rgba(0,212,177,0.22)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Glow ring */}
        <div
          className="absolute pointer-events-none inset-0"
          style={{
            background: 'radial-gradient(ellipse at top, rgba(0,212,177,0.12) 0%, transparent 60%)',
          }}
        />

        {/* Step indicator */}
        <div className="relative flex items-center justify-between px-5 pt-5 pb-2">
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-8 bg-[#00D4B1]' : i < step ? 'w-4 bg-[#00D4B1]/40' : 'w-4 bg-white/10'
                }`}
              />
            ))}
          </div>
          <button
            onClick={dismiss}
            className="text-xs text-white/40 hover:text-white/70"
          >
            Skip tour
          </button>
        </div>

        {/* Content */}
        <div className="relative px-7 pt-4 pb-7 text-center">
          <div
            className="text-7xl mb-5 mx-auto inline-block"
            style={{ animation: 'tour-bounce 1.6s ease-in-out infinite' }}
          >
            {s.emoji}
          </div>
          <h2 className="text-2xl font-black text-white/95">{s.title}</h2>
          <p className="text-sm text-white/55 mt-3 leading-relaxed max-w-md mx-auto">
            {s.body}
          </p>
        </div>

        {/* Footer */}
        <div className="relative flex items-center justify-between gap-2 px-5 pb-5">
          <button
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
            className="rounded-xl border border-white/10 px-4 py-2.5 text-xs font-bold text-white/55 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← Back
          </button>
          <div className="flex items-center gap-2">
            {s.cta && (
              <Link
                href={s.cta.href}
                onClick={dismiss}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-xs font-bold text-white/65 hover:text-white"
              >
                {s.cta.label} →
              </Link>
            )}
            {isLast ? (
              <button
                onClick={dismiss}
                className="rounded-xl bg-kds-green px-5 py-2.5 text-xs font-black text-black hover:opacity-90"
              >
                Let's go →
              </button>
            ) : (
              <button
                onClick={() => setStep(step + 1)}
                className="rounded-xl bg-kds-green px-5 py-2.5 text-xs font-black text-black hover:opacity-90"
              >
                Next →
              </button>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes tour-bounce {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-8px); }
        }
      `}</style>
    </div>
  )
}
