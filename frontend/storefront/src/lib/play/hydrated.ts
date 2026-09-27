// useHydrated(): false on the server and on the first client render, true
// after mount. Gate anything that reads persisted play state behind it so the
// first client paint matches the server HTML.

import { useEffect, useState } from 'react'
import { hydratePlay } from './store'

export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    hydratePlay()
    setHydrated(true)
  }, [])
  return hydrated
}
