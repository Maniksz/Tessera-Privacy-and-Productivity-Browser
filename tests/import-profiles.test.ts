import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  browserRoots,
  currentMachine,
  detectProfiles,
  parseProfilesIni,
  type Machine
} from '@main/import/profiles.js'

/**
 * Where Chrome, Edge, Chromium and Firefox keep their profiles, per platform (U24, R39).
 *
 * The machine is injected — platform, environment, home and a file system — so the Windows and Linux
 * paths are asserted on any machine, and a browser that is not installed is simply not listed. The
 * last block runs against a real directory, through `currentMachine`'s file system.
 */

/** A file system of the paths given; a directory is anything some path lies under. */
function machine(
  platform: string,
  files: Record<string, string>,
  env: Record<string, string> = {},
  home = platform === 'win32' ? 'C:\\Users\\ada' : '/home/ada'
): Machine {
  const paths = Object.keys(files)
  const separator = platform === 'win32' ? '\\' : '/'
  return {
    platform,
    env,
    home,
    exists: (path) => path in files || paths.some((file) => file.startsWith(path + separator)),
    list: (path) => [
      ...new Set(
        paths
          .filter((file) => file.startsWith(path + separator))
          .map((file) => file.slice(path.length + 1).split(separator)[0]!)
      )
    ],
    read: (path) => files[path] ?? null
  }
}

describe('where each browser keeps its profiles', () => {
  it('names the Windows folders under LOCALAPPDATA and APPDATA', () => {
    const roots = browserRoots(
      machine(
        'win32',
        {},
        {
          LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
          APPDATA: 'C:\\Users\\ada\\AppData\\Roaming'
        }
      )
    )
    expect(roots).toEqual({
      chrome: ['C:\\Users\\ada\\AppData\\Local\\Google\\Chrome\\User Data'],
      edge: ['C:\\Users\\ada\\AppData\\Local\\Microsoft\\Edge\\User Data'],
      chromium: ['C:\\Users\\ada\\AppData\\Local\\Chromium\\User Data'],
      firefox: ['C:\\Users\\ada\\AppData\\Roaming\\Mozilla\\Firefox']
    })
  })

  it('names nothing on Windows without the two variables', () => {
    expect(browserRoots(machine('win32', {}))).toEqual({
      chrome: [],
      edge: [],
      chromium: [],
      firefox: []
    })
  })

  it('names the macOS folders under Application Support', () => {
    expect(browserRoots(machine('darwin', {}, {}, '/Users/ada'))).toEqual({
      chrome: ['/Users/ada/Library/Application Support/Google/Chrome'],
      edge: ['/Users/ada/Library/Application Support/Microsoft Edge'],
      chromium: ['/Users/ada/Library/Application Support/Chromium'],
      firefox: ['/Users/ada/Library/Application Support/Firefox']
    })
  })

  it('names the Linux folders, the Snap and Flatpak ones included', () => {
    expect(browserRoots(machine('linux', {}))).toEqual({
      chrome: ['/home/ada/.config/google-chrome'],
      edge: ['/home/ada/.config/microsoft-edge'],
      chromium: ['/home/ada/.config/chromium', '/home/ada/snap/chromium/common/chromium'],
      firefox: [
        '/home/ada/.mozilla/firefox',
        '/home/ada/snap/firefox/common/.mozilla/firefox',
        '/home/ada/.var/app/org.mozilla.firefox/.mozilla/firefox'
      ]
    })
  })

  it('takes XDG_CONFIG_HOME on Linux when it is set', () => {
    const roots = browserRoots(machine('linux', {}, { XDG_CONFIG_HOME: '/xdg' }))
    expect(roots.chrome).toEqual(['/xdg/google-chrome'])
  })
})

describe('finding the profiles', () => {
  const CHROME = '/Users/ada/Library/Application Support/Google/Chrome'
  const FIREFOX = '/Users/ada/Library/Application Support/Firefox'

  it('lists each Chromium profile with its own name, and what it has', () => {
    const found = detectProfiles(
      machine(
        'darwin',
        {
          [`${CHROME}/Local State`]: JSON.stringify({
            profile: { info_cache: { Default: { name: 'Ada' }, 'Profile 2': { name: 7 } } }
          }),
          [`${CHROME}/Default/Bookmarks`]: '{}',
          [`${CHROME}/Default/History`]: '',
          [`${CHROME}/Profile 2/History`]: '',
          [`${CHROME}/Profile 10/Bookmarks`]: '',
          [`${CHROME}/System Profile/History`]: '',
          [`${CHROME}/Guest Profile/History`]: '',
          [`${CHROME}/Profile 3/Preferences`]: ''
        },
        {},
        '/Users/ada'
      )
    )
    expect(
      found.map((found) => [
        found.id,
        found.profile,
        found.bookmarksFile !== null,
        found.historyFile !== null
      ])
    ).toEqual([
      ['chrome:Default', 'Ada', true, true],
      ['chrome:Profile 2', 'Profile 2', false, true],
      ['chrome:Profile 10', 'Profile 10', true, false]
    ])
    expect(found[0]).toMatchObject({
      browser: 'chrome',
      bookmarksFile: `${CHROME}/Default/Bookmarks`,
      historyFile: `${CHROME}/Default/History`
    })
    expect(found[1]?.bookmarksFile).toBeNull()
  })

  it('reads a broken Local State as no names at all', () => {
    const found = detectProfiles(
      machine(
        'darwin',
        { [`${CHROME}/Local State`]: '{', [`${CHROME}/Default/History`]: '' },
        {},
        '/Users/ada'
      )
    )
    expect(found.map((profile) => profile.profile)).toEqual(['Default'])
  })

  it('lists each Firefox profile of profiles.ini that has a places.sqlite', () => {
    const found = detectProfiles(
      machine(
        'darwin',
        {
          [`${FIREFOX}/profiles.ini`]: [
            '[General]',
            'StartWithLastProfile=1',
            '',
            '[Profile1]',
            'Name=default',
            'IsRelative=1',
            'Path=Profiles/abc.default',
            '',
            '[Profile0]',
            'Name=Work',
            'IsRelative=0',
            'Path=/Volumes/work/firefox',
            '',
            '[Profile2]',
            'Name=Empty',
            'Path=Profiles/empty',
            '',
            '[Install4F96D1932A9F858E]',
            'Default=Profiles/abc.default'
          ].join('\n'),
          [`${FIREFOX}/Profiles/abc.default/places.sqlite`]: '',
          '/Volumes/work/firefox/places.sqlite': '',
          [`${FIREFOX}/Profiles/empty/prefs.js`]: ''
        },
        {},
        '/Users/ada'
      )
    )
    expect(found).toEqual([
      {
        id: 'firefox:Profiles/abc.default',
        browser: 'firefox',
        profile: 'default',
        bookmarksFile: `${FIREFOX}/Profiles/abc.default/places.sqlite`,
        historyFile: `${FIREFOX}/Profiles/abc.default/places.sqlite`
      },
      {
        id: 'firefox:/Volumes/work/firefox',
        browser: 'firefox',
        profile: 'Work',
        bookmarksFile: '/Volumes/work/firefox/places.sqlite',
        historyFile: '/Volumes/work/firefox/places.sqlite'
      }
    ])
  })

  it('resolves a relative Firefox path with the platform’s separators', () => {
    const root = 'C:\\Users\\ada\\AppData\\Roaming\\Mozilla\\Firefox'
    const found = detectProfiles(
      machine(
        'win32',
        {
          [`${root}\\profiles.ini`]:
            '[Profile0]\r\nName=default-release\r\nPath=Profiles/x.default-release\r\n',
          [`${root}\\Profiles\\x.default-release\\places.sqlite`]: ''
        },
        { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }
      )
    )
    expect(found.map((profile) => profile.historyFile)).toEqual([
      `${root}\\Profiles\\x.default-release\\places.sqlite`
    ])
  })

  it('names a Firefox profile by its folder when it has no name, and lists none from an unreadable ini', () => {
    const named = detectProfiles(
      machine(
        'darwin',
        {
          [`${FIREFOX}/profiles.ini`]: '[Profile0]\nPath=Profiles/p\n',
          [`${FIREFOX}/Profiles/p/places.sqlite`]: ''
        },
        {},
        '/Users/ada'
      )
    )
    expect(named.map((profile) => profile.profile)).toEqual(['Profiles/p'])
    const unreadable = machine('darwin', { [`${FIREFOX}/profiles.ini/odd`]: '' }, {}, '/Users/ada')
    expect(detectProfiles(unreadable)).toEqual([])
  })

  it('does not list a browser that is not installed', () => {
    expect(detectProfiles(machine('darwin', {}, {}, '/Users/ada'))).toEqual([])
    // Firefox's folder without profiles.ini, and a Chrome folder without a profile.
    expect(
      detectProfiles(
        machine(
          'darwin',
          { [`${FIREFOX}/Crash Reports/x`]: '', [`${CHROME}/Local State`]: '{}' },
          {},
          '/Users/ada'
        )
      )
    ).toEqual([])
  })

  it('lists the Chromium browsers in a fixed order: Chrome, Edge, Chromium, then Firefox', () => {
    const found = detectProfiles(
      machine('linux', {
        '/home/ada/.mozilla/firefox/profiles.ini': '[Profile0]\nName=f\nPath=p\n',
        '/home/ada/.mozilla/firefox/p/places.sqlite': '',
        '/home/ada/snap/chromium/common/chromium/Default/History': '',
        '/home/ada/.config/microsoft-edge/Default/Bookmarks': '',
        '/home/ada/.config/google-chrome/Default/History': ''
      })
    )
    expect(found.map((profile) => profile.id)).toEqual([
      'chrome:Default',
      'edge:Default',
      'chromium:Default',
      'firefox:p'
    ])
  })
})

describe('the details that decide a listing', () => {
  const CHROME = '/Users/ada/Library/Application Support/Google/Chrome'
  const FIREFOX = '/Users/ada/Library/Application Support/Firefox'

  it('orders Default first and the numbered profiles by number, and trims a profile’s name', () => {
    const found = detectProfiles(
      machine(
        'darwin',
        {
          [`${CHROME}/Profile 10/History`]: '',
          [`${CHROME}/Profile 2/History`]: '',
          [`${CHROME}/Default/History`]: '',
          [`${CHROME}/Local State`]: JSON.stringify({
            profile: { info_cache: { 'Profile 2': { name: '  Work  ' }, Default: { name: '   ' } } }
          })
        },
        {},
        '/Users/ada'
      )
    )
    expect(found.map((profile) => [profile.id, profile.profile])).toEqual([
      ['chrome:Default', 'Default'],
      ['chrome:Profile 2', 'Work'],
      ['chrome:Profile 10', 'Profile 10']
    ])
  })

  it('lists only [Profile…] sections, and reads indented and commented lines as Firefox does', () => {
    const found = detectProfiles(
      machine(
        'darwin',
        {
          [`${FIREFOX}/profiles.ini`]: [
            '[General]',
            'Path=general',
            '  [Profile0]  ',
            '  Name = Indented  ',
            ';Name=commented',
            'Path=p',
            '=nokey'
          ].join('\n'),
          [`${FIREFOX}/general/places.sqlite`]: '',
          [`${FIREFOX}/p/places.sqlite`]: ''
        },
        {},
        '/Users/ada'
      )
    )
    expect(found.map((profile) => [profile.id, profile.profile])).toEqual([
      ['firefox:p', 'Indented']
    ])
    expect(parseProfilesIni('x [Profile9]\n[Profile1] y\nPath=q')).toEqual([])
  })
})

describe('profiles.ini', () => {
  it('reads sections, keys and values, and ignores comments and stray lines', () => {
    expect(
      parseProfilesIni('; comment\n# too\nstray\n[Profile0]\n Name = A b \nPath=x=y\n[Empty]\n')
    ).toEqual([
      { section: 'Profile0', values: { Name: 'A b', Path: 'x=y' } },
      { section: 'Empty', values: {} }
    ])
  })
})

describe('on this machine', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads the real file system, and answers null for a file that is not there', () => {
    const home = mkdtempSync(join(tmpdir(), 'tessera-profiles-'))
    dirs.push(home)
    const real = currentMachine()
    expect(real.platform).toBe(process.platform)
    expect(real.home.length).toBeGreaterThan(0)
    const probe = { ...real, platform: 'linux', env: {}, home }
    mkdirSync(join(home, '.config/chromium/Default'), { recursive: true })
    writeFileSync(join(home, '.config/chromium/Default/History'), '')
    expect(detectProfiles(probe).map((profile) => profile.id)).toEqual(['chromium:Default'])
    expect(real.read(join(home, 'nothing'))).toBeNull()
    expect(real.list(join(home, 'nothing'))).toEqual([])
    expect(real.read(join(home, '.config/chromium/Default/History'))).toBe('')
  })
})
