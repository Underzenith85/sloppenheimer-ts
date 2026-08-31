import { Effect, Option } from 'effect'

import {
  githubProviderOf,
  githubTrackerProvider,
  makeGitHubCodeReview,
  makeGitHubIssueControl,
  makeGitHubSourceControl,
  makeGitHubTracker,
} from '@symphony/adapter-github'
import {
  makeTrackerProviderRegistry,
  sameTrackerProvider,
  type RegisteredTrackerProvider,
  type TrackerProviderRegistry,
  type ValidatedTrackerProvider,
} from '@symphony/core/domain/tracker-provider.js'
import { SourceControlError, TrackerError } from '@symphony/core/domain/errors.js'
import type {
  CodeReviewFactoryPort,
  IssueControlFactoryPort,
  SourceControlFactoryPort,
  TrackerFactoryPort,
} from '@symphony/core'

export type RegisteredTrackerPorts = RegisteredTrackerProvider<
  TrackerFactoryPort['make'],
  CodeReviewFactoryPort['make'],
  IssueControlFactoryPort['make'],
  SourceControlFactoryPort['make']
>

export type TrackerAdapterRegistry = TrackerProviderRegistry<RegisteredTrackerPorts>

export type TrackerPortFactories = Readonly<{
  providers: TrackerAdapterRegistry
  tracker: TrackerFactoryPort
  codeReview: CodeReviewFactoryPort
  issueControl: IssueControlFactoryPort
  sourceControl: SourceControlFactoryPort
}>

const unsupportedCapability = (
  provider: ValidatedTrackerProvider,
  capability: string,
  cause: unknown,
): TrackerError =>
  new TrackerError({
    category: 'unsupported_tracker_kind',
    message: `tracker.kind ${provider.kind} is registered but does not supply ${capability}`,
    retryable: false,
    cause,
  })

const sourceControlUnavailable = (
  provider: ValidatedTrackerProvider,
  cause: unknown,
): SourceControlError =>
  new SourceControlError({
    category: 'invalid_repository',
    message: `tracker provider ${provider.kind} does not supply SourceControlPort`,
    retryable: false,
    worktreePreserved: true,
    cause,
  })

const missingCapability = (provider: ValidatedTrackerProvider, capability: string): TrackerError =>
  unsupportedCapability(provider, capability, new Error(`missing ${capability} factory`))

/** Builds every provider-selected factory from the same registered entries. */
export const makeTrackerPortFactories = (
  entries: readonly RegisteredTrackerPorts[],
): TrackerPortFactories => {
  const providers = makeTrackerProviderRegistry(entries)
  const capabilityFor = <Capability>(
    provider: ValidatedTrackerProvider,
    select: (entry: RegisteredTrackerPorts) => Capability | undefined,
  ): Option.Option<Capability> =>
    Option.flatMap(providers.get(provider.kind), (entry) => Option.fromNullable(select(entry)))

  return Object.freeze({
    providers,
    tracker: {
      make: (provider) =>
        Option.match(
          capabilityFor(provider, (entry) => entry.tracker),
          {
            onNone: () => Effect.fail(missingCapability(provider, 'TrackerPort')),
            onSome: (make) => Effect.suspend(() => make(provider)),
          },
        ),
    },
    codeReview: {
      make: (provider) =>
        Option.match(
          capabilityFor(provider, (entry) => entry.codeReview),
          {
            onNone: () => Effect.succeed(null),
            onSome: (make) => Effect.suspend(() => make(provider)),
          },
        ),
    },
    issueControl: {
      make: (provider) =>
        Option.match(
          capabilityFor(provider, (entry) => entry.issueControl),
          {
            onNone: () => Effect.fail(missingCapability(provider, 'IssueControlPort')),
            onSome: (make) => Effect.suspend(() => make(provider)),
          },
        ),
      serves: sameTrackerProvider,
    },
    sourceControl: {
      make: (provider) =>
        Option.match(
          capabilityFor(provider, (entry) => entry.sourceControl),
          {
            onNone: () => Effect.succeed(null),
            onSome: (make) => Effect.suspend(() => make(provider)),
          },
        ),
    },
  })
}

/**
 * The tracker kinds this build supports.
 *
 * This is the composition root's list, and the only place a kind is named: an adapter owns its own
 * validation, provider equality, secret provenance, and port factories, so adding a kind is one
 * entry here and no change under `config/` or `core/`.
 */
const registered = makeTrackerPortFactories([
  {
    ...githubTrackerProvider,
    tracker: (provider): ReturnType<TrackerFactoryPort['make']> =>
      Effect.try({
        try: () => githubProviderOf(provider),
        catch: (cause) => unsupportedCapability(provider, 'TrackerPort', cause),
      }).pipe(Effect.flatMap((config) => makeGitHubTracker(config))),
    codeReview: (provider): ReturnType<CodeReviewFactoryPort['make']> =>
      Effect.try({
        try: () => makeGitHubCodeReview(githubProviderOf(provider)),
        catch: (cause) => unsupportedCapability(provider, 'CodeReviewPort', cause),
      }),
    issueControl: (provider): ReturnType<IssueControlFactoryPort['make']> =>
      Effect.try({
        try: () => githubProviderOf(provider),
        catch: (cause) => unsupportedCapability(provider, 'IssueControlPort', cause),
      }).pipe(Effect.flatMap((config) => makeGitHubIssueControl(config))),
    sourceControl: (provider): ReturnType<SourceControlFactoryPort['make']> =>
      Effect.try({
        try: () => makeGitHubSourceControl(githubProviderOf(provider)),
        catch: (cause) => sourceControlUnavailable(provider, cause),
      }),
  },
])

export const trackerProviders: TrackerAdapterRegistry = registered.providers
export const trackerFactory: TrackerFactoryPort = registered.tracker
export const codeReviewFactory: CodeReviewFactoryPort = registered.codeReview
export const issueControlFactory: IssueControlFactoryPort = registered.issueControl
export const sourceControlFactory: SourceControlFactoryPort = registered.sourceControl
