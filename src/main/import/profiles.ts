import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { ImportBrowser } from '@shared/import/model.js'

/**
 * Where Chrome, Edge, Chromium and Firefox keep their profiles, per platform (U24, R39).
 *
 * The machine is a parameter — platform, environment, home and three file operations — so the Windows
 * and Linux paths are tested on any machine, and so is "not installed": a browser whose folder is not
 * there, or holds no profile with a file to import, is not listed at all.
 *
 * ## What is found
 *
 * - **Chrome, Edge, Chromium:** the profile folders of the "User Data" directory — `Default` and
 *   `Profile N`, not the guest and system profiles — named as the browser names them in `Local State`.
 *   `Bookmarks` is the JSON tree, `History` the SQLite file.
 * - **Firefox:** the `[Profile…]` sections of `profiles.ini`, each a folder relative to the ini or an
 *   absolute path, listed when it holds `places.sqlite`, which carries bookmarks and history both.
 *
 * The id of a profile is its browser and its folder as the browser names it, and that is all a page
 * ever sends back. The core finds the profiles again for every request and reads only a file of one it
 * found, so an id is a name for something this module offered, never a path that is followed.
 */

export interface Machine {
  readonly platform: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  exists(path: string): boolean
  /** The names in a directory; none when it is not one. */
  list(path: string): readonly string[]
  /** A text file, or `null` when it cannot be read. */
  read(path: string): string | null
}

export interface BrowserProfile {
  readonly id: string
  readonly browser: ImportBrowser
  readonly profile: string
  readonly bookmarksFile: string | null
  readonly historyFile: string | null
}

/** This machine, as the running process sees it. */
export function currentMachine(): Machine {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: (path) => existsSync(path),
    list: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    },
    read: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    }
  }
}

/** The folders each browser may keep its profiles in, most usual first. */
export function browserRoots(machine: Machine): Record<ImportBrowser, string[]> {
  const { env, home } = machine
  if (machine.platform === 'win32') {
    const local = env['LOCALAPPDATA']
    const roaming = env['APPDATA']
    const under = (base: string | undefined, ...parts: string[]): string[] =>
      base === undefined ? [] : [win32.join(base, ...parts)]
    return {
      chrome: under(local, 'Google', 'Chrome', 'User Data'),
      edge: under(local, 'Microsoft', 'Edge', 'User Data'),
      chromium: under(local, 'Chromium', 'User Data'),
      firefox: under(roaming, 'Mozilla', 'Firefox')
    }
  }
  if (machine.platform === 'darwin') {
    const support = posix.join(home, 'Library', 'Application Support')
    return {
      chrome: [posix.join(support, 'Google', 'Chrome')],
      edge: [posix.join(support, 'Microsoft Edge')],
      chromium: [posix.join(support, 'Chromium')],
      firefox: [posix.join(support, 'Firefox')]
    }
  }
  const config = env['XDG_CONFIG_HOME'] ?? posix.join(home, '.config')
  return {
    chrome: [posix.join(config, 'google-chrome')],
    edge: [posix.join(config, 'microsoft-edge')],
    chromium: [posix.join(config, 'chromium'), posix.join(home, 'snap/chromium/common/chromium')],
    firefox: [
      posix.join(home, '.mozilla/firefox'),
      posix.join(home, 'snap/firefox/common/.mozilla/firefox'),
      posix.join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox')
    ]
  }
}

/** Every profile with something to import: Chrome, Edge, Chromium, then Firefox. */
export function detectProfiles(machine: Machine): BrowserProfile[] {
  const roots = browserRoots(machine)
  const path = machine.platform === 'win32' ? win32 : posix
  const chromium = (['chrome', 'edge', 'chromium'] as const).flatMap((browser) => {
    const root = roots[browser].find((candidate) => machine.exists(candidate))
    return root === undefined ? [] : chromiumProfiles(machine, path, browser, root)
  })
  const firefoxRoot = roots.firefox.find((root) => machine.exists(path.join(root, 'profiles.ini')))
  const firefox = firefoxRoot === undefined ? [] : firefoxProfiles(machine, path, firefoxRoot)
  return [...chromium, ...firefox]
}

const CHROMIUM_PROFILE = /^(?:Default|Profile (\d+))$/

function chromiumProfiles(
  machine: Machine,
  path: typeof posix,
  browser: ImportBrowser,
  root: string
): BrowserProfile[] {
  const names = namesFromLocalState(machine.read(path.join(root, 'Local State')))
  const order = (dir: string): number => Number(CHROMIUM_PROFILE.exec(dir)?.[1] ?? -1)
  return machine
    .list(root)
    .filter((dir) => CHROMIUM_PROFILE.test(dir))
    .sort((left, right) => order(left) - order(right))
    .flatMap((dir) => {
      const bookmarks = path.join(root, dir, 'Bookmarks')
      const history = path.join(root, dir, 'History')
      const bookmarksFile = machine.exists(bookmarks) ? bookmarks : null
      const historyFile = machine.exists(history) ? history : null
      if (bookmarksFile === null && historyFile === null) return []
      return [
        {
          id: `${browser}:${dir}`,
          browser,
          profile: names.get(dir) ?? dir,
          bookmarksFile,
          historyFile
        }
      ]
    })
}

/** `profile.info_cache.<folder>.name` from `Local State`; nothing when the file is not that. */
function namesFromLocalState(text: string | null): Map<string, string> {
  const names = new Map<string, string>()
  let cache: unknown
  try {
    cache = (JSON.parse(text ?? '{}') as { profile?: { info_cache?: unknown } }).profile?.info_cache
  } catch {
    return names
  }
  for (const [dir, info] of Object.entries(cache ?? {})) {
    const name = (info as { name?: unknown } | null)?.name
    if (typeof name === 'string' && name.trim() !== '') names.set(dir, name.trim())
  }
  return names
}

function firefoxProfiles(machine: Machine, path: typeof posix, root: string): BrowserProfile[] {
  const sections = parseProfilesIni(machine.read(path.join(root, 'profiles.ini')) ?? '')
  return sections.flatMap(({ section, values }) => {
    const relative = values['Path']
    if (!section.startsWith('Profile') || relative === undefined) return []
    const dir = values['IsRelative'] === '0' ? relative : path.join(root, relative)
    const places = path.join(dir, 'places.sqlite')
    if (!machine.exists(places)) return []
    return [
      {
        id: `firefox:${relative}`,
        browser: 'firefox' as const,
        profile: values['Name'] ?? relative,
        bookmarksFile: places,
        historyFile: places
      }
    ]
  })
}

export interface IniSection {
  readonly section: string
  readonly values: Readonly<Record<string, string>>
}

/** The sections of an ini file in order; comments, blank and stray lines are skipped. */
export function parseProfilesIni(text: string): IniSection[] {
  const sections: Array<{ section: string; values: Record<string, string> }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header !== null) {
      sections.push({ section: header[1]!, values: {} })
      continue
    }
    const equals = line.indexOf('=')
    const current = sections.at(-1)
    if (equals <= 0 || current === undefined || line.startsWith(';') || line.startsWith('#')) {
      continue
    }
    current.values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim()
  }
  return sections
}
