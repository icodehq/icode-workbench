import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC_CHANNELS } from '../shared/schemas/ipc'
import type { ViewCommand } from '../shared/icode-api'

/**
 * View actions live in the native menu, not in the session header.
 *
 * The header is for the session itself (status, branch, view tabs, one Session
 * menu). Focus and Sessions-list visibility are application view state, so they
 * belong with Reload/Zoom in the View menu. The renderer owns that state; main
 * only forwards the command, keeping the menu stateless.
 *
 * The default View menu is not reused because it binds F11 to full screen. F11
 * is the terminal-focus shortcut, handled by the renderer before xterm.
 */
function sendViewCommand(command: ViewCommand): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(IPC_CHANNELS.viewCommand, command)
  }
}

export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: isMac
        ? [{ role: 'close' }]
        : [
            {
              label: 'Exit',
              click: (): void => app.quit()
            }
          ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          label: `Focus Terminal (${isMac ? 'Cmd' : 'Ctrl'}+J / F11)`,
          click: (): void => sendViewCommand('focus')
        },
        {
          label: 'Toggle Sessions List',
          click: (): void => sendViewCommand('sessions')
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
