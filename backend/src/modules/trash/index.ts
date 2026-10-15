// The Trash bin (owner, 2026-10-15). See README.md.
export { registerTrashPlugin, trashRoutes, type TrashPluginOptions } from './routes.js'
export { trashProviders, trashProvider } from './registry.js'
export { takeSnapshot, restoreSnapshot, rowForCreate, type Snapshot } from './snapshot.js'
export * from './types.js'
