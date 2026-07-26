import type { MessageKey } from '../i18n/catalog.js'

/**
 * The catalogue keys this feature uses, named once.
 *
 * ## Why this file exists at all, and when it stops existing
 *
 * Spec 7 forbids hard-coded user-visible text, so every string below has an entry in
 * `shared/i18n/catalog.ts` — and `MessageKey` is derived from that catalogue, so the compiler
 * normally enforces the correspondence for free. The catalogue entries for this feature land in a
 * **separate, coordinated edit** to that file, which is being changed by other work in flight.
 * Until they do, a literal such as `t('passwords.title')` is not a member of `MessageKey` and the
 * page would not compile.
 *
 * So the correspondence is carried here in the meantime: one list, one adapter, one assertion, all
 * in a file whose whole purpose is to be deleted. When the catalogue entries are in place the
 * change is mechanical and provable:
 *
 *   1. `PasswordMessageKey` becomes `Extract<MessageKey, \`passwords.${string}\`>`;
 *   2. `passwordMessage` becomes the identity function, then goes away with its call sites;
 *   3. the compiler takes over, and a typo in a key is a build error again.
 *
 * `tests/passwords-messages.test.ts` holds the line in the meantime: it reads the sources and
 * asserts that every `passwords.*` key they mention is in the list below. That is what makes the
 * reported catalogue edit *complete* rather than approximately complete — a missing key would
 * otherwise show up as a raw identifier in the interface, in one language, on a screen nobody
 * looks at twice.
 */

/**
 * Every key, in the order they appear in the interface.
 *
 * A runtime array rather than only a type, because the test above has to iterate it — a union
 * type cannot be enumerated at runtime, and the list would then be checked by nothing.
 */
export const PASSWORD_MESSAGE_KEYS = [
  // the page
  'passwords.title',
  /*
    One sentence per protection level rather than one sentence with a placeholder.

    The four states are not variations on a theme: "anyone logged in as you can read these", "only your
    master password can", and "these are readable by anything that can read this folder" are different
    warnings with different urgency, and a template would have forced them into one grammar. Interpolating
    a noun into a shared sentence is also how a translation ends up saying the opposite in German, where
    the surrounding clause has to change with the noun.
  */
  'passwords.protection.keystoreMaster',
  'passwords.protection.master',
  'passwords.protection.keystore',
  'passwords.protection.plain',
  // the lock
  'passwords.lockedTitle',
  'passwords.lockedBody',
  'passwords.masterPassword',
  'passwords.unlock',
  'passwords.unlockFailed',
  'passwords.unreadableTitle',
  'passwords.unreadableBody',
  'passwords.lockNow',
  'passwords.idleNotice',
  // the master password
  'passwords.masterPasswordTitle',
  'passwords.setMasterPassword',
  'passwords.changeMasterPassword',
  'passwords.removeMasterPassword',
  'passwords.currentMasterPassword',
  'passwords.newMasterPassword',
  'passwords.confirmMasterPassword',
  'passwords.masterPasswordMismatch',
  'passwords.masterPasswordTooShort',
  'passwords.masterPasswordTooLong',
  'passwords.masterPasswordWarning',
  'passwords.masterPasswordSet',
  'passwords.masterPasswordChanged',
  'passwords.masterPasswordRemoved',
  // importing from another browser
  'passwords.import',
  'passwords.importTitle',
  'passwords.importUnreadable',
  'passwords.importLocked',
  'passwords.importRefusedColumns',
  'passwords.importRefusedEmpty',
  'passwords.importRefusedTooLarge',
  'passwords.importRefusedTooManyRows',
  'passwords.importSummary',
  'passwords.importDuplicates',
  'passwords.importConflicts',
  'passwords.importFull',
  'passwords.importNotesDropped',
  'passwords.importDeleteFile',
  // destroying the vault
  'passwords.resetVault',
  'passwords.resetVaultConfirm',
  'passwords.resetVaultDone',
  'passwords.searchPlaceholder',
  'passwords.empty',
  'passwords.noMatches',
  'passwords.username',
  'passwords.noUsername',
  'passwords.reveal',
  'passwords.hide',
  'passwords.revealNotice',
  'passwords.notFilled',
  'passwords.lastUsed',
  'passwords.neverUsed',
  'passwords.remove',
  'passwords.removeConfirm',
  'passwords.removed',
  'passwords.edit',
  'passwords.editTitle',
  'passwords.newPassword',
  'passwords.saveChanges',
  'passwords.updated',
  'passwords.cancel',
  'passwords.add',
  'passwords.addTitle',
  'passwords.site',
  'passwords.sitePlaceholder',
  'passwords.password',
  'passwords.created',
  'passwords.rejected',
  'passwords.neverSavedTitle',
  'passwords.neverSavedEmpty',
  'passwords.forgetNeverSaved',
  // the suggestion list and the save bar, both drawn in the page by the preload with wording the
  // core translates — so a language change reaches the next form rather than the next restart
  'passwords.fillTitle',
  'passwords.savePrompt',
  'passwords.saveUpdatePrompt',
  'passwords.saveAction',
  'passwords.neverAction',
  'passwords.dismissAction'
] as const

export type PasswordMessageKey = (typeof PASSWORD_MESSAGE_KEYS)[number]

/**
 * A password key as a catalogue key.
 *
 * The one assertion, in the one place, with the one reason: these keys *are* catalogue keys, and
 * the only thing that is not yet true is that `catalog.ts` has been edited to say so. A double
 * assertion rather than `as MessageKey` because TypeScript rightly refuses to narrow a string
 * literal into a union it is not yet a member of — which is exactly the error this file documents
 * away rather than hides.
 *
 * Both translators fall back to the key itself for an unknown one, so before the catalogue edit
 * lands the interface shows `passwords.title` rather than crashing or blanking. Visible, harmless,
 * and impossible to mistake for finished work.
 */
export function passwordMessage(key: PasswordMessageKey): MessageKey {
  return key as unknown as MessageKey
}
