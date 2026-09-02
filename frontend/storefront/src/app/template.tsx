'use client'
// Route transition — every navigation re-mounts this template, so each
// page enters with a soft cross-fade. Opacity only, on purpose: transforms
// or filters here would give the page a containing block and break the
// position:fixed layers inside pages (the Stax concrete backdrop, sticky
// scroll heroes). Per-section choreography is handled by <Reveal> inside
// each page; this is just the connective tissue between routes.

import { motion, useReducedMotion } from 'framer-motion'

export default function Template({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion()
  if (reduce) return <>{children}</>
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
