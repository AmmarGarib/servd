// Who configures servd's API connectors (Dev -> API: the WhatsApp gateway and
// the POS connector). The CEO and IT — the Dev workspace's owner role
// (lib/workspaces.ts). Kept in one place so every connector route agrees.
export const CONNECTOR_ADMINS = ['admin', 'it'] as const
