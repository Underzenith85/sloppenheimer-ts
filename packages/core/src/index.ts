/**
 * The composition root's view of the core: the ports it binds adapters to, and the orchestrator it
 * runs. Everything else — domain vocabulary, telemetry, the workflow model, the support layer — is
 * reached through its own subpath, so an importing module still names the layer it depends on.
 */
export * from './core/orchestrator.js'
export * from './ports/index.js'
