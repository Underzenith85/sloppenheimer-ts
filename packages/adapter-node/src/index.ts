/** Host-platform adapters. Both provider adapters and the composition root build on these. */
export { isSymbolicLink } from './filesystem.js'
export { makeGitSourceControl } from './source-control.js'
export { runHook, type HookPhase } from './workspace-hooks.js'
export {
  assertWorkspaceIdentity,
  openVerifiedWorkspace,
  verifyWorkspaceForLaunch,
} from './workspace-identity.js'
export { makeWorkspaceManager } from './workspace-manager.js'
