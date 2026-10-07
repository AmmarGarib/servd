// Maps storefront hrefs (authored for the web) onto the app's expo-router
// screens. Anything the app has no screen for opens on the web storefront.

import { Linking } from 'react-native'
import Constants from 'expo-constants'
import { router, type Href } from 'expo-router'

export const STOREFRONT_URL =
  ((Constants.expoConfig?.extra?.storefrontUrl as string | undefined) ?? 'https://servd.pk').replace(/\/+$/, '')

// Top-level web routes that are NOT a brand slug.
const WEB_ROOTS = new Set([
  'account', 'auth', 'brand', 'brands', 'browse', 'group-order', 'home', 'locations', 'login',
  'order', 'orders', 'pages', 'press', 'preview', 'reserve', 'signup', 'waitlist',
])

export type Target = { kind: 'route'; path: string } | { kind: 'url'; url: string }

export function mapHref(rawHref: string | undefined): Target | null {
  const href = (rawHref ?? '').trim()
  if (!href || href === '#') return null

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    // Absolute URL. Our own storefront's links are mapped like relative ones.
    if (href.startsWith(STOREFRONT_URL)) return mapHref(href.slice(STOREFRONT_URL.length) || '/')
    return { kind: 'url', url: href }
  }
  if (!href.startsWith('/')) return { kind: 'url', url: `${STOREFRONT_URL}/${href}` }

  const [pathPart] = href.split(/[?#]/)
  const segs = (pathPart ?? '/').split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  const web: Target = { kind: 'url', url: `${STOREFRONT_URL}${href}` }
  const [a, b, c] = segs

  if (!a) return { kind: 'route', path: '/' }
  switch (a) {
    case 'home':
    case 'browse':
    case 'brands':  return segs.length === 1 ? { kind: 'route', path: '/' } : web
    case 'login':
    case 'signup':  return { kind: 'route', path: '/login' }
    case 'account': return segs.length === 1 ? { kind: 'route', path: '/account' } : web
    case 'orders':  return segs.length === 1 ? { kind: 'route', path: '/orders' } : web
    case 'order':   return b && segs.length === 2 ? { kind: 'route', path: `/order/${encodeURIComponent(b)}` } : web
    case 'reserve': return b && segs.length === 2 ? { kind: 'route', path: `/reserve/${encodeURIComponent(b)}` } : web
    case 'pages':   return b && segs.length === 2 ? { kind: 'route', path: `/pages/${encodeURIComponent(b)}` } : web
    case 'brand':
      // /brand/<slug> and /brand/<slug>/menu → the app's brand screen is its menu.
      if (b && (segs.length === 2 || (segs.length === 3 && c === 'menu'))) return { kind: 'route', path: `/${encodeURIComponent(b)}/menu` }
      return web
  }
  if (WEB_ROOTS.has(a)) return web

  // /<concept>, /<concept>/menu, /<concept>/cart, /<concept>/checkout, /<concept>/order/<id>
  const concept = encodeURIComponent(a)
  if (segs.length === 1) return { kind: 'route', path: `/${concept}/menu` }
  if (segs.length === 2 && (b === 'menu' || b === 'cart' || b === 'checkout')) return { kind: 'route', path: `/${concept}/${b}` }
  if (segs.length === 3 && b === 'order' && c) return { kind: 'route', path: `/order/${encodeURIComponent(c)}` }
  return web
}

/** Navigates to a storefront href. Returns false when there was nothing to open. */
export function openHref(href: string | undefined): boolean {
  const t = mapHref(href)
  if (!t) return false
  if (t.kind === 'url') {
    Linking.openURL(t.url).catch(() => { /* no handler */ })
    return true
  }
  router.push(t.path as Href)
  return true
}

/**
 * The web paths an app route corresponds to, for matching pop-up `pages`
 * patterns, plus the brand in view (for pop-up `brands`).
 */
export function webEquivalent(appPath: string): { paths: string[]; brand: string | null } {
  const segs = appPath.split('/').filter(Boolean)
  const [a, b] = segs
  if (!a) return { paths: ['/'], brand: null }
  if (segs.length === 2 && (b === 'menu' || b === 'cart' || b === 'checkout') && !WEB_ROOTS.has(a)) {
    const paths = b === 'menu' ? [`/brand/${a}`, `/brand/${a}/menu`, `/${a}/menu`, `/${a}`] : [`/${a}/${b}`]
    return { paths, brand: a }
  }
  if (a === 'reserve' && b) return { paths: [`/reserve/${b}`], brand: b }
  return { paths: [appPath], brand: null }
}
