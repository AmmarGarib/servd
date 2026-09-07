/** @type {import('next').NextConfig} */

// The strangler proxy: any request that does NOT match a Route Handler in
// this app falls through to the legacy Fastify API. Port a module by
// creating its route file here — the moment the file exists it shadows
// the proxy for that path; delete it and traffic flows back to legacy.
// LEGACY_API_URL is the running Fastify deployment.
const LEGACY = process.env.LEGACY_API_URL ?? 'https://servd-api.garibsons.app'

const nextConfig = {
  // Route-handlers-only app; no separate eslint setup here.
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [],
      // fallback = only when no filesystem route matched.
      fallback: [
        { source: '/:path*', destination: `${LEGACY}/:path*` },
      ],
    }
  },
}

module.exports = nextConfig
