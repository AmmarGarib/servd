// The POS connector's three Fastify plugins (spec §8). W4 calls
// registerConnectorPlugins(app) from the /api/v1 scope in src/index.ts.
//
//   /connectors       — configuration, go-live, documents, charges (module api_pos)
//   /connectors       — IT change requests (changeRequests.ts: the Dev hand-over, D1/D3 B4; api_pos)
//   /connectors/raast — Raast QR bank alerts: settings, counter phones, SMS log (api_pos)
//   /pos              — the till: card machine + an order's fiscal documents
//   /pos/raast        — the till: Raast QR intents and bank alerts (CASHIERS, ungated)
//   /webhooks/pos     — inbound vendor events + bank SMS from counter phones (own raw-body parser)

import type { FastifyInstance } from 'fastify'
import { connectorRoutes } from './routes.js'
import { connectorChangeRoutes } from './changeRequests.js'
import { connectorPosRoutes } from './posRoutes.js'
import { connectorWebhookRoutes } from './webhookRoutes.js'
import { raastConnectorRoutes } from './raastRoutes.js'
import { raastPosRoutes } from './raastPosRoutes.js'

export async function registerConnectorPlugins(app: FastifyInstance): Promise<void> {
  await app.register(connectorRoutes, { prefix: '/connectors' })
  await app.register(connectorChangeRoutes, { prefix: '/connectors' })
  await app.register(raastConnectorRoutes, { prefix: '/connectors/raast' })
  await app.register(connectorPosRoutes, { prefix: '/pos' })
  await app.register(raastPosRoutes, { prefix: '/pos/raast' })
  await app.register(connectorWebhookRoutes, { prefix: '/webhooks/pos' })
}

export { connectorRoutes, connectorChangeRoutes, connectorPosRoutes, connectorWebhookRoutes, raastConnectorRoutes, raastPosRoutes }
