import { Option } from 'effect'

import { makeGitSourceControl } from '../node/source-control.js'
import type { SourceControlPort } from '../../ports/source-control.js'
import type { GitHubProviderConfig } from './provider.js'

/** GitHub supplies repository identity and a redacted credential; Git mechanics remain generic. */
export const makeGitHubSourceControl = (provider: GitHubProviderConfig): SourceControlPort =>
  makeGitSourceControl({
    remoteUrl: `https://github.com/${encodeURIComponent(provider.owner)}/${encodeURIComponent(provider.repository)}.git`,
    baseBranch: provider.baseBranch,
    credential: Option.some({ username: 'x-access-token', password: provider.token }),
  })
