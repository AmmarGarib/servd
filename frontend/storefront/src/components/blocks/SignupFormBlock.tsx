'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { SignupFormBlock as SignupFormBlockT } from '../../lib/blocks'
import { useCustomerAuth } from '../../store/customerAuth'
import { LoginForm } from '../auth/LoginForm'
import { SignupForm } from '../auth/SignupForm'

// `signup_form` block: the storefront's own sign-in / one-code sign-up, the
// same components /login and /signup render — never a second auth flow. On a
// page or in a pop-up the customer stays where they are after signing in.

export function SignupFormBlock({ block, onDone }: { block: SignupFormBlockT; onDone?: () => void }) {
  const token = useCustomerAuth((s) => s.token)
  const [justDone, setJustDone] = useState(false)
  // The auth store is localStorage-backed: read it only after mount so the
  // server HTML and the first client render agree.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const idPrefix = `sf-${block.id}`

  const done = () => { setJustDone(true); onDone?.() }

  return (
    <div className="container" style={{ display: 'flex', justifyContent: 'center' }}>
      <div
        className="w-full rounded-3xl px-7 py-8 shadow-2xl"
        style={{ maxWidth: '26rem', background: '#2D1E2F', color: 'white', textAlign: 'left' }}
      >
        {(mounted && token) || justDone ? (
          <div>
            <h2 className="font-black tracking-tight text-white mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.5rem, 5vw, 1.9rem)', letterSpacing: '-0.03em' }}>
              You&rsquo;re signed in.
            </h2>
            <p className="text-sm text-white/60">
              <Link href="/account" className="font-black text-white hover:text-white/80">Go to your account →</Link>
            </p>
          </div>
        ) : block.mode === 'login' ? (
          <>
            <h2 className="font-black tracking-tight text-white mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.5rem, 5vw, 1.9rem)', letterSpacing: '-0.03em' }}>
              {block.title?.trim() || 'Sign in'}
            </h2>
            <p className="text-sm mb-6 text-white/60">{block.subtitle?.trim() || 'Welcome back.'}</p>
            <LoginForm onSuccess={done} autoFocus={false} idPrefix={idPrefix} />
            <p className="text-center text-sm mt-6 text-white/60">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="font-black text-white hover:text-white/80 transition-colors">Create one →</Link>
            </p>
          </>
        ) : (
          <SignupForm
            headingAs="h2"
            onSuccess={done}
            autoFocus={false}
            idPrefix={idPrefix}
            {...(block.title?.trim() ? { title: block.title.trim() } : {})}
            {...(block.subtitle?.trim() ? { subtitle: block.subtitle.trim() } : {})}
          />
        )}
      </div>
    </div>
  )
}
