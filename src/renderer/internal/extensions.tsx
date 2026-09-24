import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ExtensionsPage } from './ExtensionsPage.js'
import { primeInternalI18n } from './useInternalI18n.js'
import './panel-page.css'

const container = document.getElementById('extensions-root')
if (container === null) throw new Error('extensions page root element is missing')

// The page's language before its first render, so it never draws a frame in the wrong one; see
// `useInternalI18n.ts`.
void primeInternalI18n().then(() => {
  createRoot(container).render(
    <StrictMode>
      <ExtensionsPage />
    </StrictMode>
  )
})
