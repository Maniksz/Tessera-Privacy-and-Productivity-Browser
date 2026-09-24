import { ipcRenderer } from 'electron'
import {
  chooseFillTargets,
  chooseSaveTargets,
  type FieldDescriptor,
  type FormDescriptor
} from '@shared/passwords/fields.js'
import {
  AUTOFILL_BADGE_CHANNEL,
  AUTOFILL_CLOSE_CHANNEL,
  AUTOFILL_DESCRIBE_CHANNEL,
  AUTOFILL_FILLABLE_CHANNEL,
  AUTOFILL_FILL_CHANNEL,
  AUTOFILL_PRESS_CHANNEL,
  AUTOFILL_SAVE_ANSWER_CHANNEL,
  AUTOFILL_SAVE_PROMPT_CHANNEL,
  AUTOFILL_SUBMIT_CHANNEL,
  AUTOFILL_SUGGEST_END_CHANNEL,
  asBadgeChrome,
  asFillAnswer,
  asSaveBarChrome,
  asFillToken,
  type BadgeChrome,
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
 *   - **The badge is a button and nothing else.** There is no list of account names in this file any
 *     more: the picker is drawn on the browser's overlay layer, which a page can neither read nor
 *     imitate into (R5). What the page can see here is that a badge exists, which it could have
 *     worked out from the shape of its own form.
 *   - **A page can focus a field whenever it likes**, and it can call `.click()` on our badge —
 *     neither is consent. The core answers a press only when the *browser process* saw a real input
 *     event in this view, which never happens for input a renderer synthesised; see
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
const BADGE_HOST_ID = 'tessera-autofill'
const SAVE_HOST_ID = 'tessera-autofill-save'

/** The badge's edge, in CSS pixels, and the gap it keeps from the field's own border. */
const BADGE_SIZE = 18
const BADGE_INSET = 3

/** What both surfaces have to say about themselves before anything the page says. */
const PINNED = 'position:fixed!important;z-index:2147483647!important'
/** The badge's box, which never changes: only its corner moves. */
const BADGE_BOX = `${PINNED};width:${BADGE_SIZE}px!important;height:${BADGE_SIZE}px!important`

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
}

/**
 * A host element with a closed shadow root. The caller places it, in one write.
 *
 * Every declaration a caller writes carries `!important`, which is not superstition: the stylesheet
 * the core sends sets `all: initial` on `:host` to undo whatever the page inherits into it, and that
 * includes `position`. Inline important declarations outrank both, so a surface lands where it was
 * put however the page is styled.
 */
function createSurface(id: string, styles: string, beside?: Element): Surface | null {
  const parent = beside?.parentElement ?? earlyDocument.body ?? earlyDocument.documentElement
  if (parent === null) return null
  removeSurface(id)

  const host = document.createElement('div')
  host.id = id
  // `closed`, so the page's scripts cannot reach whatever is inside — and cannot, for the badge,
  // read the focus ring off it to tell when the user is about to ask for a credential.
  const root = host.attachShadow({ mode: 'closed' })
  const sheet = document.createElement('style')
  sheet.textContent = styles
  root.appendChild(sheet)
  /*
    Next to the field when there is one, and that is the whole of the badge's keyboard story.

    Tab order follows the document, so a host parked at the end of `<body>` would be reachable only
    after every other control on the page — which for a sign-in form means after the submit button.
    Inserted after the field, one Tab from the field lands on it (KTD12). `position: fixed` keeps it
    out of flow, so nothing moves.
  */
  if (beside === undefined) parent.appendChild(host)
  else parent.insertBefore(host, beside.nextSibling)

  return { root, host }
}

function removeSurface(id: string): void {
  document.getElementById(id)?.remove()
}

/**
 * Tells the core something, and shrugs when nothing is listening.
 *
 * One place rather than a `try` at each call site, and the `catch` is the point: an old build, or a
 * view created outside a hardened session, has no responder — and an exception escaping a preload
 * takes the page down with it. Every message from this file is fire-and-forget, so there is never
 * anything to do here but carry on.
 */
function send(channel: string, payload: unknown): void {
  try {
    ipcRenderer.send(channel, payload)
  } catch {
    // No responder. Nothing here can act on that; the core is the only side that decides anything.
  }
}

/** An element with a class and its text, which is every element the two surfaces are made of. */
function element<K extends 'div' | 'button'>(
  tag: K,
  className: string,
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

function button(className: string, label: string): HTMLButtonElement {
  const control = element('button', className, label)
  control.type = 'button'
  return control
}

// --- the badge ---------------------------------------------------------------

/**
 * The badge on the field, and whether its list is open.
 *
 * `open` is the state R1 exists for. The picker is drawn by the browser, in a view of its own, so
 * the moment it appears this document sees `focusout` on the field — and a badge bound to focus
 * alone would vanish at exactly the moment it had worked. It is set when the badge is pressed and
 * taken back when the core says the list has gone.
 */
let badge: {
  readonly field: HTMLInputElement
  readonly surface: Surface
  /** The button inside the closed root, which a focus event names when nothing retargets it. */
  readonly control: HTMLButtonElement
  open: boolean
} | null = null

/** How the badge looks and what it is called, as the core sent it. No chrome, no badge. */
let badgeChrome: BadgeChrome | null = null

/**
 * The field the last press was about, which is where a chosen credential goes.
 *
 * Not the badge's field: a fill asked for from browser chrome presses no badge, and there may be no
 * badge at all — the caret can be in the address bar while the key in the toolbar is pressed.
 */
let pressed: HTMLInputElement | null = null

function hideBadge(): void {
  badge?.surface.host.remove()
  badge = null
}

/** Whether an event target is the badge: its host, or the button a closed root retargets to it. */
function isBadge(target: EventTarget | null): boolean {
  return badge !== null && (target === badge.surface.host || target === badge.control)
}

/**
 * The badge goes because the caret is no longer in its form, and the core stops listening.
 *
 * The two travel together. A badge taken down while the core still hears every press in the tab
 * leaves the listener behind for the life of the tab; a listener released under a badge still on
 * screen would answer the next press on it with nothing.
 */
function leaveForm(): void {
  hideBadge()
  reportFillable(false)
}

/** Whether the caret is still on the field or its badge, as this document sees it. */
function focusIsOurs(): boolean {
  return (
    badge !== null && (document.activeElement === badge.field || isBadge(document.activeElement))
  )
}

/**
 * The field moved under the badge: a scroll, a resize, a pinch.
 *
 * Two jobs, because it is one event. The badge follows the field, so it does not float over the
 * middle of the page — and the rectangle the *core* placed the list from is now wrong, so the list
 * closes rather than standing where the field used to be (AE6, KTD9). Following the field and
 * following the list are different problems: one is four numbers this side already has, the other
 * is four factors only the core can put together.
 */
function onViewportChange(): void {
  placeBadge()
  closeSuggest()
}

/** A pointer press that missed both the field and the badge — the ordinary way out of a menu. */
function onPointerDown(event: Event): void {
  if (badge === null) return
  const target = event.target
  if (target === badge.field || isBadge(target)) return
  closeSuggest()
}

/**
 * Puts the badge back where the field is now, in one write.
 *
 * `cssText` rather than six `setProperty` calls, and `!important` on every one of them for the
 * reason `createSurface` gives: the stylesheet the core sends resets `:host` to `all: initial`, and
 * an inline important declaration is the only thing that outranks both that and the page.
 */
function placeBadge(): void {
  if (badge === null) return
  const rect = badge.field.getBoundingClientRect()
  const left = Math.round(rect.right - BADGE_SIZE - BADGE_INSET)
  const top = Math.round(rect.top + (rect.height - BADGE_SIZE) / 2)
  badge.surface.host.style.cssText = `${BADGE_BOX};left:${left}px!important;top:${top}px!important`
}

/**
 * Says the list should go, and takes the open state back.
 *
 * The core is what actually takes the surface down — its departure is what discards the fill
 * request — so this reports rather than decides. Sent once: a scroll produces a great many events
 * and the second of them is about a list that has already gone.
 */
function closeSuggest(): void {
  if (badge?.open !== true) return
  badge.open = false
  send(AUTOFILL_CLOSE_CHANNEL, null)
  if (!focusIsOurs()) leaveForm()
}

/**
 * The badge was pressed, by pointer or by Return.
 *
 * Carries the shape of the form and the field's rectangle in CSS pixels, plus the visual viewport's
 * scale and offset — the three things only a renderer can see. Everything else the placement needs
 * is the core's (`shared/passwords/suggest-bounds.ts`). Nothing is asked for and nothing comes back
 * here: the answer, if the browser process saw the press, is a surface it draws itself.
 */
function pressBadge(field: HTMLInputElement): void {
  const described = describeForm(field)
  if (described === null || chooseFillTargets(described.descriptor) === null) return
  const rect = field.getBoundingClientRect()
  const viewport = window.visualViewport
  if (badge !== null) badge.open = true
  pressed = field
  send(AUTOFILL_PRESS_CHANNEL, {
    form: described.descriptor,
    field: {
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      // 1 and 0 unless the user has pinched, and absent altogether in an old environment. The core
      // would rather place the list at the un-pinched position than not place it at all.
      scale: viewport?.scale ?? 1,
      offsetX: viewport?.offsetLeft ?? 0,
      offsetY: viewport?.offsetTop ?? 0
    }
  })
}

/**
 * Draws the badge in the field, or leaves it where it already is.
 *
 * A `<button>` rather than anything cleverer, because a button is what answers Return and Space
 * without a keyboard handler of our own, and what a screen reader calls a button (KTD12). It has no
 * text in it at all: the key is a background image in the stylesheet the core sent, so this file
 * carries neither a glyph — which would inherit whatever font the page set — nor a word, which would
 * have to be translated somewhere that cannot read a catalogue.
 */
function showBadge(field: HTMLInputElement): void {
  if (badge?.field === field) {
    placeBadge()
    return
  }
  hideBadge()
  const chrome = badgeChrome
  if (chrome === null) return
  const surface = createSurface(BADGE_HOST_ID, chrome.styles, field)
  if (surface === null) return

  // The same helper the save bar's three buttons use, with no text: the key is a background image,
  // and the name a screen reader reads is the label the core translated.
  const control = button('badge', '')
  control.ariaLabel = chrome.label
  control.addEventListener('click', () => pressBadge(field))
  surface.root.appendChild(control)

  badge = { field, surface, control, open: false }
  placeBadge()
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
  saveBar?.host.remove()
  saveBar = null
}

function answerSave(answer: SaveAnswer): void {
  hideSaveBar()
  send(AUTOFILL_SAVE_ANSWER_CHANNEL, answer)
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
  surface.host.style.cssText = `${PINNED};top:16px!important;right:16px!important`

  const panel = element('div', 'panel')
  panel.appendChild(element('div', 'message', chrome.message))
  if (chrome.username !== '') panel.appendChild(element('div', 'who', chrome.username))

  const actions = element('div', 'actions')
  const answers = [
    ['action primary', chrome.saveLabel, 'save'],
    ['action', chrome.neverLabel, 'never'],
    ['action', chrome.dismissLabel, 'dismiss']
  ] as const
  for (const [className, label, answer] of answers) {
    const control = button(className, label)
    control.addEventListener('click', () => answerSave(answer))
    actions.appendChild(control)
  }
  panel.appendChild(actions)
  surface.root.appendChild(panel)
}

// --- wiring ------------------------------------------------------------------

/**
 * Tells the core whether a fillable password field has focus in this view.
 *
 * One boolean, no form, no address, no answer — and the whole of what makes autofill work at all.
 * The core attaches its `input-event` listener on this report and on nothing else, because the
 * listener is what records the gesture every fill requires; gating it on an offer, as it was gated
 * before, meant gating it on a decision that refused for want of that very gesture.
 *
 * Sent on every focus change, including the ones that say "no", so the subscription is released as
 * soon as the caret leaves the form rather than lasting the life of the tab.
 */
function reportFillable(fillable: boolean): void {
  send(AUTOFILL_FILLABLE_CHANNEL, fillable)
}

/**
 * Redeems the token the core sent, and puts the credential in the fields.
 *
 * The form is described again rather than reused from the press, so the core decides against the
 * document as it is at this moment. The targets are chosen again for the same reason. The token is
 * good for one attempt whatever comes of it (KTD8), so there is nothing here to retry with.
 *
 * The caret goes back into the field afterwards. The picker took the focus away in order to be
 * walked by arrow key, and a sign-in form left with the focus nowhere is one the user has to click
 * into again to press Return.
 */
function performFill(anchor: HTMLInputElement, token: string): void {
  const described = describeForm(anchor)
  if (described === null) return
  const targets = chooseFillTargets(described.descriptor)
  if (targets === null) return

  let answer: unknown
  try {
    answer = ipcRenderer.sendSync(AUTOFILL_FILL_CHANNEL, { token, form: described.descriptor })
  } catch {
    return
  }
  const credential = asFillAnswer(answer)
  if (credential === null) return

  const password = described.elements[targets.password.index]
  if (password === undefined) return
  setFieldValue(password, credential.password)

  if (targets.username !== null && credential.username !== '') {
    const username = described.elements[targets.username.index]
    if (username !== undefined) setFieldValue(username, credential.username)
  }
  anchor.focus()
}

/**
 * A field took focus. Draws the badge on it, if a fill could ever write there.
 *
 * A pure decision, and that is KTD7: `chooseFillTargets` is a function the preload already has, so
 * the badge's visibility is the shape of the form in front of the user and nothing else. The vault
 * is not asked, and cannot be, until the badge is pressed (R2, AE2).
 *
 * A page can cause focus at will, so this being reachable is not a privilege: what it produces is a
 * button, and the core refuses a press it saw no real input event for.
 */
function onFocusIn(event: FocusEvent): void {
  const target = event.target
  // Focus moving into the badge is not focus leaving the form. Its own host is the only element in
  // this document that is ours, and a closed shadow root retargets everything inside it to the host.
  if (isBadge(target)) return

  const focused = fillableFocus(target)
  // A caret that has moved to another field is a list about the wrong one.
  if (badge?.field !== focused?.field) closeSuggest()
  /*
    Reported on every focus change, including the ones that say "no".

    This is the message the core attaches its input listener on, and the message it answers with the
    badge's wording. Both matter for the press that follows: the listener is what records the gesture
    the core will demand, and without the wording there is no badge to press.
  */
  reportFillable(focused !== null)
  if (focused === null) {
    if (badge?.open === false) hideBadge()
    return
  }
  showBadge(focused.field)
}

/** The focused element, when it is a field a fill would write to, with its form. */
function fillableFocus(target: EventTarget | null): {
  field: HTMLInputElement
  form: { descriptor: FormDescriptor; elements: HTMLInputElement[] }
} | null {
  if (!(target instanceof HTMLInputElement)) return null
  if (!isFieldVisible(target)) return null

  const described = describeForm(target)
  if (described === null) return null
  const targets = chooseFillTargets(described.descriptor)
  if (targets === null) return null
  // The focused field has to be one of the two a fill would write to. Offering while the caret is
  // in an unrelated box would put a list of the user's accounts on screen for no reason.
  if (
    target !== described.elements[targets.password.index] &&
    (targets.username === null || target !== described.elements[targets.username.index])
  ) {
    return null
  }
  return { field: target, form: described }
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
  closeSuggest()
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

  const password = elements[targets.password.index]
  if (password === undefined || password.value === '') return
  const usernameField = targets.username === null ? undefined : elements[targets.username.index]

  send(AUTOFILL_SUBMIT_CHANNEL, {
    form: descriptor,
    username: usernameField?.value ?? '',
    password: password.value
  })
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
    /*
      Capturing, so a page that stops propagation in its own handlers cannot take these events away
      — a login form that swallowed `submit` would be one the manager never offered to remember.

      Passive as well, and truthfully so: not one listener in this file calls `preventDefault`, and
      declaring it is what stops Chromium waiting on our scroll handler before it scrolls.
    */
    const watching = { capture: true, passive: true } as const
    window.addEventListener('focusin', onFocusIn, watching)
    window.addEventListener('submit', onSubmit, watching)
    /*
      Registered for the life of the document rather than for the life of a badge.

      Each begins with "is there a badge?" and leaves immediately when there is not, which is a
      cheaper thing to run on every scroll than subscribing and unsubscribing is to keep correct: a
      badge is created and destroyed on every focus change, and a removal that missed one would
      leave a handler reading a field that no longer exists.
    */
    window.addEventListener('scroll', onViewportChange, watching)
    window.addEventListener('resize', onViewportChange, watching)
    window.addEventListener('pointerdown', onPointerDown, watching)
    // The pinch, which changes neither `scroll` nor `resize` on the window.
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', onViewportChange)
    viewport?.addEventListener('scroll', onViewportChange)
    /*
      The caret left the field: the badge goes, and the core is told the form is gone.

      Told here as well as on the next focus, because there may be no next focus: a press on blank
      page space, a field removed after a submit, or focus leaving the document fires this and nothing
      else. Moving to another field fires this and then `focusin`, which reports the new field.

      Two exceptions, and the keyboard needs both (AE10). The badge's own list is open: it is drawn in
      a view of the browser's, so putting it on screen takes the focus out of this document, and a
      badge that went then would vanish the moment it had worked (R1). And focus is moving *into* the
      badge — one Tab from the field — which `relatedTarget` names: the form is still the one in front
      of the user, and releasing the listener would lose the Return that is about to press it.
    */
    window.addEventListener(
      'focusout',
      (event: FocusEvent) => {
        if (badge === null) return
        if (badge.open || isBadge(event.relatedTarget)) return
        leaveForm()
      },
      watching
    )
    // Both surfaces belong to the document that asked for them. A new document gets new ones.
    window.addEventListener('pagehide', () => {
      closeSuggest()
      hideBadge()
      hideSaveBar()
      pressed = null
    })

    ipcRenderer.on(AUTOFILL_BADGE_CHANNEL, (_event, payload: unknown) => {
      // No wording, no badge. A build mismatch must leave the page alone rather than draw a control
      // nothing can name, and a build with autofill switched off never sends this at all.
      badgeChrome = asBadgeChrome(payload) ?? badgeChrome
    })

    /*
      The list has gone, and possibly with a choice in it.

      Both endings take the badge's open state back, because both mean there is no list in front of
      the field any more. Only one of them has a token, and redeeming it is the last step of the flow
      the badge started.
    */
    ipcRenderer.on(AUTOFILL_SUGGEST_END_CHANNEL, (_event, payload: unknown) => {
      const field = pressed
      pressed = null
      const token = asFillToken(payload)
      if (token !== null && field !== null) performFill(field, token)
      if (badge?.open !== true) return
      badge.open = false
      // The field — or the badge, when it was reached by Tab — usually still holds the caret as far
      // as this document is concerned, even though the overlay had the keyboard. The badge stays
      // until focus actually moves in the page; the `focusout` that did not count while the list was
      // open is made good here otherwise.
      if (!focusIsOurs()) leaveForm()
    })

    /*
      Browser chrome asks where the form is (R11, R12): the toolbar key, the shortcut, the context
      menu. Answered exactly as a badge press is, for the field with the caret or else the first one a
      fill would write to — and answering is all this does. Whether the answer counts is the core's
      to decide, from a question only browser chrome can have asked.
    */
    ipcRenderer.on(AUTOFILL_DESCRIBE_CHANNEL, () => {
      let target = fillableFocus(document.activeElement)
      for (const input of document.querySelectorAll('input')) target ??= fillableFocus(input)
      if (target !== null) pressBadge(target.field)
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
