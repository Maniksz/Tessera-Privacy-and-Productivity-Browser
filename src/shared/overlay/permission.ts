/**
 * The vocabulary a permission prompt is described in.
 *
 * ## Why it is shared, and why it lives beside the overlay surface
 *
 * Three parties have to agree on these names: the core, which decides; the overlay surface,
 * which draws the dialogue; and the store, which remembers the answer. The surface is a
 * renderer, so the names cannot live in `@main` — and a permission prompt is a *presentation*,
 * so they belong with the rest of what the topmost layer can show.
 *
 * Zod-free and platform-free, like everything the renderers import at runtime.
 *
 * ## Why not Electron's own permission names
 *
 * Electron says `clipboard-sanitized-write`, `midiSysex` and `media` — the last of which means
 * "camera and/or microphone, look at `mediaTypes` to find out which". Putting those strings on
 * the wire would make the dialogue's label depend on a Chromium implementation detail, and it
 * would give the store two keys for one clipboard and no key at all for a camera. The mapping
 * from Electron's names to these happens once, in `permission-policy.ts`, where the decision is
 * made.
 */

/** A physical device a media request can reach. Ordered as the dialogue lists them. */
export const PERMISSION_DEVICES = ['camera', 'microphone'] as const

export type PermissionDevice = (typeof PERMISSION_DEVICES)[number]

/**
 * One thing a site can be granted, and the key an answer is stored under.
 *
 * These are the *atomic* permissions: exactly one stored decision each. That matters for the
 * media pair — see `PERMISSION_SUBJECTS` for the request that asks for two at once.
 */
export const PERMISSION_TOPICS = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'midi',
  'midi-sysex',
  'storage-access',
  'top-level-storage-access'
] as const

export type PermissionTopic = (typeof PERMISSION_TOPICS)[number]

/**
 * What a dialogue can be *about*: every topic, plus the one request that asks for two of them
 * together.
 *
 * `getUserMedia({ video: true, audio: true })` is a single decision to the page and has to be a
 * single dialogue to the user. Splitting it into two prompts would train people to click through
 * both, which is how prompt fatigue turns a permission system into a formality — and it would
 * also mean answering "allow" to the first while the second is still pending, with the page
 * holding a camera it may never get a microphone for.
 *
 * Derived from the topics rather than written out again, so a topic added below cannot be
 * forgotten here.
 */
export const PERMISSION_SUBJECTS = [...PERMISSION_TOPICS, 'camera-and-microphone'] as const

export type PermissionSubject = (typeof PERMISSION_SUBJECTS)[number]

/**
 * What the user answered.
 *
 * Two ways to say yes and one to say no, and the asymmetry is deliberate. Granting a camera for
 * one visit is a real need — a video call on a site you will not return to — so "once" has to be
 * offered, or people pick "always" for everything. Refusing has no such need: somebody who says
 * no does not want to be asked again, and a prompt that reappears on every page load is itself
 * the attack. So `block` is remembered, and there is no "block once".
 */
export const PERMISSION_ANSWERS = ['allow-once', 'allow-always', 'block'] as const

export type PermissionAnswer = (typeof PERMISSION_ANSWERS)[number]

/**
 * The atomic permissions a subject covers.
 *
 * The only place that knows allowing "camera and microphone" grants *two* things. Without it,
 * the combined request would need a storage key of its own, and a later camera-only request from
 * the same site would prompt again for something the user has already granted.
 */
export function subjectTopics(subject: PermissionSubject): readonly PermissionTopic[] {
  if (subject === 'camera-and-microphone') return ['camera', 'microphone']
  return [subject]
}

/** The devices a subject reaches, for the dialogue to name them. Empty for everything else. */
export function subjectDevices(subject: PermissionSubject): readonly PermissionDevice[] {
  const devices: ReadonlySet<string> = new Set(PERMISSION_DEVICES)
  return subjectTopics(subject).filter((topic): topic is PermissionDevice => devices.has(topic))
}
