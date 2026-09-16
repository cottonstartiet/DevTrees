import '@/assets/main.css'
import './remote.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initTheme } from '@/contexts/theme-context'
import { RemoteApp } from './remote-app'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RemoteApp />
  </StrictMode>
)
