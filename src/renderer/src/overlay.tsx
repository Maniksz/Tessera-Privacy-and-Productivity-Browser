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

const container = document.getElementById('root')
if (container === null) throw new Error('overlay surface root element is missing')

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <OverlaySurface />
    </I18nProvider>
  </StrictMode>
)
