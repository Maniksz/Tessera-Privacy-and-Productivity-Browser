# tessera

Ein Desktop-Browser für Windows, Linux und macOS mit Fokus auf Privatsphäre und
paralleles Arbeiten. Alle Daten bleiben lokal: kein Account, keine Cloud, keine
Synchronisation, keine Telemetrie.

**Status: Grundgerüst mit funktionierender Startseite.** Der Browser startet, Tabs
und Navigation funktionieren, Split View ist im Kern implementiert, und die
Startseite verwaltet Quick Links. Was fehlt, steht vollständig unter
[Was noch nicht da ist](#was-noch-nicht-da-ist) — bewusst lückenlos, damit niemand
ein Feature für fertig hält, das es nicht ist.

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

| | vorher | nachher |
|---|---|---|
| Renderer-JS gesamt | ~750 kB | **227 kB** (62 kB gzip) |
| Chrome-UI-Einstieg | in einem 705-kB-Chunk | **11,5 kB** + geteilter React-Chunk |
| Main-Prozess | 160 kB | **87,6 kB** |
| Preload | 4,0 kB + Chunk | **2,2 kB**, selbstständig |
| Module im Renderer-Build | 126 | **47** |

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
pnpm test             617 Tests in 21 Dateien
  davon Gherkin       144 ausgeführte Szenarien aus 86 Blöcken in 5 Feature-Dateien
  davon Architektur   29 Fitness-Funktionen
pnpm run test:coverage 99,3 % Zeilen · 95,1 % Zweige · alle Bereichsschwellen erfüllt
pnpm run test:mutation Mutation Score 80,6 % (Schwelle: 70)
pnpm run test:smoke   26 Checks gegen die laufende Anwendung
```

Die Teststrategie und was jede Ebene beantwortet: [TESTING.md](docs/TESTING.md).
Was nur ein Mensch oder echte Hardware prüfen kann: [QA.md](docs/QA.md).

## Was noch nicht da ist

**Datenhaltung.** Verlauf, Lesezeichen, Passwörter, Downloads und Sitzung fehlen.
Einstellungen und Quick Links liegen als **unverschlüsseltes JSON** — die
`DocumentCodec`-Schnittstelle ist die Nahtstelle für die Verschlüsselung, die
Implementierung fehlt. Abschnitt 3 („alle lokalen Daten verschlüsselt") ist damit
nicht erfüllt.

**Privacy-Engine.** Die Pipeline steht mit Telemetrie-Sperre, Redirect-Blocker,
Parameter-Bereinigung und HTTPS-Upgrade. Es fehlen: die Filterlisten-Engine (die Stufe
wird übersprungen statt behelfsmäßig ersetzt), kosmetisches Filtern, die
HTTPS-Zwischenseite selbst, Proxy/VPN mit Kill-Switch, Zustandstrennung pro Seite,
lokale Phishing-Blockliste.

**Fingerprinting.** Das Preload markiert nur den Injektionspunkt. Die Maskierung von
Canvas, WebGL, Audio, Schriften und Bildschirmwerten fehlt. Header-Normalisierung ist
implementiert und getestet.

**Berechtigungen.** Alles wird abgelehnt, korrekt und getestet. Es fehlt der
Nachfrage-Dialog — `requestFromUser` gibt immer `false` zurück, was ohne Oberfläche
richtig ist, aber `ask` praktisch wie `deny` wirken lässt.

**Oberfläche.** Es fehlen: Einstellungsseiten, Kontextmenüs, Suchen auf der Seite,
Autocomplete in der Adressleiste, Lesemodus, Screenshots, Kachel-Kopfzeilen,
Per-Site-Panel. Drag & Drop von Tabs in Kacheln braucht ein temporäres Ausblenden der
nativen Views, sonst erreicht der Drop das DOM nicht.

**Auslieferung.** `electron-builder.yml` ist für alle drei Plattformen konfiguriert,
inklusive Hardened Runtime und Notarisierung. Nichts davon ist getestet, und
Signierung braucht Zertifikate: Authenticode für Windows, Apple Developer Account für
macOS.

**Nicht auf allen Plattformen geprüft.** Entwickelt und verifiziert auf macOS.
Fensterdekoration, Tastenkürzel und besonders `setFullScreenable(false)` als
Kachel-Vollbild-Mechanismus müssen auf Windows und Linux nachgewiesen werden — das ist
der riskanteste offene Punkt und steht als erster in [QA.md](docs/QA.md).

## Lizenz

GPL-3.0-or-later
