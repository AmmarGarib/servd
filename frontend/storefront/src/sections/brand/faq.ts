// brand.faq — the questions a brand page shows, resolved against the live
// brand. Shared by the section (what a visitor reads) and the Visit route's
// FAQPage structured data (what search engines are told), so the two can
// never disagree. Plain functions: server- and client-safe.

import { SERVD_ORIGIN, brandCanonical } from '../../lib/brandDomains'
import type { SectionContext } from '../types'
import { link, list } from '../safe'
import { brandHref, brandNameOf, fill } from './util'

export interface FaqEntry {
  question: string
  answer: string
  /** The link after the answer, resolved for the host (null = none). */
  link: { text: string; href: string; external: boolean } | null
}

/** Whether a question's `show` rule lets it appear for this brand. */
function shown(rule: unknown, ctx: SectionContext): boolean {
  const takesBookings = ctx.concept?.reservationsEnabled !== false
  if (rule === 'reservations') return takesBookings
  if (rule === 'no-reservations') return !takesBookings
  return true
}

/**
 * The questions on a brand.faq section, in order: placeholders filled, the
 * `show` rules applied, empty questions or answers dropped, and each link
 * resolved for the host the page is served on (absolute servd links on a
 * brand domain).
 */
export function faqEntries(fields: Record<string, unknown>, ctx: SectionContext): FaqEntry[] {
  const name = brandNameOf(ctx)
  return list<{ question?: unknown; answer?: unknown; link?: unknown; show?: unknown }>(fields.items).flatMap((it) => {
    if (!shown(it.show, ctx)) return []
    const question = fill(it.question, ctx, name).trim()
    const answer = fill(it.answer, ctx, name).trim()
    if (!question || !answer) return []
    const l = link(it.link)
    const text = fill(l.text, ctx, name).trim()
    const to = text ? brandHref(l.href, ctx) : null
    return [{ question, answer, link: to ? { text, href: to.href, external: to.external } : null }]
  })
}

/** An href as an absolute URL: the brand's pages on its canonical domain,
 *  servd's pages on servd's origin. */
function absolute(href: string, slug: string | undefined): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href
  const m = /^\/brand\/([a-z0-9-]+)(?:\/([^?#]*))?(.*)$/i.exec(href)
  if (m?.[1] && m[1] === slug) return brandCanonical(m[1], m[2] ?? '') + (m[3] ?? '')
  return `${SERVD_ORIGIN}${href}`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The same questions for FAQPage JSON-LD: each answer's text as the page
 * shows it, with its link as an <a> to an absolute URL (Google accepts links
 * in an Answer's text; a relative path would mean nothing off the page).
 * An answer carrying a link is HTML, so the owner's own text in it is escaped
 * too ("R&B night", "<3" read as the page shows them); one without stays
 * plain text.
 */
export function faqSchemaEntries(fields: Record<string, unknown>, ctx: SectionContext): Array<{ question: string; answer: string }> {
  // Resolved as on servd (relative paths), then made absolute.
  const servdCtx: SectionContext = { ...ctx, onBrandHost: false }
  return faqEntries(fields, servdCtx).map((e) => ({
    question: e.question,
    answer: e.link
      ? `${esc(e.answer)} <a href="${esc(absolute(e.link.href, ctx.concept?.slug))}">${esc(e.link.text)}</a>`
      : e.answer,
  }))
}
