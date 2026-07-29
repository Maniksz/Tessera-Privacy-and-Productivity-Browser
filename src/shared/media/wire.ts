import type { DownloadRefusal, ManifestState, MediaFinding } from './model.js'

/**
 * What the media channels carry.
 *
 * Three shapes, and each of them exists because a code on its own is not an answer.
 *
 * `MediaFinding` and `ManifestState` travel as they are: they are already plain data
 * and the interface renders them directly. What is added here is the *sentence* — a
 * refusal and a manifest failure both arrive as an enumeration value, and the core is
 * where the locale lives, so the core is what turns them into words. That is the rule on
 * this boundary rather than a choice made here: an enumeration crosses with its sentence
 * already translated. The alternative is every renderer that renders one owning a mapping
 * table, and a second table is a second place for a new enumeration value to be forgotten.
 *
 * The machine-readable value is kept alongside the sentence rather than replaced by
 * it. The interface branches on `refusal` — a `cancelled` download is not an error
 * worth a red banner — and shows `message`.
 *
 * Zod-free on purpose: a renderer imports these types to render them, and the schemas
 * that validate them live in `schema.ts`, which only the contract and the core may
 * see. See the note at the top of `model.ts`.
 */

/**
 * A tab's findings, with the tab named.
 *
 * The tab id is in the response and not only in the request because the request may
 * omit it — the core resolves "the tab in the active tile", the same default the
 * navigation channels use. A panel that did not learn which tab it was given could
 * not tell whether a change notification concerns what it is showing.
 */
export interface MediaFindingList {
  readonly tabId: string
  readonly findings: readonly MediaFinding[]
}

export interface MediaManifestReport {
  /** Null for a progressive file, which has no manifest, and for a finding that is gone. */
  readonly manifest: ManifestState | null
  /** Translated, and null unless the manifest failed — there is nothing to explain otherwise. */
  readonly message: string | null
}

export type MediaDownloadReport =
  | {
      readonly ok: true
      readonly filePath: string
      readonly byteLength: number
    }
  | {
      readonly ok: false
      readonly refusal: DownloadRefusal
      /** The sentence the user reads. */
      readonly message: string
      /** The diagnostic behind it: an HTTP status, a segment count, an OS message. */
      readonly detail: string
    }
