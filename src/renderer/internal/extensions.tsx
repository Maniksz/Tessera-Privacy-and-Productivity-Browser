import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ExtensionsPage } from './ExtensionsPage.js'
import './panel-page.css'

const container = document.getElementById('extensions-root')
if (container === null) throw new Error('extensions page root element is missing')

createRoot(container).render(
  <StrictMode>
    <ExtensionsPage />
  </StrictMode>
)
