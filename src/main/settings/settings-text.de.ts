import type { SettingTextTable } from './settings-text.en.js'

/**
 * The German half of the settings text.
 *
 * Annotated with `SettingTextTable`, which is `typeof en` — so this file cannot miss an
 * entry, add one the English table does not have, drop a description its counterpart gives,
 * or label a different set of enum members. All four are compile errors here rather than
 * something a reader has to spot, which is the same guarantee `catalog.de.ts` gets from
 * `Catalog`.
 *
 * German, not a translation of English word for word: the German sentence for a cost or a
 * limitation should read as if it had been written in German. Where the English text names a
 * placeholder such as {query}, the German one has to name it too — the guard in
 * `tests/settings-describe.test.ts` compares the placeholder sets, because a translation that
 * loses one loses the only part of the sentence the user has to type.
 */
export const de: SettingTextTable = {
  appearance: {
    theme: {
      label: 'Erscheinungsbild',
      description:
        'Noch ohne Wirkung: Die Oberfläche folgt über CSS der Hell-/Dunkel-Einstellung des Betriebssystems. Eine Auswahl hier ändert derzeit nichts.',
      choices: { system: 'Dem System folgen', light: 'Hell', dark: 'Dunkel' }
    },
    uiLanguage: {
      label: 'Sprache der Oberfläche',
      description:
        'Menüs und Fenster des Browsers selbst. Webseiten bleiben unberührt, und ein Neustart ist nicht nötig.',
      choices: { system: 'Dem System folgen', de: 'Deutsch', en: 'English' }
    },
    showBookmarksBar: { label: 'Lesezeichenleiste anzeigen' },
    defaultZoom: {
      label: 'Standardzoom (Prozent)',
      description:
        'Gilt für jeden Bereich, der noch nie von Hand gezoomt wurde. Ein selbst gezoomter Bereich behält seine eigene Stufe, bis „Zoom zurücksetzen“ ihn wieder in diese Gruppe holt.'
    },
    tabBarPosition: {
      label: 'Position der Tableiste',
      description: 'Noch ohne Wirkung: Die Leiste wird immer oben gezeichnet.',
      choices: { top: 'Oben', bottom: 'Unten' }
    }
  },

  search: {
    defaultEngine: {
      label: 'Suchmaschine',
      description:
        'Die vier genannten Dienste stehen hier, weil keiner von ihnen aus der Suchanfrage ein Profil aufbaut.',
      choices: {
        duckduckgo: 'DuckDuckGo',
        startpage: 'Startpage',
        brave: 'Brave Search',
        mojeek: 'Mojeek',
        custom: 'Eigene Adresse'
      }
    },
    customEngineUrl: {
      label: 'Eigene Suchadresse',
      description:
        'Wird nur verwendet, solange oben „Eigene Adresse“ gewählt ist – und nur, wenn sie {query} an der Stelle des Suchbegriffs enthält. Fehlt der Platzhalter, weicht der Browser auf DuckDuckGo aus, statt eine kaputte Adresse zu öffnen.'
    },
    suggestFromHistory: {
      label: 'Seiten aus dem Verlauf vorschlagen',
      description: 'Noch ohne Wirkung: Die Adressleiste zieht keine Vorschläge aus dem Verlauf.'
    },
    suggestFromBookmarks: {
      label: 'Seiten aus den Lesezeichen vorschlagen',
      description: 'Ebenfalls noch ohne Wirkung.'
    },
    suggestFromOpenTabs: {
      label: 'Offene Tabs vorschlagen',
      description: 'Noch ohne Wirkung: Die Adressleiste fragt die offenen Tabs nie ab.'
    },
    remoteSuggestions: {
      label: 'Vorschläge von der Suchmaschine',
      description:
        'Standardmäßig aus, weil dabei jedes getippte Zeichen an die Suchmaschine ginge, noch vor dem Drücken der Eingabetaste. Es wird ohnehin noch nichts abgerufen, der Schalter schützt derzeit also nichts.'
    }
  },

  splitView: {
    defaultLayout: { label: 'Layout für ein neues Fenster' },
    restoreLayoutOnStart: { label: 'Letztes Layout beim Start wiederherstellen' },
    showTileHeaders: {
      label: 'Kopfzeile je Kachel anzeigen',
      description:
        'Noch ohne Wirkung: Kacheln haben keine Kopfzeile. Was eine Kachel heute zeigt, ist die Kachelleiste weiter unten.'
    },
    adaptLayoutToTabs: {
      label: 'Kacheln gefüllt halten',
      description:
        'Eine leere Kachel bekommt etwas zu zeigen – einen bereits geladenen, aber verborgenen Tab oder sonst eine frische Startseite – und eine Kachel, deren Tab geschlossen wird, verschwindet wieder. Aus heißt: Die Anordnung gehört dir. Eine neu angelegte Kachel bleibt leer, eine Kachel mit geschlossenem Tab bleibt stehen, und nichts wandert zwischen Kacheln, was du nicht selbst bewegt hast. Jede so geöffnete Startseite ist ein eigener Prozess, also echter Arbeitsspeicher auf einer kleinen Maschine.'
    },
    fullscreenScope: {
      label: 'Vollbild, das eine Website anfordert',
      description:
        'Wohin der Vollbild-Knopf einer Website führt. Innerhalb der Kachel lässt die übrigen Kacheln sichtbar, ganzes Fenster entspricht anderen Browsern. F11 nimmt in jedem Fall das ganze Fenster – das ist deine Anforderung, nicht die der Seite.',
      choices: { tile: 'Bleibt in seiner Kachel', window: 'Nimmt das ganze Fenster' }
    },
    onlyActiveTileAudible: {
      label: 'Nur die aktive Kachel darf Ton ausgeben',
      description:
        'Dieser Schalter und der nächste bewirken derzeit dasselbe – einer von beiden genügt, um alle Kacheln außer der aktiven stummzuschalten. Zwei Schlüssel für ein Verhalten ist ein Fehler in der Einstellungstabelle, nicht im Code, der sie liest.'
    },
    muteAllButActive: {
      label: 'Alle Kacheln außer der aktiven stummschalten',
      description: 'Dasselbe Verhalten wie der Schalter darüber; einer von beiden genügt.'
    },
    throttleInactiveTiles: {
      label: 'Kacheln im Hintergrund drosseln',
      description:
        'Chromium bremst Inhalte im Hintergrund von sich aus, wodurch das Video in einer nicht fokussierten Kachel stockt – genau das, wogegen die geteilte Ansicht gebaut ist. Einschalten spart Akku und kostet genau das.'
    },
    tileBarMode: {
      label: 'Kachelleiste',
      description:
        'Die kleine Navigationsleiste, die eine Kachel für sich selbst einblenden kann. Der Weg über die Tastatur funktioniert in jedem Modus außer „Nie“, die Leiste ist also nie nur mit der Maus erreichbar.',
      choices: {
        hover: 'Wenn der Zeiger der Kachel nahekommt',
        keyboard: 'Nur über das Tastenkürzel',
        off: 'Nie'
      }
    },
    autoplayInTiles: {
      label: 'Medien, die von selbst starten',
      choices: { allow: 'Erlauben', block: 'Blockieren' }
    }
  },

  privacy: {
    blockerEnabled: { label: 'Werbung und Tracker blockieren' },
    blockerLists: {
      label: 'Filterlisten',
      description:
        'Eine Adresse je Zeile. Die letzten beiden der vier voreingestellten Listen entfernen Cookie-Banner und Adblock-Sperren: Sie verändern, was eine Seite zeigt, nicht was sie lädt – ein Fehlgriff blendet dort also etwas aus, das du sehen wolltest.'
    },
    scriptletInjection: {
      label: 'Skripte kontern, die Blocker erkennen',
      description:
        'Filterlisten enthalten kleine benannte Gegenmaßnahmen für Seiten, bei denen das eigene Skript entscheidet, was zu sehen ist – eine Adblock-Sperre, ein Overlay per Timer, eine Weiterleitung bei jedem Klick. Dies führt sie aus. Eine Liste darf nur eine Gegenmaßnahme benennen, die dieser Browser mitbringt, und ihr Text übergeben; Code aus einer Liste wird nie ausgeführt.'
    },
    blockerOffForSites: {
      label: 'Diese Seiten nicht filtern',
      description:
        'Ein Host je Zeile. Wird vom Schalter „Auf dieser Seite blockieren“ im Blocker-Menü gefüllt und ist hier bearbeitbar. Für diese Seiten sind Filterlisten und das Ausblenden von Elementen aus; Nur-HTTPS, Cookie-Blockade, Referrer-Kürzung und Fingerprint-Maskierung bleiben an.'
    },
    cosmeticFiltering: {
      label: 'Lücke blockierter Elemente ausblenden',
      description:
        'Ohne dies hinterlässt eine blockierte Anzeige ein Loch im Layout. Damit wird das Layout der Seite selbst verändert, ein Fehlgriff verbirgt also etwas Echtes.'
    },
    pageOpenedTabs: {
      label: 'Tabs, die eine Seite selbst öffnet',
      description:
        'Ein Tab, hinter dem kein Klick und kein Tastendruck steht – ein Popup per Timer oder beim Laden der Seite. Was du selbst öffnest, ist immer erlaubt, egal was hier steht: geprüft wird ein echtes Eingabeereignis, das der Browser gesehen hat, und das kann eine Seite nicht vortäuschen.',
      choices: {
        allow: 'Immer öffnen',
        ask: 'Jedes Mal fragen',
        block: 'Nie öffnen'
      }
    },
    pageInitiatedRedirects: {
      label: 'Weiterleitungen, die eine Seite selbst auslöst',
      description:
        'Nur Weiterleitungen, die die Seite verlassen, und nur für den Tab selbst. Wenn eine Seite dich innerhalb ihrer selbst weiterschickt oder ein eingebetteter Rahmen sich selbst weiterschickt, bleibt das unberührt – dafür zu fragen hieße, auf Seiten zu fragen, die nichts falsch machen. Eine Weiterleitung aus einem Klick hat eine Geste hinter sich und ist erlaubt; dafür ist die Einstellung zu den Gegenmaßnahmen da.',
      choices: {
        allow: 'Immer folgen',
        ask: 'Jedes Mal fragen',
        block: 'Nie folgen'
      }
    },
    blockRedirectTrackers: {
      label: 'Weiterleitungs-Tracker blockieren',
      description:
        'Manche Links laufen erst über einen Zählserver, bevor sie dort ankommen, wohin sie zu führen versprachen. Dies geht direkt zum Ziel.'
    },
    stripTrackingParameters: {
      label: 'Tracking-Parameter aus Adressen entfernen',
      description:
        'Schneidet die Teile einer Adresse ab, die nicht die Seite, sondern dich bezeichnen – die utm_-Familie und ihre Verwandten – bevor die Anfrage hinausgeht.'
    },
    blockTelemetryDomains: { label: 'Telemetrie-Domains blockieren' },
    httpsOnlyMode: { label: 'Nur HTTPS verwenden' },
    blockThirdPartyCookies: { label: 'Cookies von Drittanbietern blockieren' },
    referrerPolicy: {
      label: 'Was Seiten über deine Herkunft erfahren',
      description:
        'Die Seite, von der ein Link ausging, steht normalerweise in der Anfrage. Von einer verschlüsselten auf eine unverschlüsselte Seite wird sie nie mitgeschickt, unabhängig von dieser Wahl.',
      choices: {
        'origin-only': 'Nur die Website, nie die Seite – und nur seitenübergreifend',
        strict: 'Gar nichts',
        default: 'Was die Seite verlangt'
      }
    },
    sendDoNotTrack: {
      label: 'Do-Not-Track-Bitte senden',
      description:
        'Eine Bitte, keine Regel: Kaum eine Website hält sich daran, und das Senden selbst ist eine weitere Kleinigkeit, die diesen Browser von anderen unterscheidbar macht.'
    },
    sendGlobalPrivacyControl: {
      label: 'Global Privacy Control senden',
      description:
        'Dieselbe Idee wie Do Not Track, nur behandeln manche Rechtsordnungen es als rechtsverbindlichen Widerspruch statt als Wunsch.'
    },
    partitionStatePerSite: {
      label: 'Speicher pro Website trennen',
      description:
        'Würde verhindern, dass ein in zwei Websites eingebetteter Dienst dich auf beiden wiedererkennt, indem er in jeder eigenen Speicher bekommt. Noch ohne Wirkung: Es gibt eine Partition je Browsing-Modus, nie eine je Website.'
    },
    malwareProtection: {
      label: 'Vor gefährlichen Seiten warnen',
      description:
        'Ausschließlich über eine lokale Liste. Die übliche Alternative fragt für jede besuchte Adresse bei einem Dritten nach – genau der Handel, den dieser Browser ablehnt. Noch ohne Wirkung: Es wird keine Liste befragt.',
      choices: { 'local-list': 'Über eine lokale Liste', off: 'Aus' }
    }
  },

  fingerprint: {
    mode: {
      label: 'Fingerprint-Maskierung',
      description:
        'Wie dieser Browser die Fragen beantwortet, mit denen eine Website die Maschine wiedererkennen will. Einheitlich heißt: Jedes Profil antwortet gleich – zufällige Antworten würden dich erkennbarer machen statt unauffälliger, weil keine zwei Besuche übereinstimmten. Alles Folgende erreicht nur die Skripte der Seite selbst: Ein Preload läuft weder in einem iframe noch in einem Worker, dort gemessene Werte sind also die echten.',
      choices: { uniform: 'Für jedes Profil gleich', off: 'Aus' }
    },
    normalizeUserAgent: { label: 'Einheitliche Browserkennung melden' },
    normalizeClientHints: { label: 'Einheitliche Client Hints melden' },
    normalizeAcceptLanguage: {
      label: 'Einheitliche Sprachwünsche melden',
      description:
        'Websites bekommen eine feste Liste statt deiner, eine mehrsprachige Seite begrüßt dich also womöglich in der falschen Sprache.'
    },
    maskCanvas: {
      label: 'Auslesen eines Canvas maskieren',
      description:
        'Eine Website, die in ein Canvas zeichnet und es Pixel für Pixel zurückliest, erhält ein leicht verändertes Ergebnis. Seiten, die ein Canvas aus gutem Grund lesen – Bildbearbeitung, manche Karten – können sich merkwürdig verhalten.'
    },
    maskWebgl: {
      label: 'Grafikkarte maskieren',
      description:
        'Verbirgt, welche Karte das ist. Eine 3D-Seite weicht womöglich auf eine langsamere Darstellung aus.'
    },
    maskAudio: {
      label: 'Audio-Fingerprint maskieren',
      description:
        'Verändert die Messung, die eine Website an der Audio-Engine vornimmt. Was du hörst, bleibt gleich.'
    },
    limitFonts: {
      label: 'Sichtbare Schriften begrenzen',
      description:
        'Websites sehen einen Standardsatz statt aller installierten Schriften, denn der installierte Satz ist beinahe eindeutig. Eine Seite, die auf einer vorhandenen Schrift besteht, wird womöglich ersatzweise gesetzt.'
    },
    normalizeScreen: {
      label: 'Einheitliche Bildschirmgröße melden',
      description:
        'Echte Bildschirm- und Fenstergröße gehören zum Identifizierendsten, was eine Seite messen kann. Eine Seite, die ihr Layout daraus ableitet, wählt womöglich eines für eine andere Größe.'
    },
    blockDeviceApis: {
      label: 'Abfrage angeschlossener Geräte verweigern',
      description:
        'Eine Website, die nach vorhandenen Kameras und Mikrofonen fragt, erfährt nichts. Eine Videokonferenzseite bietet dann womöglich keine Geräteauswahl an.'
    },
    spoofTimezone: {
      label: 'Zeitzone, die Websites erfahren',
      description:
        'Leer lassen, um die echte zu melden. Ein Zonenname wie Europe/Berlin; Unbrauchbares wird ignoriert statt geraten.'
    },
    spoofLocale: {
      label: 'Gebietsschema, das Websites erfahren',
      description: 'Leer lassen, um das echte zu melden. Ein Sprachkürzel wie de-DE.'
    }
  },

  permissions: {
    geolocation: {
      label: 'Standort',
      choices: { ask: 'Jedes Mal fragen', allow: 'Erlauben', deny: 'Verweigern' }
    },
    camera: {
      label: 'Kamera',
      choices: { ask: 'Jedes Mal fragen', allow: 'Erlauben', deny: 'Verweigern' }
    },
    microphone: {
      label: 'Mikrofon',
      choices: { ask: 'Jedes Mal fragen', allow: 'Erlauben', deny: 'Verweigern' }
    },
    notifications: {
      label: 'Benachrichtigungen',
      choices: { ask: 'Jedes Mal fragen', allow: 'Erlauben', deny: 'Verweigern' }
    },
    clipboard: {
      label: 'Zwischenablage',
      description:
        'Betrifft sowohl das Lesen der Zwischenablage durch eine Website als auch das Schreiben hinein. Eigenes Kopieren und Einfügen ist nicht betroffen.',
      choices: { ask: 'Jedes Mal fragen', allow: 'Erlauben', deny: 'Verweigern' }
    },
    displayCapture: {
      label: 'Bildschirmfreigabe',
      description:
        'Eine Website, die ein Fenster, einen Tab oder den ganzen Bildschirm aufzeichnen oder teilen will.',
      choices: { ask: 'Jedes Mal fragen', allow: 'Erlauben', deny: 'Verweigern' }
    },
    persistentStorage: {
      label: 'Dauerhafter Speicher',
      description:
        'Eine Website, die Speicher anfordert, den der Browser bei knappem Platz nicht von sich aus leert.',
      choices: { ask: 'Jedes Mal fragen', allow: 'Erlauben', deny: 'Verweigern' }
    },
    midi: {
      label: 'MIDI-Geräte',
      description: 'Zugriff auf angeschlossene Musikinstrumente und Steuergeräte.',
      choices: { ask: 'Jedes Mal fragen', allow: 'Erlauben', deny: 'Verweigern' }
    }
  },

  network: {
    proxyMode: {
      label: 'Proxy',
      description: 'Noch ohne Wirkung: Aus diesem Fenster wird nie ein Proxy eingerichtet.',
      choices: {
        direct: 'Kein Proxy',
        system: 'Systemeinstellung verwenden',
        manual: 'Unten festlegen'
      }
    },
    proxyUrl: {
      label: 'Proxy-Adresse',
      description: 'Wird gespeichert und von nichts gelesen, aus demselben Grund wie oben.'
    },
    killSwitch: {
      label: 'Allen Verkehr stoppen, wenn der Tunnel abbricht',
      description:
        'Nicht umgesetzt. Nichts erzwingt das heute – verlass dich nicht darauf: Mit eingeschaltetem Schalter und abbrechendem VPN gehen Anfragen weiterhin hinaus.'
    },
    secureDnsMode: {
      label: 'Verschlüsseltes DNS',
      description:
        'Eine Adresse in eine Nummer aufzulösen geschieht normalerweise im Klartext, wo das Netz mitlesen und verändern kann. Dies fragt stattdessen die Server unten über HTTPS.',
      choices: {
        secure: 'Immer verschlüsselt, kein Rückfall',
        automatic: 'Verschlüsselt, wo möglich',
        off: 'Aus'
      }
    },
    secureDnsServers: {
      label: 'DNS-Server',
      description:
        'Eine Adresse je Zeile. Wird nur verwendet, solange verschlüsseltes DNS nicht aus ist.'
    },
    webrtcIpPolicy: {
      label: 'Lokale Adressen über WebRTC',
      description:
        'WebRTC kann die lokale Adresse der Maschine preisgeben und hinter einem VPN auch die echte, ohne dass die Seite dafür um Erlaubnis fragen müsste. Die strengste Wahl schließt das; der Preis ist, dass manche Videokonferenzdienste keine Verbindung aufbauen.',
      choices: {
        default: 'Keine Einschränkung',
        default_public_interface_only: 'Nur die öffentliche Schnittstelle',
        disable_non_proxied_udp: 'Nichts am Proxy vorbei'
      }
    }
  },

  downloads: {
    directory: {
      label: 'Download-Ordner',
      description:
        'Leer lassen für den Download-Ordner des Systems – darauf fällt auch ein relativer Pfad zurück.'
    },
    askForEachFile: { label: 'Bei jeder Datei nach dem Speicherort fragen' }
  },

  session: {
    startupBehaviour: {
      label: 'Beim Start öffnen',
      choices: {
        'speed-dial': 'Die Startseite',
        blank: 'Einen leeren Tab',
        restore: 'Die letzte Sitzung',
        'custom-url': 'Eine feste Adresse'
      }
    },
    customStartupUrl: {
      label: 'Feste Startadresse',
      description: 'Wird nur verwendet, solange oben „Eine feste Adresse“ gewählt ist.'
    },
    restoreOnStart: {
      label: 'Letzte Sitzung wiederherstellen',
      description:
        'Dasselbe, was die Einstellung darüber sagen kann, nur zweimal ausgedrückt: Beides gilt als Wunsch nach Wiederherstellung, dieses Häkchen genügt also, selbst wenn die Auswahl darüber etwas anderes sagt. Zwei Schlüssel für ein Verhalten ist ein Fehler in der Einstellungstabelle.'
    },
    restoreAfterCrash: {
      label: 'Nach einem Absturz wiederherstellen',
      description:
        'Unabhängig von den beiden Einstellungen darüber: Nach einem unsauberen Ende kommen die Tabs zurück, auch wenn ein gewöhnlicher Start nichts wiederherstellen würde.'
    }
  },

  clearData: {
    onExit: { label: 'Daten beim Schließen des Browsers löschen' },
    onExitCategories: {
      label: 'Was gelöscht wird',
      description:
        'Eines je Zeile, aus: cookies, cache, storage, history, downloads, formData. Alles andere wird abgelehnt.'
    }
  },

  advanced: {
    hardwareAcceleration: {
      label: 'Hardwarebeschleunigung',
      description:
        'Zeichnet über die Grafikkarte. Ausschalten ist das übliche Mittel gegen Flackern oder leere Inhalte und kostet Geschwindigkeit.'
    },
    spellcheck: { label: 'Rechtschreibung beim Tippen prüfen' },
    spellcheckLanguages: {
      label: 'Sprachen der Rechtschreibprüfung',
      description:
        'Ein Sprachkürzel je Zeile, etwa de-DE. Noch ohne Wirkung: Die Rechtschreibprüfung der Sitzung erfährt von dieser Liste nichts.'
    },
    unloadInactiveTabs: {
      label: 'Ungenutzte Tabs entladen',
      description:
        'Würde den Speicher eines ruhenden Tabs freigeben und ihn bei der Rückkehr neu laden. Nicht umgesetzt: Kein Tab wird je nach Zeit entladen.'
    },
    unloadAfterMinutes: {
      label: 'Entladen nach (Minuten)',
      description: 'Der Zeitgeber für die Einstellung darüber, den nichts ausführt.'
    },
    customShortcuts: {
      label: 'Eigene Tastenkürzel',
      description:
        'Hier nur sichtbar, geändert wird anderswo. Jeder Eintrag ersetzt das Standardkürzel einer Aktion durch das angegebene.'
    }
  },

  updates: {
    checkAutomaticallyOnGithub: {
      label: 'Automatisch nach neuen Versionen suchen (bei GitHub)',
      description:
        'Jede Prüfung fragt bei GitHub die Liste der Veröffentlichungen ab, GitHub sieht dabei also eine IP-Adresse und in der Summe, wie viele Menschen diesen Browser benutzen. Mehr als eine Prüfung ist es nicht: Ohne deine Zustimmung zu jedem Schritt wird nichts heruntergeladen und nichts installiert.'
    },
    channel: {
      label: 'Über welche Veröffentlichungen du erfährst',
      description:
        'Jede bisher veröffentlichte Version ist eine Vorabversion, und GitHubs „neueste Veröffentlichung“ schließt genau die aus – „nur stabile“ heißt heute also: Dir wird nie etwas angeboten. Das ändert sich mit der ersten Veröffentlichung, die keine Vorabversion ist.',
      choices: { stable: 'Nur stabile Versionen', alpha: 'Alpha, mit Vorabversionen' }
    }
  }
}
