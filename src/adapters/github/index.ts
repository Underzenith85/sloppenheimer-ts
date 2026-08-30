/**
 * The GitHub adapter's public surface: the constructors the composition root binds to the ports,
 * and the HTTP client layer their transport talks through. Nothing in `core/` or `ports/` may name
 * this module.
 */
export { githubHttpClientLayer } from './client.js'
export { makeGitHubCodeReview } from './code-review.js'
export { makeGitHubIssueControl, makeGitHubTracker } from './issues.js'
