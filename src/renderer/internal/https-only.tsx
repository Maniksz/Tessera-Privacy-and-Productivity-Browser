import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HttpsOnlyPage } from './HttpsOnlyPage.js'
import './https-only.css'

const container = document.getElementById('https-only-root')
if (container === null) throw new Error('https-only page root element is missing')

createRoot(container).render(
  <StrictMode>
    <HttpsOnlyPage />
  </StrictMode>
)
