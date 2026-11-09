import React from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './assets/main.css'
import App from './App'
import { initTheme } from './theme/apply-theme'
import { initI18n } from './i18n/i18n-store'

// Before React renders: the stylesheet switches palette on the attribute this
// sets, so the first painted content already uses the resolved appearance.
initTheme()
// The window argument carries the locale resolved in main, so `lang` and the
// first render are correct before any IPC round-trip completes.
initI18n()

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
