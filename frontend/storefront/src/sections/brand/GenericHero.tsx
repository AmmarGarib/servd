'use client'
// brand.genericHero — the hero of a brand without a bespoke design
// (`brand:*`, e.g. stax-padel): brand colour over its image, name, live
// open/closed badge, tagline, description, buttons, highlights, hours grid.

import Link from 'next/link'
import { brandStory, conceptHeroImage } from '../../lib/concept'
import { OpenStatusBadge, HoursGrid, useHoursData } from '../../components/brand/parts/OpenStatusBadge'
import type { SectionProps } from '../types'
import { color, link, list, safeSrc, str } from '../safe'
import { brandHref, brandNameOf, fill, orLive } from './util'

export function GenericHero({ fields, ctx }: SectionProps) {
  const concept = ctx.concept
  const hoursData = useHoursData(concept?.slug ?? '')
  if (!concept) return null
  const name = brandNameOf(ctx, fields.name)
  const t = (v: unknown) => fill(v, ctx, name)
  const accent = color(fields.accent) ?? (concept.primaryColor || 'var(--servd-green-dark)')
  const story = brandStory(concept.slug)
  const heroImage = safeSrc(fields.image) || conceptHeroImage(concept)
  const primary = link(fields.primary)
  const secondary = link(fields.secondary)
  const p = brandHref(primary.href, ctx)
  const s = brandHref(secondary.href, ctx)
  const own = list<{ text?: unknown }>(fields.highlights).map((h) => t(h.text)).filter(Boolean)
  const highlights = own.length ? own : story.highlights
  const statusGreen = color(fields.statusColor) ?? 'var(--servd-green)'
  const labels = {
    open: str(fields.openLabel), closes: str(fields.closesLabel),
    closed: str(fields.closedLabel), opens: str(fields.opensLabel),
  }

  return (
    <section style={{
      position: 'relative',
      minHeight: 'min(78dvh, 680px)',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      padding: 'clamp(2rem, 6vw, 4rem) 0',
      background: `linear-gradient(135deg, ${accent} 0%, ${accent}dd 60%, ${accent}aa 100%)${heroImage ? `, url(${heroImage}) center/cover` : ''}`,
      backgroundBlendMode: 'multiply',
      color: 'white',
      overflow: 'hidden',
      borderBottom: '1px solid var(--servd-line)',
    }}>
      <div className="container" style={{ position: 'relative', zIndex: 1 }}>
        {str(fields.eyebrow) && (
          <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.32em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.78)', marginBottom: '0.85rem' }}>
            {t(fields.eyebrow)}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <h1 style={{
            fontSize: 'clamp(3rem, 9vw, 7rem)',
            fontWeight: 900,
            letterSpacing: '-0.05em',
            lineHeight: 0.92,
            margin: 0,
            maxWidth: '62rem',
          }}>
            {name}.
          </h1>
          {fields.showStatus !== false && (
            <OpenStatusBadge hoursData={hoursData} accentColor={statusGreen} size="md" labels={labels} />
          )}
        </div>
        <p style={{ fontSize: 'clamp(1.15rem, 2vw, 1.6rem)', color: 'rgba(255,255,255,0.92)', maxWidth: '46rem', lineHeight: 1.4, fontWeight: 500 }}>
          {orLive(fields.tagline, story.tagline, ctx, name)}
        </p>
        <p style={{ marginTop: '0.6rem', fontSize: 'clamp(1rem, 1.5vw, 1.2rem)', color: 'rgba(255,255,255,0.78)', maxWidth: '46rem', lineHeight: 1.5 }}>
          {orLive(fields.description, concept.description ?? story.oneLiner, ctx, name)}
        </p>
        <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap', marginTop: '2.25rem' }}>
          {p && primary.text && (
            <Link href={p.href} style={{
              padding: 'clamp(1rem, 1.8vw, 1.2rem) clamp(2rem, 4vw, 2.6rem)',
              background: 'white', color: 'var(--servd-black)',
              fontWeight: 900, fontSize: 'clamp(1rem, 1.6vw, 1.15rem)',
              textDecoration: 'none', borderRadius: '999px',
              boxShadow: '0 16px 38px rgba(0,0,0,0.25)',
            }}>
              {t(primary.text)}
            </Link>
          )}
          {s && secondary.text && (
            <Link href={s.href} style={{
              padding: 'clamp(1rem, 1.8vw, 1.2rem) clamp(1.75rem, 3.2vw, 2.2rem)',
              background: 'rgba(255,255,255,0.14)',
              color: 'white', border: '1px solid rgba(255,255,255,0.4)',
              fontWeight: 700, fontSize: 'clamp(1rem, 1.6vw, 1.15rem)',
              textDecoration: 'none', borderRadius: '999px',
            }}>
              {t(secondary.text)}
            </Link>
          )}
        </div>
        {highlights.length > 0 && (
          <div style={{ marginTop: '3rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {highlights.map((h, i) => (
              <span key={`${h}-${i}`} style={{
                fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.06em',
                color: 'rgba(255,255,255,0.85)', padding: '0.4rem 0.8rem',
                borderRadius: '999px', background: 'rgba(0,0,0,0.18)',
                border: '1px solid rgba(255,255,255,0.2)',
              }}>{h}</span>
            ))}
          </div>
        )}
        {hoursData && hoursData.hours.length > 0 && (
          <div style={{ marginTop: '2rem' }}>
            {str(fields.hoursLabel) && (
              <p style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.55)', marginBottom: '0.6rem' }}>
                {t(fields.hoursLabel)}
              </p>
            )}
            <HoursGrid hoursData={hoursData} accentColor={statusGreen} closedLabel={labels.closed} />
          </div>
        )}
      </div>
    </section>
  )
}
