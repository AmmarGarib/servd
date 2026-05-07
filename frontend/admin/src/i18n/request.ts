import { getRequestConfig } from 'next-intl/server'
import { cookies } from 'next/headers'

export default getRequestConfig(async () => {
  const locale = (await cookies()).get('NEXT_LOCALE')?.value ?? 'en'
  const validLocale = ['en', 'ur'].includes(locale) ? locale : 'en'

  return {
    locale: validLocale,
    messages: (await import(`../../messages/${validLocale}.json`)).default,
  }
})
