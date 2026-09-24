import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHROME_ASK_TTL_MS } from '@main/passwords/AutofillSuggest.js'
import { FILL_GESTURE_WINDOW_MS } from '@shared/passwords/consent.js'
import {
  AUTOFILL_BADGE_CHANNEL,
  AUTOFILL_CLOSE_CHANNEL,
  AUTOFILL_FILL_CHANNEL,
  AUTOFILL_SAVE_ANSWER_CHANNEL,
  AUTOFILL_SAVE_PROMPT_CHANNEL,
  AUTOFILL_SUBMIT_CHANNEL
} from '@shared/passwords/wire.js'
import {
  FIELD,
  LOGIN_URL,
  SECRET,
  STORED,
  formPayload,
  frame,
  wiredAutofill
} from './autofill-fakes.js'

/**
 * The guard against "wired and dead" (autofill R14, AE7): the chain from a reported form, through an
 * input event and a press, to an authorised fill, driven through the real wiring.
 *
 * `wireAutofillView`, `AutofillService` and `AutofillSuggest` are the production objects; only the
 * view, the overlay layer and the vault are fakes, and they raise events in the order Electron does.
 *
 * **Not one line here, or in `autofill-fakes.ts`, calls the service's input recorder.** That is the
 * property that would have caught the defect this file exists for: the listener that records the
 * gesture was attached only after an offer, and the offer was refused for want of the gesture, so
 * autofill could not fill anything and every test passed — because every test handed the service the
 * gesture itself. The last test below asserts the absence over both files' source, so the property
 * cannot quietly be given up by the next person who wants a shortcut.
 */

describe('a fill from the page, through the real wiring', () => {
  it('turns a reported form, an input event, a press and a choice into a filled credential', () => {
    // AE7. Every step is one the browser performs, in the order it performs them.
    const autofill = wiredAutofill()

    autofill.reportFillable()
    autofill.host.input()
    autofill.pressBadge()
    autofill.chooseFirst()

    const [token] = autofill.endings()
    expect(autofill.redeem(token)).toEqual({ username: STORED.username, password: SECRET })
  })

  it('authorises nothing on the same path without the input event', () => {
    // AE3: a page that focuses the field and clicks our badge itself dispatches nothing Electron reports.
    const autofill = wiredAutofill()

    autofill.reportFillable()
    autofill.pressBadge()

    expect(autofill.picker(), 'a surface for a press nobody made').toBeUndefined()
    expect(autofill.endings(), 'an answer to a press nobody made').toEqual([])
    expect(autofill.redeem('a-guessed-token')).toBeNull()
  })

  it('does not hear the press that focused the field, and hears the press on the badge', () => {
    // The press that moves focus into a field reaches the core before the page reports the field, so
    // nobody is listening for it yet. The badge is what makes that harmless: its own press comes after.
    const autofill = wiredAutofill()

    autofill.host.input()
    autofill.reportFillable()
    autofill.pressBadge()
    expect(autofill.picker(), 'the focusing press counted').toBeUndefined()

    autofill.host.input()
    autofill.pressBadge()
    expect(autofill.picker()?.content.state).toBe('entries')
  })

  it('asks the vault nothing when a page focuses a field (AE2)', () => {
    const autofill = wiredAutofill()

    autofill.reportFillable()

    expect(autofill.reads).toEqual({ lists: 0, secrets: 0 })
    expect(autofill.view.sent.map((message) => message.channel)).toEqual([AUTOFILL_BADGE_CHANNEL])
  })

  it('answers a press that has gone stale with nothing', () => {
    const autofill = wiredAutofill()
    autofill.reportFillable()
    autofill.host.input()

    autofill.clock.now += FILL_GESTURE_WINDOW_MS + 1
    autofill.pressBadge()

    expect(autofill.picker()).toBeUndefined()
  })

  it('redeems a token once', () => {
    const autofill = wiredAutofill()
    autofill.reportFillable()
    autofill.host.input()
    autofill.pressBadge()
    autofill.chooseFirst()
    const [token] = autofill.endings()

    expect(autofill.redeem(token)).not.toBeNull()
    expect(autofill.redeem(token), 'the same choice was spent twice').toBeNull()
  })
})

describe('every answer the badge can have', () => {
  it('raises the notice with Unlock on a locked vault, and the list after the unlock (AE1)', async () => {
    const autofill = wiredAutofill({ unlocked: false })
    autofill.reportFillable()
    autofill.host.input()

    autofill.pressBadge()
    expect(autofill.picker()?.content).toEqual({ state: 'locked' })
    expect(autofill.unlockRequests, 'the press raised the master-password prompt').toEqual([])

    autofill.pressUnlock()
    expect(autofill.unlockRequests).toHaveLength(1)
    await autofill.answerPrompt(true)

    // No second press on the badge: the Unlock button was the consent for the rest of the flow.
    expect(autofill.picker()?.content.state).toBe('entries')
    autofill.clock.now += FILL_GESTURE_WINDOW_MS * 10
    autofill.chooseFirst()
    const [token] = autofill.endings().filter((ending) => ending !== null)
    expect(autofill.redeem(token)).toEqual({ username: STORED.username, password: SECRET })
  })

  it('says nothing is saved on a site the vault has no entry for (AE2)', () => {
    const autofill = wiredAutofill({ summaries: [] })
    autofill.reportFillable()
    autofill.host.input()

    autofill.pressBadge()

    expect(autofill.picker()?.content).toEqual({ state: 'empty' })
  })

  it('names the unencrypted page rather than doing nothing (AE4)', () => {
    const autofill = wiredAutofill()
    const insecure = frame({
      url: 'http://example.com/login',
      topLevelUrl: 'http://example.com/login'
    })
    autofill.reportFillable()
    autofill.host.input()

    autofill.host.tell('tessera:autofill-press', { form: formPayload(), field: FIELD }, insecure)

    expect(autofill.picker()?.content).toEqual({ state: 'refused', reason: 'insecure-page' })
  })

  it('names the setting when autofill was switched off under the badge (AE9)', () => {
    const autofill = wiredAutofill()
    autofill.reportFillable()
    autofill.host.input()
    autofill.state.enabled = false

    autofill.pressBadge()

    expect(autofill.picker()?.content).toEqual({ state: 'disabled' })
  })

  it('closes on the page’s report of a scroll or a press beside it, and says so (AE6)', () => {
    const autofill = wiredAutofill()
    autofill.reportFillable()
    autofill.host.input()
    autofill.pressBadge()

    autofill.host.tell(AUTOFILL_CLOSE_CHANNEL, null)

    expect(autofill.picker()).toBeUndefined()
    expect(autofill.redeem('suggest-1'), 'the request outlived its list').toBeNull()
  })
})

describe('a fill asked for from browser chrome, through the same wiring', () => {
  const KEY = { x: 900, y: 40, width: 32, height: 32 }

  it('fills with no input event in the page at all (AE5)', () => {
    const autofill = wiredAutofill()

    autofill.askFromChrome(KEY)
    expect(autofill.askedToDescribe()).toBe(true)
    // The preload answers the question the way a badge press is reported.
    autofill.pressBadge()
    autofill.chooseFirst()

    const [token] = autofill.endings()
    expect(autofill.redeem(token)).toEqual({ username: STORED.username, password: SECRET })
  })

  it('hangs the list from the toolbar key rather than from the field', () => {
    const autofill = wiredAutofill()

    autofill.askFromChrome(KEY)
    autofill.pressBadge()

    const bounds = autofill.picker()?.bounds
    // Right-aligned under the key, at the top of the tile the key fills.
    expect(bounds?.x).toBe(KEY.x + KEY.width - 320)
    expect(bounds?.y).toBeLessThan(FIELD.rect.y)
  })

  it('still refuses a framed form and a foreign form action (AE5)', () => {
    const autofill = wiredAutofill()
    autofill.askFromChrome(KEY)
    autofill.pressBadge()
    autofill.chooseFirst()
    const [token] = autofill.endings()

    expect(autofill.redeem(token, frame({ isTopLevel: false }))).toBeNull()

    const again = wiredAutofill()
    again.askFromChrome(KEY)
    again.pressBadge()
    again.chooseFirst()
    const [second] = again.endings()
    expect(
      again.redeem(second, frame(), formPayload({ action: 'https://evil.example/x' }))
    ).toBeNull()
  })

  it('is spent by the fill it authorised (AE8)', () => {
    const autofill = wiredAutofill()
    autofill.askFromChrome(KEY)
    autofill.pressBadge()
    autofill.chooseFirst()
    const [token] = autofill.endings()
    autofill.redeem(token)

    // The page repeats the press it was asked for. Nothing asked for it this time.
    autofill.pressBadge()

    expect(autofill.picker()).toBeUndefined()
  })

  it('counts one answer to one question, and none after the question has gone stale', () => {
    const autofill = wiredAutofill()

    autofill.askFromChrome(KEY)
    autofill.clock.now += CHROME_ASK_TTL_MS + 1
    autofill.pressBadge()

    expect(autofill.picker(), 'a page kept the question open and answered later').toBeUndefined()
  })
})

describe('what the wiring listens to, and when', () => {
  it('hears nothing at all until a view reports a fillable form', () => {
    const autofill = wiredAutofill()

    autofill.host.input()

    expect(autofill.host.listening).toBe(false)
  })

  it('stops listening once the field is gone, and a press afterwards buys nothing', () => {
    const autofill = wiredAutofill()
    autofill.reportFillable(true)
    autofill.reportFillable(false)

    autofill.host.input()
    autofill.pressBadge()

    expect(autofill.host.listening).toBe(false)
    expect(autofill.picker()).toBeUndefined()
  })

  it('never listens while autofill is switched off', () => {
    const autofill = wiredAutofill({ enabled: false })

    autofill.reportFillable()

    expect(autofill.host.subscriptions).toBe(0)
  })

  it('subscribes once however often the page repeats the report', () => {
    const autofill = wiredAutofill()

    autofill.reportFillable()
    autofill.reportFillable()
    autofill.reportFillable()

    expect(autofill.host.subscriptions).toBe(1)
  })

  it('leaves the synchronous channel of another feature unanswered', () => {
    // Other features answer their own synchronous channels on the same view; a reply here would
    // set `undefined` as theirs.
    const autofill = wiredAutofill()

    expect(autofill.host.ask('tessera:cosmetic-rules', {})).toBeNull()
    expect(autofill.host.ask(AUTOFILL_FILL_CHANNEL, {})).toEqual({ answer: null })
  })

  it('does nothing with a message on a channel that belongs to another feature', () => {
    const autofill = wiredAutofill()

    autofill.host.tell('tessera:cosmetic-hit', { form: formPayload() })

    expect(autofill.view.sent).toEqual([])
    expect(autofill.host.listening).toBe(false)
  })

  it('carries a submission to the save bar and the answer back to the vault', () => {
    const autofill = wiredAutofill({ summaries: [] })

    autofill.host.tell(AUTOFILL_SUBMIT_CHANNEL, {
      form: formPayload(),
      username: 'bob',
      password: 'typed-just-now'
    })
    expect(autofill.view.sent.map((message) => message.channel)).toContain(
      AUTOFILL_SAVE_PROMPT_CHANNEL
    )

    autofill.host.tell(AUTOFILL_SAVE_ANSWER_CHANNEL, 'save')
    expect(autofill.writes).toEqual([
      {
        mode: 'normal',
        call: 'save',
        input: { url: LOGIN_URL, username: 'bob', password: 'typed-just-now' }
      }
    ])
  })

  it('raises the bar again on the page the sign-in landed on, and drops it off the site', () => {
    const autofill = wiredAutofill({ summaries: [] })
    autofill.host.tell(AUTOFILL_SUBMIT_CHANNEL, {
      form: formPayload(),
      username: 'bob',
      password: 'typed-just-now'
    })

    autofill.host.navigate('https://accounts.example.com/welcome')
    autofill.host.loaded('https://accounts.example.com/welcome')
    const prompts = (): number =>
      autofill.view.sent.filter((message) => message.channel === AUTOFILL_SAVE_PROMPT_CHANNEL)
        .length
    expect(prompts()).toBe(2)

    autofill.host.navigate('https://other.example/')
    expect(autofill.service.hasPendingSave(autofill.view.id)).toBe(false)
  })

  it('drops the open request when the main frame navigates', () => {
    const autofill = wiredAutofill()
    autofill.reportFillable()
    autofill.host.input()
    autofill.pressBadge()
    autofill.chooseFirst()
    const [token] = autofill.endings()

    autofill.host.navigate('https://accounts.example.com/next')

    expect(autofill.redeem(token), 'a choice outlived its document').toBeNull()
  })

  it('stops listening, closes the picker and releases the view when it is destroyed', () => {
    const autofill = wiredAutofill()
    autofill.reportFillable()
    autofill.host.input()
    autofill.pressBadge()

    autofill.host.destroy()

    expect(autofill.host.listening, 'the input subscription outlived the view').toBe(false)
    expect(autofill.picker(), 'the picker outlived its tab').toBeUndefined()
    expect(autofill.service.hasFillableFocus(autofill.view.id)).toBe(false)
  })
})

describe('the guard itself', () => {
  it('never hands the service a gesture, in this file or in its fakes', () => {
    // Built from pieces so that this assertion does not find itself.
    const recorder = ['note', 'Input'].join('')
    for (const file of [
      'tests/autofill-wiring.test.ts',
      'tests/autofill-fakes.ts',
      'tests/features/steps/passwords.steps.ts'
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source.includes(`.${recorder}(`), `${file} records a gesture by hand`).toBe(false)
    }
  })
})
