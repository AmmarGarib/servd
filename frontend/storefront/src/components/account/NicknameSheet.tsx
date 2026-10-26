'use client'

// The first-visit "pick your servd name" sheet (owner, 2026-10-26: "when they
// hop into servd first time after logging in, ask them to pick a
// nickname/username"). Shown to a signed-in customer whose account has no
// nickname, on servd's own pages (home, account, group orders, orders, the
// reserve picker, invite links …). "Later" hides it for this visit only (per
// tab, sessionStorage) — it asks again next visit until a name is picked.
// Never on brand microsites / brand domains / brand pages (their own
// palettes), sign-in pages, the rider app or the editor frame.

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useCustomerAuth } from '../../store/customerAuth'
import { isRiderPath } from '../StorefrontNav'
import { isEditorFramePath } from '../../lib/editorFrame'
import { NicknameField, saveNickname, useNicknameCheck } from './NicknameField'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const LATER_KEY = 'servd:nickname-later'

const later = (): boolean => { try { return sessionStorage.getItem(LATER_KEY) === '1' } catch { return false } }
const setLater = () => { try { sessionStorage.setItem(LATER_KEY, '1') } catch { /* storage blocked */ } }

// servd's own pages only — never a brand's page or brand ordering skin
// (/simmer, /reserve/simmer …), whose palettes the servd sheet must not touch.
const SERVD_PAGES = ['/account', '/group-order', '/orders', '/pages', '/locations', '/waitlist', '/press']
function hiddenOn(pathname: string): boolean {
  if (isRiderPath(pathname) || isEditorFramePath(pathname)) return true
  if (pathname === '/' || pathname === '/home' || pathname === '/reserve') return false
  return !SERVD_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function NicknameSheet({ initialBrandSlug }: { initialBrandSlug?: string | null }) {
  const pathname = usePathname() ?? '/'
  const token = useCustomerAuth((s) => s.token)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const asked = useRef<string | null>(null)
  const check = useNicknameCheck(open ? token : null, value, null)

  useEffect(() => {
    if (!token || initialBrandSlug || hiddenOn(pathname) || later()) return
    if (asked.current === token) return
    asked.current = token
    fetch(`${API_URL}/api/v1/storefront/account`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((a: { nickname?: string | null } | null) => { if (a && !a.nickname) setOpen(true) })
      .catch(() => { /* try next visit */ })
  }, [token, pathname, initialBrandSlug])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setLater(); setOpen(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open || !token || hiddenOn(pathname)) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (check.state === 'bad' || !value.trim() || saving) return
    setSaving(true); setError('')
    const err = await saveNickname(token, value)
    setSaving(false)
    if (err) { setError(err); return }
    setOpen(false)
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="nick-title"
      style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        background: 'color-mix(in srgb, var(--servd-ink) 45%, transparent)', padding: '0' }}>
      <form onSubmit={(e) => { void submit(e) }} noValidate
        style={{ width: '100%', maxWidth: '28rem', background: '#fff', color: 'var(--servd-ink)',
          borderRadius: '1.25rem 1.25rem 0 0', padding: '1.5rem 1rem calc(1.25rem + env(safe-area-inset-bottom))',
          boxShadow: '0 -8px 30px rgba(38,16,56,0.18)' }}>
        <p className="text-[11px] font-bold uppercase" style={{ letterSpacing: '0.18em', color: 'var(--servd-green-dark)' }}>One last thing</p>
        <h2 id="nick-title" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.6rem', letterSpacing: '-0.02em', margin: '0.25rem 0 0.35rem' }}>
          Pick your servd name
        </h2>
        <p className="text-sm mb-4" style={{ color: 'var(--servd-mute)' }}>
          It&rsquo;s how your friends see you in group orders and on the tables you invite them to.
        </p>
        <NicknameField id="nick-sheet" value={value} onChange={(v) => { setValue(v); setError('') }} check={check} autoFocus />
        {error && <p role="alert" className="text-xs font-semibold mt-1" style={{ color: 'var(--servd-danger)' }}>{error}</p>}
        <button type="submit" disabled={saving || !value.trim() || check.state === 'bad' || check.state === 'checking'}
          className="w-full rounded-xl py-3.5 font-black mt-3 disabled:opacity-40"
          style={{ background: 'var(--servd-purple)', color: 'var(--servd-on-purple)', borderRadius: 'var(--servd-btn-radius, 0.5rem)' }}>
          {saving ? 'Saving…' : 'Save my name'}
        </button>
        <button type="button" onClick={() => { setLater(); setOpen(false) }}
          className="w-full min-h-[44px] mt-1 text-sm font-bold" style={{ color: 'var(--servd-mute)' }}>
          Later
        </button>
      </form>
    </div>
  )
}
