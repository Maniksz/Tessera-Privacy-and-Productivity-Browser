import type { MasterPasswordPresentation } from '@shared/overlay/surface.js'
import type {
  MasterPasswordPromptProblem,
  MasterPasswordPurpose,
  MasterPasswordStep
} from '@shared/passwords/prompt.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * The master-password prompt, and the one surface in this browser that is a field without an input.
 *
 * ## What this component may not do, and why it cannot
 *
 * It never sees a character of what is typed. There is no `<input>` here, no `value`, no `onChange`
 * and no state: the core takes this view's keystrokes out of the input pipeline before the renderer
 * is dispatched to (`capturesKeyboard`), counts them, and re-presents this surface with the count. So
 * what is drawn is `presentation.filled` bullets, and the "field" is a `<div>`.
 *
 * That is not defensive coding, it is the feature. A real input would put the master password in a
 * renderer's heap, and getting it from there to the core needs a channel that accepts a master
 * password — at which point the guarantee is a set of promises about everyone who can see that
 * channel instead of a property of the program. See `main/passwords/MasterPasswordPrompt.ts`.
 *
 * ## Why the two buttons exist at all
 *
 * Return and Escape are handled in the core, so a keyboard user needs neither button — but a mouse
 * user needs both, and `passwords:answerPrompt` carries a request id and a verb to serve them. The
 * hint line says which keys do what, because this field behaves unlike every other one in the browser
 * and a person who cannot see a caret has to be told that typing works.
 *
 * ## What is deliberately not said
 *
 * Nothing about the vault. Not how many credentials are in it, not whether it has any: the presentation
 * carries no such thing, and a prompt that said "unlock your 43 passwords" would have handed that number
 * to anything that could get this prompt shown.
 */

/** The heading, per purpose. A table rather than a template: these are four different sentences. */
const TITLES: Readonly<Record<MasterPasswordPurpose, MessageKey>> = {
  unlock: 'passwords.lockedTitle',
  set: 'passwords.setMasterPassword',
  change: 'passwords.changeMasterPassword',
  remove: 'passwords.removeMasterPassword'
}

/** The label above the field, per question. */
const FIELD_LABELS: Readonly<Record<MasterPasswordStep, MessageKey>> = {
  current: 'passwords.currentMasterPassword',
  new: 'passwords.newMasterPassword',
  repeat: 'passwords.confirmMasterPassword'
}

/**
 * Why the last attempt was refused.
 *
 * Written out per problem so a rule added to `MasterPasswordPromptProblem` without a sentence is a
 * compile error rather than a refusal with no reason — which is a form people retry at random, and this
 * is the form where retrying at random means being locked out of every password they own.
 */
const PROBLEMS: Readonly<Record<MasterPasswordPromptProblem, MessageKey>> = {
  'wrong-password': 'passwords.unlockFailed',
  'too-short': 'passwords.masterPasswordTooShort',
  'too-long': 'passwords.masterPasswordTooLong',
  mismatch: 'passwords.masterPasswordMismatch'
}

/** One bullet per character. Not text, so it needs no translation. */
const BULLET = '•'

export function MasterPasswordSurface({
  presentation
}: {
  presentation: MasterPasswordPresentation
}): React.ReactNode {
  const { t } = useI18n()

  const answer = (action: 'submit' | 'cancel'): void => {
    void invoke('passwords:answerPrompt', { requestId: presentation.requestId, action })
  }

  const problem = presentation.problem
  return (
    <div
      className="surface surface--modal"
      /*
        Swallows the click without answering, exactly as the permission prompt does. An outside click
        dismisses a menu because a menu costs nothing to reopen; here it would throw away a password
        somebody is halfway through typing.
      */
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
    >
      <div
        className="prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="master-password-title"
      >
        <h2 className="prompt__title" id="master-password-title">
          {t(TITLES[presentation.purpose])}
        </h2>

        <p className="prompt__field-label" id="master-password-label">
          {t(FIELD_LABELS[presentation.step])}
        </p>

        {/*
          A field the browser does not own.

          `role="textbox"` with `aria-readonly` is the honest description for a screen reader: text is
          arriving, and this element is not where it is being edited. `aria-live` announces the count
          rather than the content, so assistive technology never reads a password out — the one thing a
          password field must not do.
        */}
        <div
          className="prompt__bullets"
          role="textbox"
          aria-readonly="true"
          aria-labelledby="master-password-label"
          aria-live="off"
        >
          {BULLET.repeat(presentation.filled)}
        </div>

        {/*
          The length rule, before it is broken rather than after.

          Only for the question that is choosing a new password: repeating one and proving an existing
          one are not moments to be told about a rule.
        */}
        {presentation.step === 'new' && (
          <p className="prompt__hint">
            {t('passwords.masterPasswordWarning', { min: presentation.minLength })}
          </p>
        )}

        {problem !== null && (
          <p className="prompt__problem" role="alert">
            {t(PROBLEMS[problem])}
          </p>
        )}

        <div className="prompt__actions">
          <button
            type="button"
            className="prompt__button"
            /*
              No `autoFocus` and no focus effect anywhere in this component, unlike the permission
              dialogue where focus decides which answer a stray Return gives. Here Return is not the
              button: the core reads it off the pipeline and submits, so moving DOM focus would achieve
              nothing except a focus ring that suggests Tab does something. Tab is ignored.
            */
            onClick={() => answer('cancel')}
          >
            {t('passwords.cancel')}
          </button>
          <button
            type="button"
            className="prompt__button prompt__button--always"
            onClick={() => answer('submit')}
          >
            {t('passwords.unlock')}
          </button>
        </div>

        {/*
          What this field is and which keys work.

          Both halves are load-bearing rather than reassurance. A field with no caret that ignores Tab is
          unlike every other one in the browser, so a person needs telling that typing works and that
          Return is the button — and "the browser draws this, no page can see it" is the one sentence that
          distinguishes this prompt from a page pretending to be it, which is the attack a master-password
          field invites.
        */}
        <p className="prompt__hint">{t('passwords.lockedBody')}</p>
      </div>
    </div>
  )
}
