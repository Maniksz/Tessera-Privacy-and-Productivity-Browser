import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { I18nProvider } from './i18n.js'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('chrome UI root element is missing')

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
)
