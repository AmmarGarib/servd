// simmer.menu — /brand/simmer/menu in Simmer's printed-card typography.
// Bone on tiber green, Amarante for dish names and course numerals, Times for
// notes and prices, the service date as the single orange signal.
//
//   • No published items → the placeholder card (ported from SimmerMenu),
//     every course and dish a field, marked "draft — pending kitchen".
//   • Items published   → the live menu (fetchBrandMenu): one course per
//     category with a roman numeral, dish + description + price, and an
//     order button in place of the "flag your server" note.
//
// Outline: the page's h1 says what the page is ("Simmer menu in Karachi" —
// the words search engines and AI answers read), the wordmark line under it is
// a styled paragraph (it is the tagline "simmer down." and stays below the
// wordmark), each course an h2, each dish an h3, the closing headline an h2 — in the same type as before (the h-tag
// defaults in globals.css are reset inline; see HEADING_RESET).

import Link from 'next/link'
import { Fragment } from 'react'
import type { SectionProps } from '../types'
import { fetchBrandMenu, hasMenuItems, type MenuCategory } from '../data'
import { filled, locationFromConcept } from '../../lib/brandLocations'
import { formatBrandName } from '../../lib/concept'
import { link, list, str } from '../safe'
import { HEADING_RESET, simmerConcept, simmerHref, simmerLines, simmerText, stampOr } from './shared'

interface Dish { name: string; body: string; price: string; soldOut?: boolean }
interface Course { rubric: string; title: string; items: Dish[] }

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX']

/** Simmer prices read `Rs 1,400` — the printed menu's own format. */
const rs = (pkr: number) => `Rs ${Math.round(pkr).toLocaleString('en-PK')}`

function placeholderCourses(v: unknown): Course[] {
  return list<{ rubric?: unknown; title?: unknown; items?: unknown }>(v).map((c) => ({
    rubric: simmerText(c.rubric),
    title: simmerText(c.title),
    items: list<{ name?: unknown; body?: unknown; price?: unknown }>(c.items).map((it) => {
      const n = typeof it.price === 'number' ? it.price : Number(str(it.price).replace(/[^\d.]/g, ''))
      return { name: simmerText(it.name), body: simmerText(it.body), price: Number.isFinite(n) && n > 0 ? rs(n) : '' }
    }),
  }))
}

function liveCourses(categories: MenuCategory[]): Course[] {
  return categories
    .filter((c) => (c.items?.length ?? 0) > 0)
    .map((c, i) => ({
      rubric: `${ROMAN[i] ?? String(i + 1)}.`,
      title: c.name,
      items: c.items.map((it) => ({
        name: it.name,
        body: it.description ?? '',
        price: rs(it.priceCents / 100),
        soldOut: it.isAvailable === false,
      })),
    }))
}

export async function Menu({ fields: f, ctx }: SectionProps) {
  const concept = simmerConcept(ctx)
  const slug = concept.slug
  const categories = await fetchBrandMenu(slug)
  const live = hasMenuItems(categories)
  const courses = live ? liveCourses(categories) : placeholderCourses(f['courses'])

  // The h1: what this page is, in plain words. Name and city are the brand
  // record's (formatBrandName, Concept.addressLocality), never typed here.
  const menuHeading = `${formatBrandName(concept.name)} menu in ${filled(locationFromConcept(concept).city) || 'Karachi'}`
  const kicker = simmerText(f['kicker'])
  const wordmark = simmerText(f['wordmark'])
  const mark = simmerText(f['mark'])
  const draftNote = simmerText(f['draftNote'])
  const closingNote = simmerText(f['closingNote'])
  const closingHeadline = simmerText(f['closingHeadline'])
  const closingBody = simmerLines(live ? f['liveClosingBody'] : f['closingBody'])
  const order = link(f['order'])
  const reserve = link(f['reserve'])
  const home = link(f['home'])
  const homeText = simmerText(home.text).trim() || `${formatBrandName(concept.name)} home`
  const soldOut = simmerText(f['soldOutLabel'])
  // Host-aware targets: Simmer's home is / on simmer.pk and /brand/simmer on
  // servd; ordering and booking are servd pages (absolute from simmer.pk).
  // null = hide the button (e.g. @book when the brand takes no reservations).
  const orderTo = live && order.text ? simmerHref(order.href, ctx, '@order') : null
  const reserveTo = reserve.text ? simmerHref(reserve.href, ctx, '@book') : null
  const homeTo = simmerHref(home.href, ctx, '@home')

  return (
    <div className="simmer-page" style={{ minHeight: '100dvh' }}>

      {/* ── MASTHEAD — printed-menu header ─────────────────────────── */}
      <section style={{
        padding: 'clamp(2.5rem, 6vh, 4rem) clamp(1.5rem, 5vw, 3rem) clamp(1.5rem, 4vh, 2.5rem)',
      }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            paddingBottom: '0.9rem',
            borderBottom: '1px solid rgb(var(--simmer-bone-rgb) / 0.22)',
          }}>
            <span className="utility" style={{ fontSize: '0.72rem' }}>{simmerText(f['eyebrow'])}</span>
            <span className="utility signal" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>{stampOr(f['stamp'])}</span>
          </div>

          <div style={{ textAlign: 'center', padding: '2.4rem 0 0.6rem' }}>
            <h1 className="utility" style={{
              ...HEADING_RESET, fontSize: '0.78rem', opacity: 0.85, margin: '0 0 1rem',
            }}>
              {menuHeading}
            </h1>
            {kicker && (
              <p className="utility" style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '1rem' }}>
                {kicker}
              </p>
            )}
            {(wordmark || mark) && (
              <p className="wordmark amarante" style={{
                ...HEADING_RESET,
                fontSize: 'clamp(2.6rem, 8vw, 4.2rem)', lineHeight: 1, margin: 0,
              }}>
                {wordmark}{mark && <span className="signal">{mark}</span>}
              </p>
            )}
            {!live && draftNote && (
              <p className="utility" style={{
                fontSize: '0.66rem', opacity: 0.55, marginTop: '1.4rem',
                letterSpacing: '0.4em',
              }}>
                {draftNote}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── COURSES ────────────────────────────────────────────────── */}
      <section style={{
        padding: '0 clamp(1.5rem, 5vw, 3rem) clamp(3rem, 8vh, 5rem)',
      }}>
        <div style={{ maxWidth: '38rem', margin: '0 auto' }}>
          {courses.map((course, ci) => (
            <div key={ci} style={{
              padding: '2.2rem 0',
              borderTop: ci === 0 ? '1px solid rgb(var(--simmer-bone-rgb) / 0.22)' : '0',
              borderBottom: '1px solid rgb(var(--simmer-bone-rgb) / 0.18)',
            }}>
              {/* Course header — Amarante numeral + lowercase rubric */}
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: '0.9rem',
                marginBottom: '1.4rem',
              }}>
                {course.rubric && (
                  <span className="amarante signal" style={{
                    fontSize: '1.5rem', lineHeight: 1,
                  }}>{course.rubric}</span>
                )}
                {course.title && (
                  <h2 className="utility" style={{
                    ...HEADING_RESET,
                    fontSize: '0.72rem', opacity: 0.72,
                  }}>{course.title}</h2>
                )}
              </div>

              {/* Items — name + body line, price right-aligned */}
              <div style={{ display: 'grid', gap: '1.2rem' }}>
                {course.items.map((item, ii) => (
                  <div key={ii} style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: '1rem',
                    alignItems: 'baseline',
                    ...(item.soldOut && { opacity: 0.5 }),
                  }}>
                    <div>
                      {item.name && (
                        <h3 className="amarante" style={{
                          ...HEADING_RESET,
                          fontSize: '1.2rem', lineHeight: 1.2, margin: '0 0 0.25rem',
                        }}>
                          {item.name}
                        </h3>
                      )}
                      {item.body && (
                        <p style={{
                          fontFamily: 'var(--simmer-body)',
                          fontSize: '0.86rem',
                          lineHeight: 1.45,
                          letterSpacing: '0.02em',
                          opacity: 0.78,
                          margin: 0,
                        }}>
                          {item.body}
                        </p>
                      )}
                      {item.soldOut && soldOut && (
                        <p className="utility" style={{ fontSize: '0.66rem', margin: '0.35rem 0 0' }}>{soldOut}</p>
                      )}
                    </div>
                    <p className="amarante" style={{
                      fontSize: '1rem',
                      letterSpacing: '0.04em',
                      opacity: 0.88,
                      whiteSpace: 'nowrap',
                      margin: 0,
                    }}>
                      {item.price}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── FOOTER NOTES + CTA ─────────────────────────────────────── */}
      <section style={{
        padding: 'clamp(3rem, 7vh, 5rem) clamp(1.5rem, 5vw, 3rem) clamp(4rem, 10vh, 6rem)',
        textAlign: 'center',
      }}>
        <div style={{ maxWidth: '32rem', margin: '0 auto' }}>
          {closingNote && (
            <p className="utility" style={{ fontSize: '0.66rem', opacity: 0.55, letterSpacing: '0.4em' }}>
              {closingNote}
            </p>
          )}
          {closingHeadline && (
            <h2 className="amarante" style={{
              ...HEADING_RESET,
              fontSize: 'clamp(1.4rem, 4vw, 2rem)', lineHeight: 1.25, margin: '1.4rem 0 0',
            }}>
              {closingHeadline}
            </h2>
          )}
          {closingBody.some((l) => l.trim()) && (
            <p style={{
              fontFamily: 'var(--simmer-body)',
              fontSize: '0.95rem', letterSpacing: '0.02em',
              opacity: 0.78, marginTop: '0.8rem',
            }}>
              {closingBody.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{l}</Fragment>)}
            </p>
          )}
          <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            {/* One orange button per viewport: with a live menu "order" takes
                the signal and reserve steps down to the bone outline. */}
            {orderTo && (
              <Link href={orderTo.href} className="action action--signal">{simmerText(order.text)}</Link>
            )}
            {reserveTo && (
              <Link href={reserveTo.href} className={orderTo ? 'action' : 'action action--signal'}>
                {simmerText(reserve.text)}
              </Link>
            )}
            {homeTo && (
              <Link href={homeTo.href} className="action">{homeText}</Link>
            )}
          </div>
        </div>
      </section>

    </div>
  )
}
