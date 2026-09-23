import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OverlaySurface } from './surfaces/OverlaySurface.js'
import { I18nProvider } from './i18n.js'
import './overlay.css'

/**
 * Entry point for the overlay layer — a second renderer in each window, sitting above the
 * tab views. See `src/main/browser/OverlayLayer.ts` for why a separate surface is the only
 * way browser UI can be drawn over page content.
 */

// Nothing may be dropped onto the overlay either, for the reasons given in `main.tsx`: a drop is a
// navigation by default, and this surface holds the same channels as the chrome UI.
window.addEventListener('dragover', (event) => {
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none'
})
window.addEventListener('drop', (event) => {
  event.preventDefault()
})

const container = document.getElementById('root')
if (container === null) throw new Error('overlay surface root element is missing')

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <OverlaySurface />
    </I18nProvider>
  </StrictMode>
)
