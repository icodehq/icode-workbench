import type { GitWorkspaceService } from './git-workspace-service'

/**
 * The internals a Git domain module needs.
 *
 * The service still owns deps, the operation queue and target resolution; a
 * domain module receives this context instead of duplicating that machinery.
 * Everything here is a read or a queue, never a second router.
 */
export type GitWorkspaceContext = Pick<
  GitWorkspaceService,
  'deps' | 'queue' | 'statusReads' | 'resolve' | 'readStatus' | 'readStatusSnapshot' | 'remoteNames' | 'withUpstream'
>
