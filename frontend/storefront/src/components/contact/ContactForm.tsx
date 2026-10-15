'use client'
// legal.contactForm — the contact form on /contact. It posts a `contact`
// entry to the feedback API (POST /api/v1/feedback): name, a phone or email to
// reply to, a topic, an optional kitchen, and the message. The company that
// receives it is decided by the server from the kitchen chosen — never sent
// from here. Nothing is messaged back on submit; staff read it in Admin →
// Reviews → Messages. A hidden "website" field catches bots.
//
// Every word on it is a field.

import { useId, useState, type CSSProperties, type FormEvent } from 'react'
import { track } from '../../lib/analytics'
import { formatBrandName } from '../../lib/concept'
import { inBrandOrder } from '../../lib/liveConcepts'
import type { SectionProps } from '../../sections/types'
import { str } from '../../sections/safe'

/** Inner padding of the form and the success notice (servd-card has none). */
const CARD_PAD = 'clamp(1.1rem, 3vw, 1.5rem)'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const TOPICS = ['catering', 'complaint', 'press', 'jobs', 'other'] as const
type Topic = (typeof TOPICS)[number]

const lab: CSSProperties = { display: 'block', fontWeight: 700, fontSize: '0.9rem', margin: '0 0 0.35rem' }
const group: CSSProperties = { marginBottom: '1.1rem' }

export function ContactForm({ fields, ctx }: SectionProps) {
  const uid = useId()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [topic, setTopic] = useState<Topic | ''>('')
  const [brand, setBrand] = useState('')
  const [message, setMessage] = useState('')
  const [trap, setTrap] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const kitchens = inBrandOrder(ctx.concepts.filter((c) => !c.isTestCompany))
  const topicLabel = (t: Topic) => str(fields[`topic_${t}`]) || t

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setError('')
    if (!name.trim()) return setError(str(fields.errName) || 'Please tell us your name.')
    if (!phone.trim() && !email.trim()) return setError(str(fields.errReply) || 'Give a phone number or an email so we can reply.')
    if (!topic) return setError(str(fields.errTopic) || 'Please pick a topic.')
    if (message.trim().length < 10) return setError(str(fields.errMessage) || 'Please write at least a sentence.')
    setBusy(true)
    try {
      const token = (() => {
        try { return JSON.parse(localStorage.getItem('servd-customer-auth') ?? '{}')?.state?.token as string | undefined } catch { return undefined }
      })()
      const res = await fetch(`${API_URL}/api/v1/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify({
          kind: 'contact',
          name: name.trim(),
          replyPhone: phone.trim() || null,
          replyEmail: email.trim() || null,
          topic,
          conceptId: brand || null,
          comment: message.trim(),
          website: trap,
        }),
      })
      if (res.ok) {
        setDone(true)
        track('contact_submit', { topic })
      } else {
        const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
        setError(res.status === 429
          ? (str(fields.errLimit) || 'Too many messages from you just now. Please try again in an hour.')
          : (body?.error?.message ?? (str(fields.errGeneric) || 'Something went wrong. Please try again, or use the phone or WhatsApp above.')))
      }
    } catch {
      setError(str(fields.errGeneric) || 'Something went wrong. Please try again, or use the phone or WhatsApp above.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}>
      <div className="container" style={{ maxWidth: '40rem', paddingTop: 'clamp(1.5rem, 3vw, 2.5rem)', paddingBottom: 'clamp(3rem, 7vw, 5rem)' }}>
        {str(fields.heading) && (
          <h2 className="display" style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', margin: '0 0 0.5rem' }}>{str(fields.heading)}</h2>
        )}
        {str(fields.intro) && <p style={{ margin: '0 0 1.5rem', color: 'var(--servd-mute)', lineHeight: 1.55 }}>{str(fields.intro)}</p>}

        {done ? (
          <div className="servd-card" role="status" style={{ padding: CARD_PAD }}>
            <p style={{ margin: 0, fontWeight: 800, fontSize: '1.15rem' }}>{str(fields.doneTitle) || 'Message received.'}</p>
            <p style={{ margin: '0.5rem 0 0', lineHeight: 1.55 }}>{str(fields.doneBody)}</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="servd-card" style={{ padding: CARD_PAD, position: 'relative' }}>
            {/* Honeypot: off-screen, not in the tab order, ignored by screen readers. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor={`${uid}-website`}>Website</label>
              <input id={`${uid}-website`} type="text" name="website" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
            </div>

            <div style={group}>
              <label style={lab} htmlFor={`${uid}-name`}>{str(fields.nameLabel) || 'Your name'}</label>
              <input id={`${uid}-name`} className="servd-input" name="name" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '1rem' }}>
              <div style={group}>
                <label style={lab} htmlFor={`${uid}-phone`}>{str(fields.phoneLabel) || 'Phone (to reply)'}</label>
                <input id={`${uid}-phone`} className="servd-input" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0300 1234567" />
              </div>
              <div style={group}>
                <label style={lab} htmlFor={`${uid}-email`}>{str(fields.emailLabel) || 'Email (to reply)'}</label>
                <input id={`${uid}-email`} className="servd-input" name="email" type="email" autoComplete="email" maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>
            {str(fields.replyHint) && <p style={{ margin: '-0.5rem 0 1.1rem', fontSize: '0.85rem', color: 'var(--servd-mute)' }}>{str(fields.replyHint)}</p>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '1rem' }}>
              <div style={group}>
                <label style={lab} htmlFor={`${uid}-topic`}>{str(fields.topicLabel) || 'Topic'}</label>
                <select id={`${uid}-topic`} className="servd-input" name="topic" value={topic} onChange={(e) => setTopic(e.target.value as Topic | '')} required>
                  <option value="">{str(fields.topicPlaceholder) || 'Pick one'}</option>
                  {TOPICS.map((t) => <option key={t} value={t}>{topicLabel(t)}</option>)}
                </select>
              </div>
              {kitchens.length > 0 && (
                <div style={group}>
                  <label style={lab} htmlFor={`${uid}-brand`}>{str(fields.brandLabel) || 'Which kitchen? (optional)'}</label>
                  <select id={`${uid}-brand`} className="servd-input" name="brand" value={brand} onChange={(e) => setBrand(e.target.value)}>
                    <option value="">{str(fields.brandAny) || 'Not about one kitchen'}</option>
                    {kitchens.map((c) => <option key={c.id} value={c.id}>{formatBrandName(c.name)}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div style={group}>
              <label style={lab} htmlFor={`${uid}-message`}>{str(fields.messageLabel) || 'Your message'}</label>
              <textarea id={`${uid}-message`} className="servd-input" name="message" rows={6} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} style={{ resize: 'vertical' }} required />
            </div>

            {error && <p role="alert" style={{ margin: '0 0 1rem', fontWeight: 700, color: 'var(--servd-danger)' }}>{error}</p>}
            <button type="submit" className="servd-btn-primary" disabled={busy}>
              {busy ? (str(fields.sendingText) || 'Sending…') : (str(fields.sendText) || 'Send message')}
            </button>
            {str(fields.privacyNote) && <p style={{ margin: '1rem 0 0', fontSize: '0.82rem', color: 'var(--servd-mute)', lineHeight: 1.5 }}>{str(fields.privacyNote)}</p>}
          </form>
        )}
      </div>
    </section>
  )
}
