import './assets/main.css'
import '@xterm/xterm/css/xterm.css'
import './lib/api'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initTheme } from './contexts/theme-context'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
