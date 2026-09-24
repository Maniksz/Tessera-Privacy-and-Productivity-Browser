import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OverlaySurface } from './surfaces/OverlaySurface.js'
import { I18nProvider, requestCatalog } from './i18n.js'
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

/*
  Asked for now, rendered at once, and not awaited — the one renderer that must not wait.

  The overlay's view is created for its first presentation, and the core sends that presentation at
  `did-finish-load`, once, to whoever is subscribed. The subscription is an effect of the first render; a
  render held back behind a round trip would subscribe after the load had finished and the prompt had been
  sent into nothing. So the request goes out here, while the document is still loading, and the provider
  applies the answer when it lands: it reaches the core before the load can finish, so it is answered
  before the presentation is sent, and until a presentation arrives the surface draws nothing to translate.
*/
createRoot(container).render(
  <StrictMode>
    <I18nProvider initial={requestCatalog()}>
      <OverlaySurface />
    </I18nProvider>
  </StrictMode>
)
