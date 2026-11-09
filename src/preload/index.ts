import { contextBridge, ipcRenderer } from 'electron'
import { createIcodeApi } from './api'
import { readInitialLocale } from './initial-locale'

const api = createIcodeApi(
  (channel, input) => ipcRenderer.invoke(channel, input),
  (channel, listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  readInitialLocale(process.argv)
)

contextBridge.exposeInMainWorld('icode', api)
