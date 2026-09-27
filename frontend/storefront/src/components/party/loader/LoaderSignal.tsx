'use client'
// LoaderSignal — tells the world a route loader is up (or gone).
//
// Mounted inside PartyLoader and BrandLoader. On mount it fires a window
// CustomEvent 'servd:loader' { state: 'show', ground }, on unmount
// { state: 'hide', ground }. The route curtain (components/world/RouteCurtain)
// listens and gets out of the loader's way at once, so a navigation never
// shows curtain-then-loader-then-page. `ground` is the loader's background
// colour (any CSS colour, including var(...)). Renders nothing.

import { useEffect } from 'react'

export interface LoaderSignalDetail {
  state: 'show' | 'hide'
  ground: string
}

export const LOADER_EVENT = 'servd:loader'

function send(detail: LoaderSignalDetail) {
  try {
    window.dispatchEvent(new CustomEvent<LoaderSignalDetail>(LOADER_EVENT, { detail }))
  } catch {
    /* very old browsers without CustomEvent constructor: nothing listens there */
  }
}

export function LoaderSignal({ ground }: { ground: string }) {
  useEffect(() => {
    send({ state: 'show', ground })
    return () => send({ state: 'hide', ground })
  }, [ground])
  return null
}

export default LoaderSignal
