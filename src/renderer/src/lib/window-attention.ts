import { useEffect, useState } from 'react'

type AttentionDocument = Pick<Document, 'visibilityState' | 'hasFocus'>

/**
 * Whether the user can actually see and act on this window. iCode has no
 * presence service, so a focused, visible window is the read signal for an
 * on-screen room; a background window or a hidden document is not.
 */
export function windowIsAttended(doc: AttentionDocument = document): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus()
}

export function useWindowAttention(): boolean {
  const [attended, setAttended] = useState<boolean>(() => windowIsAttended())

  useEffect(() => {
    const update = (): void => setAttended(windowIsAttended())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    update()
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  return attended
}
