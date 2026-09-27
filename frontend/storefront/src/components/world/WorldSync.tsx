'use client'
// Keeps the world attributes on <html> live.
//
// The root layout stamps them on the server so the first paint is already
// right; this takes over after mount. It writes straight to
// document.documentElement (never through React), so there is nothing to
// hydrate and nothing to mismatch. It never writes before the world is ready
// — the pre-mount 'lunch' placeholder must not overwrite the server's stamp.

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { KITCHEN_SLUGS } from '../../lib/world/kitchenCore'
import { useKitchens } from '../../lib/world/kitchens'
import { refreshWorld, useWorld } from '../../lib/world/useWorld'

const RESYNC_MS = 60_000

function setAttr(el: HTMLElement, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

export function WorldSync(): null {
  const world = useWorld()
  const kitchens = useKitchens()
  const pathname = usePathname()

  // A client navigation can change ?daypart= without a popstate.
  useEffect(() => { refreshWorld() }, [pathname])

  // Belt and braces: the stores tick on their own, but re-read once a minute
  // even if a store's timer was throttled in a background tab.
  useEffect(() => {
    const id = window.setInterval(refreshWorld, RESYNC_MS)
    return () => window.clearInterval(id)
  }, [])

  // The attributes are re-asserted on every navigation too: a server refresh
  // of the root layout re-applies its own (fallback-hours) stamp to <html>.
  const { ready, dayPart, dark } = world
  useEffect(() => {
    if (!ready) return
    const el = document.documentElement
    setAttr(el, 'data-daypart', dayPart)
    setAttr(el, 'data-world-dark', dark ? '1' : '0')
  }, [ready, dayPart, dark, pathname])

  const kReady = kitchens.ready
  const phases = KITCHEN_SLUGS.map((s) => kitchens.bySlug[s].phase).join(',')
  const openCount = kitchens.openCount
  useEffect(() => {
    if (!kReady) return
    const el = document.documentElement
    setAttr(el, 'data-kitchens-open', String(openCount))
    const list = phases.split(',')
    KITCHEN_SLUGS.forEach((s, i) => setAttr(el, `data-k-${s}`, list[i] ?? 'closed'))
  }, [kReady, phases, openCount, pathname])

  return null
}

export default WorldSync
