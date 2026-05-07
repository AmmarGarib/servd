import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Providers } from '../components/ui/Providers'
import { AuthGuard } from '../components/ui/AuthGuard'
import { AppShell } from '../components/ui/AppShell'
import { NextIntlClientProvider } from 'next-intl'
import { cookies } from 'next/headers'
import en from '../../messages/en.json'
import ur from '../../messages/ur.json'

const MESSAGES = { en, ur } as const
type Locale = keyof typeof MESSAGES

export const metadata: Metadata = {
  title: 'servd — Operations',
  description: 'servd Hospitality Operations Platform',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black', title: 'servd' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0C0D10',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies()
  const raw = cookieStore.get('NEXT_LOCALE')?.value ?? 'en'
  const locale: Locale = raw in MESSAGES ? (raw as Locale) : 'en'

  return (
    <html lang={locale} dir={locale === 'ur' ? 'rtl' : 'ltr'} className="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js')}` }} />
      </head>
      <body className="bg-s-bg text-s-text antialiased">
        <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
          <Providers>
            <AuthGuard>
              <AppShell>{children}</AppShell>
            </AuthGuard>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
