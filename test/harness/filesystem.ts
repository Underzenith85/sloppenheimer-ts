import type { FileSystem } from '@effect/platform'
import { NodeFileSystem } from '@effect/platform-node'
import type { Layer } from 'effect'

/**
 * The host filesystem, bound the way `src/cli.ts` binds it.
 *
 * Modules that read and write through `FileSystem` are exercised against the real one here, so a
 * test drives the same path the composition root does rather than a stub of its own.
 */
export const hostFileSystem: Layer.Layer<FileSystem.FileSystem> = NodeFileSystem.layer
