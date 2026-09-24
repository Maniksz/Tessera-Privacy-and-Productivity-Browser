import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ReaderPage } from './ReaderPage.js'
import { primeInternalI18n } from './useInternalI18n.js'
import './reader.css'

const container = document.getElementById('reader-root')
if (container === null) throw new Error('reader page root element is missing')

// The page's language before its first render, so it never draws a frame in the wrong one; see
// `useInternalI18n.ts`.
void primeInternalI18n().then(() => {
  createRoot(container).render(
    <StrictMode>
      <ReaderPage />
    </StrictMode>
  )
})
