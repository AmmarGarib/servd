# frontend/admin/src/hooks

Custom React hooks. Each is a single `use*.ts` file.

- `useKdsSocket.ts` — Subscribes to KDS WebSocket events; wires up sound + flash on new orders.
- `useKdsVoice.ts` — Web Speech API integration for voice-controlled KDS ("bump 47").
- `useCan.ts` — Permission check (`useCan('orders:refund')`) backed by GET /permissions/me.
