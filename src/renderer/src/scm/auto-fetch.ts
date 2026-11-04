/**
 * Auto-fetch pacing.
 *
 * The interval is the user's configured seconds, clamped to the schema's
 * 30–3600 s range. Failures back off by doubling up to 8× so a broken remote
 * or offline machine does not retry every interval. A success resets the
 * failure count at the call site.
 */
export function autoFetchDelayMs(intervalSeconds: number, failures: number): number {
  const seconds = Math.min(3600, Math.max(30, Math.floor(intervalSeconds)))
  const factor = Math.min(8, 2 ** Math.max(0, Math.min(failures, 3)))
  return seconds * 1000 * factor
}
