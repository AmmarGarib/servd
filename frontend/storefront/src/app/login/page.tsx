'use client'
import Link from 'next/link'
import { LoginForm } from '../../components/auth/LoginForm'
import { useAuthReturnPath, withReturnPath } from '../../components/auth/authFlow'

// /login — glassmorphism card over an interactive servd-purple WebGL shader.
// The form itself (email/password → /auth/customer/login → setAuth → ?next=,
// else /account) lives in components/auth/LoginForm so the storefront content
// module's sign-in block reuses the same flow. "Create one" carries ?next= on
// to /signup, so a customer sent here from checkout who signs up instead
// still lands back in checkout.

export default function LoginPage() {
  const signupHref = withReturnPath('/signup', useAuthReturnPath())
  return (
    <div className="relative flex items-center justify-center px-5" style={{ minHeight: '100dvh', background: 'var(--servd-surface)' }}>
      <div className="relative z-10 w-full max-w-sm">
        <Link href="/" aria-label="servd home" className="mb-6 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/servd-logo.png" alt="servd" width={64} height={64} style={{ width: 64, height: 64, borderRadius: 14 }} />
        </Link>

        <div className="w-full rounded-3xl px-7 py-8 shadow-xl" style={{ animation: 'fadeSlideUp 0.4s both', background: '#ffffff', border: '1px solid var(--servd-line)', color: 'var(--servd-ink)' }}>
          <h1 className="font-black tracking-tight mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.9rem, 6vw, 2.3rem)', letterSpacing: '-0.03em' }}>Sign in</h1>
          <p className="text-sm mb-6 text-[color:var(--servd-mute)]">Welcome back.</p>

          <LoginForm />

          <p className="text-center text-sm mt-6 mb-3 text-[color:var(--servd-mute)]">Don&apos;t have an account?</p>
          <Link href={signupHref}
            className="flex items-center justify-center w-full rounded-xl py-3.5 font-black text-[0.95rem] transition-colors"
            style={{ background: 'var(--servd-purple)', color: 'var(--servd-on-purple)', textDecoration: 'none' }}>
            Create an account
          </Link>
        </div>

        <Link href="/" className="mt-6 block text-center text-xs font-semibold text-[color:var(--servd-mute)] hover:text-[color:var(--servd-ink)] transition-colors" style={{ textDecoration: 'none' }}>
          ← Back to home
        </Link>
      </div>
    </div>
  )
}
