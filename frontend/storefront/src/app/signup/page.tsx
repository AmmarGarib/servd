'use client'
import Link from 'next/link'
import { SmokeyBackground } from '../../components/ui/SmokeyBackground'
import { SignupForm } from '../../components/auth/SignupForm'

// /signup — glassmorphism card over the servd-purple WebGL shader. The
// two-step one-code flow lives in components/auth/SignupForm so the storefront
// content module's sign-up block reuses the same flow.

export default function SignupPage() {
  return (
    <div className="relative flex items-center justify-center px-5 py-12" style={{ minHeight: '100dvh', background: 'var(--servd-black)' }}>
      <SmokeyBackground color="#5c3458" backdropBlur="sm" />

      <div className="relative z-10 w-full max-w-sm">
        <Link href="/" aria-label="servd home" className="mb-6 block text-center"
          style={{ fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.045em', color: 'white', textDecoration: 'none' }}>
          servd<span style={{ color: 'var(--servd-green)' }}>.</span>
        </Link>

        <div className="w-full rounded-3xl px-7 py-8 backdrop-blur-xl border border-white/20 shadow-2xl" style={{ animation: 'fadeSlideUp 0.4s both', background: 'linear-gradient(rgb(255 255 255 / 0.10), rgb(255 255 255 / 0.10)), color-mix(in srgb, var(--servd-black) 80%, transparent)' }}>
          <SignupForm />
        </div>

        <Link href="/" className="mt-6 block text-center text-xs font-semibold text-white/50 hover:text-white/80 transition-colors" style={{ textDecoration: 'none' }}>
          ← Back to home
        </Link>
      </div>
    </div>
  )
}
