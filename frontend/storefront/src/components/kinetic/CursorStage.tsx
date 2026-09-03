'use client'
// CursorStage — a background video whose cast follows the mouse.
//
// The clip is authored so the food characters look LEFT through the
// first half and RIGHT through the second. Instead of playing it, we
// scrub it: the pointer's X position maps to a target timestamp and the
// current time lerps toward it every frame — move the cursor left and
// the crowd turns left, glide right and they follow. The video itself
// stays paused the whole time; the cursor is the timeline.
//
// Touch devices simply loop the clip (no cursor to follow). Reduced-
// motion parks it on a mid-video frame. The dark scrim on top keeps the
// hero headline legible over the bright stage.

import { motion, useReducedMotion, type MotionValue } from 'framer-motion'
import { useEffect, useRef } from 'react'

interface Props {
  src: string
  /** Hero-driven opacity (the stage belongs to the intro beat). */
  opacity: MotionValue<number>
}

export function CursorStage({ src, opacity }: Props) {
  const reduce = useReducedMotion()
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const coarse = window.matchMedia?.('(pointer: coarse)').matches

    if (reduce) {
      // Park on a forward-facing mid frame.
      const park = () => { video.currentTime = (video.duration || 10) / 2 }
      if (video.readyState >= 1) park()
      else video.addEventListener('loadedmetadata', park, { once: true })
      return
    }

    if (coarse) {
      // No cursor to follow — let the scene live on its own.
      video.loop = true
      video.play().catch(() => { /* autoplay blocked — static frame is fine */ })
      return
    }

    // Cursor-scrub: pointer X → timestamp, lerped for a natural turn.
    let target = 0
    let raf = 0
    const onMove = (e: MouseEvent) => {
      const dur = video.duration
      if (!dur) return
      const nx = Math.max(0, Math.min(1, e.clientX / window.innerWidth))
      // Keep a hair off the extremes so we never stall on the last frame.
      target = 0.05 + nx * (dur - 0.15)
    }
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const dur = video.duration
      if (!dur || video.seeking) return
      const d = target - video.currentTime
      if (Math.abs(d) < 0.04) return
      video.currentTime = video.currentTime + d * 0.16
    }
    const start = () => {
      video.pause()
      target = (video.duration || 10) / 2
      video.currentTime = target
      raf = requestAnimationFrame(tick)
    }
    if (video.readyState >= 1) start()
    else video.addEventListener('loadedmetadata', start, { once: true })
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [reduce])

  return (
    <motion.div aria-hidden style={{
      opacity,
      position: 'absolute', inset: 0, zIndex: 0,
      pointerEvents: 'none', overflow: 'hidden',
    }}>
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        preload="auto"
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          objectFit: 'cover',
        }}
      />
      {/* Scrim — the bright stage glows through, the headline stays legible. */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `
          radial-gradient(ellipse 74% 58% at 50% 44%, rgba(21,16,26,0.62) 0%, rgba(21,16,26,0.45) 55%, rgba(21,16,26,0.7) 100%),
          linear-gradient(180deg, rgba(21,16,26,0.85) 0%, rgba(21,16,26,0.25) 32%, rgba(21,16,26,0.25) 62%, rgba(21,16,26,0.9) 100%)
        `,
      }} />
    </motion.div>
  )
}
