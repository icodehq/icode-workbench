import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { buildWrappedLogicalLine, rangeForParsedLink } from './wrapped-line'
import { extractTerminalHttpLinks } from './url-extraction'

type UrlLinkProviderOptions = {
  term: Terminal
  activate: (event: MouseEvent, url: string) => void
  isDisposed: () => boolean
}

function rangeIntersectsRow(
  range: { start: { y: number }; end: { y: number } },
  bufferLineNumber: number
): boolean {
  return range.start.y <= bufferLineNumber && range.end.y >= bufferLineNumber
}

/**
 * URL links across soft-wrapped terminal rows.
 *
 * xterm calls this once per hovered buffer row. The logical line reconstructs
 * the wrapped chain, and the returned range is mapped back to 1-based cells.
 */
export function createUrlLinkProvider(options: UrlLinkProviderOptions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      if (options.isDisposed()) {
        callback(undefined)
        return
      }
      try {
        const buffer = options.term.buffer.active
        const logicalLine = buildWrappedLogicalLine(buffer, bufferLineNumber)
        if (logicalLine === null) {
          callback(undefined)
          return
        }
        const links: ILink[] = []
        for (const parsed of extractTerminalHttpLinks(logicalLine.text)) {
          const range = rangeForParsedLink(logicalLine, parsed.startIndex, parsed.endIndex)
          if (range === null || !rangeIntersectsRow(range, bufferLineNumber)) continue
          links.push({
            range,
            text: logicalLine.text.slice(parsed.startIndex, parsed.endIndex),
            activate: (event) => options.activate(event, parsed.url)
          })
        }
        callback(links.length > 0 ? links : undefined)
      } catch {
        // A link provider must never break xterm's render/hover path.
        callback(undefined)
      }
    }
  }
}
