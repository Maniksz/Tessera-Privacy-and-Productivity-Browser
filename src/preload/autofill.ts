import { ipcRenderer } from 'electron'
import { chooseFillTargets, chooseSaveTargets, type FieldDescriptor, type FormDescriptor } from '@shared/passwords/fields.js'
import {
  AUTOFILL_FILL_CHANNEL,
  AUTOFILL_OFFER_CHANNEL,
  AUTOFILL_SAVE_ANSWER_CHANNEL,
  AUTOFILL_SAVE_PROMPT_CHANNEL,
  AUTOFILL_SUBMIT_CHANNEL,
  asFillAnswer,
  asFillOffer,
  asSaveBarChrome,
  type FillOffer,
  type SaveAnswer,
  type SaveBarChrome
} from '@shared/passwords/wire.js'

/**
 * Autofill, inside the page.
 *
 * ## Why any of this is here rather than in the core
 *
 * The core owns every decision — `AutofillService` and `shared/passwords/fill-policy.ts` — and this
 * file owns the two things that can only happen in a renderer: reading the shape of a form out of a
 * live document, and putting a value into an input. Nothing here decides anything; it describes,
 * asks, and obeys.
 *
 * ## Why a page cannot use it
 *
 * Nothing is exposed on `window`. A visited page has no bridge (spec 6) and this does not become
 * one: there is no function a page can call, no property it can read, and no event it can fire that
 * produces a credential. The three things that could look like a way in, and why they are not:
 *
 *   - **The suggestion list is a closed shadow root.** The page's scripts cannot read the usernames
 *     in it, and its own CSS cannot move or hide it. A site with `* { position: static !important }`
 *     would otherwise be able to place our list somewhere the user did not expect.
 *   - **A page can focus a field whenever it likes**, so a suggestion list appearing is not consent
 *     to anything. Nothing is filled until a trusted click lands on one of our own entries, and the
 *     core independently refuses a fill it did not see a real input event for — see
 *     `shared/passwords/gesture.ts`. A hidden form therefore harvests nothing.
 *   - **The save bar carries no secret.** It is drawn from wording the core sent, and the answer
 *     that goes back is one of three verbs. The credential it is about never leaves the core.
 *
 * ## Why reading the DOM from here is trustworthy, and where that ends
 *
 * Context isolation gives this file its own JavaScript world with its own prototypes, so a page that
 * redefines `HTMLFormElement.prototype.action` or `HTMLInputElement.prototype.value` changes nothing
 * about what is read here — those getters live in the page's world. What a page *can* still do is
 * change the actual DOM: rewrite the form's action after a fill, or move the fields. The core's
 * checks are therefore fill-time checks, which is stated plainly in `fill-policy.ts` rather than
 * left to be discovered.
 */

/** One element per document, replaced rather than appended. Same reasoning as the cosmetic sheet. */
const SUGGESTION_HOST_ID = 'tessera-autofill'
const SAVE_HOST_ID = 'tessera-autofill-save'

/** Below this, a control is decoration or a tracking pixel rather than something to type into. */
const MIN_FIELD_SIZE_PX = 4

/**
 * The document as it actually is at `document-start`, rather than as the DOM types describe it.
 *
 * `lib.dom` declares `body` and `documentElement` non-nullable, and for code a web developer writes
 * that is true. A preload runs earlier: both can be null, so the type is simply wrong for this
 * timing, and the linter's suggestion to drop the checks would crash the preload and take the page
 * with it. Same shape as `cosmetic.ts` and `picker.ts`.
 */
// `Omit` and not an intersection: `HTMLElement & (HTMLElement | null)` is still `HTMLElement`, so an
// intersection narrows where this has to widen.
const earlyDocument = document as Omit<Document, 'body' | 'documentElement'> & {
  body: HTMLElement | null
  documentElement: HTMLElement | null
}

// --- describing a form -------------------------------------------------------

/**
 * Whether a control is one the user could actually type into.
 *
 * A heuristic, and its limit is worth stating: a field positioned at `left: -9999px` has a real size
 * and passes. That is deliberate rather than overlooked — the same trick is how several accessible
 * form patterns hide a label's input, and a stricter rule would break real sign-in pages. What
 * closes the hidden-form attack is not this function but the gesture requirement in the core: an
 * off-screen field cannot receive a click the user did not make.
 */
function isFieldVisible(field: HTMLInputElement): boolean {
  if (field.type === 'hidden') return false
  const rect = field.getBoundingClientRect()
  if (rect.width < MIN_FIELD_SIZE_PX || rect.height < MIN_FIELD_SIZE_PX) return false
  try {
    // `display: none` already yields a zero rect; this catches `visibility: hidden`, which does not.
    return getComputedStyle(field).visibility !== 'hidden'
  } catch {
    // A field detached between the rect read and this call. Not visible, and not an error.
    return false
  }
}

function describeField(field: HTMLInputElement, index: number): FieldDescriptor {
  return {
    index,
    // `field.type` rather than the attribute: the browser resolves an unknown type to `text`, and
    // the roles in `fields.ts` are about what the control *is*, not what the markup claims.
    type: field.type.toLowerCase(),
    name: field.name,
    id: field.id,
    autocomplete: field.getAttribute('autocomplete')?.toLowerCase() ?? '',
    visible: isFieldVisible(field),
    editable: !field.disabled && !field.readOnly,
    // Whether, never what. The value crosses only on a submission the user performed.
    hasValue: field.value !== ''
  }
}

/**
 * The controls belonging to one form, and a description of them.
 *
 * Scoped to the focused field's own `<form>` when it has one, and to the whole document when it does
 * not — a login "form" built out of loose inputs and a `<div>` that calls `fetch` is common enough
 * that ignoring it would mean ignoring a good share of real sign-in pages.
 *
 * The elements are kept alongside the descriptor so a chosen index can be turned back into an
 * element. Nothing durable is derived from the DOM here: this pair is valid for exactly the one
 * round trip that produced it, which is why `fields.ts` uses an index rather than a selector.
 */
function describeForm(anchor: HTMLInputElement): {
  descriptor: FormDescriptor
  elements: HTMLInputElement[]
} | null {
  const form = anchor.form
  const scope: ParentNode = form ?? document
  let elements: HTMLInputElement[]
  try {
    elements = [...scope.querySelectorAll('input')]
  } catch {
    // A document torn down mid-read. Nothing to describe.
    return null
  }
  if (elements.length === 0) return null

  return {
    // The *attribute*, unresolved. `form.action` would already have been resolved against the
    // document, and how a relative, a protocol-relative and an absolute action each resolve is
    // exactly what the core's cross-origin-action rule is tested on.
    descriptor: {
      action: form === null ? null : form.getAttribute('action'),
      fields: elements.map(describeField)
    },
    elements
  }
}

// --- the shadow-root surfaces ------------------------------------------------

interface Surface {
  readonly root: ShadowRoot
  readonly host: HTMLElement
  remove(): void
}

/**
 * A host element with a closed shadow root, positioned by inline declarations.
 *
 * Inline and `!important`, which is not superstition: the stylesheet the core sends sets
 * `all: initial` on `:host` to undo whatever the page inherits into it, and that includes
 * `position`. Inline important declarations outrank both, so the surface lands where it was put
 * however the page is styled.
 */
function createSurface(id: string, styles: string): Surface | null {
  const parent = earlyDocument.body ?? earlyDocument.documentElement
  if (parent === null) return null
  removeSurface(id)

  const host = document.createElement('div')
  host.id = id
  host.style.setProperty('position', 'fixed', 'important')
  host.style.setProperty('z-index', '2147483647', 'important')
  // `closed`, so the page's scripts cannot read the usernames on offer — which would tell a site
  // which accounts the person has with it before they had chosen to say.
  const root = host.attachShadow({ mode: 'closed' })
  const sheet = document.createElement('style')
  sheet.textContent = styles
  root.appendChild(sheet)
  parent.appendChild(host)

  return { root, host, remove: () => host.remove() }
}

function removeSurface(id: string): void {
  document.getElementById(id)?.remove()
}

function button(className: string, label: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  return element
}

// --- the suggestion list -----------------------------------------------------

/** What is on screen, so dismissing can undo exactly what was installed. */
let suggestion: { surface: Surface; teardown: () => void } | null = null

function hideSuggestion(): void {
  if (suggestion === null) return
  suggestion.teardown()
  suggestion.surface.remove()
  suggestion = null
}

/**
 * Puts the suggestion list under a field.
 *
 * Anchored to the field's own rectangle rather than to the pointer, because the list is about that
 * field: a list floating at the cursor would leave the user guessing which of two password boxes it
 * would fill.
 */
function showSuggestion(anchor: HTMLInputElement, offer: FillOffer, fill: (id: string) => void): void {
  hideSuggestion()
  const surface = createSurface(SUGGESTION_HOST_ID, offer.chrome.styles)
  if (surface === null) return

  const rect = anchor.getBoundingClientRect()
  surface.host.style.setProperty('left', `${String(Math.round(rect.left))}px`, 'important')
  surface.host.style.setProperty('top', `${String(Math.round(rect.bottom + 4))}px`, 'important')

  const panel = document.createElement('div')
  panel.className = 'panel'
  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = offer.chrome.title
  panel.appendChild(title)

  for (const entry of offer.entries) {
    const item = button('entry', entry.username === '' ? offer.chrome.noUsernameLabel : entry.username)
    item.addEventListener('click', () => {
      // Hidden before the fill, so a fill that throws cannot leave a list hanging over the page.
      hideSuggestion()
      fill(entry.id)
    })
    panel.appendChild(item)
  }
  surface.root.appendChild(panel)

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') hideSuggestion()
  }
  // Dismissed on scroll and resize rather than repositioned: the anchor rectangle is read once, and
  // a list that stayed put while the page moved underneath it would be pointing at nothing.
  const onScroll = (): void => hideSuggestion()
  const options = { capture: true } as const
  window.addEventListener('keydown', onKeyDown, options)
  window.addEventListener('scroll', onScroll, options)
  window.addEventListener('resize', onScroll)

  suggestion = {
    surface,
    teardown: () => {
      window.removeEventListener('keydown', onKeyDown, options)
      window.removeEventListener('scroll', onScroll, options)
      window.removeEventListener('resize', onScroll)
    }
  }
}

// --- filling -----------------------------------------------------------------

/**
 * Writes a value and tells the page about it.
 *
 * `element.value = value` is enough, and the usual React workaround — reaching for the native setter
 * through `Object.getOwnPropertyDescriptor` — is not needed here: this code runs in an isolated
 * world, so any setter the page installed on its own `HTMLInputElement.prototype` is not on the path
 * this assignment takes. What *is* needed is the two events, because a framework only learns about a
 * value it did not set from them. Without them the field looks filled and the application's own
 * state does not know it.
 */
function setFieldValue(element: HTMLInputElement, value: string): void {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

// --- the save bar ------------------------------------------------------------

let saveBar: Surface | null = null

function hideSaveBar(): void {
  saveBar?.remove()
  saveBar = null
}

function answerSave(answer: SaveAnswer): void {
  hideSaveBar()
  try {
    ipcRenderer.send(AUTOFILL_SAVE_ANSWER_CHANNEL, answer)
  } catch {
    // Only the core can store anything, so there is nothing to do here but let the bar go.
  }
}

/**
 * Draws the "save this password?" bar.
 *
 * Top-right rather than over the form, because the form is what the user was just looking at and a
 * bar covering it would hide the thing being asked about. It stays until it is answered: an offer
 * that vanished on its own would train people to ignore it, and the core drops the credential by
 * itself after two minutes whether or not anybody presses anything.
 */
function showSaveBar(chrome: SaveBarChrome): void {
  const surface = createSurface(SAVE_HOST_ID, chrome.styles)
  if (surface === null) return
  saveBar = surface
  surface.host.style.setProperty('top', '16px', 'important')
  surface.host.style.setProperty('right', '16px', 'important')

  const panel = document.createElement('div')
  panel.className = 'panel'
  const message = document.createElement('div')
  message.className = 'message'
  message.textContent = chrome.message
  panel.appendChild(message)

  if (chrome.username !== '') {
    const who = document.createElement('div')
    who.className = 'who'
    who.textContent = chrome.username
    panel.appendChild(who)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'
  const save = button('action primary', chrome.saveLabel)
  save.addEventListener('click', () => answerSave('save'))
  const never = button('action', chrome.neverLabel)
  never.addEventListener('click', () => answerSave('never'))
  const dismiss = button('action', chrome.dismissLabel)
  dismiss.addEventListener('click', () => answerSave('dismiss'))
  actions.append(save, never, dismiss)
  panel.appendChild(actions)
  surface.root.appendChild(panel)
}

// --- wiring ------------------------------------------------------------------

function requestOffer(descriptor: FormDescriptor): FillOffer | null {
  try {
    /*
      Synchronous, like the cosmetic and picker channels, and for a plainer reason than theirs: this
      runs when a field takes focus, so there is exactly one round trip per focus and the answer has
      to be in hand before the list can be drawn at all. The core answers from an in-memory vault.
    */
    return asFillOffer(ipcRenderer.sendSync(AUTOFILL_OFFER_CHANNEL, descriptor))
  } catch {
    // No responder — an old build, or a view created outside a hardened session. Offering nothing
    // is the only safe reading; there is nothing here to guess at.
    return null
  }
}

/**
 * Asks for one credential and puts it in the fields.
 *
 * The form is described again rather than reused from the offer, so the core decides against the
 * document as it is at the moment of the click. The targets are chosen again for the same reason.
 */
function performFill(anchor: HTMLInputElement, id: string): void {
  const described = describeForm(anchor)
  if (described === null) return
  const targets = chooseFillTargets(described.descriptor)
  if (targets === null) return

  let answer: unknown
  try {
    answer = ipcRenderer.sendSync(AUTOFILL_FILL_CHANNEL, { id, form: described.descriptor })
  } catch {
    return
  }
  const credential = asFillAnswer(answer)
  if (credential === null) return

  const [password] = described.elements.slice(targets.password.index, targets.password.index + 1)
  if (password === undefined) return
  setFieldValue(password, credential.password)

  if (targets.username !== null && credential.username !== '') {
    const [username] = described.elements.slice(
      targets.username.index,
      targets.username.index + 1
    )
    if (username !== undefined) setFieldValue(username, credential.username)
  }
}

/**
 * A field took focus. Offers what may be filled into it.
 *
 * Only for a field the user could see and type into, and only for a form that has a password in it.
 * A page can cause focus at will, so this being reachable is not a privilege — the core refuses an
 * offer it saw no real input event for, and nothing is filled without a click on one of our own
 * entries.
 */
function onFocusIn(event: FocusEvent): void {
  const target = event.target
  hideSuggestion()
  if (!(target instanceof HTMLInputElement)) return
  if (!isFieldVisible(target)) return

  const described = describeForm(target)
  if (described === null) return
  const targets = chooseFillTargets(described.descriptor)
  if (targets === null) return
  // The focused field has to be one of the two a fill would write to. Offering while the caret is
  // in an unrelated box would put a list of the user's accounts on screen for no reason.
  if (target !== described.elements[targets.password.index] &&
      (targets.username === null || target !== described.elements[targets.username.index])) {
    return
  }

  const offer = requestOffer(described.descriptor)
  if (offer === null) return
  showSuggestion(target, offer, (id) => performFill(target, id))
}

/**
 * A form was submitted. Reports what was in it so the core can decide whether to ask about saving.
 *
 * This is the one message from this file that carries a password, and it carries one the page
 * already has — the user typed it there. What the report buys is that the *core* gets to decide
 * whether it may be kept, which is where the private-window rule and the "never here" list live.
 *
 * Its limit, named rather than left to be found: a sign-in performed by `fetch` without a `submit`
 * event is not seen, so single-page applications are not offered a save. The passwords page can add
 * the entry by hand, and closing this properly needs a heuristic about disappearing password fields
 * that is worth building on its own rather than smuggling in here.
 */
function onSubmit(event: SubmitEvent): void {
  hideSuggestion()
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return

  let elements: HTMLInputElement[]
  try {
    elements = [...form.querySelectorAll('input')]
  } catch {
    return
  }
  const descriptor: FormDescriptor = {
    action: form.getAttribute('action'),
    fields: elements.map(describeField)
  }
  const targets = chooseSaveTargets(descriptor)
  if (targets === null) return

  const [password] = elements.slice(targets.password.index, targets.password.index + 1)
  if (password === undefined || password.value === '') return
  const [usernameField] =
    targets.username === null
      ? []
      : elements.slice(targets.username.index, targets.username.index + 1)

  try {
    ipcRenderer.send(AUTOFILL_SUBMIT_CHANNEL, {
      form: descriptor,
      username: usernameField?.value ?? '',
      password: password.value
    })
  } catch {
    // Nothing to do: the core is the only thing that can store a credential.
  }
}

/**
 * Installs autofill. Called from the content preload only, for visited pages.
 *
 * Guarded as a whole as well as in parts, like the cosmetic filtering: a failure here must cost the
 * page its autofill and nothing else. A preload that throws takes the document with it.
 *
 * Capture phase throughout, so a page that stops propagation in its own handlers cannot take these
 * events away — a login form that swallowed `submit` would otherwise be one the manager never
 * offered to remember.
 */
export function installAutofill(): void {
  try {
    const options = { capture: true } as const
    window.addEventListener('focusin', onFocusIn, options)
    window.addEventListener('submit', onSubmit, options)
    // A form the user has moved away from should not leave a list of their accounts on screen.
    window.addEventListener('focusout', () => hideSuggestion(), options)
    // Both surfaces belong to the document that asked for them. A new document gets new ones.
    window.addEventListener('pagehide', () => {
      hideSuggestion()
      hideSaveBar()
    })

    ipcRenderer.on(AUTOFILL_SAVE_PROMPT_CHANNEL, (_event, payload: unknown) => {
      const chrome = asSaveBarChrome(payload)
      // No wording, no bar. A build mismatch must leave the page alone rather than draw an unstyled,
      // wordless prompt about the user's password.
      if (chrome !== null) showSaveBar(chrome)
    })
  } catch (error) {
    console.warn('[autofill] could not be installed:', error)
  }
}
