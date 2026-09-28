// Vercel serverless entry for the servd API — the whole Fastify app as ONE
// Node function. vercel.json rewrites every path here.
//
// Why this imports compiled output from ../dist instead of ../src/app.ts:
// the backend is ESM with TypeScript `moduleResolution: NodeNext`, so source
// files import each other as `./foo.js` while the file on disk is `foo.ts`.
// Vercel's built-in TypeScript transform for functions does not reliably map
// those `.js` specifiers back to `.ts`, and fails at runtime with
// ERR_MODULE_NOT_FOUND deep in the import graph. So the build step runs `tsc`
// (see vercel.json buildCommand / package.json vercel-build) and this plain-JS
// file loads the emitted JavaScript. tsconfig has rootDir ".", so src/app.ts
// is emitted at dist/src/app.js. dist/** is shipped via `includeFiles`.
//
// What does NOT run here (long-running-process only, see src/index.ts):
// socket.io, the BullMQ/cron workers, the boot-time seeds, listen().

import 'dotenv/config'
// Static import (not `await import()`) so Vercel's file tracer follows the
// whole compiled graph and bundles every node_module it reaches.
import { buildApp } from '../dist/src/app.js'

// Match the Docker entry: a stray Redis/BullMQ rejection must not take the
// function instance down mid-request.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err instanceof Error ? err.message : err)
})

/** @type {Promise<import('fastify').FastifyInstance> | null} */
let appPromise = null

function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const app = await buildApp({ serverless: true })
      await app.ready()
      return app
    })()
    // A failed cold start must not be cached forever — let the next
    // invocation try again.
    appPromise.catch(() => { appPromise = null })
  }
  return appPromise
}

export default async function handler(req, res) {
  const app = await getApp()
  app.server.emit('request', req, res)
}
