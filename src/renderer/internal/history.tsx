import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HistoryPage } from './HistoryPage.js'
import './history.css'

const container = document.getElementById('history-root')
if (container === null) throw new Error('history page root element is missing')

createRoot(container).render(
  <StrictMode>
    <HistoryPage />
  </StrictMode>
)
