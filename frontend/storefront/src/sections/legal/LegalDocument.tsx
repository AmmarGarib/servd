// legal.document — a policy page (privacy, terms): an optional "draft" note,
// the page's one H1, a last-updated line, an intro and numbered sections. Every
// word is a field, so the owner edits the wording in Admin → Storefront and
// the CEO approves it; the defaults are DRAFT wording (./policyText.ts).
//
// Section bodies are plain text: a blank line starts a paragraph and lines
// that begin "- " are a bullet list. Anything else is shown as typed (no HTML).

import type { ReactNode } from 'react'
import type { SectionProps } from '../types'
import { list, str } from '../safe'

type Block = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] }

/** Plain text → paragraphs and bullet lists. */
export function parseBody(text: string): Block[] {
  const out: Block[] = []
  let items: string[] | null = null
  let para: string[] = []
  const flushPara = () => { if (para.length) { out.push({ kind: 'p', text: para.join(' ') }); para = [] } }
  const flushList = () => { if (items) { out.push({ kind: 'ul', items }); items = null } }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { flushPara(); flushList(); continue }
    if (/^[-•]\s+/.test(line)) { flushPara(); (items ??= []).push(line.replace(/^[-•]\s+/, '')); continue }
    flushList()
    para.push(line)
  }
  flushPara(); flushList()
  return out
}

function Body({ text }: { text: string }): ReactNode {
  return parseBody(text).map((b, i) =>
    b.kind === 'p'
      ? <p key={i} style={{ margin: '0 0 0.9rem', lineHeight: 1.65 }}>{b.text}</p>
      : (
        <ul key={i} style={{ margin: '0 0 0.9rem', paddingLeft: '1.25rem', display: 'grid', gap: '0.45rem', lineHeight: 1.6 }}>
          {b.items.map((it, j) => <li key={j}>{it}</li>)}
        </ul>
      ))
}

export function LegalDocument({ fields }: SectionProps) {
  const draft = str(fields.draftNote).trim()
  const eyebrow = str(fields.eyebrow).trim()
  const title = str(fields.title).trim()
  const updated = str(fields.updated).trim()
  const intro = str(fields.intro).trim()
  const sections = list<{ heading?: unknown; body?: unknown }>(fields.sections)
    .map((s) => ({ heading: str(s.heading).trim(), body: str(s.body) }))
    .filter((s) => s.heading || s.body.trim())
  const numbered = fields.numbered !== false

  return (
    <article style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}>
      <div className="container" style={{ maxWidth: '48rem', paddingTop: 'clamp(3.5rem, 8vw, 6rem)', paddingBottom: 'clamp(3rem, 7vw, 5rem)' }}>
        {draft && (
          <p role="note" data-legal-draft style={{
            margin: '0 0 2rem', padding: '0.85rem 1.1rem', borderRadius: '0.75rem', fontSize: '0.92rem', lineHeight: 1.5, fontWeight: 600,
            border: '1px solid var(--servd-line)', background: 'var(--servd-surface, rgba(135,197,64,0.12))', color: 'var(--servd-ink)',
          }}>
            {draft}
          </p>
        )}
        {eyebrow && <p className="eyebrow eyebrow-accent">{eyebrow}</p>}
        {title && (
          <h1 className="display" style={{ fontSize: 'clamp(2.25rem, 6vw, 3.75rem)', margin: '0.5rem 0 0.75rem', letterSpacing: '-0.04em' }}>
            {title}
          </h1>
        )}
        {updated && <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', margin: '0 0 1.5rem' }}>{updated}</p>}
        {intro && <p style={{ fontSize: '1.1rem', lineHeight: 1.6, margin: '0 0 2.5rem' }}>{intro}</p>}
        {sections.map((s, i) => (
          <section key={i} style={{ marginBottom: '2rem' }}>
            {s.heading && (
              <h2 className="display" style={{ fontSize: 'clamp(1.25rem, 2.6vw, 1.6rem)', margin: '0 0 0.75rem', letterSpacing: '-0.02em' }}>
                {numbered ? `${i + 1}. ` : ''}{s.heading}
              </h2>
            )}
            <Body text={s.body} />
          </section>
        ))}
      </div>
    </article>
  )
}
