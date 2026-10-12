'use client'
import { useEffect } from 'react'

// Mounted by SiteLayoutView only when the rendered blocks carry a scroll
// effect (block.motion). Renders nothing; starts the shared motion engine
// (./motionClient — the reach guard everywhere, the scroll fallback where CSS
// scroll timelines are missing). The engine is loaded on demand, so pages
// without motion never download it.

type Engine = typeof import('./motionClient')

export function MotionRuntime() {
  useEffect(() => {
    let alive = true
    let engine: Engine | null = null
    void import('./motionClient').then((m) => {
      if (!alive) return
      engine = m
      m.startMotionEngine()
    }).catch(() => { /* no engine: CSS alone (or natural content) */ })
    return () => {
      alive = false
      engine?.stopMotionEngine()
    }
  }, [])
  return null
}
