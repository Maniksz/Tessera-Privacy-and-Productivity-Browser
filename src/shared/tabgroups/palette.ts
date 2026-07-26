/**
 * The fixed palette a tab group's colour is chosen from.
 *
 * ## Why names and not colours
 *
 * A group stores `'orange'`, never `#e8a33d`. Three reasons, in order of how much
 * they cost when got wrong:
 *
 *   - A private window overrides the theme tokens (`.app--private` in
 *     `styles.css`), so the same group has to be drawn differently in a private
 *     window than in a normal one. A hex value in the document would be whichever
 *     window happened to create the group, baked into user data.
 *   - Stored data outlives the theme. Adjusting the palette for contrast — or adding
 *     a light theme — would leave every existing group on the old value, and there
 *     would be no way to tell "the user picked this exact colour" from "this is what
 *     orange looked like in 0.1".
 *   - Contrast is a rendering decision. The label drawn on the colour needs a
 *     readable foreground, and only the surface knows what its background is.
 *
 * So the model names a slot and the interface maps the slot to a token. This file is
 * the mapping's one description; the stylesheet declares the variables it names.
 *
 * ## Why a fixed set rather than a colour picker
 *
 * A free choice produces groups the user cannot tell apart, groups invisible against
 * the toolbar, and groups that look like the private-window accent. Eight named slots
 * can each be checked once for contrast in both themes and then trusted.
 *
 * Purple is deliberately absent. `--accent-private` is purple and marks "this window
 * keeps nothing" — a group tinted like that signal is exactly the confusion spec 4
 * exists to prevent.
 */

/**
 * Allocation order as well as the set: `nextTabGroupColor` walks this list, so the
 * first group a user makes is blue and grey is reached last. Grey is the slot for "no
 * colour in particular", which makes it the wrong first impression and the right
 * fallback.
 */
export const TAB_GROUP_COLORS = [
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'grey'
] as const

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

/**
 * What an unrecognised stored colour becomes.
 *
 * Used by the document schema rather than by a rejection: a colour removed from the
 * palette in a later version must not delete the group that used it. Healing to grey
 * loses a label; discarding the document loses the user's groups.
 */
export const FALLBACK_TAB_GROUP_COLOR: TabGroupColor = 'grey'

/**
 * The custom property a stylesheet declares for a slot.
 *
 * Separate from `tabGroupColorToken` because the two ends of the mapping have
 * different callers: a stylesheet (or a test that reads one) needs the property's
 * name, a rule needs a reference to it.
 */
export function tabGroupColorVariable(color: TabGroupColor): string {
  return `--tab-group-${color}`
}

/** The value a CSS rule or an inline style uses to paint a group. */
export function tabGroupColorToken(color: TabGroupColor): string {
  return `var(${tabGroupColorVariable(color)})`
}
