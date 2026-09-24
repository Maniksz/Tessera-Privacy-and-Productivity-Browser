import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { SECRET, STORED, wiredAutofill } from '../../autofill-fakes.js'
import { scope } from './world.js'

/**
 * Steps for `passwords.feature`.
 *
 * The real wiring — `wireAutofillView`, `AutofillService`, `AutofillSuggest` — over the fakes in
 * `tests/autofill-fakes.ts`, which raise a view's events in Electron's order. Like the wiring guard
 * next door, no step hands the service a gesture: "I press the badge" is an input event dispatched
 * into the view followed by the preload's report of the press, which is all a real press is.
 */

type Autofill = ReturnType<typeof wiredAutofill>

/** Kept in `scratch`: the shape is this file's alone. */
const KEY = 'autofillWorld'

function world(state: unknown): { autofill: Autofill; unlocked: boolean } {
  const held = scope(state).scratch[KEY]
  if (held === undefined) throw new Error('this scenario has no sign-in page; add a Given for it')
  return held as { autofill: Autofill; unlocked: boolean }
}

function autofillOf(state: unknown): Autofill {
  return world(state).autofill
}

Given('a sign-in page with a password saved for it', (state: unknown) => {
  scope(state).scratch[KEY] = { autofill: wiredAutofill(), unlocked: true }
})

Given('the vault is locked', (state: unknown) => {
  const current = world(state)
  current.autofill = wiredAutofill({ unlocked: false })
})

When('I focus the password field', (state: unknown) => {
  autofillOf(state).reportFillable()
})

When('I press the badge', (state: unknown) => {
  const autofill = autofillOf(state)
  autofill.host.input()
  autofill.pressBadge()
})

When('the page clicks the badge itself', (state: unknown) => {
  // A synthesised click reaches the preload's handler, never Electron's input pipeline.
  autofillOf(state).pressBadge()
})

When('I press the toolbar key', (state: unknown) => {
  const autofill = autofillOf(state)
  autofill.askFromChrome({ x: 900, y: 40, width: 32, height: 32 })
  // The page answers the core's question the way a badge press is reported.
  autofill.pressBadge()
})

When('I choose the first account', (state: unknown) => {
  autofillOf(state).chooseFirst()
})

When('I press Unlock and enter the master password', async (state: unknown) => {
  const autofill = autofillOf(state)
  autofill.pressUnlock()
  await autofill.answerPrompt(true)
})

Then('the form is filled with the saved account', (state: unknown) => {
  const autofill = autofillOf(state)
  const token = autofill.endings().find((ending) => ending !== null)
  expect(autofill.redeem(token)).toEqual({ username: STORED.username, password: SECRET })
})

Then('no list appears', (state: unknown) => {
  expect(autofillOf(state).picker()).toBeUndefined()
})

Then('nothing can be filled', (state: unknown) => {
  const autofill = autofillOf(state)
  expect(autofill.endings()).toEqual([])
  expect(autofill.redeem('a-guessed-token')).toBeNull()
})

Then('the list says the vault is locked', (state: unknown) => {
  expect(autofillOf(state).picker()?.content).toEqual({ state: 'locked' })
})

Then('the list shows the saved account', (state: unknown) => {
  expect(autofillOf(state).picker()?.content).toEqual({
    state: 'entries',
    entries: [{ id: STORED.id, username: STORED.username }]
  })
})
