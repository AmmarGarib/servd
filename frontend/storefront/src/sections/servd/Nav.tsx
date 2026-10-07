'use client'

// servd.nav — the servd global nav (SiteLayout `servd:header`): Apple-style
// glass bar with the logo (or the text wordmark), section links (desktop), then
// search, account and the Order button. Where it shows (not on brand
// microsites, sign-in or ordering pages) is decided by StorefrontNav, which
// also mounts the search sheet.

import Link from 'next/link'
import { useCustomerAuth } from '../../store/customerAuth'
import { openSearch } from '../../components/SearchSheet'
import type { SectionProps } from '../types'
import { link, list, safeHref, safeSrc, str } from '../safe'

export function Nav({ fields }: SectionProps) {
  const token = useCustomerAuth((s) => s.token)
  const logo = safeSrc(fields.logo)
  const h = Number(fields.logoHeight)
  const logoHeight = Number.isFinite(h) && h > 0 ? Math.min(44, Math.max(16, Math.round(h))) : 28
  const alt = str(fields.logoAlt).trim() || 'servd'
  const wordmark = str(fields.wordmark)
  const links = list<{ text?: unknown; href?: unknown }>(fields.links)
  const orders = link(fields.ordersLink)
  const cta = link(fields.cta)

  return (
    <nav aria-label="Primary" className="sv-nav">
      <div className="sv-nav-inner">
        <Link href="/home" aria-label={`${alt} home`} className="sv-nav-mark">
          {logo
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logo} alt={alt} style={{ height: logoHeight, width: 'auto', display: 'block' }} />
            : <>{wordmark}<span>.</span></>}
        </Link>

        <div className="sv-nav-links">
          {links.map((l, i) => str(l.text) && (
            <Link key={i} href={safeHref(l.href)}>{str(l.text)}</Link>
          ))}
          {token && fields.showOrders === true && orders.text && <Link href={safeHref(orders.href)}>{orders.text}</Link>}
        </div>

        {fields.showSearch === true && (
          <button type="button" className="sv-icon-btn" aria-label="Search" onClick={() => openSearch('')}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
        )}
        {fields.showAccount === true && (
          <Link href={token ? '/account' : '/login'} className="sv-icon-btn" aria-label={token ? 'Your account' : 'Sign in'}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
            </svg>
          </Link>
        )}
        {cta.text && <Link href={safeHref(cta.href)} className="sv-nav-cta">{cta.text}</Link>}
      </div>
    </nav>
  )
}
