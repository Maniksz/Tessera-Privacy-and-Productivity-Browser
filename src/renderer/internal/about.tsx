import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AboutPage } from './AboutPage.js'
import './about.css'

const container = document.getElementById('about-root')
if (container === null) throw new Error('about page root element is missing')

createRoot(container).render(
  <StrictMode>
    <AboutPage />
  </StrictMode>
)
