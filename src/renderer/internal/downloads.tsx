import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DownloadsPage } from './DownloadsPage.js'
import './downloads.css'

const container = document.getElementById('downloads-root')
if (container === null) throw new Error('downloads page root element is missing')

createRoot(container).render(
  <StrictMode>
    <DownloadsPage />
  </StrictMode>
)
