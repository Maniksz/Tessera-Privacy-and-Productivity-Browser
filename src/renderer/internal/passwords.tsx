import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PasswordsPage } from './PasswordsPage.js'
import './passwords.css'

const container = document.getElementById('passwords-root')
if (container === null) throw new Error('passwords page root element is missing')

createRoot(container).render(
  <StrictMode>
    <PasswordsPage />
  </StrictMode>
)
