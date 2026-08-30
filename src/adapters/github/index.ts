/**
 * The GitHub adapter's public surface: the constructors the composition root binds to the ports.
 * Nothing in `core/` or `ports/` may name this module.
 */
export { makeGitHubCodeReview } from './code-review.js'
export {
  githubProviderOf,
  githubTrackerProvider,
  validateGitHubProvider,
  type GitHubProviderConfig,
} from './provider.js'
export { makeGitHubIssueControl, makeGitHubTracker } from './issues.js'
