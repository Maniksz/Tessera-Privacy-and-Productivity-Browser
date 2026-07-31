/**
 * What every setting is called and, where the name cannot say it, what it does. English.
 *
 * The reference table: `settings-text.de.ts` is typed against `typeof en`, so the compiler
 * refuses a German file that misses an entry, invents one, omits a description this file
 * gives, or labels a different set of enum members. Same arrangement as the message
 * catalogue, for the same reason — a translation that silently drifts is worse than one
 * that is missing, because nothing looks wrong.
 *
 * See `settings-text.ts` for why these strings are here in the core and not in
 * `shared/i18n/catalog.*`, and for why the table is nested rather than keyed by the full
 * setting key. Both of those are load-bearing; neither is tidiness.
 *
 * ## Which settings get a description
 *
 * A label for all of them; a description only where one of these is true:
 *
 *   1. the label cannot tell you what changes — `adaptLayoutToTabs`, `webrtcIpPolicy`;
 *   2. it has a cost or a reach the name implies but does not have — masking that stops at
 *      the iframe boundary, cosmetic filtering that can hide something wanted;
 *   3. it sends something to a third party;
 *   4. it is declared and **not honoured yet**, so the switch moves and nothing happens;
 *   5. two settings do the same thing, and the user needs to be told which is which.
 *
 * Anything else stands on its label alone. A description restating the label is noise, and
 * noise is what makes the five cases above get skipped.
 *
 * ## The "not applied yet" sentences are a debt, not a feature
 *
 * Case 4 above accounts for a dozen of these. They exist because a switch that flips and
 * changes nothing is the failure spec 5 is written against, and saying so beside the switch
 * is the only honest thing to do until it is implemented. Each one corresponds to an entry
 * in the `notYetRead` list in `tests/architecture.test.ts` — **when a key earns its way off
 * that list, its sentence here has to go with it.** Nothing enforces that pairing, because
 * a test reading another test's allowlist would be worse than the coupling it guards.
 */

export interface SettingText {
  label: string
  /** Only where the label cannot carry it; see the rule above. */
  description?: string
  /** Readable names for enum members, keyed by member. */
  choices?: Readonly<Record<string, string>>
}

/**
 * Nested by the key's own prefix, and the nesting is deliberate; see `settings-text.ts`.
 *
 * `satisfies` rather than an annotation, so `typeof en` keeps the exact shape — which is
 * what lets the German file be checked entry by entry instead of merely being a table of
 * strings.
 */
export const en = {
  appearance: {
    theme: {
      label: 'Theme',
      description:
        'Not applied yet: the interface follows the operating system’s light or dark setting through CSS, so choosing one here changes nothing at the moment.',
      choices: { system: 'Follow the system', light: 'Light', dark: 'Dark' }
    },
    uiLanguage: {
      label: 'Interface language',
      description:
        'The browser’s own menus and screens. Web pages are unaffected, and no restart is needed.',
      choices: { system: 'Follow the system', de: 'Deutsch', en: 'English' }
    },
    showBookmarksBar: { label: 'Show the bookmarks bar' },
    defaultZoom: {
      label: 'Default zoom (per cent)',
      description:
        'Applies to every pane that has never been zoomed by hand. A pane you zoomed keeps its own level until Reset Zoom puts it back in this group.'
    },
    tabBarPosition: {
      label: 'Position of the tab strip',
      description: 'Not applied yet: the strip is always drawn at the top.',
      choices: { top: 'Top', bottom: 'Bottom' }
    }
  },

  search: {
    defaultEngine: {
      label: 'Search engine',
      description:
        'The four named engines were chosen because none of them builds a profile from the query.',
      choices: {
        duckduckgo: 'DuckDuckGo',
        startpage: 'Startpage',
        brave: 'Brave Search',
        mojeek: 'Mojeek',
        custom: 'A custom address'
      }
    },
    customEngineUrl: {
      label: 'Custom search address',
      description:
        'Used only while the engine above is set to a custom address, and only if it contains {query} where the search term belongs. Without that placeholder the browser falls back to DuckDuckGo rather than opening a broken address.'
    },
    suggestFromHistory: {
      label: 'Suggest pages from the history',
      description: 'Not applied yet: the address bar draws no suggestions from the history.'
    },
    suggestFromBookmarks: {
      label: 'Suggest pages from the bookmarks',
      description: 'Not applied yet either.'
    },
    suggestFromOpenTabs: {
      label: 'Suggest open tabs',
      description: 'Not applied yet: the address bar never consults the open tabs.'
    },
    remoteSuggestions: {
      label: 'Suggestions from the search engine',
      description:
        'Off by default because it would send what you type to the search engine as you type it, before you press Enter. Nothing is fetched yet, so the switch currently guards nothing.'
    }
  },

  splitView: {
    // No `choices` here on purpose: the members are `1x2`, `2x2` and so on. They read the same
    // in every language, and inventing a translation would only make the two locales differ.
    defaultLayout: { label: 'Layout for a new window' },
    restoreLayoutOnStart: { label: 'Restore the last layout on start' },
    showTileHeaders: {
      label: 'Show a header on each tile',
      description:
        'Not applied yet: tiles have no header. The tile bar further down is what a tile shows today.'
    },
    adaptLayoutToTabs: {
      label: 'Keep every tile filled',
      description:
        'An empty tile is given something to show — a tab that is already open but hidden, or a fresh start page — and a tile whose tab you close is taken away again. Off means the arrangement is yours: a tile you add stays empty, a tile whose tab closed stays there, and nothing moves between tiles that you did not move. Each start page opened this way is its own process, which is real memory on a small machine.'
    },
    fullscreenScope: {
      label: 'Fullscreen requested by a website',
      description:
        'Where a website’s own fullscreen button goes. Within its tile keeps the other tiles visible; whole window is what other browsers do. F11 always takes the whole window either way — that one is your request, not the page’s.',
      choices: { tile: 'Stays within its tile', window: 'Takes the whole window' }
    },
    onlyActiveTileAudible: {
      label: 'Only the active tile may play sound',
      description:
        'This and the switch below currently do the same thing — either one on mutes every tile but the active one. Two keys for one behaviour is a defect in the settings table, not in the code that reads them.'
    },
    muteAllButActive: {
      label: 'Mute every tile but the active one',
      description: 'The same behaviour as the switch above; either one on is enough.'
    },
    throttleInactiveTiles: {
      label: 'Slow down tiles in the background',
      description:
        'Chromium slows background content by default, which stalls the video in a tile you are not focused on — the exact thing split view exists to avoid. Turning this on saves battery and costs precisely that.'
    },
    tileBarMode: {
      label: 'Tile bar',
      description:
        'The small navigation bar a tile can show for itself. The keyboard route works in every mode but Never, so the bar is never pointer-only.',
      choices: {
        hover: 'When the pointer nears the tile',
        keyboard: 'Only on the keyboard shortcut',
        off: 'Never'
      }
    },
    autoplayInTiles: {
      label: 'Media that starts by itself',
      choices: { allow: 'Allow', block: 'Block' }
    }
  },

  privacy: {
    blockerEnabled: { label: 'Block adverts and trackers' },
    blockerLists: {
      label: 'Filter lists',
      description:
        'One address per line. The last two of the default four remove cookie banners and anti-adblock walls: they change what a page shows rather than what it loads, so a wrong rule there hides something you wanted to see.'
    },
    cosmeticFiltering: {
      label: 'Hide the space a blocked element left',
      description:
        'Without this a blocked advert leaves a hole in the layout. With it the page’s own layout is changed, so a false positive hides something real.'
    },
    scriptletInjection: {
      label: 'Counter scripts that detect blocking',
      description:
        'Filter lists carry small named countermeasures for pages whose own script decides what to show — an anti-adblock wall, an overlay on a timer, a redirect from a click anywhere. This runs them. The list may only name a countermeasure this browser ships and pass it text; no code from a list is ever executed.'
    },
    blockerOffForSites: {
      label: 'Do not filter these sites',
      description:
        'One host per line. Added by the “Blocking on this site” switch in the blocker menu, and editable here. Filter lists and element hiding are switched off for these sites; HTTPS-only, cookie blocking, referrer trimming and fingerprint masking stay on.'
    },
    pageOpenedTabs: {
      label: 'Tabs a page opens by itself',
      description:
        'A tab the page opened with no click or keypress behind it — a popup on a timer, or one on page load. Something you opened yourself is always allowed, whatever this says: the check is a real input event seen by the browser, which a page cannot fake.',
      choices: {
        allow: 'Always open',
        ask: 'Ask each time',
        block: 'Never open'
      }
    },
    pageInitiatedRedirects: {
      label: 'Redirects a page performs by itself',
      description:
        'Only redirects that leave the site, and only for the tab itself. A site moving you around within itself, and an embedded frame moving itself, are left alone — prompting for those would mean dialogues on sites doing nothing wrong. A redirect fired from a click has a gesture behind it and is allowed; the countermeasure setting above is what deals with those.',
      choices: {
        allow: 'Always follow',
        ask: 'Ask each time',
        block: 'Never follow'
      }
    },
    blockRedirectTrackers: {
      label: 'Block redirect trackers',
      description:
        'Some links travel through a counting server before arriving where they said they would. This goes straight to the destination.'
    },
    stripTrackingParameters: {
      label: 'Remove tracking parameters from addresses',
      description:
        'Trims the parts of an address that identify you rather than the page — the utm_ family and its relatives — before the request leaves.'
    },
    blockTelemetryDomains: { label: 'Block telemetry domains' },
    httpsOnlyMode: { label: 'Use HTTPS only' },
    blockThirdPartyCookies: { label: 'Block third-party cookies' },
    referrerPolicy: {
      label: 'What sites are told about where you came from',
      description:
        'A page you follow a link from is normally named in the request. Going from an encrypted page to an unencrypted one never sends it, whichever of these is chosen.',
      choices: {
        'origin-only': 'Only the site, never the page — and only across sites',
        strict: 'Nothing at all',
        default: 'Whatever the page asks for'
      }
    },
    sendDoNotTrack: {
      label: 'Send the Do Not Track request',
      description:
        'A request, not a rule: almost no site honours it, and sending it is itself one more small thing that tells this browser apart from others.'
    },
    sendGlobalPrivacyControl: {
      label: 'Send Global Privacy Control',
      description:
        'The same idea as Do Not Track, except that some jurisdictions treat it as a legally binding objection rather than a wish.'
    },
    partitionStatePerSite: {
      label: 'Keep storage separate per site',
      description:
        'Would stop a service embedded in two different sites from recognising you across both, by giving it separate storage in each. Not applied yet: there is one partition per browsing mode, never one per site.'
    },
    malwareProtection: {
      label: 'Warn about dangerous sites',
      description:
        'A local list only. The usual alternative asks a third party about every address you visit, which is the trade this browser refuses. Not applied yet: no list is consulted.',
      choices: { 'local-list': 'From a local list', off: 'Off' }
    }
  },

  fingerprint: {
    mode: {
      label: 'Fingerprint masking',
      description:
        'How this browser answers the questions a site asks in order to recognise the machine. Uniform means every profile answers alike — random answers would make you more identifiable rather than less, because no two visits would agree. Everything below only reaches the page’s own scripts: a preload does not run in an iframe or in a worker, so a measurement taken there still sees the real values.',
      choices: { uniform: 'Uniform for every profile', off: 'Off' }
    },
    normalizeUserAgent: { label: 'Report a uniform browser identification' },
    normalizeClientHints: { label: 'Report uniform client hints' },
    normalizeAcceptLanguage: {
      label: 'Report a uniform language preference',
      description:
        'Sites are told one fixed list instead of yours, so a multilingual site may greet you in the wrong language.'
    },
    maskCanvas: {
      label: 'Mask what a canvas reads back',
      description:
        'A site that draws into a canvas and reads it back pixel by pixel gets a slightly altered result. Pages that read a canvas for a real reason — image editors, some maps — may misbehave.'
    },
    maskWebgl: {
      label: 'Mask the graphics adapter',
      description: 'Hides which card this is. A 3D page may fall back to a slower renderer.'
    },
    maskAudio: {
      label: 'Mask the audio fingerprint',
      description:
        'Alters the measurement a site takes of the audio engine. What you hear is unaffected.'
    },
    limitFonts: {
      label: 'Limit the fonts a site can see',
      description:
        'Sites see a standard set rather than everything installed, because the installed set is close to unique. A page insisting on a font you have may render in a substitute.'
    },
    normalizeScreen: {
      label: 'Report a uniform screen size',
      description:
        'Your real screen and window size are among the most identifying things a page can measure. A page that lays itself out from them may pick a layout meant for another size.'
    },
    blockDeviceApis: {
      label: 'Refuse the list of attached devices',
      description:
        'A site asking which cameras and microphones exist is told nothing. A video-call page may then not offer a device picker.'
    },
    spoofTimezone: {
      label: 'Time zone reported to sites',
      description:
        'Leave empty to report the real one. A zone name such as Europe/Berlin; anything unusable is ignored rather than guessed at.'
    },
    spoofLocale: {
      label: 'Locale reported to sites',
      description: 'Leave empty to report the real one. A language tag such as de-DE.'
    }
  },

  permissions: {
    geolocation: {
      label: 'Location',
      choices: { ask: 'Ask each time', allow: 'Allow', deny: 'Deny' }
    },
    camera: { label: 'Camera', choices: { ask: 'Ask each time', allow: 'Allow', deny: 'Deny' } },
    microphone: {
      label: 'Microphone',
      choices: { ask: 'Ask each time', allow: 'Allow', deny: 'Deny' }
    },
    notifications: {
      label: 'Notifications',
      choices: { ask: 'Ask each time', allow: 'Allow', deny: 'Deny' }
    },
    clipboard: {
      label: 'Clipboard',
      description:
        'Covers both a site reading the clipboard and a site writing to it. Copying and pasting yourself is not affected.',
      choices: { ask: 'Ask each time', allow: 'Allow', deny: 'Deny' }
    },
    displayCapture: {
      label: 'Screen sharing',
      description: 'A site asking to record or share a window, a tab or the whole screen.',
      choices: { ask: 'Ask each time', allow: 'Allow', deny: 'Deny' }
    },
    persistentStorage: {
      label: 'Persistent storage',
      description:
        'A site asking for storage the browser will not clear on its own when disk space runs short.',
      choices: { ask: 'Ask each time', allow: 'Allow', deny: 'Deny' }
    },
    midi: {
      label: 'MIDI devices',
      description: 'Access to attached musical instruments and control surfaces.',
      choices: { ask: 'Ask each time', allow: 'Allow', deny: 'Deny' }
    }
  },

  network: {
    proxyMode: {
      label: 'Proxy',
      description: 'Not applied yet: no proxy is ever configured from this screen.',
      choices: { direct: 'No proxy', system: 'Use the system setting', manual: 'Set one below' }
    },
    proxyUrl: {
      label: 'Proxy address',
      description: 'Stored and read by nothing, for the same reason as the setting above.'
    },
    killSwitch: {
      label: 'Stop all traffic if the tunnel drops',
      description:
        'Not implemented. Nothing enforces this today, so do not rely on it: with the switch on and a VPN dropping, requests still go out.'
    },
    secureDnsMode: {
      label: 'Encrypted DNS',
      description:
        'Turning an address into a number is normally done in the clear, where the network can read and change it. This asks the servers below over HTTPS instead.',
      choices: {
        secure: 'Always encrypted, never fall back',
        automatic: 'Encrypted where possible',
        off: 'Off'
      }
    },
    secureDnsServers: {
      label: 'DNS servers',
      description: 'One address per line. Used only while encrypted DNS is not off.'
    },
    webrtcIpPolicy: {
      label: 'Local addresses over WebRTC',
      description:
        'WebRTC can disclose the machine’s local address, and its real one from behind a VPN, without the page asking for a permission. The strictest choice closes that; the price is that some video-call sites will not connect.',
      choices: {
        default: 'No restriction',
        default_public_interface_only: 'Only the public interface',
        disable_non_proxied_udp: 'Nothing that bypasses the proxy'
      }
    }
  },

  downloads: {
    directory: {
      label: 'Download folder',
      description:
        'Leave empty for the system’s own downloads folder, which is also what a relative path falls back to.'
    },
    askForEachFile: { label: 'Ask where to save every file' }
  },

  session: {
    startupBehaviour: {
      label: 'On start, open',
      choices: {
        'speed-dial': 'The start page',
        blank: 'An empty tab',
        restore: 'The last session',
        'custom-url': 'A fixed address'
      }
    },
    customStartupUrl: {
      label: 'Fixed start address',
      description: 'Used only while the setting above is set to a fixed address.'
    },
    restoreOnStart: {
      label: 'Restore the last session',
      description:
        'The same thing the setting above can say, expressed twice: either one asks for a restore, so this box on is enough even if the dropdown says something else. Two keys for one behaviour is a defect in the settings table.'
    },
    restoreAfterCrash: {
      label: 'Restore after a crash',
      description:
        'Independent of the two settings above: after an unclean exit the tabs come back even when an ordinary start would not restore them.'
    }
  },

  clearData: {
    onExit: { label: 'Clear data when the browser closes' },
    onExitCategories: {
      label: 'What gets cleared',
      description:
        'One per line, from: cookies, cache, storage, history, downloads, formData. Anything else is refused.'
    }
  },

  advanced: {
    hardwareAcceleration: {
      label: 'Hardware acceleration',
      description:
        'Draws through the graphics card. Turning it off is the usual cure for flickering or blank content, and costs speed.'
    },
    spellcheck: { label: 'Check spelling as you type' },
    spellcheckLanguages: {
      label: 'Spell-check languages',
      description:
        'One language tag per line, such as de-DE. Not applied yet: the session’s spellchecker is never told about this list.'
    },
    unloadInactiveTabs: {
      label: 'Unload tabs you have not used',
      description:
        'Would free a sleeping tab’s memory and reload it when you return to it. Not implemented: no tab is ever unloaded on a timer.'
    },
    unloadAfterMinutes: {
      label: 'Unload after (minutes)',
      description: 'The timer for the setting above, which nothing runs yet.'
    },
    customShortcuts: {
      label: 'Custom keyboard shortcuts',
      description:
        'Shown here, edited elsewhere. Each entry replaces one action’s default key with the accelerator given.'
    }
  },

  updates: {
    checkAutomaticallyOnGithub: {
      label: 'Check for new versions automatically (at GitHub)',
      description:
        'Every check asks GitHub for the release list, so GitHub sees an IP address and, in aggregate, how many people run this browser. Checking is all it does: nothing is downloaded and nothing is installed without you agreeing to each step.'
    },
    channel: {
      label: 'Which releases you are told about',
      description:
        'Every version published so far is a prerelease, and GitHub’s "latest release" excludes those — so choosing stable today means never being offered anything at all. That changes with the first release that is not a prerelease.',
      choices: { stable: 'Stable versions only', alpha: 'Alpha, including prereleases' }
    }
  }
} satisfies Readonly<Record<string, Readonly<Record<string, SettingText>>>>

/**
 * The exact shape of the reference table.
 *
 * Exported so `settings-text.de.ts` can be annotated with it: that turns a missing entry, a
 * stray one, a description present in one language and absent in the other, and a differing
 * set of enum members into four compile errors instead of four things a reader has to notice.
 */
export type SettingTextTable = typeof en
