import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HttpsOnlyPage } from './HttpsOnlyPage.js'
import { prepareBundledI18n } from './bundled-i18n.js'
import './https-only.css'

const container = document.getElementById('https-only-root')
if (container === null) throw new Error('https-only page root element is missing')

// The chosen language's chunk before the first render, so the page never draws a frame in another one;
// see `bundled-i18n.ts`.
void prepareBundledI18n().then(() => {
  createRoot(container).render(
    <StrictMode>
      <HttpsOnlyPage />
    </StrictMode>
  )
})
