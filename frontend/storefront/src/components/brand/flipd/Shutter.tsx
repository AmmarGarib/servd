'use client'
// The checker band as a shutter between Flipd's sections — the same brand
// edge the book uses as a rule, now part of the camera language: as the band
// crosses the middle of the viewport it opens from a 12px rule to a 56px
// shutter and the checker slides across, the way the Flipd cut (P1's checker
// shutter) lifts between pages.
//
// Scrubbed by scroll position ('pass' progress), never triggered by time, so
// any snapshot has a defined state. Clip-path + transform only — the band's
// layout box never changes size, so nothing below it moves. Under reduced
// motion useScene pins progress at 1: a still, open band.

import { useRef } from 'react'
import { motion, useTransform } from 'framer-motion'
import { seg, useScene } from '../../../lib/film/motion'
import sh from './shutter.module.css'

const MAX = 56
const MIN = 12
/** One checker period (two squares) at the band's tile size. */
const PERIOD = 28

export function Shutter({ reverse = false }: { reverse?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const p = useScene(ref, 'pass')
  // Opens as it climbs from the lower third to the middle, stays open.
  const clip = useTransform(p, (v) => {
    const open = seg(v, 0.2, 0.5)
    const inset = ((MAX - (MIN + (MAX - MIN) * open)) / 2).toFixed(2)
    return `inset(${inset}px 0px ${inset}px 0px)`
  })
  // The pattern slides by four periods over the pass, fastest mid-screen.
  const x = useTransform(p, (v) => {
    const eased = v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2
    const d = eased * PERIOD * 4
    return reverse ? d - PERIOD * 4 : -d
  })
  return (
    <div ref={ref} className={sh.shutter} aria-hidden>
      <motion.div className={sh.band} style={{ clipPath: clip }}>
        <motion.div className={sh.pattern} style={{ x }} />
      </motion.div>
    </div>
  )
}
