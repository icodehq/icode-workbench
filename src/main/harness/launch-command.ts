/**
 * Turns a launched harness plus its extra arguments into the final host command.
 *
 * Why this is not a one-liner at the call site: a guest Agent is not launched as
 * `claude --settings …`. It is launched as a *login shell* whose script `exec`s
 * the harness, because only a login shell puts a version-manager install on
 * `PATH` (see `wsl/harness/guest-harness.ts`). Its argv is therefore
 *
 *     ['-ilc', "exec '/home/…/claude'", '--settings', '/mnt/d/…/settings.json']
 *
 * and the shell consumes the trailing two as `$0` and `$1` — Claude Code never
 * receives them. Measured in Work 70: `argc=1`, `ARGV: /tmp/example.json`.
 *
 * A command that carries shell arguments must declare where extra arguments go.
 * `shellWrapper.scriptIndex` is that declaration: extra arguments are quoted into
 * the script so `exec` passes them to the harness itself. Plain commands keep
 * appending to argv, which is what the local target already did.
 */

/** POSIX single-quoting: the value is never parsed as shell syntax. */
export function quoteForPosixShell(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

function quoteWindowsArg(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

/**
 * The raw command line for a Windows `.cmd`/`.bat` shim.
 *
 * node-pty treats a string `args` value as a verbatim command line; building it
 * here keeps the same quoting the version probe already uses. The outer quotes
 * are part of `cmd /s /c`'s documented form.
 */
export function windowsShimCommandLine(shim: string, extraArgs: readonly string[] = []): string {
  const command = [shim, ...extraArgs].map(quoteWindowsArg).join(' ')
  return `/d /s /c "${command}"`
}

export type LaunchCommand = {
  command: string
  /** argv for ordinary spawns, or a raw command line for a Windows shim. */
  args: string[] | string
  /**
   * Present when `command` is a shell and the harness is exec'd from
   * `args[scriptIndex]`. Extra arguments then belong inside that script text.
   */
  shellWrapper?: { scriptIndex: number }
  /**
   * Present when `args` is a raw cmd.exe command line for this shim. Extra
   * arguments are quoted into that line instead of being appended as argv.
   */
  cmdShim?: { shim: string }
}

/**
 * Applies extra arguments to a launch command without changing its semantics.
 *
 * - No extra arguments: the command is returned untouched.
 * - A plain command: arguments are appended to argv (the local target).
 * - A shell wrapper: arguments are quoted into the exec script, because anything
 *   appended to argv would become the shell's `$0`/`$1`.
 */
export function withLaunchArgs<T extends LaunchCommand>(
  command: T,
  extraArgs: readonly string[]
): T {
  if (extraArgs.length === 0) return command

  const wrapper = command.shellWrapper
  if (wrapper === undefined) {
    if (command.cmdShim) {
      return { ...command, args: windowsShimCommandLine(command.cmdShim.shim, extraArgs) }
    }
    if (typeof command.args === 'string') {
      throw new Error('cannot append arguments to a raw command line without a shim declaration')
    }
    return { ...command, args: [...command.args, ...extraArgs] }
  }

  if (!Array.isArray(command.args)) {
    throw new Error('a shell wrapper requires an argv array')
  }
  const script = command.args[wrapper.scriptIndex]
  if (script === undefined) {
    throw new Error(
      `launch command declares a shell wrapper at index ${String(wrapper.scriptIndex)} but has no such argument`
    )
  }
  const quoted = extraArgs.map(quoteForPosixShell).join(' ')
  const args = [...command.args]
  args[wrapper.scriptIndex] = `${script} ${quoted}`
  return { ...command, args }
}
