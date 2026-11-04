import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { ViewName } from './use-app-navigation'

type UseGlobalShortcutsInput = {
  hasActiveSession: boolean
  hasQuickOpenSession: boolean
  focusableSessionId: string | null
  requestView: (view: ViewName) => void
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  setQuickOpenOpen: Dispatch<SetStateAction<boolean>>
  setTerminalFocus: Dispatch<SetStateAction<boolean>>
}

/**
 * Registers the application's global keyboard shortcuts.
 *
 * It coordinates existing navigation, overlay and shell-focus setters without
 * owning their state. F11 is a capture-phase terminal-focus shortcut; the
 * command chord map is a bubble-phase window listener.
 */
export function useGlobalShortcuts({
  hasActiveSession,
  hasQuickOpenSession,
  focusableSessionId,
  requestView,
  setPaletteOpen,
  setQuickOpenOpen,
  setTerminalFocus
}: UseGlobalShortcutsInput): void {
  const activeSessionRef = useRef(hasActiveSession)
  const quickOpenRef = useRef(hasQuickOpenSession)
  quickOpenRef.current = hasQuickOpenSession

  useEffect(() => {
    if (focusableSessionId === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F11') return
      // Capture before xterm: the terminal should not receive a function key
      // whose whole purpose here is to give the terminal more room.
      event.preventDefault()
      event.stopPropagation()
      setTerminalFocus((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [focusableSessionId])

  useEffect(() => {
    activeSessionRef.current = hasActiveSession
  }, [hasActiveSession])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Ctrl+K and Ctrl+P are line/history bindings inside a shell. Leave them
      // to xterm when the terminal owns focus; the palette remains one click
      // away in the command bar.
      const target = event.target
      if (target instanceof Element && target.closest('.xterm') !== null) return
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key.toLowerCase() === 'g' || event.key.toLowerCase() === 'e')
      ) {
        if (activeSessionRef.current) {
          event.preventDefault()
          setPaletteOpen(false)
          setQuickOpenOpen(false)
          requestView(event.key.toLowerCase() === 'g' ? 'changes' : 'files')
        }
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setQuickOpenOpen(false)
        setPaletteOpen((current) => !current)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p' && !event.shiftKey) {
        if (quickOpenRef.current) {
          event.preventDefault()
          setPaletteOpen(false)
          setQuickOpenOpen((current) => !current)
        }
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
        setQuickOpenOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [requestView])
}
