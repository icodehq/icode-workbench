import React from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './assets/main.css'
import App from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Renderer root is missing')

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
