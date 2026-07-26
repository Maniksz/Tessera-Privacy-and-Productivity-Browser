import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BookmarksPage } from './BookmarksPage.js'
import './bookmarks.css'

const container = document.getElementById('bookmarks-root')
if (container === null) throw new Error('bookmarks page root element is missing')

createRoot(container).render(
  <StrictMode>
    <BookmarksPage />
  </StrictMode>
)
