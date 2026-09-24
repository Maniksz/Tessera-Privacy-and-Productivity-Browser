import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { I18nProvider, requestCatalog } from './i18n.js'
import './styles.css'

/*
  Nothing may be dropped onto the chrome UI.

  A link or file dropped on a page is, by default, a navigation to it — and this document holds every
  IPC channel there is. Electron 43 already leaves `navigateOnDragDrop` off and the main process
  refuses every navigation of this view (`BrowserWindowController.#guardChrome`); this is the third
  layer, and the only one that also tells the user so: `dropEffect = 'none'` shows the "not allowed"
  cursor instead of promising a drop that then does nothing. Nothing in the chrome uses HTML drag and
  drop — tab dragging is pointer events (`useTabDrag.ts`) — so there is no drop target to spare.
*/
window.addEventListener('dragover', (event) => {
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none'
})
window.addEventListener('drop', (event) => {
  event.preventDefault()
})

const container = document.getElementById('root')
if (container === null) throw new Error('chrome UI root element is missing')

/*
  The language first, then the first render.

  Rendering at once and translating when the core answered meant one frame in English for every German
  user, since the answer lands after the first paint. Waiting is safe here and not in the overlay: nothing
  this document shows depends on an event it could miss in the meantime — `useBrowserState` asks the core
  for the window's state when it mounts rather than relying on the push at `did-finish-load`.
*/
void requestCatalog().then((initial) => {
  createRoot(container).render(
    <StrictMode>
      <I18nProvider initial={initial}>
        <App />
      </I18nProvider>
    </StrictMode>
  )
})
