'use client'

// /home?q=… (the sitelinks search box in the home JSON-LD) opens the search
// sheet. Mounted by the /home route itself, so it works whatever sections the
// page holds.

import { useEffect } from 'react'
import { openSearch } from '../../components/SearchSheet'

export function HomeSearchParam() {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) openSearch(q)
  }, [])
  return null
}
