/**
 * The one place a repository becomes a renderer payload.
 *
 * Both `repos.list` and `repos.add` return `RepositorySummary`, and they were
 * built by hand at each call site. They drifted: `add` sent `target` and `list`
 * did not, so the target survived the registration response and disappeared on
 * the next refresh. The renderer then had no persisted answer for "where does
 * this repository live" — and the schema said it always would.
 *
 * `target` is therefore spelled once, here, from the persisted row.
 */

import type { RepositorySummary } from '../../shared/schemas/ipc'
import type { RepositoryRecord } from '../../shared/domain/repository'

export function toRepositorySummary(repository: RepositoryRecord): RepositorySummary {
  return {
    id: repository.id,
    displayName: repository.displayName,
    path: repository.path,
    currentBranch: repository.currentBranch,
    availability: repository.availability,
    // Never omitted and never inferred from the path: a `/home/you/app` string
    // does not say whether it is this machine's or a distro's.
    target: repository.executionTarget,
    // Always present on the wire, like target: the renderer must distinguish
    // "no preparation needed" from "preparation is still running".
    preparation: repository.preparation ?? null
  }
}
