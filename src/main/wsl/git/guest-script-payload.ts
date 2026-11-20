/**
 * Parsing helpers for the sentinel-delimited payloads guest scripts return.
 *
 * The scripts always exit 0 and fence their answers with a sentinel, so a
 * transport failure can never be mistaken for a verdict about the user's data.
 * These helpers are shared by every script parser so the fence has one rule.
 */

export function betweenSentinels(stdout: string, sentinel: string): string[] | null {
  const lines = stdout.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.trim() === sentinel)
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.trim() === sentinel)
  if (end === -1) return null
  return lines.slice(start + 1, end)
}

export function valueOf(lines: readonly string[], key: string): string | undefined {
  const prefix = `${key}=`
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length)
  }
  return undefined
}

export function betweenMarkers(
  lines: readonly string[],
  startMarker: string,
  endMarker: string
): string | null {
  const start = lines.findIndex((line) => line.trim() === startMarker)
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.trim() === endMarker)
  if (end === -1) return null
  return lines.slice(start + 1, end).join('\n').trim()
}
