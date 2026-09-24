# tessera

Ein Desktop-Browser für Windows, Linux und macOS mit Fokus auf Privatsphäre und
paralleles Arbeiten. Alle Daten bleiben lokal: kein Account, keine Cloud, keine
Synchronisation, keine Telemetrie.

**Status: benutzbarer Browser, noch nicht fertig.** Tabs, Split View mit Tab-Gruppen,
Verlauf, Lesezeichen, Downloads, Passwort-Tresor, Sitzungswiederherstellung, Werbe- und
Trackerblocker und Fingerprint-Maskierung sind gebaut und getestet. Was fehlt, steht vollständig unter
[Was noch nicht da ist](#was-noch-nicht-da-ist) — bewusst lückenlos, damit niemand ein Feature für
fertig hält, das es nicht ist. Die Liste ist am 24.09.2026 Punkt für Punkt gegen den Code geprüft.

## Loslegen

```bash
pnpm install
pnpm dev
```

| Befehl | Zweck |
|---|---|
| `pnpm dev` | Entwicklungsmodus mit Hot Reload |
| `pnpm build` | Typprüfung und Bündelung aller drei Prozesse |
| `pnpm quality` | Typprüfung, Lint, Coverage, Metriken |
| `pnpm test` | Alle Tests (Unit, Gherkin, Architektur) |
| `pnpm run test:bdd` | Nur die Gherkin-Szenarien |
| `pnpm run test:coverage` | Mit Abdeckungsschwellen |
| `pnpm run test:mutation` | Mutationstests (mehrere Minuten) |
| `pnpm run test:smoke` | Baut und prüft die laufende Anwendung |
| `pnpm run metrics` | Qualitätsmetriken mit Grenzwerten |
| `pnpm package` | Signierte Pakete für die aktuelle Plattform |

Node ≥ 22 und pnpm werden erwartet.

### Installieren und Deinstallieren unter Windows

Der Installer ist ein NSIS-Setup und installiert **pro Benutzer** (`perMachine: false`), also
ohne Administratorrechte. Das entscheidet auch, wo alles landet, und das ist der Punkt, an dem
gemeldet wurde, es gäbe keine Deinstallation:

| Was | Wo |
|---|---|
| Anwendung | `%LOCALAPPDATA%\Programs\tessera\` |
| Deinstallation | `%LOCALAPPDATA%\Programs\tessera\Uninstall tessera.exe` |
| Startmenü | Eintrag für die Anwendung **und** „Uninstall tessera" |
| Systemeinstellungen | *Apps & Features* → `tessera` (Eintrag unter `HKCU`) |

Nicht in `C:\Program Files` — dort liegt bei einer Benutzerinstallation nichts, und wer dort
sucht, findet zu Recht keinen Uninstaller. Der Startmenü-Eintrag existiert, weil die Suche dort
naheliegt; er wird von `build/installer.nsh` angelegt und beim Deinstallieren wieder entfernt.

Wird bei der Installation ein Zielordner gewählt, in den der angemeldete Benutzer nicht schreiben
darf — `C:\Program Files` ist der wahrscheinliche Fall, weil `allowToChangeInstallationDirectory`
das zulässt —, kann die Installation unvollständig bleiben. Dann ist `perMachine: true` in
`electron-builder.yml` die richtige Einstellung; sie kostet eine UAC-Abfrage und installiert
systemweit.

## Warum Electron

Gegen einen eigenen Chromium-Fork und für Electron — nicht aus Bequemlichkeit,
sondern wegen der Wartbarkeit. Ein Fork bedeutet permanentes Rebase gegen Chromiums
Vier-Wochen-Takt, und Split View im Fork heißt C++ in der Views-Toolkit plus
Eingriffe in den Fullscreen-Controller. Mit Electron sind Chromium-Updates eine
Versionsnummer und Split View eine `WebContentsView` pro Kachel.

Der Preis ist ehrlich zu nennen: **Fingerprint-Maskierung läuft per Preload-Skript
statt auf C++-Ebene.** Wirksam, weil Preloads garantiert vor dem ersten Seitenskript
laufen, aber angreifbarer als eine Maskierung im Renderer selbst. Das ist die eine
bewusst akzeptierte Schwäche gegenüber Brave.

Extensions sind kein Argument für einen Fork — Abschnitt 8 der Spezifikation
schließt sie ohnehin aus, weil installierte Erweiterungen selbst ein
Erkennungsmerkmal sind. Zusätzlich liefert Electron keine Browser-Oberfläche, in die
sich eine Extension einhängen könnte: kein Toolbar-Button, kein Popup, keine
Options-Seite, kein Web Store, kein Update-Mechanismus.

## Aufbau

```
src/
  shared/          Von allen Prozessen genutzt, ohne Electron und ohne Node
    ipc/           channels.ts (Namen) + contract.ts (Typen und Schemata)
    settings/      definitions.ts — die einzige Quelle der Wahrheit
    split/         layout.ts — Kachel-Geometrie, rein und testbar
    quicklinks/    model.ts (rein) + schema.ts (Validierung, getrennt s.u.)
    url/           Adress-Erkennung, Domain-Grenzen, Parameter-Bereinigung
    shortcuts/     Drei handgepflegte Tastaturtabellen, eine pro Plattform
    i18n/          catalog.ts (rein) + schema.ts (Validierung, dieselbe Trennung)
  main/            Browser-Kern
    browser/       Tab, SplitController, BrowserWindowController, WindowRegistry
    data/          JsonStore (atomar) + QuickLinkStore
    privacy/       RequestPipeline — ein Abfangpunkt, geordnete Stufen
    session/       hardening (Electron) + headers/permission-policy (rein)
    ipc/           router (validierend) + sender-policy (wer darf was)
  preload/         index.ts — ein Skript, Rolle vom Main-Prozess gesetzt
  renderer/
    src/           Chrome-UI: Tab-Leiste, Toolbar, Adressleiste
    internal/      Startseite mit Quick Links (tessera://start)
tests/             Unit-, Architektur- und Gherkin-Tests
scripts/           Smoke-Test und Metriken
docs/              ARCHITECTURE, TESTING, QA
```

Die vier Stellen, an denen die Architektur eine Meinung hat:

**Die IPC-Grenze kann nicht auseinanderdriften.** `channels.ts` nennt die Kanäle,
`contract.ts` typisiert sie mit `satisfies Record<InvokeChannel, …>`. Ein Kanal ohne
Vertragseintrag bricht den Build, ein Eintrag ohne Kanal ebenso. Beim Start prüft
`assertAllChannelsRegistered()` zusätzlich, dass jeder Kanal einen Handler hat.

**Einstellungen haben eine Quelle.** Ein unbekannter Schlüssel führt zu einer
abgelehnten IPC-Anfrage, nicht zu einem stillen Verwerfen. Ein Schlüssel aus einer
neueren Version bleibt beim Zurückschreiben erhalten — sonst würde das Ausführen
einer älteren Version die Einstellungen einer neueren zerstören.

**Die Filterstufen sind eine Pipeline, keine Sammlung.** Electron hält pro
`webRequest`-Ereignis genau *einen* Listener — eine zweite Registrierung ersetzt die
erste ohne Fehlermeldung. Deshalb gibt es einen Abfangpunkt, die Stufen sind ein
geordnetes Array darin, und die Reihenfolge wird beim Installieren geprüft.

**Web-Inhalte haben zwei Tore vor sich.** Das Preload entscheidet, *was es
exponiert* (Rolle aus `additionalArguments`, die nur der Main-Prozess setzt); der
Main-Prozess entscheidet unabhängig, *was er annimmt* (`ipc/sender-policy.ts`). Eine
besuchte Seite bekommt nichts, eine interne Seite eine enge Erlaubnisliste, die
Chrome-UI alles. Der Smoke-Test prüft beide Tore an der laufenden Anwendung.

## Split View

Jede Kachel ist eine eigene `WebContentsView` mit eigenem Renderer-Prozess — echte
unabhängige Ansicht, keine Vorschau.

**Kacheln werden nicht gedrosselt.** Chromium drosselt Timer und Rendering in
Inhalten, die es für im Hintergrund hält. In einem 2×2-Raster sieht Chromium drei von
vier Kacheln als Hintergrund — genau die Videos, die der Nutzer anschaut. Deshalb
`backgroundThrottling: false` pro View plus die entsprechenden Kommandozeilen-Schalter.

**Vollbild bleibt in der Kachel.** Im Split-Layout wird das Fenster als nicht
vollbildfähig markiert. Die Anfrage der Seite wird trotzdem honoriert:
`enter-html-full-screen` feuert, `document.fullscreenElement` ist gesetzt, der Player
wechselt seine Oberfläche — aber das Fenster wechselt nicht, und die anderen Kacheln
laufen weiter. Bei 1×1 wird echtes Vollbild durchgelassen.

Die Trenner brauchen einen Gutter zwischen den Kacheln: native Views liegen *über*
dem DOM, ein Trenner ohne freien Streifen bekäme nie ein Mausereignis.

## Startseite und Quick Links

`tessera://start` ist eine echte Anwendung, nicht statisches Markup. Kacheln
anlegen, öffnen, umbenennen, per Drag oder Tastatur umsortieren, in Ordner ablegen
und löschen. Vollständig ohne Maus bedienbar: Enter öffnet, Strg/⌘+Pfeil sortiert,
F2 benennt um, Entf löscht.

Drei Regeln, die im Code festgenagelt sind:

- Eine Adresse wird mit **demselben Klassifizierer** aufgelöst wie in der
  Adressleiste. Ein Suchbegriff wird abgelehnt statt still in eine Suche verwandelt —
  eine Kachel, die heimlich zur Suche nach dem Eingetippten wurde, ist schlimmer als
  eine Absage.
- Ordner enthalten Kacheln, aber niemals Ordner. Eine Ebene hält die Seite navigierbar
  und die Regeln überprüfbar.
- Die Content-Security-Policy der Seite erlaubt **keine externe Herkunft**. Damit ist
  die Anforderung aus Abschnitt 1 — Favicons kommen lokal, nie von einem Dienst bei
  jedem Aufruf — strukturell garantiert und nicht nur versprochen.

## Performance

Beim Bau der Startseite fiel auf, dass der Renderer 705 kB in einem Chunk auslieferte.
Ursache: `quicklinks/model.ts` und `i18n/catalog.ts` exportierten reine Funktionen
*und* zod-Schemata aus derselben Datei, also zog ein Import der Funktion die ganze
Validierungsbibliothek mit. Dazu war die Minifizierung überhaupt nicht aktiv.

Alle Größen in dezimalen kB (Bytes ÷ 1000), wie der Build-Log sie ausgibt. Diese
Tabelle mischte vorher dezimale und binäre Werte, was korrekte Zahlen widersprüchlich
aussehen ließ; `scripts/metrics.mjs` und die Budget-Tests rechnen jetzt ebenso.

| | vorher | nach der Korrektur | 24.09.2026 | Budget |
|---|---|---|---|---|
| Renderer-JS gesamt | ~750 kB | 227 kB (62 kB gzip) | **371 kB** (120 kB gzip), 26 Chunks | 320 kB |
| Chrome-UI-Einstieg | in einem 705-kB-Chunk | 11,5 kB + geteilter React-Chunk | **24,4 kB** + React-Chunk (192 kB) | 60 kB |
| Katalog-Chunk (beide Sprachen) | — | — | **45,1 kB** | 48 kB |
| Main-Prozess | 160 kB | 87,6 kB | **527,5 kB** | 320 kB |
| Preload (Tabs) | 4,0 kB + Chunk | 2,2 kB, selbstständig | **41,6 kB** | 22 kB |
| Preload (Fenster und Overlay) | — | — | **3,3 kB** | 5 kB |

Die Spalte „nach der Korrektur" ist der Stand direkt nach dem Fund oben, als der Browser noch
ein Grundgerüst war. Seitdem sind Blocker, Tresor, Autofill, Medien-Erkennung, Tab-Gruppen und
die übrigen Funktionen dazugekommen, und drei Summenbudgets stehen darüber: Renderer-JS,
Main-Prozess und Preload. Sie sind absichtlich nicht angehoben. Für die Roadmap Herbst 2026 gilt:
Main- und Renderer-Bundle dürfen wachsen, wenn jede Einheit ihren Zuwachs in kB mit dem Feature
notiert; das steht in [STATUS.md](docs/STATUS.md#roadmap-herbst-2026). Gemessen am Build vom
24.09.2026 (`out/`), nicht geschätzt.

React liegt jetzt in einem geteilten Chunk, wird also einmal kompiliert statt zweimal
pro Fenster. Build-Ziele sind auf Chromium 150 und Node 24 gepinnt — was Electron 43
mitbringt, verifiziert am ausgelieferten Framework statt angenommen. Ein
Architekturtest hält zod aus jedem Modul heraus, das der Renderer zur Laufzeit
importiert, und `pnpm run metrics` schlägt bei Überschreiten der Größenbudgets fehl.

Zur Frage nach älteren Laptops steht die vollständige Analyse in
[ARCHITECTURE.md](docs/ARCHITECTURE.md#performance-auf-schwacher-hardware) — inklusive
der Spannung zwischen „Kacheln nie drosseln" und „vier 1080p-Streams flüssig", die auf
Hardware von 2015 nicht beides erfüllbar ist.

## Verifiziert

```
pnpm run typecheck    strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
pnpm run lint         0 Fehler, 0 Warnungen (type-aware, strictTypeChecked)
pnpm test             6126 Tests in 203 Dateien (letzter voller Lauf, 24.09.2026)
  davon Gherkin       195 Szenario-Blöcke in 14 Feature-Dateien
  davon Architektur   Fitness-Funktionen in tests/architecture.test.ts
pnpm run test:coverage Schwellen 90 % Zeilen, 85 % Zweige, dazu Untergrenzen pro Datei
pnpm run test:mutation Schwelle 70 %; der Stand des letzten Laufs steht in docs/STATUS.md
pnpm run format:check blockierend in CI seit a57fde3
pnpm run test:smoke   läuft nur der Benutzer; Agenten starten die App nicht
```

Aktuelle Coverage- und Mutationswerte stehen mit Datum unter „Qualitätsstand" in
[STATUS.md](docs/STATUS.md). Hier stehen sie nicht, weil eine Zahl ohne Datum im README
schneller veraltet als jede andere Stelle.

Die Teststrategie und was jede Ebene beantwortet: [TESTING.md](docs/TESTING.md).
Was nur ein Mensch oder echte Hardware prüfen kann: [QA.md](docs/QA.md).

## Was noch nicht da ist

Geprüft am 24.09.2026 gegen `src/`. Gebaut und deshalb nicht mehr auf dieser Liste: Verlauf,
Lesezeichen, Passwort-Tresor mit Autofill, Downloads, Sitzungswiederherstellung, verschlüsselte
lokale Daten, Filterlisten-Engine mit kosmetischem Filtern und Element-Picker,
Fingerprint-Maskierung, Berechtigungs-Dialog, Einstellungsseite, Kontextmenüs, Suchen auf der
Seite, Lesemodus, Tabs in Kacheln ziehen, Fehler- und Absturzanzeige in der Kachel, Nachfrage
beim Verlassen einer Seite (`beforeunload`) und Löschen beim Beenden samt Verlauf und Downloads.

**In Arbeit.** Die HTTPS-only-Zwischenseite und die About-Seite. Beide Adressen stehen in
`KNOWN_PAGES`, liefern aber bis zum Abschluss dieser Arbeit keine Seite aus.

**Privacy-Engine.** Es fehlen: Proxy/VPN mit Kill-Switch (die Einstellungen existieren und
sagen selbst, dass sie noch nichts tun), Zustandstrennung pro Seite (heute eine Partition pro
Browsing-Modus, nicht pro Site), lokale Phishing-Blockliste.

**Verschlüsselung mit einer Grenze.** Lokale Daten werden mit einem Schlüssel aus dem
Schlüsselspeicher des Betriebssystems versiegelt. Wo es keinen echten gibt (Linux mit
`basic_text`), startet ein neues Profil unverschlüsselt und sagt das.

**Fingerprinting.** Die Maskierung läuft im Preload der Seite. iframes und Worker bleiben
unmaskiert.

**Berechtigungen.** Kamera, Mikrofon und Bildschirmfreigabe bleiben bewusst unangetastet:
„Fragen" ist dort ein stilles Nein. Das ist eine Entscheidung, keine Lücke.

**Oberfläche.** Es fehlen: Vorschläge in der Adressleiste (Verlauf, Lesezeichen, offene Tabs),
Screenshots einer Seite (Vorschaubilder der Startseite gibt es, ein Screenshot-Werkzeug nicht),
Kachel-Kopfzeilen, Per-Site-Panel hinter dem Schloss.

**Einstellungen ohne Wirkung.** Neben Proxy, Kill-Switch, Zustandstrennung, Vorschlägen und
Kachel-Kopfzeilen tun auch diese noch nichts: Tabs nach Zeit entladen, Rechtschreibsprachen,
Position der Tab-Leiste, Schutz vor Schadsoftware. Jede trägt auf der Einstellungsseite einen
Hinweis, und `tests/architecture.test.ts` führt sie auf der Liste `notYetRead`.

**Auslieferung.** `electron-builder.yml` ist für alle drei Plattformen konfiguriert,
inklusive Hardened Runtime und Notarisierung. Signierung braucht Zertifikate: Authenticode
für Windows, Apple Developer Account für macOS. Bis dahin führen Updates auf allen drei
Plattformen zur Release-Seite, statt sich selbst zu installieren.

**Nicht auf allen Plattformen geprüft.** Entwickelt und verifiziert auf macOS.
Fensterdekoration, Tastenkürzel und besonders `setFullScreenable(false)` als
Kachel-Vollbild-Mechanismus müssen auf Linux nachgewiesen werden; auf Windows hat der Benutzer
das Kachel-Vollbild am 29.07.2026 bestätigt. Das ist der riskanteste offene Punkt und steht als
erster in [QA.md](docs/QA.md).

## Lizenz

GPL-3.0-or-later
