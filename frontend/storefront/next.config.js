const { withSentryConfig } = require('@sentry/nextjs')

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
  // The burger brand was "stax" before the rebrand to "stackd". Printed QR
  // codes, table tents, old posts and anything already shared point at the old
  // paths, and those keep working — permanently, because the printed ones can't
  // be reissued. Ordering, the microsite, the menu and reservations are all
  // covered. Note eatstax.com is untouched: it is a real registered domain and
  // still resolves to this brand.
  async redirects() {
    return [
      { source: '/stax',              destination: '/stackd',              permanent: true },
      { source: '/stax/:path*',       destination: '/stackd/:path*',       permanent: true },
      { source: '/brand/stax',        destination: '/brand/stackd',        permanent: true },
      { source: '/brand/stax/:path*', destination: '/brand/stackd/:path*', permanent: true },
      { source: '/brands/stax',       destination: '/brands/stackd',       permanent: true },
      { source: '/reserve/stax',      destination: '/reserve/stackd',      permanent: true },
    ]
  },

  // Baseline security headers for the consumer site.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

module.exports = withSentryConfig(nextConfig, {
  silent: true,
  org: 'servd',
  project: 'storefront',
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
  automaticVercelMonitors: false,
})
