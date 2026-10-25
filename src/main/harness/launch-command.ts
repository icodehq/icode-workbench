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

export type LaunchCommand = {
  command: string
  args: string[]
  /**
   * Present when `command` is a shell and the harness is exec'd from
   * `args[scriptIndex]`. Extra arguments then belong inside that script text.
   */
  shellWrapper?: { scriptIndex: number }
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
    return { ...command, args: [...command.args, ...extraArgs] }
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
