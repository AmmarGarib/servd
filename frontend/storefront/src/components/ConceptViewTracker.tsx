'use client'
import { useEffect } from 'react'
import { trackConceptView } from '../lib/analytics'

export default function ConceptViewTracker({ conceptId, slug }: { conceptId: string; slug: string }) {
  useEffect(() => {
    trackConceptView(conceptId, slug)
  }, [conceptId, slug])
  return null
}
