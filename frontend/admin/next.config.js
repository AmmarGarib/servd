const { withSentryConfig } = require('@sentry/nextjs')
const createNextIntlPlugin = require('next-intl/plugin')
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.BUILD_STANDALONE === 'true' && { output: 'standalone' }),
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.r2.cloudflarestorage.com' },
      { protocol: 'https', hostname: 'media.servd.pk' },
    ],
  },
  // Baseline security headers. The operator console must never be frameable
  // (clickjacking on refund/void/payroll buttons is a real attack here).
  // X-Robots-Tag keeps every response (pages, JSON, files) out of search
  // engines; it is a header, not a robots.txt Disallow, so a crawler can still
  // fetch a page and see it is noindex. HSTS: no includeSubDomains until
  // every servd.pk subdomain is confirmed https-only.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        ],
      },
    ]
  },
  // The old dashboards were retired for four blank ones (2026-10-05); their
  // routes only forward old links and bookmarks. Temporary, not permanent —
  // browsers cache 308s for good.
  async redirects() {
    const to = (destination) => ({ destination, permanent: false })
    return [
      { source: '/dashboard', ...to('/home') },
      { source: '/dashboard/ceo', ...to('/home') },
      { source: '/dashboard/:old(fnb|boh|foh)', ...to('/dashboard/operations') },
      { source: '/dashboard/brand', ...to('/dashboard/marketing') },
      { source: '/ops', ...to('/dashboard/operations') },
      { source: '/chain', ...to('/dashboard/operations') },
      { source: '/marketing', ...to('/dashboard/marketing') },
      { source: '/hr', ...to('/dashboard/hr') },
    ]
  },
  async rewrites() {
    if (!process.env.NEXT_PUBLIC_API_URL) return []
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL}/api/:path*`,
      },
    ]
  },
}

module.exports = withSentryConfig(withNextIntl(nextConfig), {
  silent: true,
  org: 'servd',
  project: 'ops-web',
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
  automaticVercelMonitors: false,
})
