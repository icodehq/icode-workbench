import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  extendParsed,
  parseText,
  type Block,
  type Inline,
  type ParsedText
} from '../lib/markdown-parser'

/** Streaming repaint interval: roughly 12 updates per second. */
const STREAM_THROTTLE_MS = 80

function RenderInlines({ inlines }: { inlines: Inline[] }): React.JSX.Element {
  return (
    <>
      {inlines.map((item, index) => {
        switch (item.kind) {
          case 'text':
            return <span key={index}>{item.value}</span>
          case 'bold':
            return (
              <strong key={index} className="font-semibold text-foreground">
                <RenderInlines inlines={item.children} />
              </strong>
            )
          case 'italic':
            return (
              <em key={index} className="italic">
                <RenderInlines inlines={item.children} />
              </em>
            )
          case 'code':
            return (
              <code
                key={index}
                className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground"
              >
                {item.value}
              </code>
            )
          case 'link':
            return (
              <a
                key={index}
                href={item.url}
                className="text-accent underline underline-offset-2 hover:opacity-80"
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  event.preventDefault()
                  void window.icode.window.openExternal({ url: item.url })
                }}
              >
                {item.text}
              </a>
            )
        }
      })}
    </>
  )
}

// Closed blocks keep their parsed object identity across streaming updates, so
// appending text re-renders only the open block.
const RenderBlock = memo(function RenderBlock({ block }: { block: Block }): React.JSX.Element {
  switch (block.kind) {
    case 'heading':
      if (block.level === 1) {
        return (
          <h1 className="mb-2 border-b border-border pb-1.5 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            {block.text}
          </h1>
        )
      }
      if (block.level === 2) {
        return (
          <h2 className="mt-3 mb-1.5 text-[13.5px] font-semibold text-foreground">
            {block.text}
          </h2>
        )
      }
      return (
        <h3 className="mt-2.5 mb-1 text-[13px] font-semibold text-foreground">{block.text}</h3>
      )
    case 'hr':
      return <hr className="my-2 border-border" />
    case 'paragraph':
      return (
        <p className="text-[12px] leading-relaxed text-foreground">
          <RenderInlines inlines={block.children} />
        </p>
      )
    case 'list':
      return block.ordered ? (
        <ol className="my-1 list-decimal space-y-0.5 pl-4 text-[12px] leading-relaxed text-foreground">
          {block.items.map((item, index) => (
            <li key={index}>
              <RenderInlines inlines={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="my-1 list-disc space-y-0.5 pl-4 text-[12px] leading-relaxed text-foreground">
          {block.items.map((item, index) => (
            <li key={index}>
              <RenderInlines inlines={item} />
            </li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <div className="my-2 max-w-full overflow-x-auto rounded border border-border">
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                {block.headers.map((header, index) => (
                  <th
                    key={index}
                    className="border-b border-border bg-muted/50 px-2 py-1 text-left font-semibold text-foreground"
                  >
                    <RenderInlines inlines={header} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="border-b border-border px-2 py-1 align-top text-foreground last:border-b-0"
                    >
                      <RenderInlines inlines={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'code':
      return (
        <pre className="my-2 max-w-full overflow-x-auto rounded-md bg-[#1e1e1e] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#d4d4d4]">
          <code>{block.text}</code>
        </pre>
      )
    case 'blockquote':
      return (
        <blockquote className="my-1.5 border-l-2 border-accent pl-3 text-[12px] italic text-muted-foreground">
          <RenderInlines inlines={block.children} />
        </blockquote>
      )
  }
})

function clearPending(timer: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timer.current !== null) {
    clearTimeout(timer.current)
    timer.current = null
  }
}

/**
 * Leading-edge throttle: the first characters show immediately, later updates
 * land at most once per STREAM_THROTTLE_MS. The trailing update uses the latest
 * text, so completion is never held back.
 */
function useThrottledText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text)
  const lastShownAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(text)

  useEffect(() => {
    latest.current = text
  }, [text])

  useEffect(() => {
    if (!streaming) {
      clearPending(timer)
      return
    }
    if (shown === text) return
    const wait = STREAM_THROTTLE_MS - (Date.now() - lastShownAt.current)
    if (wait <= 0) {
      lastShownAt.current = Date.now()
      setShown(text)
      return
    }
    if (timer.current !== null) return
    timer.current = setTimeout(() => {
      timer.current = null
      lastShownAt.current = Date.now()
      setShown(latest.current)
    }, wait)
  }, [text, streaming, shown])

  useEffect(() => () => clearPending(timer), [])

  return streaming ? shown : text
}

function useMarkdownBlocks(text: string, streaming: boolean): Block[] {
  const shown = useThrottledText(text, streaming)
  const previous = useRef<ParsedText | null>(null)
  return useMemo(() => {
    const prev = previous.current
    const parsed =
      streaming && prev !== null && shown.startsWith(prev.text)
        ? extendParsed(prev, shown)
        : parseText(shown)
    previous.current = parsed
    return parsed.blocks
  }, [shown, streaming])
}

export default function Markdown({
  text,
  streaming = false
}: {
  text: string
  streaming?: boolean
}): React.JSX.Element | null {
  const blocks = useMarkdownBlocks(text, streaming)
  if (blocks.length === 0) return null
  return (
    <div className="space-y-1.5" data-testid="markdown">
      {blocks.map((block, index) => (
        <RenderBlock key={index} block={block} />
      ))}
    </div>
  )
}
