/** POSIX single-quoting: nothing in the word is interpreted by the shell. */
export function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
