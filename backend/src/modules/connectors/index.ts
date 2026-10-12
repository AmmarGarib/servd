// The POS connector's three Fastify plugins (spec §8). W4 calls
// registerConnectorPlugins(app) from the /api/v1 scope in src/index.ts.
//
//   /connectors     — configuration, go-live, documents, charges (module api_pos)
//   /pos            — the till: card machine + an order's fiscal documents
//   /webhooks/pos   — inbound vendor events (own raw-body parser)

import type { FastifyInstance } from 'fastify'
import { connectorRoutes } from './routes.js'
import { connectorPosRoutes } from './posRoutes.js'
import { connectorWebhookRoutes } from './webhookRoutes.js'

export async function registerConnectorPlugins(app: FastifyInstance): Promise<void> {
  await app.register(connectorRoutes, { prefix: '/connectors' })
  await app.register(connectorPosRoutes, { prefix: '/pos' })
  await app.register(connectorWebhookRoutes, { prefix: '/webhooks/pos' })
}

export { connectorRoutes, connectorPosRoutes, connectorWebhookRoutes }
