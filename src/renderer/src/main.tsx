import React from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './assets/main.css'
import App from './App'
import { initTheme } from './theme/apply-theme'

// Before React renders: the stylesheet switches palette on the attribute this
// sets, so the first painted content already uses the resolved appearance.
initTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
