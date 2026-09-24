/**
 * A name or title as another browser stored it, made fit to show: every run of whitespace becomes
 * one space and the ends are trimmed. Anything that is not text is the empty string, so a missing
 * field and a malformed one read the same.
 *
 * Shared by the Chrome and Firefox bookmark readers. It imports nothing, zod least of all, so either
 * reader can keep taking it wherever it goes.
 */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}
