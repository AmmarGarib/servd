'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

// Admin language (English / Urdu). A per-browser preference stored in the
// NEXT_LOCALE cookie; the KDS and POS screens read the same cookie. This used
// to be the "Preferences" tab of the retired /settings page.
export default function LanguagePage() {
  const [locale, setLocale] = useState('en')

  useEffect(() => {
    const cookieLocale = document.cookie.split('; ').find((r) => r.startsWith('NEXT_LOCALE='))?.split('=')[1]
    if (cookieLocale) setLocale(cookieLocale)
  }, [])

  function changeLocale(next: string) {
    setLocale(next)
    document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=31536000`
    window.location.reload()
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Language / زبان</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          The language this browser shows the admin, KDS and POS in. Saved on this device only.
        </p>
      </header>
      <div className="px-7 py-7 max-w-lg mx-auto">
        <div className="grid grid-cols-2 gap-2">
          {[{ code: 'en', label: 'English', native: 'English' }, { code: 'ur', label: 'Urdu', native: 'اردو' }].map((lang) => (
            <button key={lang.code} onClick={() => changeLocale(lang.code)}
              className={`rounded-xl p-4 text-center border transition-colors ${
                locale === lang.code
                  ? 'border-primary bg-primary/15 text-primary-ink'
                  : 'border-white/10 text-white/55 hover:border-white/30'
              }`}>
              <div className="font-bold text-sm">{lang.native}</div>
              <div className="text-xs opacity-70">{lang.label}</div>
            </button>
          ))}
        </div>
        <p className="text-xs text-white/40 mt-3">Changing language reloads the page.</p>
      </div>
    </div>
  )
}
