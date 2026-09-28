// Shows live storefront pop-ups inside the app. Mounted once in app/_layout.
//
// Rules (settings.popup on the web) are evaluated against the web path the
// current screen corresponds to (home '/', brand menu '/brand/<slug>', …, see
// links.webEquivalent). exit_intent has no mobile equivalent and never fires.
// Frequency is remembered in secure-store; 'every_visit' means once per app
// launch. One pop-up at a time.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, ScrollView, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native'
import { usePathname } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as SecureStore from 'expo-secure-store'
import { api } from '../lib/api'
import { ContentBlocks } from './BlockRenderer'
import { fetchLivePopups } from './api'
import { webEquivalent } from './links'
import { onScrollProgress } from './scroll'
import type { LivePopup, PopupRules } from './types'

const shownThisLaunch = new Set<string>()

const seenKey = (slug: string) => `servd_popup_${slug.replace(/[^A-Za-z0-9._-]/g, '_')}`
const today = () => new Date().toISOString().slice(0, 10)

async function frequencyAllows(p: LivePopup): Promise<boolean> {
  if (shownThisLaunch.has(p.slug)) return false
  if (p.rules.frequency === 'every_visit') return true
  let last: string | null = null
  try { last = await SecureStore.getItemAsync(seenKey(p.slug)) } catch { /* treat as unseen */ }
  if (!last) return true
  if (p.rules.frequency === 'once') return false
  return last.slice(0, 10) !== today() // daily
}

function markShown(p: LivePopup) {
  shownThisLaunch.add(p.slug)
  if (p.rules.frequency !== 'every_visit') {
    SecureStore.setItemAsync(seenKey(p.slug), new Date().toISOString()).catch(() => {})
  }
}

interface Audience { signedIn: boolean; neverOrdered: boolean }

async function resolveAudience(needOrders: boolean): Promise<Audience> {
  let token: string | null = null
  try { token = await SecureStore.getItemAsync('servd_token') } catch { /* signed out */ }
  if (!token) return { signedIn: false, neverOrdered: true }
  if (!needOrders) return { signedIn: true, neverOrdered: false }
  try {
    const me = await api.get<{ firstOrderAt: string | null; orders?: unknown[] }>('/storefront/account')
    return { signedIn: true, neverOrdered: !me.firstOrderAt && !(me.orders?.length) }
  } catch {
    return { signedIn: false, neverOrdered: true }
  }
}

function audienceAllows(r: PopupRules, a: Audience): boolean {
  switch (r.audience) {
    case 'signed_in':     return a.signedIn
    case 'signed_out':    return !a.signedIn
    case 'never_ordered': return a.neverOrdered
    default:              return true
  }
}

function pathMatches(pattern: string, path: string): boolean {
  const norm = (s: string) => (s.length > 1 ? s.replace(/\/+$/, '') : s)
  const p = norm(pattern.trim())
  if (p === '*' || p === '/*') return true
  if (p.endsWith('*')) return path.startsWith(p.slice(0, -1))
  return norm(path) === p
}

function statically(p: LivePopup, paths: string[], brand: string | null): boolean {
  const r = p.rules
  if (r.trigger === 'exit_intent') return false
  const now = Date.now()
  if (r.startsAt && Date.parse(r.startsAt) > now) return false
  if (r.endsAt && Date.parse(r.endsAt) <= now) return false
  if (r.pages?.length && !r.pages.some((pat) => paths.some((path) => pathMatches(pat, path)))) return false
  if (r.brands?.length && (!brand || !r.brands.includes(brand))) return false
  return true
}

export function PopupHost() {
  const pathname = usePathname()
  const { data: popups } = useQuery({
    queryKey: ['site-popups-live'],
    queryFn: fetchLivePopups,
    staleTime: 5 * 60_000,
  })
  const [active, setActive] = useState<LivePopup | null>(null)
  const activeRef = useRef<LivePopup | null>(null)
  activeRef.current = active

  const show = useCallback((p: LivePopup) => {
    if (activeRef.current) return
    markShown(p)
    setActive(p)
  }, [])

  useEffect(() => {
    if (!popups?.length || !pathname) return
    const { paths, brand } = webEquivalent(pathname)
    const candidates = popups.filter((p) => statically(p, paths, brand))
    if (candidates.length === 0) return

    let cancelled = false
    const cleanups: Array<() => void> = []
    ;(async () => {
      const needOrders = candidates.some((p) => p.rules.audience === 'never_ordered')
      const aud = await resolveAudience(needOrders)
      for (const p of candidates) {
        if (cancelled) return
        if (!audienceAllows(p.rules, aud) || !(await frequencyAllows(p))) continue
        if (cancelled) return
        const r = p.rules
        if (r.trigger === 'before_page') { show(p); return }
        if (r.trigger === 'after_seconds') {
          const t = setTimeout(() => show(p), Math.max(0, r.delaySeconds ?? 5) * 1000)
          cleanups.push(() => clearTimeout(t))
        } else if (r.trigger === 'scroll') {
          const target = Math.max(0, Math.min(100, r.scrollPct ?? 50))
          const off = onScrollProgress((pct) => { if (pct >= target) { off(); show(p) } })
          cleanups.push(off)
        }
      }
    })()
    return () => { cancelled = true; cleanups.forEach((fn) => fn()) }
  }, [popups, pathname, show])

  const close = useCallback(() => setActive(null), [])
  if (!active) return null
  return <PopupView popup={active} onClose={close} />
}

function PopupView({ popup, onClose }: { popup: LivePopup; onClose: () => void }) {
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const layout = { slug: popup.slug, version: popup.version, blocks: popup.blocks, fonts: popup.fonts }
  const body = <ContentBlocks layout={layout} onAfterAction={onClose} />
  const closeBtn = (
    <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12}
      style={{ position: 'absolute', top: 8, right: 10, zIndex: 2, paddingHorizontal: 8, paddingVertical: 4 }}>
      <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '700' }}>Close</Text>
    </TouchableOpacity>
  )
  const card = { backgroundColor: '#0d0f15', borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' as const }

  if (popup.rules.display === 'bar') {
    return (
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000, paddingTop: insets.top, backgroundColor: '#0d0f15', borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }}>
        <ScrollView style={{ maxHeight: height * 0.4 }} contentContainerStyle={{ paddingTop: 12 }}>{body}</ScrollView>
        {closeBtn}
      </View>
    )
  }

  const corner = popup.rules.display === 'corner'
  return (
    <Modal transparent animationType={corner ? 'slide' : 'fade'} visible onRequestClose={onClose}>
      <View style={{
        flex: 1,
        backgroundColor: corner ? 'transparent' : 'rgba(0,0,0,0.6)',
        justifyContent: corner ? 'flex-end' : 'center',
        alignItems: corner ? 'flex-end' : 'center',
        padding: 16, paddingBottom: corner ? insets.bottom + 16 : 16,
      }}>
        {!corner && <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />}
        <View style={[card, { width: corner ? Math.min(360, width - 32) : Math.min(480, width - 32), maxHeight: corner ? height * 0.5 : height * 0.8 }]}>
          <ScrollView contentContainerStyle={{ paddingTop: 24 }}>{body}</ScrollView>
          {closeBtn}
        </View>
      </View>
    </Modal>
  )
}
