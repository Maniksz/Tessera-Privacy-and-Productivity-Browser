/**
 * Extensions, as far as this browser supports them.
 *
 * Zod-free so the UI can import it (see the bundle-weight rule in
 * `docs/solutions/performance-issues/`).
 *
 * ## What is deliberately absent
 *
 * There is no store, no `.crx` install, and no automatic updates. Only an unpacked
 * folder can be loaded, only a subset of the extension APIs exists, and there is no
 * toolbar button, popup or options page for an extension to render into — this browser
 * ships no such surface. An installed extension is also detectable by websites through
 * the resources it injects, which makes a user *more* identifiable, not less.
 *
 * All of that is stated in the UI rather than discovered by the user. The feature
 * exists because it was asked for; the limits exist because the platform has them.
 */

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  /** Absolute path of the unpacked folder it was loaded from. */
  path: string
}

export interface ExtensionDocument {
  version: 1
  /** Folders to reload at startup; Electron does not persist extensions itself. */
  paths: string[]
}

export function emptyExtensionDocument(): ExtensionDocument {
  return { version: 1, paths: [] }
}

/** Removes duplicates while keeping the order the user added them in. */
export function withPath(paths: readonly string[], path: string): string[] {
  return paths.includes(path) ? [...paths] : [...paths, path]
}

export function withoutPath(paths: readonly string[], path: string): string[] {
  return paths.filter((entry) => entry !== path)
}
