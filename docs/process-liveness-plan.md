# Process-tree liveness: implementation plan

Implements the decision recorded under **Process-tree liveness** in `AGENTS.md`, which resolves
[#158](https://github.com/Underzenith85/symphony-ts/issues/158). That section is the record; this
file is the plan and is removed when the work lands.

Two implementations, no more: the exact cgroup v2 one and the `/proc` scan that ships today. The
`SIGSTOP` and netlink strategies are rejected in the record, and the port is not to be sized for
them.

## The seam

`processGroupIsAlive` in `src/support/subprocess.ts` is a query taking a pid. A cgroup cannot be
reached through that signature: it has to exist before the child is spawned and be joined before the
payload `exec`s, so an implementation behind `isAlive(pid)` would need a hidden pid-to-path map fed
by a side channel. The port therefore owns the supervised tree, and liveness is something a
supervised tree answers about itself.

Three spawn sites hand-roll `spawn(…, { detached: true })` today, and two of them re-implement the
same group-signalling and liveness logic:

| Site                                       | Spawns         | Liveness use                                    |
| ------------------------------------------ | -------------- | ----------------------------------------------- |
| `src/adapters/codex/codex.ts:276`          | `bash -lc`     | `#reapGroup` poll loop, `#processGroupIsAlive`  |
| `src/adapters/node/workspace-hooks.ts:109` | `bash -lc`     | `hookGroupIsAlive`, cancels forceful escalation |
| `src/adapters/node/source-control.ts:117`  | `git` directly | `terminateChildProcess`                         |

Centralising them is most of the work, and it is worth doing on its own: the escalation rules in
`workspace-hooks.ts` and `codex.ts` are near-duplicates that have to stay in step.

## Port sketch

`src/ports/process-supervisor.ts`. Imports only from `domain/` and `support/`, per the module import
direction.

```ts
import { Context, Effect, type Scope } from 'effect'

/** What a `dead` verdict from this implementation is worth. See the record in AGENTS.md. */
export type LivenessGuarantee =
  /** Exact: the kernel accounts for every descendant; no fork can fall between two reads. */
  | 'cgroup'
  /** Sound against reporting a dead tree alive; bounded residual in the other direction. */
  | 'proc'

export type SupervisedSpec = Readonly<{
  /** Names the tree in its cgroup path and in logs; not a security boundary. */
  label: string
  command: SpawnCommand
  cwd: string
  env: Readonly<Record<string, string>> | undefined
}>

export type SupervisedProcess = Readonly<{
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  /** Resolves with the leader's exit, which is not the same as the tree emptying. */
  readonly exit: Effect.Effect<ProcessExit>
  /** Whether the tree still holds a process that can run. */
  readonly isAlive: Effect.Effect<boolean>
  readonly signal: (signal: NodeJS.Signals) => Effect.Effect<void>
  /** `SIGTERM`, then `SIGKILL` after the grace period, returning once the tree has emptied. */
  readonly terminate: (gracePeriodMs: number) => Effect.Effect<void>
}>

export type ProcessSupervisorPort = Readonly<{
  readonly guarantee: LivenessGuarantee
  readonly supervise: (
    spec: SupervisedSpec,
  ) => Effect.Effect<SupervisedProcess, SubprocessError, Scope.Scope>
}>

export class ProcessSupervisor extends Context.Tag('symphony/ProcessSupervisor')<
  ProcessSupervisor,
  ProcessSupervisorPort
>() {}
```

`guarantee` is a property of the bound implementation, read once at startup — not a per-call flag
callers branch on. Nothing in `core/` or the adapters reads it; it exists so the startup log, the
operator surface and the conformance suites can state which contract is in force.

The `Scope` is load-bearing. The cgroup implementation creates the directory on acquisition and
removes it in the finalizer, after the tree is confirmed empty — a cgroup can only be removed when
it holds nothing. The `/proc` implementation acquires and releases nothing.

## The `proc` implementation

`src/adapters/node/process-supervisor-proc.ts`. It keeps `src/support/subprocess.ts` as its
mechanism unchanged, including the doc comment stating the residual, and adds nothing: `supervise`
spawns detached exactly as the sites do now, `isAlive` calls `processGroupIsAlive`, `terminate` calls
`terminateChildProcess`, and `guarantee` is `'proc'`.

This step must be behaviour-preserving. `test/support/subprocess.test.ts` stays as it is and keeps
passing against the support module directly.

## The `cgroup` implementation

`src/adapters/node/process-supervisor-cgroup.ts`.

**Root discovery.** Read `/proc/self/cgroup`, which under cgroup v2 is a single `0::<path>` line.
Inside a cgroup namespace that path is namespace-relative, so the supervised root is
`/sys/fs/cgroup` joined with it.

**Capability probe**, all four of which must pass or the implementation is not selectable:

1. `statfs('/sys/fs/cgroup')` reports `cgroup2fs`. A `tmpfs` result is a v1 or hybrid hierarchy.
2. The mount is read-write.
3. A child directory can be created under the root and removed again.
4. That child's `cgroup.events` reads `populated 0`.

**Per-tree cgroup.** `<root>/symphony.<label>.<n>/`, created before the spawn. No controller is
enabled in Symphony's own `cgroup.subtree_control`, which is what keeps this clear of the
controller-delegation problems that bite unprivileged containers, and keeps Symphony's own processes
clear of the no-internal-processes rule.

**Joining before `exec`.** Writing `child.pid` to `cgroup.procs` after `spawn` returns is a race:
migration moves one process, not a subtree, so a child that forks first leaks descendants outside
the cgroup. The move must happen in the child, before the payload runs. For the two shell sites that
is a wrapper that execs the real script, with no interpolation of the script into a larger string:

```ts
spawn('bash', ['-lc', 'echo $$ > "$1/cgroup.procs"; exec bash -lc "$2"', 'symphony', path, script])
```

`bash -lc COMMAND NAME ARG…` binds `$0` to `NAME`, so `$1` is the cgroup path and `$2` the original
script. The outer shell `exec`s, so no extra process survives the move.

**`source-control.ts` spawns `git` directly**, and the same wrapper would put a login shell in front
of every git invocation, which loads profile scripts that can rewrite `PATH` and git configuration.
Two acceptable answers, to settle when that site is migrated: wrap with `bash -c` rather than
`bash -lc` and accept one extra `exec`, or leave git on the `proc` implementation, since a git
process group is short-lived and does not fork anything that outlives it. Prefer the wrapper —
`terminateChildProcess` already depends on group liveness there — but do not use `-l`.

**Reading liveness** is one small read of `cgroup.events`, and `populated` accounts for descendants
rather than process-group membership, so a tree that has escaped its process group is still counted.

**Polling.** The kernel documents `cgroup.events` as supporting `poll` and inotify notification, so
the 25 ms `reapPollMs` cadence in `terminateChildProcess` and the `groupReapPollMs` loop in
`codex.ts:#reapGroup` may be replaceable with an `fs.watch` on the file. Verify that Node's inotify
watch actually fires on cgroupfs on the target kernel before relying on it; if it does not, keep the
existing cadence. The read is exact and far cheaper than a `/proc` sweep either way, so this is an
optimisation and not part of the guarantee.

**Cleanup.** `rmdir` in the scope finalizer once the tree is empty. Add a startup sweep that removes
`symphony.*` cgroups reporting `populated 0`, so a hard kill of the host does not leak directories
indefinitely.

## Selection

Configuration takes `auto`, `cgroup` or `proc`, defaulting to `auto`.

- `auto` runs the probe and binds `cgroup` when it passes, `proc` otherwise. Development hosts and
  macOS land on `proc`.
- `cgroup` runs the probe and **fails startup** when it does not pass. This is the point of making
  the mode pinnable: a unit that loses `Delegate=yes`, or a host that comes back on a hybrid
  hierarchy, must refuse to start rather than silently downgrade the guarantee.
- `proc` binds the fallback without probing.

The composition root binds one layer in `src/cli.ts`, logs the selected mode and its guarantee once
at startup, and exposes both through the operator surface.

## Conformance split

Both implementations owe one shared contract, and the cgroup one owes more. Following the
`SourceControlPort conformance` pattern in `test/conformance/`:

- `test/conformance/process-supervisor.conformance.test.ts` runs the shared suite against every
  selectable implementation on the host: a killed tree is eventually reported dead; a tree with a
  running descendant is never reported dead; unreaped zombies do not report alive; `terminate`
  returns only after the tree has emptied; a tree that outlives its leader is still terminated.
- `test/conformance/process-supervisor-cgroup.conformance.test.ts` pins the invariant only the
  cgroup implementation establishes: a supervised tree whose cgroup reports `populated 0` holds no
  process, member or descendant, that can run — including the fork-and-die case the `/proc` scan
  cannot close, driven directly rather than left to chance.

A host without delegation must **skip these with a stated reason** and record the skip in
`docs/conformance-matrix.md`. A silent pass is how a guarantee survives in the documentation after
it has stopped being tested.

CI gets both: the existing runners exercise `proc`, and a cgroup v2 Linux runner exercises `cgroup`
under `systemd-run --user --scope -p Delegate=yes`, which supplies the delegated subtree without any
elevated capability.

## Order of work

Each step is independently landable and leaves the tree green.

1. **Port and `proc` implementation.** Introduce `src/ports/process-supervisor.ts`, implement it
   over the existing `src/support/subprocess.ts`, migrate the three spawn sites and both liveness
   callers, bind it in `src/cli.ts`. No behaviour change; existing tests pass unchanged. This is the
   large step, because `codex.ts` and `workspace-hooks.ts` currently own their escalation timers.
2. **Shared conformance suite** against `proc`, plus its rows in `docs/conformance-matrix.md`.
3. **cgroup implementation and capability probe**, selectable only by explicit configuration.
4. **`auto` selection, fail-fast pinning, startup log and operator surface.**
5. **cgroup invariant suite and the CI job that runs it**, with skip rows in the matrix.
6. **Delete this file** and close #158 against the record in `AGENTS.md`.

Steps 1 and 2 are worth landing whether or not the cgroup implementation follows: they remove the
duplicated escalation logic and give the current behaviour a contract. Nothing before step 3 changes
what any host does.

## Out of scope

The `SIGSTOP`/`SIGCONT` freeze and the netlink proc connector, both rejected in the record. Resource
control — memory or CPU limits on agent trees — is a separate question that this port's cgroups make
possible but that no part of this plan implements; enabling a controller here would pull in exactly
the delegation problems the plan avoids.
