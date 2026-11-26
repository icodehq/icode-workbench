import { useCallback, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(`icode.composer.${key}`) ?? ''
  } catch {
    return ''
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value.length === 0) window.localStorage.removeItem(`icode.composer.${key}`)
    else window.localStorage.setItem(`icode.composer.${key}`, value)
  } catch {
    // A blocked storage area only costs the draft, never the message.
  }
}

/**
 * One chat's unsent text, kept across a tab close or reload. The value follows
 * the key, so switching conversations shows that conversation's own draft.
 */
export function usePersistentDraft(key: string): [
  string,
  (value: string) => void
] {
  const [state, setState] = useState(() => ({ key, value: readDraft(key) }))
  const value = state.key === key ? state.value : readDraft(key)
  const setDraft = useCallback(
    (next: string) => {
      setState({ key, value: next })
      writeDraft(key, next)
    },
    [key]
  )
  return [value, setDraft]
}

/** Grows a textarea to its content, up to a scrollable cap. */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight = 200
): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
  }, [maxHeight, ref, value])
}

/** Enter sends only when an IME is not composing; Shift+Enter is always a newline. */
export function isSendEnter(event: React.KeyboardEvent): boolean {
  const composing =
    event.nativeEvent.isComposing ||
    (event.nativeEvent as KeyboardEvent & { keyCode?: number }).keyCode === 229
  return event.key === 'Enter' && !event.shiftKey && !composing
}

export type ComposerAttachment = {
  id: string
  name: string
  path: string
  /** A small image preview for a chip; the agent still reads the path. */
  preview: string | null
}

function imagePreview(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/') || file.size > 10_000_000) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** Files the platform gave a real path; a file without one cannot reach the agent. */
export async function filesToAttachments(
  files: File[]
): Promise<ComposerAttachment[]> {
  const attachments: ComposerAttachment[] = []
  for (const file of files) {
    const path = window.icode.pathForFile(file)
    if (path.length === 0) continue
    attachments.push({
      id: globalThis.crypto.randomUUID(),
      name: file.name,
      path,
      preview: await imagePreview(file)
    })
  }
  return attachments
}

/** The message text an agent receives: the owner's words, then the attached paths. */
export function messageWithAttachments(
  text: string,
  attachments: readonly ComposerAttachment[]
): string {
  if (attachments.length === 0) return text
  const block = attachments.map((file) => `- ${file.path} (${file.name})`).join('\n')
  return `${text.trim()}\n\nAttached files:\n${block}`.trim()
}
