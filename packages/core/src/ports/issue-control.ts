import { Context, Effect, Layer, Option, Ref } from 'effect'

import type { ValidatedTrackerProvider } from '../domain/tracker-provider.js'
import type { Issue } from '../domain/domain.js'
import type { TrackerError } from '../domain/errors.js'

/**
 * The narrow issue surface the operator console drives directly: list what is open, and mark one
 * issue for orchestration. It is separate from `TrackerPort` because the operator needs neither
 * dependency hydration nor provider-native tools, and a tracker must not have to supply the
 * console's vocabulary to be a tracker.
 */
export type IssueControlPort = Readonly<{
  listOpenIssues: () => Effect.Effect<readonly Issue[], TrackerError>
  addLabel: (issueNumber: number, label: string) => Effect.Effect<void, TrackerError>
}>

/**
 * Constructs an issue control for one validated provider.
 *
 * Unlike `TrackerFactoryPort` this does not build into a `Scope`: the console's surface is two
 * request-shaped calls, so an implementation that had to acquire a resource to answer them would be
 * holding it open across the idle life of the console rather than across one request.
 */
export type IssueControlFactoryPort = Readonly<{
  make: (provider: ValidatedTrackerProvider) => Effect.Effect<IssueControlPort, TrackerError>
  /**
   * Whether the instance built for `built` also serves `requested`. Only the adapter knows which
   * provider fields its instance captured, and the console reloads the workflow on every request:
   * without this, an edit to an unrelated part of the workflow would discard a warm instance.
   */
  serves: (built: ValidatedTrackerProvider, requested: ValidatedTrackerProvider) => boolean
}>

export class IssueControlFactory extends Context.Tag('symphony/IssueControlFactory')<
  IssueControlFactory,
  IssueControlFactoryPort
>() {}

export const layerIssueControlFactory = (
  factory: IssueControlFactoryPort,
): Layer.Layer<IssueControlFactory> => Layer.succeed(IssueControlFactory, factory)

/**
 * The issue control in force, and the seam through which a provider change installs its
 * replacement. The console asks for the control that serves the provider its freshly loaded
 * workflow names; the cell answers with the instance it already holds, or builds a replacement.
 */
export type IssueControlCell = Readonly<{
  forProvider: (provider: ValidatedTrackerProvider) => Effect.Effect<IssueControlPort, TrackerError>
}>

export class CurrentIssueControl extends Context.Tag('symphony/CurrentIssueControl')<
  CurrentIssueControl,
  IssueControlCell
>() {}

/** Reads the issue control that serves `provider`, building it if the provider has changed. */
export const issueControlFor = (
  provider: ValidatedTrackerProvider,
): Effect.Effect<IssueControlPort, TrackerError, CurrentIssueControl> =>
  Effect.flatMap(CurrentIssueControl, (cell) => cell.forProvider(provider))

type Held = Readonly<{ provider: ValidatedTrackerProvider; control: IssueControlPort }>

/**
 * Builds the instance on first use and holds it in a `Ref` until the provider it was built for no
 * longer serves. The gate makes one concurrent request build it rather than all of them: two
 * instances would each carry their own dependency cache, and the loser's would be thrown away warm.
 */
export const layerCurrentIssueControl: Layer.Layer<
  CurrentIssueControl,
  never,
  IssueControlFactory
> = Layer.effect(
  CurrentIssueControl,
  Effect.gen(function* () {
    const factory = yield* IssueControlFactory
    const held = yield* Ref.make(Option.none<Held>())
    const gate = yield* Effect.makeSemaphore(1)
    return {
      forProvider: (provider) =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(held)
            if (Option.isSome(current) && factory.serves(current.value.provider, provider)) {
              return current.value.control
            }
            const control = yield* factory.make(provider)
            yield* Ref.set(held, Option.some({ provider, control }))
            return control
          }),
        ),
    }
  }),
)
