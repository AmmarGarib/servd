'use client'
import Link from 'next/link'
import { SmokeyBackground } from '../../components/ui/SmokeyBackground'
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
    <div className="relative flex items-center justify-center px-5" style={{ minHeight: '100dvh', background: 'var(--servd-black)' }}>
      <SmokeyBackground color="#5c3458" backdropBlur="sm" />

      <div className="relative z-10 w-full max-w-sm">
        <Link href="/" aria-label="servd home" className="mb-6 block text-center"
          style={{ fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.045em', color: 'white', textDecoration: 'none' }}>
          servd<span style={{ color: 'var(--servd-green)' }}>.</span>
        </Link>

        <div className="w-full rounded-3xl px-7 py-8 bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl" style={{ animation: 'fadeSlideUp 0.4s both' }}>
          <h1 className="font-black tracking-tight text-white mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.9rem, 6vw, 2.3rem)', letterSpacing: '-0.03em' }}>Sign in</h1>
          <p className="text-sm mb-6 text-white/60">Welcome back.</p>

          <LoginForm />

          <p className="text-center text-sm mt-6 text-white/60">
            Don&apos;t have an account?{' '}
            <Link href={signupHref} className="font-black text-white hover:text-white/80 transition-colors">Create one →</Link>
          </p>
        </div>

        <Link href="/" className="mt-6 block text-center text-xs font-semibold text-white/50 hover:text-white/80 transition-colors" style={{ textDecoration: 'none' }}>
          ← Back to home
        </Link>
      </div>
    </div>
  )
}
