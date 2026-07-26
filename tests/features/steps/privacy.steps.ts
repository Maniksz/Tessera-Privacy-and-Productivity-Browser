import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { STAGE_ORDER, evaluateStages } from '@main/privacy/RequestPipeline.js'
import { filterResponseHeaders, findHeader, normalizeRequestHeaders } from '@main/session/headers.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import { scope } from './world.js'

/**
 * Steps for `privacy.feature`.
 *
 * These call the real pipeline and the real header transforms. That is the point:
 * spec 7 asks for a test proving each privacy setting changes actual traffic, not
 * that a switch moved — so the scenarios toggle a setting and then assert on the
 * request or the headers that would go out.
 */

// --- given -------------------------------------------------------------------

Given('default privacy settings', (state: unknown) => {
  scope(state).settings = { ...defaultSettings() }
})

Given('the current page is {string}', (state: unknown, url: string) => {
  scope(state).documentUrl = url
})

Given('the request carries the referrer {string}', (state: unknown, referrer: string) => {
  scope(state).referrer = referrer
})

// --- when --------------------------------------------------------------------

When('a {string} request is made to {string}', (state: unknown, resourceType: string, url: string) => {
  const target = scope(state)
  target.requestOutcome = evaluateStages({
    url,
    resourceType,
    documentUrl: target.documentUrl,
    method: 'GET',
    settings: target.settings
  })
})

When('headers are prepared for {string}', (state: unknown, url: string) => {
  const target = scope(state)
  const incoming: Record<string, string> = {
    'User-Agent': 'placeholder',
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="150.0.7871.129"'
  }
  if (target.referrer !== null) incoming['Referer'] = target.referrer
  target.requestHeaders = normalizeRequestHeaders(incoming, url, target.settings)
})

When('a response from {string} sets a cookie', (state: unknown, url: string) => {
  const target = scope(state)
  target.responseHeaders = filterResponseHeaders(
    { 'Set-Cookie': 'id=abc; Path=/', 'Content-Type': 'text/html' },
    { documentUrl: target.documentUrl, requestUrl: url },
    target.settings
  )
})

// --- then --------------------------------------------------------------------

Then('the filter stage order is {string}', (_state: unknown, expected: string) => {
  expect([...STAGE_ORDER].join(', ')).toBe(expected)
})

Then('the request is blocked by the {string} stage', (state: unknown, stage: string) => {
  const outcome = scope(state).requestOutcome
  expect(outcome, 'no request was evaluated').not.toBeNull()
  expect(outcome).toEqual({ action: 'block', reason: stage })
})

Then('the request is allowed', (state: unknown) => {
  expect(scope(state).requestOutcome?.action).toBe('continue')
})

Then('the request is redirected to {string}', (state: unknown, url: string) => {
  const outcome = scope(state).requestOutcome
  expect(outcome?.action, `expected a redirect, got ${outcome?.action}`).toBe('redirect')
  if (outcome?.action !== 'redirect') return
  expect(outcome.url).toBe(url)
})

Then('the request is redirected to an {string} page', (state: unknown, prefix: string) => {
  const outcome = scope(state).requestOutcome
  expect(outcome?.action).toBe('redirect')
  if (outcome?.action !== 'redirect') return
  // A real interstitial, not a silent switch to HTTPS (spec 4).
  expect(outcome.url.startsWith(prefix)).toBe(true)
})

Then('the header {string} is {string}', (state: unknown, name: string, value: string) => {
  const headers = scope(state).requestHeaders
  expect(headers, 'no headers were prepared').not.toBeNull()
  expect(findHeader(headers ?? {}, name)).toBe(value)
})

Then('the header {string} is absent', (state: unknown, name: string) => {
  const headers = scope(state).requestHeaders
  expect(headers, 'no headers were prepared').not.toBeNull()
  expect(findHeader(headers ?? {}, name)).toBeUndefined()
})

Then('the response has no cookie header', (state: unknown) => {
  expect(findHeader(scope(state).responseHeaders ?? {}, 'set-cookie')).toBeUndefined()
})

Then('the response still has its cookie header', (state: unknown) => {
  expect(findHeader(scope(state).responseHeaders ?? {}, 'set-cookie')).toBeDefined()
})
