import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReaderPage } from './ReaderPage.js'
import './reader.css'

const container = document.getElementById('reader-root')
if (container === null) throw new Error('reader page root element is missing')

createRoot(container).render(
  <StrictMode>
    <ReaderPage />
  </StrictMode>
)
