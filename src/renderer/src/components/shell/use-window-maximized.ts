import { useCallback, useEffect, useState } from 'react'

/**
 * Tracks the native window's maximized state and owns the maximize/restore
 * toggle. The hook lives outside the chrome component so a drag region can
 * trigger the same toggle as the title-bar button.
 */
export function useWindowMaximized(): [boolean, () => void] {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let disposed = false
    void window.icode.window.isMaximized().then((result) => {
      if (!disposed && result.ok) setMaximized(result.value)
    })
    const off = window.icode.window.onMaximizedChange((value) => {
      if (!disposed) setMaximized(value)
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  const toggleMaximize = useCallback((): void => {
    void window.icode.window.toggleMaximize().then((result) => {
      if (result.ok) setMaximized(result.value)
    })
  }, [])

  return [maximized, toggleMaximize]
}
