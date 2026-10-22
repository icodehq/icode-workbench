import { contextBridge, ipcRenderer } from 'electron'
import { createAdeApi } from './api'

const api = createAdeApi(
  (channel, input) => ipcRenderer.invoke(channel, input),
  (channel, listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
)

contextBridge.exposeInMainWorld('ade', api)
