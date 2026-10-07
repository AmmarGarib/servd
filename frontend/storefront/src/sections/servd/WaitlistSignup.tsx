// servd.waitlistSignup — the /waitlist page body: pitch + checklist beside the
// WhatsApp-verified waitlist form. The form is code; every word around it
// (and the form's own title, sub-title and button) is a field.

import { WaitlistForm } from '../../components/waitlist/WaitlistForm'
import type { SectionProps } from '../types'
import { list, str } from '../safe'

export function WaitlistSignup({ fields }: SectionProps) {
  const eyebrow = str(fields.eyebrow)
  const title = str(fields.title)
  const body = str(fields.body)
  const points = list<{ text?: unknown }>(fields.points).map((p) => str(p.text)).filter(Boolean)
  const formTitle = str(fields.formTitle).trim()
  const formSubtitle = str(fields.formSubtitle).trim()
  const formButton = str(fields.formButton).trim()

  return (
    <div style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}>
      <div
        className="container grid items-center gap-10 md:grid-cols-2"
        style={{ paddingTop: 'clamp(3rem, 8vw, 6rem)', paddingBottom: 'clamp(3rem, 8vw, 6rem)' }}
      >
        <div>
          {eyebrow && (
            <p style={{ color: 'var(--servd-green-dark)', fontWeight: 800, fontSize: '0.8rem', letterSpacing: '0.14em', textTransform: 'uppercase', margin: '0 0 1rem' }}>
              {eyebrow}
            </p>
          )}
          {title && (
            <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: 'clamp(2.6rem, 9vw, 4.75rem)', letterSpacing: '-0.04em', lineHeight: 0.95, margin: '0 0 1.25rem' }}>
              {title}
            </h1>
          )}
          {body && (
            <p style={{ color: 'var(--servd-mute)', fontSize: 'clamp(1rem, 2.4vw, 1.15rem)', lineHeight: 1.55, maxWidth: '32rem', margin: '0 0 1.75rem' }}>
              {body}
            </p>
          )}
          {points.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.7rem' }}>
              {points.map((p, i) => (
                <li key={i} style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-start', fontWeight: 600 }}>
                  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }}>
                    <circle cx="10" cy="10" r="10" fill="var(--servd-green)" />
                    <path d="M5.5 10.5l3 3 6-6.5" fill="none" stroke="var(--servd-on-green)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <WaitlistForm
          {...(formTitle && { title: formTitle })}
          {...(formSubtitle && { subtitle: formSubtitle })}
          {...(formButton && { buttonText: formButton })}
        />
      </div>
    </div>
  )
}
