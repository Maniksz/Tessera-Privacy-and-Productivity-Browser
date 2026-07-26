import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import {
  classifyOmniboxInput,
  resolveOmniboxInput,
  type OmniboxIntent,
  type SearchEngineId
} from '@shared/url/omnibox.js'
import { cleanUrl } from '@shared/url/tracking-params.js'
import { scope } from './world.js'

/**
 * Steps for `address-bar.feature`.
 *
 * Both the classification and the resolution are exercised, because they answer
 * different questions: whether the browser *thinks* something is an address, and
 * where it actually ends up going. A scenario that only checked the first would
 * pass while navigating somewhere wrong.
 */

interface OmniboxScratch {
  intent: OmniboxIntent
  resolved: string | null
  engine: SearchEngineId
  customUrl: string
}

function omnibox(state: unknown): OmniboxScratch {
  const current = scope(state)
  let existing = current.scratch['omnibox'] as OmniboxScratch | undefined
  if (existing === undefined) {
    existing = { intent: { kind: 'empty' }, resolved: null, engine: 'duckduckgo', customUrl: '' }
    current.scratch['omnibox'] = existing
  }
  return existing
}

// --- given -------------------------------------------------------------------

Given('the search engine is {string}', (state: unknown, engine: string) => {
  omnibox(state).engine = engine as SearchEngineId
})

Given('the search engine is custom with template {string}', (state: unknown, template: string) => {
  const current = omnibox(state)
  current.engine = 'custom'
  current.customUrl = template
})

// --- when --------------------------------------------------------------------

When('I type {string} into the address bar', (state: unknown, input: string) => {
  const current = omnibox(state)
  current.intent = classifyOmniboxInput(input)
  current.resolved = resolveOmniboxInput(input, {
    engine: current.engine,
    customUrl: current.customUrl
  })
})

When('the URL {string} is cleaned', (state: unknown, url: string) => {
  scope(state).scratch['cleaned'] = cleanUrl(url)
})

// --- then --------------------------------------------------------------------

Then('it is treated as an address', (state: unknown) => {
  expect(omnibox(state).intent.kind).toBe('url')
})

Then('it is treated as a search', (state: unknown) => {
  expect(omnibox(state).intent.kind).toBe('search')
})

Then('it navigates to {string}', (state: unknown, url: string) => {
  expect(omnibox(state).resolved).toBe(url)
})

Then('the search term is {string}', (state: unknown, term: string) => {
  const intent = omnibox(state).intent
  expect(intent.kind).toBe('search')
  if (intent.kind !== 'search') return
  expect(intent.query).toBe(term)
})

Then('nothing happens', (state: unknown) => {
  const current = omnibox(state)
  expect(current.intent.kind).toBe('empty')
  // `null` rather than an empty string, so the caller can leave the page alone.
  expect(current.resolved).toBeNull()
})

Then('the result is {string}', (state: unknown, expected: string) => {
  expect(scope(state).scratch['cleaned']).toBe(expected)
})
