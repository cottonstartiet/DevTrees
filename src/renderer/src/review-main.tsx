import './assets/main.css'
import './lib/api'

import * as React from 'react'
import { createRoot } from 'react-dom/client'

import { initTheme } from '@/contexts/theme-context'
import { ReviewApp } from '@/review-app'

initTheme()

const root = document.getElementById('root')

if (!root) throw new Error('Review renderer root element is missing.')

createRoot(root).render(
  <React.StrictMode>
    <ReviewApp search={window.location.search} />
  </React.StrictMode>
)
