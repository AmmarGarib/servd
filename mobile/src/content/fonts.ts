// Library fonts for content blocks. expo-font ships with the `expo` package
// (a direct dependency of expo 52), so no extra install is needed.
//
// Native text can only use a family that has been loaded, so a family is
// applied only once loadAsync has resolved; until then (or when the file is a
// format the platform can't read, e.g. woff2 on iOS/Android) the system font
// is used. Unloaded names are never passed to <Text>, which would warn in dev.

import { useEffect, useState } from 'react'
import { Platform } from 'react-native'
import * as Font from 'expo-font'
import type { LibraryFont } from './types'

const loaded = new Set<string>()
const failed = new Set<string>()
const inflight = new Map<string, Promise<void>>()

function load(font: LibraryFont): Promise<void> {
  if (loaded.has(font.family) || failed.has(font.family)) return Promise.resolve()
  let p = inflight.get(font.family)
  if (!p) {
    p = Font.loadAsync({ [font.family]: font.url })
      .then(() => { loaded.add(font.family) })
      .catch(() => { failed.add(font.family) })
      .finally(() => { inflight.delete(font.family) })
    inflight.set(font.family, p)
  }
  return p
}

/** Loads the page's library fonts; re-renders once they are ready. */
export function useLibraryFonts(fonts: LibraryFont[] | undefined): number {
  const [tick, setTick] = useState(0)
  const key = (fonts ?? []).map((f) => `${f.family}|${f.url}`).join(',')
  useEffect(() => {
    const list = (fonts ?? []).filter((f) => f && f.family && f.url)
    if (list.length === 0) return
    let alive = true
    Promise.all(list.map(load)).then(() => { if (alive) setTick((t) => t + 1) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return tick
}

const GENERIC: Record<string, string | undefined> = {
  serif:     Platform.select({ ios: 'Georgia', android: 'serif' }),
  monospace: Platform.select({ ios: 'Courier', android: 'monospace' }),
}

/**
 * Resolves a block/page font to a native family name, or undefined for the
 * system font. Accepts a library family or a CSS stack ("'Amarante', serif"):
 * the first loaded family wins, then a generic serif/monospace fallback.
 */
export function resolveFontFamily(family: string | undefined): string | undefined {
  if (!family) return undefined
  const parts = family.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  for (const p of parts) if (loaded.has(p)) return p
  for (const p of parts) {
    const g = GENERIC[p.toLowerCase()]
    if (g) return g
  }
  return undefined
}
