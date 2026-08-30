/**
 * The GitHub adapter's public surface: the constructors the composition root binds to the ports.
 * Nothing in `core/` or `ports/` may name this module.
 */
export { makeGitHubCodeReview } from './code-review.js'
export { makeGitHubIssueControl, makeGitHubTracker } from './issues.js'
