import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StartPage } from './StartPage.js'
import './start.css'

const container = document.getElementById('start-root')
if (container === null) throw new Error('start page root element is missing')

createRoot(container).render(
  <StrictMode>
    <StartPage />
  </StrictMode>
)
