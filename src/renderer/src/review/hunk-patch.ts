import { translate } from '../i18n/i18n-store'
/**
 * Splits one file's unified patch into its preamble and individual hunks.
 *
 * The raw text is preserved exactly: a hunk patch is fed back to `git apply`,
 * so re-rendering it from parsed line models would risk changing whitespace,
 * CRLF content or the `\ No newline at end of file` marker. The index returned
 * here matches `parseUnifiedDiff`'s hunk order because both read `@@` headers
 * in the same order.
 */
export type SplitPatchHunks = {
  /** `diff --git`, index, mode and `---`/`+++` lines, ending before the first `@@`. */
  header: string
  hunks: string[]
}

export function splitPatchHunks(patch: string): SplitPatchHunks {
  if (patch.length === 0) return { header: '', hunks: [] }
  const lines = patch.split('\n')
  const starts: number[] = []
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('@@ ')) starts.push(index)
  }
  if (starts.length === 0) return { header: patch, hunks: [] }
  const header = lines.slice(0, starts[0]!).join('\n')
  const hunks = starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    return lines.slice(start, end).join('\n')
  })
  return { header, hunks }
}

/**
 * One hunk with the file preamble, ready for `git apply`.
 *
 * Returns null when the index is outside the patch; callers use that to disable
 * an action rather than sending an empty patch.
 */
export function hunkPatch(patch: string, hunkIndex: number): string | null {
  const split = splitPatchHunks(patch)
  const hunk = split.hunks[hunkIndex]
  if (hunk === undefined) return null
  const combined = split.header.length === 0 ? hunk : `${split.header}\n${hunk}`
  // `git apply` treats a bare final line as a corrupt patch.
  return combined.endsWith('\n') ? combined : `${combined}\n`
}

/** Stable key for one side of a changed line in a hunk. */
export function lineSelectionKey(side: 'old' | 'new', line: number): string {
  return `${side === 'old' ? 'o' : 'n'}:${String(line)}`
}

export type LinePatchDirection = 'forward' | 'reverse'
export type LinePatchResult = { status: 'ok'; patch: string } | { status: 'error'; error: string }

type ChangeLine = {
  text: string
  oldLine: number | null
  newLine: number | null
}

type ChangeBlock = {
  removals: ChangeLine[]
  additions: ChangeLine[]
}

/**
 * Builds a patch that applies only the selected changed lines of one hunk.
 *
 * `forward` is used for staging: the old side must match the index, so an
 * unselected removal becomes context and an unselected addition disappears.
 * `reverse` is used for unstaging/discarding: the new side must match the
 * current target, so an unselected addition becomes context and an unselected
 * removal disappears.
 *
 * Modified lines are paired by order inside a change block. Selecting either
 * side of a replacement selects the pair, so staging a replacement never leaves
 * a duplicate old line or unstaging it never turns a modification into a
 * separate deletion. Extra removals or additions remain independently
 * selectable.
 */
export function buildLinePatch(
  patch: string,
  hunkIndex: number,
  selected: ReadonlySet<string>,
  direction: LinePatchDirection
): LinePatchResult {
  if (selected.size === 0) return { status: 'error', error: translate('review.selectLine') }
  const split = splitPatchHunks(patch)
  const rawHunk = split.hunks[hunkIndex]
  if (rawHunk === undefined) {
    return { status: 'error', error: translate('review.hunkGone') }
  }
  const lines = rawHunk.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const header = lines[0] ?? ''
  const counts = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(header)
  if (counts === null) return { status: 'error', error: translate('review.hunkHeaderUnreadable') }
  let oldLine = Number.parseInt(counts[1]!, 10)
  let newLine = Number.parseInt(counts[2]!, 10)
  let matched = 0
  const output: string[] = [header]

  const isSelected = (side: 'old' | 'new', line: number | null): boolean =>
    line !== null && selected.has(lineSelectionKey(side, line))

  const emitBlock = (block: ChangeBlock): void => {
    const pairCount = Math.min(block.removals.length, block.additions.length)
    // Pairs must be emitted in place. Emitting all removals and then all
    // additions reorders the new side when a later pair is selected after an
    // earlier unselected one, which changes line order in the index.
    for (let index = 0; index < pairCount; index += 1) {
      const removal = block.removals[index]!
      const addition = block.additions[index]!
      const removalSelected = isSelected('old', removal.oldLine)
      const additionSelected = isSelected('new', addition.newLine)
      if (removalSelected) matched += 1
      if (additionSelected) matched += 1
      const chosen = removalSelected || additionSelected
      if (direction === 'forward') {
        if (chosen) {
          output.push(`-${removal.text}`)
          output.push(`+${addition.text}`)
        } else {
          // Keep the old line in the index; the new line is not staged.
          output.push(` ${removal.text}`)
        }
      } else if (chosen) {
        output.push(`-${removal.text}`)
        output.push(`+${addition.text}`)
      } else {
        // Keep the staged new line; the old line is not restored.
        output.push(` ${addition.text}`)
      }
    }
    for (const removal of block.removals.slice(pairCount)) {
      const chosen = isSelected('old', removal.oldLine)
      if (chosen) matched += 1
      if (direction === 'forward') output.push(`${chosen ? '-' : ' '}${removal.text}`)
      else if (chosen) output.push(`-${removal.text}`)
    }
    for (const addition of block.additions.slice(pairCount)) {
      const chosen = isSelected('new', addition.newLine)
      if (chosen) matched += 1
      if (direction === 'forward') {
        if (chosen) output.push(`+${addition.text}`)
      } else {
        output.push(`${chosen ? '+' : ' '}${addition.text}`)
      }
    }
  }

  let block: ChangeBlock | null = null
  const flush = (): void => {
    if (block !== null) emitBlock(block)
    block = null
  }

  for (const raw of lines.slice(1)) {
    const prefix = raw[0]
    if (prefix === '\\') {
      return {
        status: 'error',
        error: translate('review.noTrailingNewline')
      }
    }
    if (prefix === ' ') {
      flush()
      output.push(raw)
      oldLine += 1
      newLine += 1
      continue
    }
    if (prefix === '-') {
      block ??= { removals: [], additions: [] }
      block.removals.push({ text: raw.slice(1), oldLine, newLine: null })
      oldLine += 1
      continue
    }
    if (prefix === '+') {
      block ??= { removals: [], additions: [] }
      block.additions.push({ text: raw.slice(1), oldLine: null, newLine })
      newLine += 1
      continue
    }
    return { status: 'error', error: translate('review.hunkUnreadable') }
  }
  flush()
  if (matched === 0) {
    return { status: 'error', error: translate('review.selectLineInHunk') }
  }
  const hunk = output.join('\n')
  const combined = split.header.length === 0 ? hunk : `${split.header}\n${hunk}`
  return {
    status: 'ok',
    patch: combined.endsWith('\n') ? combined : `${combined}\n`
  }
}
