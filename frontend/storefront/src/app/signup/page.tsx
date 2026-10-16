'use client'
import Link from 'next/link'
import { SignupForm } from '../../components/auth/SignupForm'

// /signup — glassmorphism card over the servd-purple WebGL shader. The
// two-step one-code flow lives in components/auth/SignupForm so the storefront
// content module's sign-up block reuses the same flow.

export default function SignupPage() {
  return (
    <div className="relative flex items-center justify-center px-5 py-12" style={{ minHeight: '100dvh', background: 'var(--servd-surface)' }}>
      <div className="relative z-10 w-full max-w-sm">
        <Link href="/" aria-label="servd home" className="mb-6 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/servd-logo.png" alt="servd" width={64} height={64} style={{ width: 64, height: 64, borderRadius: 14 }} />
        </Link>

        <div className="w-full rounded-3xl px-7 py-8 shadow-xl" style={{ animation: 'fadeSlideUp 0.4s both', background: '#ffffff', border: '1px solid var(--servd-line)', color: 'var(--servd-ink)' }}>
          <SignupForm />
        </div>

        <Link href="/" className="mt-6 block text-center text-xs font-semibold text-[color:var(--servd-mute)] hover:text-[color:var(--servd-ink)] transition-colors" style={{ textDecoration: 'none' }}>
          ← Back to home
        </Link>
      </div>
    </div>
  )
}
