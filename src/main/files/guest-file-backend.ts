import {
  FILES_MAX_ENTRIES_PER_DIRECTORY,
  FILES_MAX_FILE_BYTES,
  FILES_MAX_SEARCH_FILES,
  looksBinaryBytes,
  type FileEntry,
  type FileSearchResult
} from '../../shared/domain/workspace-files'
import type { WslCommandRunner } from '../wsl/exec'
import { FileAccessError, type FileBackend } from './local-file-backend'

/**
 * File access for a checkout that lives inside a distro.
 *
 * Paths are never interpolated into a shell script. Each script here is a
 * constant and the path arrives as a positional parameter (`sh -c SCRIPT sh
 * "$1"`), so a file name containing `$`, a backtick or a quote is data rather
 * than code. That is the same discipline the guest Git reader follows.
 *
 * Exit codes are part of the contract with the scripts below; `sh` reserves
 * 1 and 2 for its own errors, so the scripts use 3 and up.
 */

const LIST_SCRIPT = `
root=$1
rel=$2
cd "$root" 2>/dev/null || { echo "NOTFOUND"; exit 4; }
dir=\${rel:-.}
if [ ! -d "$dir" ]; then
  if [ -e "$dir" ]; then echo "NOTDIR"; exit 5; fi
  echo "NOTFOUND"; exit 4
fi
find "$dir" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\0' 2>/dev/null | head -c 4000000
exit 0
`

const READ_SCRIPT = `
root=$1
f=$2
cd "$root" 2>/dev/null || { echo "NOTFOUND"; exit 4; }
if [ -d "$f" ]; then echo "ISDIR"; exit 6; fi
if [ ! -e "$f" ]; then echo "NOTFOUND"; exit 4; fi
if [ ! -f "$f" ]; then echo "NOTFILE"; exit 7; fi
size=$(wc -c < "$f" 2>/dev/null || echo 0)
printf 'SIZE %s\\n' "$size"
head -c 2097152 -- "$f"
exit 0
`

const WRITE_SCRIPT = `
root=$1
f=$2
cd "$root" 2>/dev/null || { echo "NOTFOUND"; exit 4; }
if [ -d "$f" ]; then echo "ISDIR"; exit 6; fi
if [ -e "$f" ] && [ ! -f "$f" ]; then echo "NOTFILE"; exit 7; fi
# Stage then move, so a failed or empty write cannot truncate the real file.
tmp="$f.icode-write-$$"
cat > "$tmp" || { rm -f "$tmp"; echo "WRITEFAIL"; exit 8; }
mv -f "$tmp" "$f" || { rm -f "$tmp"; echo "WRITEFAIL"; exit 8; }
wc -c < "$f"
exit 0
`

const SEARCH_SCRIPT = `
root=$1
pattern=$2
limit=$3
maxfiles=$4
caseflag=$5
cd "$root" || { echo "NOTFOUND"; exit 4; }
args=""
if [ "$caseflag" = "0" ]; then args="-i"; fi
out=$(grep -rn $args --binary-files=without-match \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv \
  --exclude-dir=__pycache__ --exclude-dir=dist --exclude-dir=out \
  --exclude-dir=build --exclude-dir=.next --exclude-dir=.turbo --exclude-dir=target \
  --exclude='*.min.js' --exclude='*.map' \
  -- "$pattern" . 2>/dev/null | head -n "$limit")
files=$(printf '%s\\n' "$out" | sed 's/^\\.\\///' | cut -d: -f1 | sort -u | wc -l)
printf 'FILES %s\\n' "$files"
printf '%s' "$out"
exit 0
`

const CREATE_SCRIPT = `
root=$1
rel=$2
kind=$3
cd "$root" 2>/dev/null || { echo "NOTFOUND"; exit 4; }
if [ -e "$rel" ]; then echo "EXISTS"; exit 10; fi
parent=$(dirname -- "$rel")
if [ ! -d "$parent" ]; then echo "NOTFOUND"; exit 4; fi
if [ "$kind" = "directory" ]; then
  mkdir -- "$rel" || { echo "FAILED"; exit 8; }
else
  # noclobber-equivalent: set -C makes the redirect refuse an existing file.
  ( set -C; : > "$rel" ) 2>/dev/null || { echo "FAILED"; exit 8; }
fi
exit 0
`

const RENAME_SCRIPT = `
root=$1
from=$2
to=$3
cd "$root" 2>/dev/null || { echo "NOTFOUND"; exit 4; }
if [ ! -e "$from" ]; then echo "NOTFOUND"; exit 4; fi
if [ -e "$to" ]; then echo "EXISTS"; exit 10; fi
parent=$(dirname -- "$to")
if [ ! -d "$parent" ]; then echo "NOTFOUND"; exit 4; fi
mv -- "$from" "$to" || { echo "FAILED"; exit 8; }
exit 0
`

const REMOVE_SCRIPT = `
root=$1
rel=$2
cd "$root" 2>/dev/null || { echo "NOTFOUND"; exit 4; }
if [ ! -e "$rel" ]; then echo "NOTFOUND"; exit 4; fi
# Never allow the checkout itself to be the target.
case "$rel" in "."|""|"/") echo "FAILED"; exit 8;; esac
rm -rf -- "$rel" || { echo "FAILED"; exit 8; }
exit 0
`

function decode(buffer: Buffer): string {
  return buffer.toString('utf8')
}

/**
 * `worktreePath` is the guest directory every request is relative to.
 *
 * It is passed as the first positional argument and each script `cd`s into it,
 * because `wsl.exe --exec` starts in the *interop* working directory
 * (C:\\Windows\\System32). Without this the scripts read and write beside
 * System32 through /mnt/c — measured in Work 81, and the reason the file tree
 * listed Windows directories instead of the worktree.
 */
export function createGuestFileBackend(
  runner: WslCommandRunner,
  distro: string,
  worktreePath: string
): FileBackend {
  const run = async (
    script: string,
    args: string[],
    options: { stdin?: string; timeoutMs?: number } = {}
  ): Promise<{ stdout: Buffer; stderr: string; code: number | null }> => {
    const result = await runner.runBytes({
      scope: 'guest',
      distro,
      argv: ['sh', '-c', script, 'sh', ...args],
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      timeoutMs: options.timeoutMs ?? 20_000
    })
    if ('status' in result) {
      throw new FileAccessError('unreadable', 'The WSL distro could not be reached.')
    }
    return { stdout: result.stdout, stderr: decode(result.stderr).trim(), code: result.code }
  }

  return {
    async list(relative) {
      const result = await run(LIST_SCRIPT, [worktreePath, relative])
      const text = decode(result.stdout)
      if (result.code === 4) throw new FileAccessError('not-found', 'That directory does not exist in the distro.')
      if (result.code === 5) throw new FileAccessError('not-a-directory', 'That path is not a directory.')
      if (result.code !== 0) {
        throw new FileAccessError('unreadable', 'That directory could not be read inside the distro.')
      }
      const entries: FileEntry[] = []
      let truncated = false
      for (const record of text.split('\u0000')) {
        if (record === '') continue
        if (entries.length >= FILES_MAX_ENTRIES_PER_DIRECTORY) {
          truncated = true
          break
        }
        const firstTab = record.indexOf('\t')
        const secondTab = record.indexOf('\t', firstTab + 1)
        if (firstTab === -1 || secondTab === -1) continue
        const type = record.slice(0, firstTab)
        const size = Number.parseInt(record.slice(firstTab + 1, secondTab), 10)
        const name = record.slice(secondTab + 1)
        if (!name || name === '.' || name === '..') continue
        const path = relative === '' ? name : `${relative}/${name}`
        if (type === 'd') {
          entries.push({ name, path, kind: 'directory', size: null })
        } else if (type === 'f') {
          entries.push({ name, path, kind: 'file', size: Number.isFinite(size) ? size : null })
        }
      }
      entries.sort(
        (left, right) =>
          Number(right.kind === 'directory') - Number(left.kind === 'directory') ||
          left.name.localeCompare(right.name)
      )
      return { entries, truncated }
    },

    async read(relative) {
      const result = await run(READ_SCRIPT, [worktreePath, relative])
      if (result.code === 4) throw new FileAccessError('not-found', 'That file does not exist in the distro.')
      if (result.code === 6) throw new FileAccessError('not-a-file', 'That path is a directory in the distro.')
      if (result.code === 7) throw new FileAccessError('not-a-file', 'That path is not a regular file.')
      if (result.code !== 0) {
        throw new FileAccessError('unreadable', 'That file could not be read inside the distro.')
      }

      const newline = result.stdout.indexOf(0x0a)
      if (newline === -1) {
        throw new FileAccessError('unreadable', 'The distro returned no file header.')
      }
      const header = result.stdout.subarray(0, newline).toString('utf8')
      const size = Number.parseInt(header.replace('SIZE ', ''), 10)
      const body = result.stdout.subarray(newline + 1)
      const binary = looksBinaryBytes(body)
      if (Number.isFinite(size) && size > FILES_MAX_FILE_BYTES) {
        return {
          path: relative,
          text: '',
          size,
          binary: false,
          tooLarge: true,
          missingTrailingNewline: false
        }
      }
      return {
        path: relative,
        text: binary ? '' : body.toString('utf8'),
        size: Number.isFinite(size) ? size : body.length,
        binary,
        tooLarge: false,
        missingTrailingNewline: body.length > 0 && body[body.length - 1] !== 0x0a
      }
    },

    async write(relative, text) {
      // `runBytes` has no stdin channel, so a write through it would deliver an
      // empty payload and `cat >` would truncate the file. The string runner
      // carries stdin, which is what a write needs.
      const outcome = await runner.run({
        scope: 'guest',
        distro,
        argv: ['sh', '-c', WRITE_SCRIPT, 'sh', worktreePath, relative],
        stdin: text,
        timeoutMs: 30_000
      })
      if (outcome.status === 'wsl_missing') {
        throw new FileAccessError('write-failed', 'WSL is not available on this machine.')
      }
      if (outcome.status !== 'ok') {
        const code = outcome.status === 'exit_failure' ? outcome.code : null
        if (code === 6) throw new FileAccessError('not-a-file', 'That path is a directory in the distro.')
        if (code === 7) throw new FileAccessError('not-a-file', 'That path is not a regular file.')
        throw new FileAccessError('write-failed', 'That file could not be written inside the distro.')
      }
      const size = Number.parseInt(outcome.stdout.trim(), 10)
      return { size: Number.isFinite(size) ? size : Buffer.byteLength(text, 'utf8') }
    },

    async search(query, options) {
      const limit = Math.max(1, Math.min(options.limit, 500))
      const result = await run(
        SEARCH_SCRIPT,
        [worktreePath, query, String(limit), String(FILES_MAX_SEARCH_FILES), options.caseSensitive ? '1' : '0'],
        { timeoutMs: 45_000 }
      )
      const text = decode(result.stdout)
      if (result.code === 4) {
        throw new FileAccessError('not-found', 'The checkout is missing inside the distro.')
      }
      const newline = text.indexOf('\n')
      const header = newline === -1 ? text : text.slice(0, newline)
      const scannedFiles = Number.parseInt(header.replace('FILES ', ''), 10)
      const body = newline === -1 ? '' : text.slice(newline + 1)

      const matches: FileSearchResult['matches'] = []
      for (const line of body.split('\n')) {
        if (!line) continue
        const firstColon = line.indexOf(':')
        if (firstColon === -1) continue
        const secondColon = line.indexOf(':', firstColon + 1)
        if (secondColon === -1) continue
        const path = line.slice(0, firstColon).replace(/^\.\//u, '')
        const lineNumber = Number.parseInt(line.slice(firstColon + 1, secondColon), 10)
        if (!Number.isFinite(lineNumber)) continue
        const content = line.slice(secondColon + 1)
        const needle = options.caseSensitive ? query : query.toLowerCase()
        const haystack = options.caseSensitive ? content : content.toLowerCase()
        const column = haystack.indexOf(needle)
        matches.push({
          path,
          line: lineNumber,
          column: column === -1 ? 1 : column + 1,
          text: content.trimEnd().slice(0, 400)
        })
        if (matches.length >= limit) break
      }

      return {
        matches,
        truncated: matches.length >= limit || scannedFiles >= FILES_MAX_SEARCH_FILES,
        scannedFiles: Number.isFinite(scannedFiles) ? scannedFiles : matches.length
      }
    },

    async create(relative, kind) {
      const result = await run(CREATE_SCRIPT, [worktreePath, relative, kind])
      if (result.code === 4) throw new FileAccessError('not-found', 'The parent directory does not exist.')
      if (result.code === 10) throw new FileAccessError('already-exists', 'Something already exists at that path.')
      if (result.code !== 0) throw new FileAccessError('write-failed', 'That path could not be created.')
    },

    async rename(from, to) {
      const result = await run(RENAME_SCRIPT, [worktreePath, from, to])
      if (result.code === 4) throw new FileAccessError('not-found', 'That path does not exist.')
      if (result.code === 10) throw new FileAccessError('already-exists', 'Something already exists at the new path.')
      if (result.code !== 0) throw new FileAccessError('write-failed', 'That path could not be renamed.')
    },

    async remove(relative) {
      const result = await run(REMOVE_SCRIPT, [worktreePath, relative])
      if (result.code === 4) throw new FileAccessError('not-found', 'That path does not exist.')
      if (result.code !== 0) throw new FileAccessError('write-failed', 'That path could not be deleted.')
    }
  }
}
