import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPage } from './SettingsPage.js'
import './panel-page.css'

const container = document.getElementById('settings-root')
if (container === null) throw new Error('settings page root element is missing')

createRoot(container).render(
  <StrictMode>
    <SettingsPage />
  </StrictMode>
)
