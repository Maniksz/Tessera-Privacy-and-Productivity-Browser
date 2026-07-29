# Tessera — Verbesserungsplan

**Stand:** 2026-07-29 · **Basis:** 0.7.0-ALPHA · **Grundlage:** vier unabhängige Bewertungen (UX, UI, Performance/RAM, Funktionalität/Architektur), statisch am Code erhoben, App nicht gestartet.

**Revision 2** nach zwei technischen Reviews (Machbarkeit der Fixes / Belegprüfung). Die Belegprüfung ergab ~96 % korrekte Verweise; die drei gefundenen Fehler sind eingearbeitet. Die Machbarkeitsprüfung hat sechs Maßnahmen als technisch fehlerhaft widerlegt — R1, R2, R5, W2, W3 und H4 sind daraufhin neu geschrieben, zehn fehlende Maßnahmen (N1–N10) sind ergänzt und die Aufwände korrigiert. Belege, die in dieser Revision gegen `node_modules/electron/electron.d.ts` (Electron 43.2.0) geprüft wurden, sind als solche markiert.

---

## 1. Zielbild und Maßstab

Das erklärte Produktziel lautet: **blitzschnell, mit allen Funktionalitäten, nicht so RAM-hungrig wie andere Browser.** Jede Maßnahme in diesem Plan wird an diesem Satz gemessen und trägt eine Angabe, wie viel sie darauf einzahlt.

Messbare Zielwerte, gegen die 1.0 geprüft werden soll:

| Größe | heute (Schätzung) | Ziel 1.0 |
|---|---|---|
| Kaltstart bis sichtbares Fenster | ~1600 ms | **< 700 ms** |
| Einfrieren nach dem Start (2. Filter-Compile) | 600–1500 ms | **0 ms** |
| RAM, 1 Tab | ~380 MB | ~350 MB |
| RAM, 10 Tabs | ~1,5 GB | **< 700 MB** |
| RAM, 50 Tabs | ~6 GB | **< 1,5 GB** |
| Tote Einstellungen in der UI | 16 | **0** |
| Gebaute Dienste ohne Aufrufer | 3 | **0**, per Fitness-Funktion erzwungen |

Alle Ausgangswerte sind **Schätzungen aus statischer Analyse**, keine Messungen. Welle 0 existiert, um das zu ändern.

### Leitplanken

1. **Keine Sicherheitsregression.** `sandbox`, `contextIsolation`, `nodeIntegration: false` und das Zwei-Tore-Modell (Preload exponiert / Kern akzeptiert) bleiben unangetastet. Maßnahmen, die daran rühren, sind als solche markiert und brauchen eine explizite Entscheidung.
2. **Kein Schalter ohne Wirkung.** Der eigene Test in `tests/architecture.test.ts:758-761` formuliert das Prinzip bereits: ein Kill-Switch, der ein Boolean in einer Datei ist, ist schlimmer als kein Kill-Switch. Jede Einstellung wird gebaut oder entfernt — ein dritter Weg existiert nicht.
3. **Jede Maßnahme bringt ihre Sicherung mit.** Keine Korrektur ohne den Test, der ihren Rückfall verhindert. Bei Verdrahtungsfehlern heißt das: eine Fitness-Funktion, nicht ein Unit-Test.
4. **Reihenfolge folgt Wirkung/Aufwand, nicht Bequemlichkeit.** Welle 1 ist kleiner als Welle 5 und zahlt zehnmal so viel ein.

---

## 2. Welle 0 — Messgrundlage herstellen

**Ohne diese Welle sind alle Zahlen in diesem Plan Hypothesen.** Rund 25 % des Quellcodes (~15.600 Zeilen, 19 Main-Dateien plus der gesamte Renderer) sind von der Coverage-Messung ausgeschlossen (`vitest.config.ts:89`, `:94-150`), abgesichert nominell durch einen Smoke-Test, der seit dem Umbau von CDP auf In-Prozess nie gelaufen ist (`docs/STATUS.md:973`, `:1230`).

| ID | Maßnahme | Aufwand | Wer |
|---|---|---|---|
| **M0.1** | `pnpm test:smoke` einmal in der echten App ausführen und das Ergebnis in `docs/STATUS.md` festhalten. | 30 min | **Benutzer** — nicht automatisiert ausführen |
| **M0.2** | Baseline messen: Kaltstart (3 Läufe, Median) und RSS aller Prozesse bei 1 / 10 / 50 Tabs, über den Task-Manager des Betriebssystems oder `process.getProcessMemoryInfo()`. Ergebnis als Tabelle in `docs/STATUS.md`. | 1 h | **Benutzer** |
| **M0.3** | `pnpm build` ausführen, damit die Größenbudgets aus `scripts/metrics.mjs` wieder gegen einen aktuellen Stand messen (seit 2026-07-28 nicht gemessen, `docs/STATUS.md:1226`). | 15 min | Benutzer |
| **M0.4** | **Das Throttling-Experiment.** Ein Video in Kachel 2 laufen lassen, Fokus auf Kachel 1 — einmal mit den drei Schaltern aus `runtime-flags.ts:100-102` und einmal ohne. Läuft es auch ohne, ist die Begründung der Schalter hinfällig und **R1 wird eine Löschung statt eines Umbaus**. Ohne dieses Ergebnis ist R1 nicht entscheidbar. | 30 min | **Benutzer** |
| **M0.5** | RAM-Messung nach Prozesstyp über `app.getAppMetrics()` (`electron.d.ts:11214-11261`, `MemoryInfo.workingSetSize` bei `:9428-9447`) statt über den Task-Manager. Liefert **GPU-Prozess getrennt** — die Kosten mehrerer Compositor-Surfaces bei 2×2 auf einem 4K-Schirm fehlen in allen bisherigen Schätzungen vollständig. | in M0.2 enthalten | Benutzer |

**Abhängigkeit:** M0.2 liefert die Vorher-Werte, gegen die Welle 1 verifiziert wird. Welle 1 kann ohne M0.2 umgesetzt, aber nicht abgenommen werden. **M0.4 ist Vorbedingung für R1**, nicht nur dessen Abnahme.

---

## 3. Welle 1 — RAM und Startzeit

Die mit Abstand höchste Wirkung pro Zeile. Vier Maßnahmen, zusammen geschätzt **4–11 GB bei 50 Tabs** und **700–1700 ms Startzeit**.

### R1 — Hintergrund-Drosselung je View statt prozessweit

**Problem.** `src/main/runtime-flags.ts:99-104` setzt bei `throttleBackgroundContent === false` (dem Standard, `definitions.ts:113`) drei Chromium-Schalter **prozessweit**:

```
disable-background-timer-throttling
disable-renderer-backgrounding
disable-backgrounding-occluded-windows
disable-features-in-background   ← existiert in Chromium nicht
```

Die Begründung im Kommentar ist richtig: in einem Split-Layout sieht jede nicht fokussierte Kachel für Chromium wie Hintergrund aus, und ein gedrosseltes Video in Kachel 2 wäre ein Produktfehler. Falsch ist nur die Reichweite. Der Schalter gilt auch für die 46 Tabs, die *keine* Kachel haben — und `--disable-renderer-backgrounding` unterbindet insbesondere Blinks `MemoryPurgeManager`, der einen Hintergrund-Renderer nach ~60 s aufräumt.

**Tessera gibt also nicht nur nichts frei, es schaltet ab, was Chromium von selbst freigeben würde.**

> **Revision 2 — die ursprüngliche Fassung war technisch falsch.** Sie behauptete, `setBackgroundThrottling` pro View sei ein Ersatz für die drei Prozess-Schalter. Das stimmt nicht, und zwar aus fünf voneinander unabhängigen Gründen.

**Warum der naive Per-View-Weg nicht trägt** (alles gegen `electron.d.ts` 43.2.0 verifiziert):

**(a) Frame-Drawing ist fensterweit, nicht view-weit.** `electron.d.ts:19104-19108`: *„When at least one webContents displayed in a single browserWindow has disabled `backgroundThrottling` then frames will be drawn and swapped for the whole window and other webContents displayed by it."* Und dieses Fenster hat **immer** mindestens einen solchen WebContents: die Chrome-UI (`src/main/browser/window-options.ts:83`, hart `false`, kommentiert mit *„always visible"*) und die Overlay-Ebene (`src/main/browser/OverlayLayer.ts:247`, ebenfalls hart `false`). Beide sind aus guten Gründen nicht abschaltbar.

**(b) `setBackgroundThrottling` deckt den RAM-Hebel gar nicht ab.** `electron.d.ts:18519-18523` beschreibt genau eine Wirkung: *„whether or not this WebContents will throttle animations and timers when the page becomes backgrounded. This also affects the Page Visibility API."* Timer und Animationen — **nicht die Prozesspriorität.** Genau daran hängt aber `--disable-renderer-backgrounding` und damit Blinks `MemoryPurgeManager`. Es gibt kein `webContents`-Äquivalent für diesen Schalter. *(Verifiziert: die Dokumentation nennt nur Timer/Animationen/Page Visibility. Dass das Entfernen des Schalters die Priorität wieder freigibt, ist plausibel, aber nur messbar — nicht am Code belegbar.)*

**(c) `disable-backgrounding-occluded-windows` ist Fenster-Ebene und hat überhaupt keinen View-Ersatz.** Occlusion entscheidet das OS für das ganze Fenster.

**(d) `relayout()` ist der falsche Ort.** Es wird aus mindestens zehn Pfaden gerufen, unter anderem aus `setFractions()` (`BrowserWindowController.ts:641-656`) — also **pro Pointer-Frame beim Divider-Drag**. Bei 50 Tabs wären das 3000 native Aufrufe pro Sekunde, jeder mit Mojo-Roundtrip. Das ist eine neue Regression und arbeitet direkt gegen H3.

**(e) Der Overlay-Zweig würde alles drosseln.** `relayout()` setzt bei `#overlayActive` **jeden** Tab auf `setVisible(false)` und kehrt zurück (`BrowserWindowController.ts:874-877`). „Direkt daneben" gedrosselt hieße: Panel öffnen → Video in der Kachel steht. Der Kommentar bei `:91-97` verlangt ausdrücklich das Gegenteil.

**Korrigierter Fix:**
1. **Zuerst M0.4 ausführen.** Läuft das Video in Kachel 2 auch ohne die Schalter, sind sie überflüssig und R1 ist eine reine Löschung.
2. `disable-features-in-background` (`runtime-flags.ts:103`) ersatzlos streichen — unstrittig, der Switch existiert in Chromium nicht. *(Nicht am Code prüfbar; Chromium-Kenntnis.)*
3. Nur `disable-renderer-backgrounding` entfernen — der einzige der drei mit RAM-Bezug. `disable-background-timer-throttling` behalten: billig, ohne RAM-Wirkung, und es hält die Kachel-Zusage.
4. `setBackgroundThrottling` **mit Wertwechsel-Gate am `Tab`** (`#backgroundThrottling`-Feld), nicht als Nebenwirkung in `relayout()`. Overlay-Zweig ausnehmen.
5. **Mitzuziehen, im Plan zuvor übersehen:** `src/main/startup-flags.ts:32-35` und `:107-112` (`throttleBackgroundContent` wird teilweise tot), `tests/startup-flags.test.ts` (7 Fundstellen), `definitions.ts:113` (`applies: 'new-tab'` muss `'live'` werden, sonst lügt die Settings-UI), `docs/ARCHITECTURE.md:165-172` (behauptet ausdrücklich, beide Ebenen seien nötig).
6. **Leitplanke 2 beachten:** Ein sichtbarer Kachel-Tab wird von Chromium ohnehin nicht als Hintergrund behandelt. Wenn `splitView.throttleInactiveTiles` dadurch wirkungslos wird, muss es entfernt werden — sonst verlängert R1 die Schuldenliste, die Q4 abarbeitet.

**Aufwand** korrigiert: **1 Tag** plus vorgelagerte Messung (statt 2 h). **Wirkung** geschätzt 0,4–2,7 GB bei 50 Tabs — **bis M0.4 eine Hypothese ohne belegten Mechanismus.** Das ist die Maßnahme mit dem höchsten Verhältnis von behauptetem Nutzen zu belegtem Mechanismus im ganzen Plan; sie rutscht deshalb in der Reihenfolge nach hinten.

**Verifikation.** Fitness-Funktion: `disable-features-in-background` darf nicht vorkommen. Unit-Test: Wertwechsel-Gate feuert nur bei echtem Wechsel; Overlay-Zustand drosselt keine Kachel. Manuell: M0.4 nach der Änderung wiederholen.

### R2 — Tab-Discarding implementieren

**Problem.** Es gibt kein Entladen inaktiver Tabs. Zwei Einstellungen versprechen es — `advanced.unloadInactiveTabs` (Default **`true`**) und `advanced.unloadAfterMinutes` (Default 30), `src/shared/settings/definitions.ts:240-241` — und **kein Leser existiert im gesamten Quellbaum** (verifiziert: Treffer nur in `definitions.ts` und den beiden Beschreibungstexten). Ein Nutzer, der die Standardeinstellungen liest, glaubt, sein Browser entlade Tabs nach 30 Minuten.

**Die Bausteine sind bereits gebaut und getestet:**

| Baustein | Ort |
|---|---|
| `#deferred`-Zustand am Tab | `src/main/browser/Tab.ts:206` |
| `deferLoad()` / `loadIfDeferred()` | `Tab.ts:675`, `:681` |
| Aufrufer im Aktivierungspfad | `BrowserWindowController.ts:391-392`, `:453-454`, `:691` |
| `TabState.unloaded` samt Kommentar, der exakt dieses Feature beschreibt | `src/shared/model.ts:62-63` |
| Lazy-Restore als Vorbild | `src/shared/session/restore.ts:177` |

Was fehlt, ist ausschließlich der Weg von *geladen* zurück nach *entladen*.

> **Revision 2 — der ursprüngliche Mechanismus hätte den Tab geschlossen statt ihn zu entladen.** Vier konkrete Defekte, alle am Code verifiziert.

**(a) `close()` löst den eigenen `close`-Handler aus.** `Tab.ts:504` (verifiziert):
```ts
on('close', () => this.callbacks.onCloseRequested(this))
```
und `onCloseRequested` ist in `BrowserWindowController.ts:341` auf `this.closeTab(source.id)` verdrahtet — **der Tab verschwindet komplett.** Dass das heute nicht passiert, ist Reihenfolgen-Zufall: `Tab.destroy()` (`:768-776`) entsorgt erst alle Disposer und ruft dann `close()`. `discard()` muss diesen Listener gezielt vorher abmelden und danach neu setzen.

**(b) `Tab.setBounds`/`setVisible` haben keinen `isDestroyed()`-Guard** (`Tab.ts:509-515`) — anders als `toState()` (`:742`), `emitToInternalPages` (`:953`) und `#focusActiveTab` (`:901`). Jeder `relayout()` nach einem Discard trifft eine tote View. → **N2, Vorbedingung.**

**(c) `loadIfDeferred()` kann keinen neuen View erzeugen.** `Tab.view` ist `readonly` (`Tab.ts:170`), und das Wiederanhängen muss an **Index 0** in `window.contentView` geschehen, sonst verdeckt der Tab die Overlay-Ebene — `BrowserWindowController.ts:367-370` erklärt genau das. Ein `Tab` hat keinen Zugriff auf das Fenster. Nötig ist eine `#createView()`-Extraktion aus dem Konstruktor plus ein Controller-Callback; dabei müssen `applyWebRtcPolicy`, `zoomFactor`, `spellcheck`, `autoplayPolicy` und alle 23 Event-Subscriptions neu angewandt werden, die heute alle im Konstruktor stehen (`Tab.ts:230-285`). **Das ist ein Umbau der zentralen, von der Coverage ausgeschlossenen Klasse.**

**(d) Der ursprünglich vorgeschlagene Persistenzweg war der falsche.** `electron.d.ts:10091-10103` (verifiziert):
```
interface NavigationEntry {
  /** A base64 encoded data string containing Chromium page state including
      information like the current scroll position or form values. */
  pageState?: string
  …
}
```
`navigationHistory.getAllEntries()` liefert das mit, `restore({ entries, index })` spielt es zurück — **Scroll-Position und Formularwerte inklusive, für alle Einträge und alle Frames.** Der Weg über `executeJavaScript` nach dem Muster von `reader/harvest.ts:195` ist strikt schlechter: er erreicht keine Cross-Origin-Iframes, injiziert Skript in fremde Seiten und trüge Formularinhalte als Klartext durch einen IPC-Pfad.

**Korrigierter Fix:**
1. **`Tab.discard()`** neben `destroy()` (`Tab.ts:768`), mit gezieltem Abmelden des `close`-Listeners.
2. Persistenz **ausschließlich** über `navigationHistory.getAllEntries()` / `restore()`. Kein `executeJavaScript`. Ergänzend aus `toState()`: `url`, `title`, `zoomPercent`, `pinned`, `tileIndex`, `#favicon`.
3. **`pageState` darf nicht in `TabState`/`SessionTab` landen.** Es ist Base64 von Chromiums `PageState`, typisch einige bis einige zehn kB pro Historieneintrag. `SessionTab` ist ein struktureller Subset von `TabState` (`BrowserWindowController.ts:1044-1048`) — bei 50 Tabs wüchse die Sitzungsdatei um mehrere MB, die `JsonStore.update` bei **jeder** Mutation per zod-Deep-Clone validiert. R2 würde damit genau das Problem verschärfen, das H4 löst. **Eigener, nicht-persistierter In-Memory-Speicher** — oder H4 kommt zuerst.
4. **Ausschlusskriterien**, erweitert: Kachel (`#tileIndex !== null`) · hörbar (`isCurrentlyAudible()`) · **stummgeschaltetes Medium** (`isCurrentlyAudible()` ist dafür `false`; `Tab.ts:450-451` abonniert bereits `media-started-playing`/`media-paused`, ein Flag kostet zwei Zeilen) · angeheftet · lädt gerade (`isLoading()`) · DevTools offen (`isDevToolsOpened()`) · HTML-Fullscreen · Ziel des `ElementPicker` · offene Autofill-Save-Bar.
   **Gestrichen:** „ist die aktive Ansicht eines anderen Fensters" — gegenstandslos, ein Tab gehört genau einem Controller (`#tabs`-Map, `:86`).
   **Ersetzt:** „unbestätigte Formulareingaben" ist ohne Mechanismus nicht erkennbar. Der einzige existierende Weg ist `close({ waitForBeforeUnload: true })` plus `will-prevent-unload`-Handler — widerspricht die Seite, wird nicht entladen. **Das koppelt R2 zwingend an W4.**
5. **`lastActiveAt` am Tab einführen** (→ N3). Ohne Zeitstempel ist `advanced.unloadAfterMinutes` nicht auswertbar. Setzen in `activateTab`, `onFocused`, `did-navigate`.
6. **Ein Timer für die Anwendung**, nicht einer je Fenster (→ N8). `app.getAppMetrics()` iteriert alle Prozesse und ist nicht billig; bei N Fenstern liefe das N-mal.
7. **UI**: `TabState.unloaded` im Tab-Streifen darstellen, damit der Zustand nicht unsichtbar ist.
8. `unloadInactiveTabs`/`unloadAfterMinutes` aus der Schuldenliste in `tests/architecture.test.ts:777-798` entfernen — der `stale`-Check erzwingt das.

**Aufwand** korrigiert: **6–9 Tage** (statt 2–4). **Wirkung** geschätzt 3,6–9 GB bei 50 Tabs, 0,9–1,9 GB bei 10 Tabs. **Größter Einzelhebel des gesamten Plans.**

**Verifikation.** Unit-Tests für jedes Ausschlusskriterium einzeln. Integrationstest: entladen → reaktivieren → Scroll, Formularinhalt und Vor/Zurück-Historie erhalten. Manuell gegen die Baseline aus M0.2.

### R3 — Filterlisten-Kompilierung aus dem Startpfad nehmen

**Problem.** `src/main/index.ts:533` — verifiziert:
```ts
await filterSubscription.start()
```
Dahinter: `#compileFromCache()` → `FilterEngine.replaceLists()` → `compileFilterLists()`, **vollständig synchron auf dem Main-Thread**, ohne Worker, ohne Chunking. Umfang laut den eigenen Messkommentaren im Code: ~113.000 Netzwerkregeln (`shared/filters/network.ts:14-17`) und ~47.000 kosmetische Regeln (`shared/filters/cosmetic.ts:16-17`) für drei Listen — bei vier konfigurierten Standardlisten (`definitions.ts:140-148`) realistisch über 200.000 Quellzeilen. Das Fenster erscheint erst danach (`:771`/`:775`).

**Und es passiert zweimal pro Start:** `FilterSubscription.ts:107` feuert direkt nach dem Kompilieren `void this.refresh()`, was nach dem Netzwerk-Refresh erneut `#compileFromCache()` aufruft (`:131`). Der zweite Durchlauf blockiert den Main-Thread bei **bereits sichtbarem Fenster** — für den Nutzer ein Browser, der eine Sekunde nach dem Start einfriert.

**Der entscheidende Punkt:** die Engine ist leer bereits gültig. `FilterSubscription.ts:82-87` konstruiert `new FilterEngine({ lists: [] })` und der Kommentar dort sagt es selbst — *"an engine with no rules matches nothing, so the pipeline is correct before the first list arrives"*. `replaceLists()` mutiert das Objekt, das die Pipeline bereits hält. Das `await` ist nicht nötig.

**Fix, gestaffelt.**

| Stufe | Maßnahme | Gewinn | Aufwand |
|---|---|---|---|
| **a** | `await` → `void`, Aufruf hinter die Fenstererstellung (nach `index.ts:802`) | 600–1500 ms | 15 min |
| **b** | Den zweiten Compile unterdrücken, wenn der Netzwerk-Refresh keine geänderte Liste liefert (ETag/Last-Modified vergleichen, `FilterSubscription.ts:131`) | weitere 600–1500 ms, kein Einfrieren | 3 h |
| **c** | Die 13 Store-Öffnungen (`index.ts:172`…`:583`) teilweise parallelisieren. **Revision 2:** Der Gewinn wurde überschätzt — die Kosten sind nicht I/O, sondern Main-Thread-Arbeit (Entschlüsselung, `JSON.parse`, zod-Validierung); `Promise.all` parallelisiert nur die `readFile`-Aufrufe im libuv-Threadpool. Zudem ist die Reihenfolge an drei Stellen tragend und im Code kommentiert: `faviconStore`/`thumbnailStore` **müssen** vor `registerInternalProtocol` fertig sein (`index.ts:186-195`), `settings` vor `applySecureDns` (`:183`) und vor `persistStartupFlags` (`:292`), `extensions` vor `extensions.attach` (`:267`). Ein naives `Promise.all` bricht das. | **30–60 ms** (statt 100–300) | **4 h** |
| **d** | `JsonStore.ts:148` vergleicht `JSON.stringify(repaired) !== JSON.stringify(document)` — zwei vollständige Serialisierungen des ganzen Dokuments, nur um zu erkennen, ob `repair` etwas geändert hat. Bei History (~2 MB) sind das ~4 MB Stringbau beim Start, für nichts. `repair` gibt stattdessen ein Änderungsflag zurück. | 30–100 ms | 2 h |
| **e** | Mittelfristig: Compile in `utilityProcess`/`worker_threads`, oder den kompilierten Index serialisiert cachen statt bei jedem Start neu zu parsen | Compile verschwindet vom Main-Thread | 3–5 Tage |

**Race Condition: geklärt und harmlos.** `FilterEngine.replaceLists` (`FilterEngine.ts:132-134`) ist eine einzige synchrone Zuweisung, und `#compileFromCache` (`FilterSubscription.ts:197-205`) ruft `replaceLists` und `replaceUserRules` ohne `await` dazwischen. JavaScript ist einthreadig — **die Pipeline kann keinen halb gebauten Index sehen.**

**Kosten von (a) — Revision 2: die ursprüngliche Einschätzung war zu optimistisch.** Der Satz „bei `speed-dial` gibt es ohnehin keine Fremdanfragen" gilt für den Default, aber der Default ist nicht der einzige Pfad:
- **`session.restoreAfterCrash` steht ab Werk auf `true`** (`definitions.ts:226`). Nach einem Absturz lädt `applySessionRestore` (`index.ts:775-801`) bis zu vier echte Seiten sofort — `loadTimingFor` (`shared/session/restore.ts:177`) gibt für jeden Tab mit Kachel `'now'` zurück. Ausgerechnet in dem Lauf, in dem der Nutzer am wenigsten überrascht werden will, liefen vier Seiten ungefiltert.
- `startupBehaviour: 'restore'` und `'custom-url'` sind ein Klick entfernt.

**Die Zurückstellung ist deshalb Pflicht, nicht Option** — aber nicht in der ursprünglich skizzierten Form. „Alle Requests zurückstellen" kostet Latenz auf jedem Request. Richtig ist: **nur `mainFrame`-Navigationen zurückstellen, mit hartem Timeout (750 ms), danach durchlassen.** Subresources folgen der Navigation ohnehin. In `installRequestPipeline` (`RequestPipeline.ts:348`) ein Flag plus eine Promise, ca. 30 Zeilen.

**Zu (b):** Vor der Schätzung von 3 h prüfen, ob `FilterListStore` ETag/Last-Modified überhaupt speichert. Wenn nicht, ist das eine Manifest-Formatänderung mit Migration — dann **1,5 Tage**, nicht 3 h.

**Verifikation.** Fitness-Funktion: `filterSubscription.start()` darf in `index.ts` nicht awaited werden. Test: eine `mainFrame`-Navigation vor Fertigstellung wird zurückgestellt und nach spätestens 750 ms freigegeben. Zeitmessung gegen die Baseline aus M0.2.

### R4 — Startseite und interne Assets entschlacken

**Problem.** `session.startupBehaviour` steht auf `'speed-dial'` (`definitions.ts:218-222`), `#startupUrl()` (`BrowserWindowController.ts:576-586`) liefert `HOME_URL` = `tessera://start`. **Jeder neue Tab startet damit eine vollständige React-Anwendung in einem eigenen Prozess** — ~265 kB JS parsen und kompilieren plus React-Mount, für eine Kachelseite mit Quick Links. 55–85 MB statt der ~40 MB eines leeren Renderers.

Verschärfend: `src/main/protocol.ts:148` liefert interne Assets per `net.fetch(file://…)` **ohne `cache-control`-Header** — die Bild-Routen bei `:186-195` haben einen, die Skript-Routen nicht. Chromium behandelt sie damit als nicht cachebar, sodass jede neue Startseite die 192 kB React erneut durch den Main-Prozess anfordert.

Dazu: `catalog-*.js` (45,6 kB) enthält **beide** Sprachkataloge in jedem Renderer, weil `shared/i18n/catalog.ts:41` beide eager benennt — der Kommentar dort räumt es selbst ein.

**Fix.**
- **a** (30 min, **Wirkung vermutlich 0**): `cache-control` für Bundle-Assets in `protocol.ts:148`. **Revision 2:** Die Begründung ist zweifelhaft — Chromiums HTTP-Disk-Cache greift für eigene Schemata nicht, die Bytes kommen ohnehin aus dem Protokoll-Handler. Bliebe der Renderer-Memory-Cache, und **jeder neue Startseiten-Tab ist ein neuer Renderer mit leerem Cache**. Der dominierende Posten ist Parse + Compile von 265 kB pro Prozess, und dagegen hilft kein HTTP-Header. Als 30-Minuten-Versuch vertretbar, nicht als geplanter Gewinn.
- **b** (halber Tag): Sprachkataloge je Locale laden statt beide.
- **c** (**3 Tage**, statt 1–2): Startseite als statisches HTML + CSS mit einer kleinen Vanilla-JS-Insel für die Quick Links. **Die einzige Maßnahme in R4 mit belegbarer Wirkung.** Höherer Aufwand als gedacht, weil die i18n-Fitness-Funktionen (`architecture.test.ts:1402`, `:1417`) und die CSP-Prüfung (`:1496`) weitergelten — die Vanilla-Insel muss den Katalog weiter benutzen.

**Wirkung** 20–40 MB je Startseiten-Tab, spürbar schnelleres Öffnen neuer Tabs — im Wesentlichen aus (c).

### R5 — Prozesszahl deckeln (Entscheidung erforderlich)

**Problem.** Kein `--renderer-process-limit`, kein Prozess-Sharing. Bei 50 Tabs entstehen 54–56 Prozesse.

> ### ⚠️ Revision 2 — die gefährlichste Einzelzeile des ursprünglichen Plans
>
> `src/main/runtime-flags.ts:72` (verifiziert) setzt bereits:
> ```ts
> cli.appendSwitch('disable-features', DISABLED_FEATURES)   // 16 Features
> ```
> Ein **zweiter** `appendSwitch('disable-features', …)` — wie ursprünglich für `CalculateNativeWinOcclusion` vorgeschlagen — **überschreibt den ersten und verwirft die gesamte Datenschutzliste** (Translate, TopicsAPI, AttributionReporting, PrivacySandbox …). `base::CommandLine` hält Switches in einer Map; `AppendSwitchNative` ersetzt bei gleichem Namen. Kein Fehler, keine Warnung, und **keine Fitness-Funktion prüft die Liste.**
>
> **Auflage:** jedes weitere Feature gehört in das `DISABLED_FEATURES`-Array. Neue Fitness-Funktion: `appendSwitch('disable-features'` darf in `src/main` **genau einmal** vorkommen. *(Der Überschreib-Mechanismus ist Chromium-Kenntnis, am Code nicht prüfbar — die Auflage kostet nichts und deckt beide Fälle ab.)*

**`--renderer-process-limit=N`** — **Revision 2: Nutzen vermutlich gering, nicht 2–5 GB.** Bei erreichtem Limit sucht Chromium zwar einen bestehenden Prozess, aber `IsSuitableHost` erzwingt den `ProcessLock`: ein auf Site A gesperrter Prozess ist für Site B nicht geeignet, also entsteht trotzdem ein neuer. Mit intakter Site Isolation degradiert das Limit auf „gleiche Site teilt sich einen Prozess" — was Chromium oberhalb seines eigenen, RAM-abhängigen Defaults ohnehin tut. **Damit ist R5 nicht „hohe Wirkung, hohes Risiko", sondern „unbekannte, vermutlich geringe Wirkung" — und im selben Zug ist der Sicherheits-Tradeoff kleiner als angenommen.** *(Chromium-Kenntnis; messbar über `app.getAppMetrics()`.)* **Vor dem Bau messen.** Falls doch gebaut: nicht als Standard, sondern als beschrifteter „Sparmodus" mit ehrlichem Text.

**Nicht** `--process-per-site` (ein Renderer-Crash reißt alle Tabs derselben Site mit) und **nicht** Site Isolation abschalten — `docs/ARCHITECTURE.md:355` benennt das korrekt als Nicht-Option.

**Ergänzend:**
- `--js-flags=--max-semi-space-size=…` — **Revision 2: `=8` senkt vermutlich nichts.** V8s Default auf 64-Bit-Desktops liegt bereits bei etwa 8 MB; `=8` wäre ein No-op oder eine Erhöhung. Wer begrenzen will, braucht `=2` oder `=4`. **Und `--js-flags` gilt in Electron auch für das V8-Isolate des Main-Prozesses** — es verlangsamt damit den Filter-Compile aus R3. *(Chromium-/V8-Kenntnis.)*
- `CalculateNativeWinOcclusion` (nur Windows) — verhindert den bekannten Fehler, bei dem Chromium Fenster fälschlich als verdeckt einstuft und das Rendern einstellt. Für Multi-View-Anwendungen praktisch Pflicht. **Nur über `DISABLED_FEATURES`, siehe Warnung oben.**
- `--disk-cache-size` setzen — Chromium wählt sonst adaptiv, gern über 1 GB. Nur Platte, kein RAM.

### N1–N2, N5 — drei Sofortmaßnahmen aus der Review

| ID | Befund | Aufwand |
|---|---|---|
| **N1** | **`sessionStore?.seal()` steht im falschen Handler — echter Bug, verifiziert.** `src/main/index.ts:835` liegt **innerhalb** von `app.on('open-url', …)`, zwischen `event.preventDefault()` und `const target = …`, mit abweichender Einrückung und einem Kommentar, der eindeutig den Shutdown beschreibt („The flush below records every window while they are all still open; the windows then close and would each drop their slot"). Es ist der **einzige** Aufrufer von `seal()` im Produktionscode. **Doppelte Folge:** beim Beenden wird nie versiegelt (der Zweck, für den `seal()` existiert, wird nie erfüllt — `BrowserWindowController.ts:289` verlässt sich darauf), und sobald einmal ein Link aus einer anderen Anwendung geöffnet wird (macOS, Standardbrowser-Betrieb), wird die Sitzungsaufzeichnung für den Rest des Laufs stillgelegt. Bug seit dem Init-Commit; von keiner der vier Bewertungen gefunden. | **15 min** |
| **N2** | `Tab.setBounds`/`setVisible` ohne `isDestroyed()`-Guard (`Tab.ts:509-515`) — als einzige Methoden der Klasse. Vorbedingung für R2, für die Absturzseite in V5 und für W2. | 15 min |
| **N5** | **Das Fenster wird erst nach dem React-Mount gezeigt.** `BrowserWindowController.ts:274-278` wartet auf `did-finish-load` des Chrome-Renderers. `backgroundColor` setzen und bei `ready-to-show` (oder direkt nach `new BrowserWindow`) anzeigen verkürzt die **wahrgenommene** Startzeit stärker als R3a. Der billigste Startzeit-Hebel im ganzen Plan. | 15 min |

**Die übrigen Review-Ergänzungen** sind bei ihrer jeweiligen Maßnahme eingearbeitet und hier nur zur Nachverfolgbarkeit gelistet:

| ID | Befund | eingearbeitet in |
|---|---|---|
| **N3** | Kein `lastActiveAt` am Tab — ohne Zeitstempel ist `advanced.unloadAfterMinutes` nicht auswertbar | R2, Punkt 5 |
| **N4** | Zwei `input-event`-Listener pro WebContents, nicht einer | H6 |
| **N6** | GPU-Prozess-Kosten bei vielen Kacheln fehlen in allen Schätzungen | M0.5 |
| **N7** | Private Sessions werden nie freigegeben | Q3 |
| **N8** | Ein Discard-Timer für die Anwendung statt einer je Fenster | R2, Punkt 6 |
| **N9** | `applySessionIdentity` wird nie erneut angewandt — `applies: 'new-tab'` lügt | Q6, eigener Abschnitt |
| **N10** | `search.suggestFromHistory` fehlte in der Q4-Tabelle | Q4 |

---

## 4. Welle 2 — Tote Verdrahtungen und fehlende Seiten

Vier Systeme sind vollständig gebaut und getestet, aber nie angeschlossen. Das ist die billigste Welle des Plans: viel sichtbare Wirkung, fast keine neue Logik.

### V1 — Berechtigungs-Dialog anschließen

**Problem, verifiziert.** `src/main/session/hardening.ts:81`:
```ts
const ask = options.requestFromUser ?? ((): Promise<boolean> => Promise.resolve(false))
```
`requestFromUser` wird **nirgends übergeben** — die einzigen Treffer im Quellbaum sind die Typdeklaration (`:63`) und dieser Fallback. `permissionArbiter` (`index.ts:591`) geht ausschließlich an `registerHandlers` (`:701`), nie an `applySessionHardening` (`WindowRegistry.ts:242-245`). **`PermissionArbiter.ask()` hat null Produktions-Aufrufer.**

Damit ist ein System von ~400 Zeilen mit eigener Warteschlange, Coalescing, Cap, Fokusfalle und drei Testdateien vollständig unerreichbar. Es ist die am sorgfältigsten gebaute Komponente des Projekts.

**Zweiter, unabhängiger Defekt:** alle acht Berechtigungen stehen ab Werk auf `deny` statt `ask` (`definitions.ts:186-193`), und `session/permission-policy.ts:292-293` gibt bei `deny` **vor** `recall` und `prompt` zurück. Selbst nach V1 erreicht niemand den Dialog, solange er nicht acht Auswahlfelder umstellt.

**Nutzerpfad heute:** Videocall öffnen → Kamera wird verweigert → kein Prompt, kein Icon in der Adressleiste, keine Zeile im UI. Die Seite sagt „Kamera nicht verfügbar", der Browser sagt nichts.

**Fix.**
1. `requestFromUser: (permission, origin) => permissionArbiter.ask(permission, origin)` durch `WindowRegistryDeps` an `applySessionHardening` durchreichen.
2. Defaults für Kamera, Mikrofon, Standort, Zwischenablage und Bildschirmfreigabe von `deny` auf `ask` — das ist genau die Semantik, für die der Arbiter gebaut wurde. Benachrichtigungen und Sensoren können auf `deny` bleiben.
3. **Revision 2 — sonst bleibt V1 wirkungslos:** `hardening.ts:114-116` registriert einen **zweiten** Handler:
   ```ts
   session.setPermissionCheckHandler((_webContents, permission) =>
     decidePermission(permission, getSettings()) === 'allow')
   ```
   Bei Default `ask` liefert der `false` — `navigator.permissions.query()` meldet „denied", während der Request-Handler den Dialog zeigen würde. Zwei Wahrheiten über denselben Zustand. Schlimmer: einige Chromium-Pfade fragen den Check-Handler **vor** dem Request-Handler und brechen dort ab; dann erscheint der Prompt bei `ask` nie. Der Check-Handler muss bei `ask` die erinnerte Antwort aus dem `PermissionStore` konsultieren (`recall`) und nur bei „nichts erinnert" `false` liefern — dieselbe Reihenfolge, die `resolvePermissionRequest` bereits kennt. *(Die Reihenfolge der beiden Handler ist Chromium-Verhalten; nur in der laufenden App verifizierbar — M0.1.)*
4. Ein Berechtigungs-Indikator in der Omnibox, wenn eine Seite etwas angefragt hat.

**Aufwand** korrigiert: **1 Tag** (statt halber). **Risiko** niedrig — fail-closed bleibt der Fallback.

### V2 — Medien-Erkennung anschließen

**Problem.** `MediaService.observeRequest`/`observeResponse` (`MediaService.ts:113`, `:118`) haben keine Aufrufer. `WindowRegistryDeps` (`WindowRegistry.ts:51-85`) hat kein Media-Feld; `applySessionHardening` bekommt kein `onResponse` (`hardening.ts:82` setzt es auf einen No-Op), `installRequestPipeline` bekommt nur `onBlocked` (`:263-278`). Sechs Testdateien mit über 3500 Zeilen prüfen ein System, das nie Daten sieht. Das `MediaPanel` im Renderer ist vollständig implementiert und nirgends verdrahtet.

**Fix.** Media-Feld in `WindowRegistryDeps`, `onResponse`/`onRequest` an die Beobachter hängen, `MediaPanel` in der Toolbar erreichbar machen.

**Vorbedingung:** gleichzeitig mit **Q3** umsetzen — die Media-Registry hat zwei latente Speicherlecks (`MediaSessions.release()` und `forgetTab()` ohne Aufrufer), die genau in dem Moment real werden, in dem die Hooks angeschlossen sind.

### V3 — Tote Menüeinträge verdrahten

**Problem, verifiziert.** `src/renderer/src/App.tsx:75-127` behandelt `nextTab`, `previousTab`, `focusAddressBar`, `findInPage`, `findNext`, `blockElement` — und fällt für alles andere auf `default: break`. Ohne Fall bleiben:

| Menüeintrag | Sendet | Ergebnis |
|---|---|---|
| Lesezeichen hinzufügen (Strg+D), `appMenu.ts:286` | `addBookmark` | nichts. **Es gibt keinen anderen Weg, die aktuelle Seite zu speichern** — `bookmarks:create` ist nur von der Lesezeichen-Seite erreichbar, und in der Toolbar fehlt der Stern. |
| Browserdaten löschen (Strg+Umschalt+Entf), `appMenu.ts:372-376` | `clearData` | nichts. **Ein Privacy-Browser, der Cookies und Cache nicht löschen kann, ohne beendet zu werden** — `clearData` in den Einstellungen kennt nur `onExit`. |
| Panik-Eintrag, `appMenu.ts:379` | `panic` | nichts |

**Fix.** Drei `case`-Zweige plus ein Bestätigungsdialog für `clearData` mit Kategorieauswahl. Zusätzlich einen Lesezeichen-Stern in der Toolbar, der den gespeicherten Zustand der aktuellen Seite anzeigt — sonst bleibt Strg+D unsichtbar.

**Aufwand** 1 Tag inkl. Dialog.

### V4 — Die Fitness-Funktion, die das verhindert hätte

**Das ist der eigentliche Punkt dieser Welle.** Es gibt Fitness-Funktionen für „jeder Kanal hat einen Handler" (`architecture.test.ts:1242-1258`), „jeder puffernde Store wird beim Beenden geflusht" (`:1550`), „jede Aktion hat einen Menüeintrag mit Accelerator" (`:496`) — aber **keine für „jeder gebaute Dienst hat einen Produktions-Aufrufer".** Dieselbe Fehlerklasse ist fünfmal durchgerutscht: V1, V2, V3, N1 und die Einstellungen aus Q4.

> **Revision 2 — die ursprünglich vorgeschlagene Prüfung ist so nicht baubar.** „Für jede öffentliche Methode einen Aufrufer suchen", umgesetzt als Quelltext-Grep über Methodennamen, erzeugt massiv Rauschen: `open`, `close`, `find`, `list`, `flush`, `get`, `size`, `install`, `start`, `apply`, `release` kommen dutzendfach in unverwandtem Code vor. Ergebnis wäre ein Test, der immer grün ist, oder eine Allowlist, die jeder erweitert — genau die Falle, die der Kommentar bei `architecture.test.ts:496` schon einmal beschrieben hat („**This list was over-permissive by eight entries**").

**Korrigierter Fix — syntaktisch prüfbar statt namensbasiert:**
1. **Jedes optionale Funktions-Feld in einem `*Deps`/`*Options`-Interface muss an mindestens einer Produktions-Aufrufstelle gesetzt werden.** Das hätte V1 (`requestFromUser`) und V2 (`onResponse`) **beide** gefangen — und es ist über den AST entscheidbar, ohne Namensraten.
2. Jede in `src/main` exportierte Klasse muss in `src/main/index.ts` (oder in einer der Phasen aus Q6) konstruiert werden — Form wie der bestehende Test „starts every installer it has" (`:820`).
3. **Die Settings-Prüfung schärfen:** Sie akzeptiert heute, dass das Literal irgendwo in `src/` vorkommt. Gegenbeispiel: `appearance.showBookmarksBar` besteht den Test, weil `appMenu.ts:192` es für einen Menühaken liest, hinter dem keine Leiste existiert. Verlangt sein muss ein Leser **außerhalb** der eigenen Definition, der Beschreibungstexte und der eigenen Menü-Checkbox.

**Aufwand** korrigiert: **2 Tage** (statt 1) — dafür wirksam. **Wirkung** verhindert die teuerste Fehlerklasse des Projekts dauerhaft.

### V5 — Die vier fehlenden Seiten

**Problem, verifiziert.** `KNOWN_PAGES` in `src/main/protocol.ts:67-81` listet `about` und `https-only`. In `src/renderer/internal/` existieren acht HTML-Dateien — `about.html` und `https-only.html` sind **nicht** darunter. Beide Adressen landen auf `protocol.ts:210-219`: dunkler Kasten, `<h1>tessera://https-only</h1>`, darunter hartkodiert *„This internal page does not exist."* — kein Zurück-Link, keine Erklärung, keine Übersetzung.

Das trifft zwei reale Pfade:

1. **`privacy.httpsOnlyMode` steht ab Werk auf `true`** (`definitions.ts:154`). `RequestPipeline.ts:226` leitet jede `http://`-Top-Level-Navigation auf `tessera://https-only?target=…`. **Jede HTTP-Seite ist damit kaputt, und die Ursache steht nirgends.**
2. **Hilfe ▸ Über Tessera** (`appMenu.ts:443`, macOS zusätzlich `:455`) → dieselbe 404. Man kann nicht einmal die Versionsnummer nachsehen.

Die passenden Texte existieren bereits ungenutzt im Katalog: `error.httpsOnly`, `error.httpsOnly.continue`, `error.httpsOnly.back` (`shared/i18n/catalog.de.ts:515-517`).

**Zwei weitere Seiten fehlen ganz:**

3. **Netzwerkfehlerseite.** `did-fail-load` wird abonniert (`Tab.ts:452`), aber `TabState` (`:740-765`) hat kein Fehlerfeld. `Tab.loadUrl` (`:519-525`) verschluckt die Rejection mit dem Kommentar „surface through … the error page" — diese Seite gibt es nicht. Die Texte `error.dnsFailed`, `error.offline`, `error.certificate`, `error.blocked` (`catalog.de.ts:512-517`) haben keinen Abnehmer. Ergebnis: Chromiums englische Rohfehlerseite in einem deutschen Browser.
4. **Absturzseite.** `Tab.ts` abonniert 22 WebContents-Ereignisse; `render-process-gone` und `unresponsive` sind nicht darunter (`render-process-gone` existiert nur für die Overlay-Schicht, `OverlayLayer.ts:288`). Ein abgestürzter Tab ist eine weiße Fläche mit unverändertem Titel im Streifen.

**Fix.** Vier HTML-Einstiege plus Vite-Einträge, Texte aus dem vorhandenen Katalog, `render-process-gone` und `unresponsive` in `Tab.ts` abonnieren, Fehlerfeld in `TabState`.

**Aufwand** korrigiert: **3 Tage** (statt 1,5). Das Fehlerfeld in `TabState` berührt `shared/ipc/contract.ts`, die `same-shape`-Tests und potenziell das Session-Schema (`SessionTab` ist ein struktureller Subset von `TabState`); jeder der vier HTML-Einstiege muss durch die CSP-Prüfung (`architecture.test.ts:1496`), die Privilegientabelle in `channels.ts` und das Bundle-Budget. **Trotzdem: größte Wirkung pro Zeile im ganzen Projekt** — das Gerüst steht, die Texte sind geschrieben, es fehlen die Dateien.

**Sicherheitsauflage:** Die Interstitial-Seiten dürfen **keine** IPC-Kanäle bekommen. `navigation-policy.ts:61-64` listet `https-only` bewusst nicht in `INTERNAL_PAGES` — das muss so bleiben.

---

## 5. Welle 3 — Web-Kompatibilität

Ohne diese Welle bricht der Alltag an Stellen, die nichts mit dem Produktkonzept zu tun haben.

### W1 — Zertifikatsfehler: Ausnahme ermöglichen

`Tab.ts:460-463` setzt nur ein Flag — kein `preventDefault`, kein `callback(true)`, kein `setCertificateVerifyProc`. Die UI zeigt ein ⛔ in der Omnibox. **Es gibt kein „Erweitert ▸ Trotzdem fortfahren".**

Betroffen: Intranet mit eigener CA, NAS mit Selfsigned-Zertifikat, lokaler Dev-Server, Router-Oberflächen, Firmen-Proxies. Das ist sicher, aber es zwingt den Nutzer zum Browserwechsel — und das ist das schlechtere Sicherheitsergebnis.

**Fix.** Interstitial-Seite (baut auf V5 auf) mit Fehlerdetails und einer Ausnahme, die **pro Host und nur für die Sitzung** gilt. Dauerhafte Ausnahmen nur über die Einstellungen, mit sichtbarer Liste. **Aufwand** 1 Tag.

### W2 — `window.open`: den Rückkanal reparieren

**Korrektur eines Befunds aus der Bewertung.** `Tab.ts:495-499` verwirft *nicht* alles — verifiziert:
```ts
wc.setWindowOpenHandler(({ url, disposition }) => {
  if (/^https?:/i.test(url)) {
    this.callbacks.onOpenNewTab(url, { background: disposition === 'background-tab' })
  }
  return { action: 'deny' }
})
```
http(s)-URLs werden als **neuer Tab** geöffnet; das `deny` verhindert nur das unkontrollierte Popup-Fenster. Redirect-basierte OAuth-Flows funktionieren daher.

**Was wirklich bricht:** `window.open()` liefert `null` und `window.opener` existiert nie. Popup-basierte Flows, die über `window.opener.postMessage` zurückmelden — verbreitet bei „Mit Google anmelden", Banking-TANs und Zahlungsdienstleistern — laufen ins Leere. Der Nutzer sieht einen neuen Tab, der nach erfolgreicher Anmeldung stehen bleibt, während die ursprüngliche Seite ewig wartet.

> ### 🔴 Revision 2 — der ursprüngliche Fix kompiliert nicht und öffnet ein geschlossenes Sicherheitsloch
>
> **(a) `'new-popup'` gibt es in Electron 43 nicht.** `electron.d.ts:21397` (verifiziert):
> ```
> disposition: ('default' | 'foreground-tab' | 'background-tab' | 'new-window' | 'other');
> ```
> Der Vergleich ist auf diesem Union-Typ ein TypeScript-Fehler; `pnpm typecheck` schlägt fehl. Chromiums `NEW_POPUP` wird auf `'new-window'` oder `'other'` abgebildet — **die angenommene Trennschärfe zwischen OAuth-Popup und beliebigem `window.open` existiert nicht.**
>
> **(b) Ein von Electron erzeugtes Popup hat keinen Navigationsschutz.** Der Schutz gegen „Seite navigiert sich auf `tessera://settings` und bekommt dessen Kanäle" hängt an `will-frame-navigate`/`will-redirect`, die in `Tab.#wireEvents` sitzen (`Tab.ts:491-492`). Ein Popup ist kein `Tab` und hat keine davon. `decideAccess` (`sender-policy.ts:93-122`) vergibt Kanäle allein anhand der Frame-URL, und das Popup erbt Preload und Rollenargument vom Elternteil. **Ergebnis: `window.open('about:blank').location = 'tessera://settings'` liefert einer besuchten Seite die Settings-Kanäle** — exakt das Loch, das `navigation-policy.ts:6-16` als „the one security hole this project shipped with" beschreibt.
>
> **(c) Die Fitness-Funktion greift nicht.** `architecture.test.ts:421-434` prüft auf das Literal `new BrowserWindow(` in `src/main`. Ein von Electron intern erzeugtes Fenster enthält es nicht — der Test bliebe grün, während die Zusage „jedes Fenster geht durch die eine Optionsfunktion" nicht mehr gilt.

**Korrigierter Fix.** `WindowOpenHandlerResponse` bietet zwei Felder, die der ursprüngliche Plan nicht kannte (`electron.d.ts:20274-20299`, verifiziert): `createWindow?: (options) => WebContents` und `overrideBrowserWindowOptions`.

1. `action: 'allow'` **nur** mit `createWindow`, das ein `BrowserWindowController`-verwaltetes Fenster mit einem echten `Tab` erzeugt — damit gelten `will-frame-navigate`, `applyWebRtcPolicy`, Zoom, Kontextmenü und Historien-Aufzeichnung unverändert.
2. `overrideBrowserWindowOptions` mit `chromeWindowOptions`-Äquivalent, `webPreferences` explizit gesetzt statt geerbt.
3. Ein Allowlist-Kriterium, das **nicht** `disposition` ist — etwa Nutzergeste plus abweichende Registrable Domain.
4. Neue Fitness-Funktion: jede `setWindowOpenHandler`-Rückgabe mit `action: 'allow'` muss `createWindow` **und** `overrideBrowserWindowOptions` tragen.

**Sicherere Alternative, die der ursprüngliche Plan nicht erwog:** den `opener`-Rückkanal simulieren statt das Popup zuzulassen. Der Tab wird wie heute geöffnet, der Kern merkt sich die Beziehung und stellt im Kind-Tab per `document-start`-Injektion ein `window.opener`-Shim bereit, dessen `postMessage` über den Kern an den Eltern-Tab geht (Origin-Prüfung im Kern). Mehr Arbeit, hält aber jede Seite in einem verwalteten `Tab`.

**Aufwand** korrigiert: **4–6 Tage** für den sicheren Weg (statt 1–2). **Ampel 🔴** — ohne die vier Auflagen **nicht umsetzen.**

### W3 — Externe Protokolle

`shell.openExternal` existiert nur in `updates/install-updates.ts:92`. Es gibt keinen `will-navigate`-Handler für Nicht-http-Schemata. **`mailto:`-, `tel:`- und `zoommtg:`-Links tun schlicht nichts.**

> ### 🔴 Revision 2 — die Frage ist bereits entschieden, und zwar anders
>
> `src/main/session/permission-policy.ts:44-56` (verifiziert):
> ```ts
> export const ALWAYS_DENIED: ReadonlySet<string> = new Set([
>   'hid', 'serial', 'usb', 'bluetooth', 'idle-detection',
>   'window-management', 'speaker-selection', 'keyboard-lock',
>   // Would let a page launch other applications.
>   'openExternal'
> ])
> ```
> Das Projekt hat die Frage mit **genau der Begründung** entschieden, die W3 aufheben will. Ein `will-navigate`-Handler, der `shell.openExternal` selbst ruft, **umgeht diese Policy von außen, statt sie zu ändern** — und kein Test bricht dabei.
>
> Ein Bestätigungsdialog ist auch keine Entscheidung: Dialoge lassen sich in Serie auslösen (Dialog-Bombing), und ohne Gestenprüfung reicht ein `<iframe src="ms-msdt:…">` beim Laden.

**Korrigierter Fix — Policy ändern statt umgehen:**
1. `'openExternal'` aus `ALWAYS_DENIED` entfernen und als sichtbares Setting `permissions.openExternal` mit Default `ask` einführen.
2. Den Weg über den in **V1** angeschlossenen Arbiter führen — eine Entscheidungsstelle, nicht zwei.
3. **Nutzergeste erforderlich**, Rate-Limit pro Tab, Schema-**Allowlist** (nicht Denylist).
4. Die Entscheidung in `permission-policy.ts` dokumentieren, nicht daneben.

**Aufwand** korrigiert: **1,5 Tage** (statt halber). **Ampel 🔴 → 🟡** nach Umsetzung der vier Auflagen. **Abhängigkeit: V1 muss vorher stehen.**

### W4 — Beforeunload respektieren

`Tab.ts:768-776` ruft `webContents.close()` ohne `waitForBeforeUnload`; es gibt keinen `will-prevent-unload`-Handler. Der Tab wird zudem *vorher* aus `#tabOrder` und `#tabs` entfernt (`BrowserWindowController.ts:419-422`). Halb geschriebene Mail, versehentliches Strg+W → weg, ohne Rückfrage.

**Fix.** `close({ waitForBeforeUnload: true })` plus `will-prevent-unload`-Handler mit Dialog. **Aufwand** halber Tag.

> **Revision 2 — die offene Frage ist beantwortet.** `electron.d.ts:17886-17892` und `:20753-20760` (verifiziert): *„If the page is successfully closed (i.e. the unload is not prevented by the page, or `waitForBeforeUnload` is false **or unspecified**), the WebContents will be destroyed"*, und `CloseOpts.waitForBeforeUnload`: *„if true, fire the `beforeunload` event before closing the page."* **Ohne die Option wird `beforeunload` nicht ausgelöst.** Der Befund ist bestätigt.
>
> **Konsequenz für die Reihenfolge:** W4 ist keine unabhängige Maßnahme der Welle 3, sondern die **Voraussetzung von R2** — es ist der einzige existierende Mechanismus, um „unbestätigte Eingaben" vor einem Discard zu erkennen. W4 gehört nach Welle 1, unmittelbar vor R2.

### W5 — PDF-Viewer

Keine Treffer für `plugins:`, `application/pdf`, `PDFViewer`, `printToPDF`. PDFs landen als Download. Für einen Daily Driver eine harte Lücke — jede Rechnung, jedes Ticket, jeder Behördenbrief.

**Fix.** Chromiums eingebauten PDF-Viewer über `webPreferences.plugins: true` aktivieren.

> **Revision 2:** Die Zusage „gegen die Sicherheits-Fitness-Funktionen prüfen" liefe ins Leere — **keine bestehende Fitness-Funktion prüft `plugins`.** `architecture.test.ts:457-465` prüft nur `enableRemoteModule`, `allowRunningInsecureContent`, `webSecurity`, `nodeIntegration`. **Auflage:** neue Fitness-Funktion, `plugins:\s*true` ausschließlich in `Tab.ts` und nirgends sonst. PDFium läuft im Renderer-Sandbox, das Risiko ist real, aber begrenzt; die eigentliche offene Frage ist, ob Electron 43 den Viewer überhaupt ausliefert — nur in der App prüfbar (M0.1).

**Aufwand** korrigiert: **1 Tag** (statt halber). **Ampel 🟡.**

### W6 — Screen-Sharing

`hardening.ts:122-127` antwortet auf `getDisplayMedia` immer `callback({})`; kein `desktopCapturer`. Videokonferenzen ohne Bildschirmfreigabe. **Fix** über `desktopCapturer` plus Quellenauswahl-Dialog, angebunden an V1. **Aufwand** 1–2 Tage.

### W7 — Rechtsklick in Eingabefeldern

`src/main/menu/page-context-items.ts` liest `linkURL`, `srcURL`, `selectionText`, `isEditable` — für ein Textfeld gibt es **keine eigenen Einträge**. Kein Einfügen, kein Rückgängig, keine Rechtschreibvorschläge. Rechtsklick-Einfügen in ein Webformular ist unmöglich. Die Chrome-UI selbst hat gar kein Kontextmenü: Rechtsklick in die Adressleiste öffnet nichts.

Zusätzlich fehlen im Tab-Kontextmenü (`tab-context-items.ts`) „Andere schließen", „Nach rechts schließen", „Duplizieren" und „In neues Fenster" — die vier meistgenutzten Aufräumbefehle jedes Browsers.

**Fix.** Editier-Rollen plus `replaceMisspelling`, Kontextmenü für die Omnibox, vier Tab-Menüeinträge. **Aufwand** 1 Tag.

### W8 — Nicht auf der Liste, aber ehrlich zu benennen

**DRM/Widevine** (Netflix, Spotify Web, Disney+) ist mit einem Standard-Electron-Build **nicht nachrüstbar**. Es braucht einen castlabs-ECS-Build und kollidiert zusätzlich mit `--disable-component-update` (`runtime-flags.ts:77`). Wenn Streaming zum Alltag gehört, ist das eine Architekturentscheidung am Anfang, keine Aufgabe in einem Plan.

---

## 6. Welle 4 — Hot Path und IPC

Zahlt direkt auf „blitzschnell" ein, ohne Feature-Risiko.

### H1 — Request-Pipeline aufräumen

Der Filter-Matcher selbst ist algorithmisch richtig: Host-Map plus Token-Buckets nach dem seltensten Token, nur 84 untokenisierte Fallback-Regeln, keine Regex im Hot Path. **Die Kosten liegen daneben.**

| Befund | Ort | Fix |
|---|---|---|
| `getSettings()` klont 76 Schlüssel — **dreimal pro Request** (228 Property-Kopien; bei 150 Requests/Seite ~34.000) | `SettingsStore.ts:194-196`, gerufen aus `RequestPipeline.ts:349`, `hardening.ts:141`, `:151` | eingefrorenen Snapshot als Feld halten, in `onChange` tauschen (~4 Zeilen) |
| Telemetrie-Stufe: ~105 Stringoperationen pro Request — `Array.some` über 15 Hosts, jeder Vergleich mit zweimal `normalizeHost` (`toLowerCase` + 2 Regex-`replace`) gegen eine bereits kleingeschriebene Konstante | `RequestPipeline.ts:137`, `:162`; `shared/url/domain.ts:182-187`, `:122` | Hostliste einmalig als `Set` normalisieren, Suffix-Walk über die Labels: 2–4 Lookups statt 30 Regex-Durchläufen |
| 5–6 `new URL()` je Top-Level-Navigation allein in der Pipeline, plus 2 in `partiesOf`, plus 4 auf der Antwortseite | `RequestPipeline.ts:240,251,258`; `network.ts:344-345`; `headers.ts:80-81,177` | ein Parse, im Context geteilt |
| `normalizeRequestHeaders` kopiert das Header-Objekt 5–7 Mal | `session/headers.ts`, `hardening.ts:143` | in-place arbeiten, eine Kopie am Ende |
| **`#noteBlockedRequest` baut je geblocktem Request einen vollständigen `TabState`** — nur um `.url` zu lesen. `toState()` macht dabei ~8 synchrone Chromium-Aufrufe. Auf einer werbelastigen Seite im 2×2 geschätzt ~4800 native Aufrufe pro Ladung. | `WindowRegistry.ts:282-295`, `Tab.ts:740-765` | `Tab` hält `#currentUrl`, aktualisiert in `did-navigate` (~5 Zeilen) |
| Kosmetik: `cosmeticSelectorsFor` berechnet die generische Hälfte mit, obwohl nur `.specific` verwendet wird; bei einer `#@#`-Ausnahmeregel werden 28.914 Selektoren zweimal gefiltert und verworfen | `FilterEngine.ts:165-185`, `shared/filters/cosmetic.ts:178-185` | generische Hälfte nur auf Anforderung berechnen |

**Revision 2 — zwei Präzisierungen:**
- Der Settings-Snapshot gehört **nicht** an die drei Aufrufstellen, sondern in `SettingsStore.snapshot()` selbst: das eingefrorene Objekt einmal cachen und in `#applyMany` austauschen. Ein Ort, alle Aufrufer profitieren — auch `BrowserWindowController.getSettings`, das in `Tab.zoomPercent` bei **jedem** `toState()` läuft.
- `#noteBlockedRequest` hat einen zweiten, bisher nicht genannten Defekt: es durchsucht nur Tabs **in Kacheln** (`for (let tile = 0; tile < controller.split.tileCount; tile++)`, `WindowRegistry.ts:282-295`). **Der Blocker-Zähler eines Hintergrund-Tabs bleibt bei 0.** Der `#currentUrl`-Fix sollte das gleich miterledigen.

**Aufwand** ~4 h für die ersten fünf, halber Tag für die Kosmetik. **Wirkung** grob 3–5× weniger JS-Arbeit je Request.

### H2 — Broadcast-Deduplizierung und React-Memoisierung

Coalescing existiert und funktioniert (`BrowserWindowController.ts:1015-1020`, Dirty-Flag plus `setImmediate`). **Aber jede Runde sendet den Vollzustand:** `tabs:changed` mit allen Tabs à 16 Feldern, dazu `tabgroups:changed`, `split:changed`, bis zu zwei Tile-Bar-Nachrichten und eine volle Zod-Validierung des Session-Dokuments. Bei 50 Tabs ~21 kB je Runde, 6–7 Runden je Seitenladung ≈ **145 kB, um die Änderung an einem einzigen Tab mitzuteilen.**

Renderer-seitig: kein `React.memo`, kein `useCallback`, kein `useMemo` in `TabBar.tsx`, `Toolbar.tsx`, `SplitDividers.tsx`, `App.tsx`. Jeder Push rendert den ganzen Baum, und weil drei getrennte Nachrichten in drei Tasks ankommen, sind es 2–3 Vollrender pro Runde. Dazu ist die Dependency `[state.tabs, state.activeTabId]` in `App.tsx:129` bei jedem Push eine neue Array-Identität — der `shortcut:triggered`-Listener wird bei **jedem** Zustandspush ab- und wieder angemeldet.

**Fix, gestaffelt:** (a) Gleichheitsprüfung vor `emit` — billig, entfernt 50–80 % der Runden. (b) `React.memo` auf `TabBar`/`Toolbar`, `useMemo` für `shortcutTitles`, Dependency in `App.tsx:129` über eine Ref auf `[]` reduzieren. (c) mittelfristig `tabs:patch` mit geänderten IDs statt Vollzustand. **Aufwand** a+b ~3 h, c ~1 Tag.

### H3 — Divider-Drag drosseln

`SplitDividers.tsx:40-55` sendet bei **jedem** Pointer-Event ungedrosselt `invoke('split:setFractions')`, was im Main-Prozess `setBounds()` auf mehreren Views auslöst und eine volle Broadcast-Runde anstößt: ~5 Nachrichten pro Frame, 300/s bei 60 Hz, 600/s bei 120 Hz. Bei 50 Tabs ~1,2 MB/s Serialisierung für eine einzige Fließkommazahl.

Der strukturell identische Tab-Drag-Pfad nutzt dafür bereits `rafThrottle` (`useTabDrag.ts:56`), dessen eigener Kommentar begründet, warum das auf älteren Laptops nötig ist. **`rafThrottle` existiert und wird an genau einer Stelle benutzt.**

**Fix.** `rafThrottle` davorsetzen; `setFractions` emittiert nur `split:changed` statt der vollen Runde.

> **Revision 2 — der zweite Teil hat eine Nebenwirkung.** `setFractions` (`BrowserWindowController.ts:641-656`) ruft `#scheduleBroadcast()`, und **darin** steckt `sessionSlot.record({… fractions …})` (`:1049`). Emittiert `setFractions` künftig nur noch `split:changed`, wird die neue Teilung **gar nicht mehr in der Sitzung aufgezeichnet** — bis zufällig ein anderes Ereignis eine volle Runde auslöst. **Auflage: am Drag-Ende eine volle Runde.**
>
> **Zusammen mit H2 umsetzen** — H2(a) („Gleichheitsprüfung vor `emit`") und H3 sind zwei Umbauten derselben Funktion `#scheduleBroadcast`.

**Aufwand** korrigiert: **2 h** (statt 30 min).

### H4 — Persistenz-Kosten senken

`JsonStore.update` (`:178`) ruft `safeParse(next)` — Zod konstruiert seine Ausgabe, das ist ein **Deep-Clone des gesamten Dokuments bei jeder Mutation**. Bei 10.000 History-Einträgen: ~50.000 Feldprüfungen plus 10.000 Objektallokationen **pro Navigation**. Davor liegen in `shared/history/model.ts:209,223,225,246-251` bereits vier weitere Vollkopien des Arrays. Die 250-ms-Entprellung coalesced nur den Plattenschreibvorgang, nicht diese Arbeit. Geschätzt **20–60 ms Main-Thread-Blockade je Seitenaufruf** bei voller History.

> ### Revision 2 — die Validierung darf nicht verschoben werden
>
> `JsonStore.update` macht heute zwei Dinge: Ein fehlerhafter Aufrufer bekommt einen **Throw**, und das Dokument bleibt unverändert (der Docblock sagt das ausdrücklich). Gespeichert wird `parsed.data` — zods **Ausgabe** mit allen Coercions, Defaults und `strip`-Effekten, nicht der rohe Eingabewert.
>
> Verschiebt man die Validierung in `flush()`, dann landet **(a)** ein ungültiges Dokument im Speicher und wird an alle `onChange`-Listener und über IPC an die Renderer verteilt, und **(b)** fällt der Fehler erst beim Schreiben auf — wo `flush()` ihn **verschluckt** (`catch { console.error(…) }`). Das ist exakt die Fehlerklasse, die dieser Plan in U10 als Defekt führt („Lesezeichen anlegen, sichtbar, nach Neustart weg"). H4 hätte sie ausgeweitet.

**Korrigierter Fix.** Der Kostentreiber ist nicht die Validierung, sondern dass sie das **ganze** Dokument klont:
1. Pro Store einen `updateEntry`-Pfad, der nur das geänderte Element gegen das Element-Schema validiert und in ein bestehendes Array/eine Map einsetzt — kein Voll-Clone. Zusage bleibt erhalten.
2. History intern als `Map<url, Visit>` plus sortiertem Index halten statt mehrerer Array-Vollkopien (`shared/history/model.ts:209,224,251,265`); `HistoryStore.ts:192` (lineares `.some()` bei **jedem** `page-title-updated`) über dieselbe Map lösen.

**Aufwand** korrigiert: **2,5 Tage** (statt 1). **Vorbedingung für R2**, falls R2 Historiendaten in die Sitzung schreibt — siehe R2 Punkt 3.

### H5 — Antwortvalidierung in Release-Builds abschalten

`ipc/router.ts:76` prüft `process.env['NODE_ENV'] !== 'production'`. **Nichts im Repository setzt `NODE_ENV`** — nicht `electron.vite.config.ts`, nicht `electron-builder.yml`, nicht `package.json`; Electron setzt es auch nicht. Die Prüfung steht als Laufzeitbedingung im gebauten Bundle. **Die Antwortvalidierung läuft also in ausgelieferten Builds mit** — genau die Kosten, die der Kommentar bei `:73-75` zu vermeiden meint.

**Fix.** Bedingung auf `app.isPackaged === false` umstellen. Das ist ehrlicher als `define:` im Build, weil es nicht durch eine Umgebungsvariable ausgehebelt werden kann. **Aufwand** 15 min.

### H6 — `input-event` je WebContents gaten

`passwords/install-autofill.ts:66` registriert `contents.on('input-event')` für **jeden** WebContents, unabhängig davon, ob der Nutzer Passwörter nutzt. Jede Mausbewegung in jedem Tab erzeugt einen Main-Prozess-Callback.

**Fix.** Erst registrieren, wenn der Tresor mindestens einen Eintrag hat.

> **Revision 2 (N4) — es sind zwei Listener, nicht einer.** Neben `install-autofill.ts:66` registriert auch `Tab.ts:338` einen `input-event`-Listener für die Kachelleiste; die Prüfung auf `tileBarMode === 'hover'` findet erst **innerhalb** des Handlers statt. Bei 50 Tabs und bewegter Maus sind das zwei Main-Prozess-Callbacks pro Sample. Beide gaten.

**Aufwand** korrigiert: **2 h** (statt 1).

---

## 7. Welle 5 — UX-Lücken

### U1 — Aktive Kachel sichtbar machen

`SplitState.activeTile` wird gesendet (`SplitController.ts:310-321`) und im Renderer **nirgends verwendet** — verifiziert, null Treffer in `src/renderer/`. Kein Rahmen, kein Fokusring, keine Gutter-Färbung. In einem 2×2 wirken Toolbar, Strg+L, Zurück/Vor, Neu laden, Lesezeichen und der Layout-Knopf auf *eine* der vier Kacheln, und der einzige Hinweis ist eine kleine Ziffer neben dem aktiven Tab im Streifen.

**Das ist die zentrale Bedienfrage des Kernfeatures, und sie ist unbeantwortet.**

**Fix.** 2-px-Rahmen im Gutter über die vorhandene `.dividers`-Ebene. Im selben Zug den Kachel-Platzhalter (`App.tsx:226-228`) von „keine Tabs" auf „diese Kachel ist leer" umstellen, pro Kachel gezeichnet, und das `aria-hidden="true"` am Container entfernen. **Aufwand** halber Tag. **Höchste UX-Wirkung pro Zeile.**

### U2 — Overlay-Dismiss differenzieren

`window-events.ts:95-109` ruft bei `resize` **und** `blur` `host.overlay.dismiss()`. `PermissionArbiter.overlayVacated` settelt daraufhin mit `'block'`, `MasterPasswordPrompt.overlayVacated` mit `'cancelled'`.

**Nutzerpfad:** Prompt erscheint → Systembenachrichtigung, Spotlight, ein Blick in ein anderes Fenster, oder das Fenster wird größer gezogen → Antwort „Blockieren", ohne dass jemand geantwortet hat. Beim Master-Passwort: 20 getippte Zeichen sind weg, ohne Meldung.

Für ein Menü ist „Fokusverlust = weg" richtig; für diese beiden Oberflächen ist es die falsche Regel, und sie teilen sich denselben Mechanismus.

**Fix.** `OverlayLayer.dismissKind` (`:172-176`) existiert bereits — kind-selektiv verwerfen: Menüs ja, Prompts nein. **Aufwand** 2 h.

### U3 — Tab-Streifen tragfähig machen

`styles.css:45-58`: `overflow-x: auto` mit `scrollbar-width: none` und ausgeblendetem `::-webkit-scrollbar`; `.tab` hat `min-width: 60px`. Bei ~20 Tabs ist der Streifen voll, danach scrollt er mit **unsichtbarem Scrollbalken ohne Pfeilknöpfe**, und `scrollIntoView` kommt im gesamten Quellbaum nicht vor — es gibt **kein Auto-Scroll zum aktiven Tab**. Bei 25 Tabs ist ein neuer Tab unsichtbar, der „+"-Knopf ebenfalls weggescrollt.

**Fix.** `scrollIntoView({ inline: 'nearest' })` auf den aktiven Tab, sichtbarer Überlauf-Hinweis, Tab-Suche (Strg+Umschalt+A). **Aufwand** 1 Tag inkl. Tab-Suche.

### U4 — Undo reparieren und ausbauen

`#closedTabUrls` speichert nur die **URL** (`BrowserWindowController.ts:411-415`); `reopenClosedTab` (`:445-449`) ruft `createTab({ url })` — ohne Historie, ohne Scrollposition, ans Streifenende, **und mit erneutem Zusammenklappen des Splits**. Wer versehentlich eine Kachel schließt und Strg+Umschalt+T drückt, verliert das Layout ein zweites Mal.

Darüber hinaus gibt es in der gesamten Anwendung **kein Undo** — kein Lesezeichen, kein Verlaufseintrag, kein Download, kein Passwort, keine Filterregel. Eine Quick-Link-Kachel löscht sich auf **Backspace** ohne Rückfrage (`QuickLinkTile.tsx:62-66`); eine ganze Domain fliegt mit einem Klick auf ein unbeschriftetes `⌦` aus dem Verlauf (`HistoryPage.tsx:118-124`).

**Fix.** `#closedTabUrls` um Streifenposition, Kachelindex und Navigations-History erweitern (nutzt dieselbe Persistenz wie R2). Ein einheitliches Undo-Muster („Rückgängig"-Hinweis nach destruktiven Aktionen) für die vier Listenseiten. **Aufwand** 1,5 Tage.

### U5 — Strg+Tab respektiert eingeklappte Gruppen

`App.tsx:77-85` zyklt über `state.tabs`, und das ist `displayOrder()` **inklusive** der Mitglieder eingeklappter Gruppen. `activateTabAtStripPosition` filtert korrekt über `tabsHiddenByCollapse` (`BrowserWindowController.ts:496-500`), Strg+Tab nicht. Ergebnis: eine Seite auf dem Schirm, zu der im Streifen nichts steht — genau der Zustand, den `setCollapsed` laut eigenem Kommentar verhindern soll.

**Fix.** Denselben Filter anwenden. **Aufwand** 30 min.

### U6 — Locale-Auflösung reparieren

`appearance.uiLanguage` steht auf `'system'`. Zwei korrekte Auflöser existieren — `activeLocale()` (`ipc/handlers.ts:765-768`) und `uiLocale()` (`index.ts:908-911`). **Sieben Aufrufstellen umgehen sie** und geben den Rohwert an `resolveLocale()`, das `'system'` nicht kennt und auf `DEFAULT_LOCALE = 'en'` zurückfällt:

`handlers.ts:239` (Medien-Ablehnungen) · `handlers.ts:329` (**Blocker-Menü**) · `index.ts:403` (**Passwort-Speicherleiste**) · `index.ts:445` (Tresor-Zurücksetzen) · `index.ts:563` (**Element-Picker**) · `index.ts:644` (**Seiten-Kontextmenü**) · `index.ts:727` (**Update-Dialoge**)

Ein deutscher Nutzer bekommt deutsche Menüs und interne Seiten, aber ein englisches Rechtsklick-Menü.

**Zusätzlich:** `useInternalI18n.ts:79-81` abonniert `settings:changed`, um die Sprache live umzustellen — aber `INTERNAL_PAGE_EVENT_CHANNELS` (`channels.ts:452-474`) vergibt diesen Kanal **nur an `settings`**. Offene Tabs mit Verlauf, Lesezeichen, Downloads und Tresor bleiben in der alten Sprache.

**Fix.** Sieben Ein-Zeilen-Änderungen plus Grant-Erweiterung plus Fitness-Funktion, die `resolveLocale` mit einem Rohwert aus den Einstellungen verbietet. **Aufwand** 3 h. Der Katalog ist mit 434/434 Schlüsseln vollständig — hier hängt gute Arbeit an einer Handvoll falscher Aufrufe.

### U7 — Onboarding und Datenmobilität

- **Kein Willkommensbildschirm**, keine Suchmaschinenwahl, kein „Als Standardbrowser festlegen". Das Alleinstellungsmerkmal Split View ist beim ersten Start unsichtbar (`splitView.defaultLayout: '1x1'`) und wird nirgends erwähnt.
- **Import ist gebaut, aber nicht auffindbar**: `shared/bookmarks/import.ts` und `shared/passwords/chrome-import.ts` sind sauber implementiert, haben aber **keinen Menüeintrag und keine Einstellungssektion** — nur je einen Knopf im Kopf zweier interner Seiten, den Passwort-Knopf nur bei entsperrtem Tresor.
- **Kein Lesezeichen-Export.** Daten kommen rein und nie wieder raus; das einzige Backup ist eine verschlüsselte Datei, die auf einer anderen Maschine unlesbar ist.
- **Fenstergröße und -position werden nie gespeichert** (`window-options.ts:43-46`, fest 1440×900).
- **Sitzungswiederherstellung ist aus** (`definitions.ts:225`) und wird von zwei Einstellungen gleichzeitig gesteuert, was `session-restore/settings.ts:25-32` selbst als Defekt führt.

**Fix.** Erststart-Assistent (Sprache, Suchmaschine, Import, Split-View-Kurzvorstellung), Import/Export in Menü und Einstellungen, Fenstergeometrie persistieren, die doppelte Restore-Einstellung auflösen. **Aufwand** 3 Tage.

### U8 — Tresor-Status und Downloads sichtbar machen

- **Der Tresor sperrt nach 15 Minuten** (`shared/passwords/vault.ts:44`, nicht konfigurierbar) und **nichts in der Oberfläche zeigt das an** — kein Schloss in der Toolbar, kein Menüeintrag „Tresor entsperren". Der Nutzer erlebt „Autofill funktioniert manchmal".
- **Downloads erzeugen keinerlei Feedback**: `downloads:changed` geht ausschließlich an interne Seiten (`download-handlers.ts:170`). Kein Download-Regal, kein Toolbar-Indikator, kein Fortschritt in Dock/Taskleiste (`setProgressBar` kommt nicht vor).

**Fix.** Tresor-Indikator mit Entsperr-Aktion, Timeout konfigurierbar; Download-Indikator in der Toolbar plus `setProgressBar`. **Aufwand** 1,5 Tage.

### U9 — Benutzerregeln erreichbar machen

`userrules:list`, `userrules:setEnabled` und `userrules:remove` sind als Kanäle deklariert (`channels.ts:140-142`), aber im Renderer kommt `userrules` **nicht vor**, und die Settings-Seite hat keine Erlaubnis dafür. Das Blocker-Menü bietet „Meine Regeln (n)" an und ruft `onOpenSettings()` (`blocker-menu-items.ts:60-63`) — die Seite, die diese Regeln nicht anzeigen kann.

**Nutzerpfad:** Element blocken → Seite geht kaputt → „Meine Regeln (3)" klicken → Einstellungen öffnen sich → nichts. Die einzige Rücknahme ist der globale Aus-Schalter des Blockers.

**Fix.** Regel-Liste in den Einstellungen, Grant ergänzen. **Aufwand** 1 Tag.

### U10 — Kleinere UX-Korrekturen

| Befund | Ort |
|---|---|
| Stummschalt-Knopf tut bei kachellosen Tabs nichts — genau bei dem Tab, den man sucht | `TabBar.tsx:296-301` |
| Kein Lesezeichen-Stern, keine Lesezeichenleiste (das Setting existiert, die Leiste nicht) | `Toolbar.tsx`, `appearance.showBookmarksBar` |
| Schloss-Symbol ist ein `<span>`, kein Knopf — in jedem anderen Browser öffnet es das Seiten-Panel | `Omnibox.tsx:116-122` |
| Kachelleiste nicht auffindbar: 16-px-Hover-Band ohne Griff, Menülabel „Focus Tile Navigation Bar" | `shared/split/tile-bar.ts:49`, `appMenu.ts:231` |
| Lesemodus nur im Ansicht-Menü, kein Indikator in der Adressleiste | `appMenu.ts:236` |
| Trenner ohne `aria-label` (QA 5.6 verlangt „als Trenner angekündigt") | `SplitDividers.tsx:99-104` |
| Shortcuts faktisch nicht umbelegbar — als JSON schreibgeschützt gerendert, Text behauptet „edited elsewhere", dieses Elsewhere existiert nicht. `KNOWN_CONFLICTS` (`bindings.ts:245-271`) wird von keiner Oberfläche gelesen. | `SettingsView.tsx:315-322` |
| Auf Linux beendet Strg+Umschalt+W den **gesamten Browser** (`role: 'quit'`); es gibt auf Windows/Linux keinen Eintrag „Fenster schließen" | `appMenu.ts:97-99` |
| Vier von fünf Listenseiten rendern bei fehlgeschlagenem ersten IPC-Aufruf ihren Leerzustand (`try/finally` ohne `catch`); ein gesperrter Tresor zeigt „Noch keine Passwörter gespeichert" | `HistoryPage.tsx:64-70`, `BookmarksPage.tsx:98-104`, `DownloadsPage.tsx:88-94`, `PasswordsPage.tsx:179-185` |
| Keine Liste ist virtualisiert — 10.000 Verlaufseinträge sind 10.000 `<li>` | alle vier Listenseiten |
| Startfehler beenden den Prozess wortlos (`app.exit(1)`, kein `showErrorBox`); `JsonStore` fängt **jeden** Schreibfehler ab und loggt nur — Lesezeichen anlegen, sichtbar, nach Neustart weg | `index.ts:972-975`, `JsonStore.ts:228-241` |
| Ein hartkodierter englischer Satz: „Choose an unpacked extension folder" | `handlers.ts:625` |

**Aufwand** zusammen ~3 Tage.

---

## 8. Welle 6 — UI und Design-System

### D1 — `start.css` an `tokens.css` andocken

`internal/start.css:10-35` definiert **18 eigene Hex-Werte** (9 dunkel, 9 hell) parallel zu `tokens.css`, ohne dessen Import. Ändert sich `--accent`, bleibt die Startseite beim alten Blau. Der Kommentarkopf von `tokens.css:5-8` beschreibt dieses Risiko wörtlich.

Zugleich ist `start.css` die **einzige** Datei, die `prefers-color-scheme` überhaupt beachtet. **Fix:** Palette entfernen, `tokens.css` importieren, den `prefers-color-scheme`-Block dorthin verschieben, wo alle Oberflächen ihn lesen. **Aufwand** 2 h. **Beseitigt die konkreteste Drift-Quelle im Projekt.**

### D2 — `appearance.theme` verdrahten

`tokens.css:48` erzwingt hart `color-scheme: dark`; keine Zeile im Renderer liest `appearance.theme`. Nutzer wählt „Hell" → alles bleibt dunkel. Das ist exakt der „Schalter, der umspringt und nichts bewirkt", den `README.md:88-93` als architektonisch ausgeschlossen beschreibt.

**Fix.** Nach D1 ist das eine Klasse am `<html>`, gesetzt aus dem Setting. **Aufwand** halber Tag.

### D3 — Border-Kontrast anheben

`--border: #35353d` gegen `--bg: #17171a` ergibt rechnerisch **~1,47:1**, gegen `--bg-elevated` **~1,34:1**. WCAG 1.4.11 fordert 3:1 für UI-Komponentengrenzen. Betroffen ist praktisch jede unfokussierte Eingabefeld- und Panelumrandung.

**Fix.** Ein Tokenwert, Richtung `#45454e` oder heller. **Aufwand** 15 min, Wirkung auf das ganze Produkt. *(Rechnerisch aus den Hexwerten ermittelt, nicht am Bildschirm gegengeprüft.)*

### D4 — Token-System vervollständigen

`tokens.css` hat 20 Custom Properties und **keine Spacing-, Radius-, Schatten- oder Motion-Skala**. Radien tauchen als Literale in mindestens sechs Werten (6/7/8/10/12 px) auf, Schatten als `rgb(0 0 0 / X%)` an zehn Stellen in vier Dateien. Ein designseitiger Wechsel ist eine Suche-und-Ersetzen-Aktion statt eines Token-Edits. Dazu fehlt ein `--on-accent`-Token (`#0d0d10` steht dreimal hartkodiert).

**Fix.** Skalen ergänzen, Literale ersetzen, Fitness-Funktion gegen neue Hex-Literale außerhalb von `tokens.css`. **Aufwand** 1 Tag.

### D5 — Gemeinsame Primitive extrahieren

`.dialog__button` ist **dreifach** eigenständig implementiert (`styles.css:665-674`, `start.css:386-395`, `bookmarks.css:239-248`) mit abweichenden Radien, Hintergründen und Cursorn. Das Hover-Reveal-Aktionsmuster ist **viermal** parallel gebaut (`bookmarks.css:172-198`, `downloads.css:120-150`, `history.css:149-172`, `start.css:272-297`) mit bereits divergierenden Maßen. Jede Korrektur muss drei- bis viermal nachgezogen werden.

**Fix.** Gemeinsame Basis in `styles.css`/`panel-page.css`. **Aufwand** 1 Tag.

### D6 — Fokus-Trap vereinheitlichen

`QuickLinkDialog.tsx:52-81` implementiert eine vollständige Tab-Trap. `MediaPanel.tsx:121-129` deklariert ebenfalls `role="dialog" aria-modal="true"` (`:160`), behandelt aber nur Escape — ein Tastaturnutzer kann aus dem angeblich modalen Dialog in die Toolbar tabben. **Fix.** Gemeinsamer `useFocusTrap`-Hook für alle als modal deklarierten Oberflächen, plus Fitness-Funktion. **Aufwand** halber Tag.

### D7 — Schmale Layouts

`passwords.css:144` setzt sieben Spalten mit textbeschrifteten Buttons; rechnerische Mindestbreite grob 650–750 px, ohne `overflow-x`-Behandlung. In einer 1×3- oder 1×4-Kachel läuft die Zeile über den Viewport. **Fix.** Icon-Buttons statt Textbuttons, Umbruch unterhalb einer Schwelle. Systematisch für alle vier Listenseiten prüfen. **Aufwand** 1 Tag.

### D8 — Restliche UI-Hygiene

`prefers-contrast`/`forced-colors` fehlen vollständig · interne Seitentitel sind hartkodiert englisch (`<title>Bookmarks</title>` etc.) im Widerspruch zum eigenen Prinzip · `color: #17171a` in `styles.css:465` dupliziert `--bg` statt es zu referenzieren · kein `<link rel="icon">` in internen Seiten. **Aufwand** halber Tag.

---

## 9. Welle 7 — Qualitätsapparat und Schulden

### Q1 — Downloads testen

`DownloadManager.ts` (642 Zeilen) hat **0 % Zeilen- und 0 % Funktionsabdeckung** (verifiziert in `coverage/coverage-summary.json`); keine Testdatei importiert die Klasse, und sie steht **nicht in der Stryker-Allowlist**. `target-path.ts` (entscheidet den Zielpfad, also die Path-Traversal-Fläche) ebenfalls 0 %. Beide schreiben Dateien auf die Platte.

Weitere Nullabdeckung, verifiziert: `TileAudioController.ts` · `window-seams.ts` · `ipc/password-handlers.ts` · `ipc/update-handlers.ts` · `menu/blockerMenu.ts` · `menu/pageContextMenu.ts`.

**Fix.** Testabdeckung für `DownloadManager` und `target-path` mit Priorität; die übrigen sechs bewerten und entweder testen oder begründet auf die Ausschlussliste setzen. **Aufwand** 2 Tage.

### Q2 — Coverage-Ausschlüsse ehrlich machen

Von ~61.000 Quellzeilen sind rund **15.600 (≈25 %) außerhalb jeder Coverage-Messung** — der gesamte Renderer plus Preload (`vitest.config.ts:89`) und 19 Electron-nahe Main-Dateien (`:94-150`), darunter `index.ts`, `Tab.ts`, `WindowRegistry.ts`, `hardening.ts`, `handlers.ts`. **Genau die Dateien, in denen alle Verdrahtungsfehler aus Welle 2 stecken.** Die Ersatzmetrik meldet 3900 ungetestete Renderer-Zeilen gegen ein Budget von 2800.

**Fix.** Nach M0.1 entscheiden: entweder der Smoke-Test wird zur belastbaren Sicherung ausgebaut (dann gehört er in CI und muss die Verdrahtung prüfen, nicht nur den Start), oder die Ausschlussliste schrumpft. Der Status quo — Ausschluss mit Verweis auf eine nie gelaufene Sicherung — ist die schlechteste der drei Optionen. **Aufwand** 1 Tag Entscheidung plus Umsetzung nach Wahl.

### Q3 — Speicherlecks schließen

| Befund | Ort |
|---|---|
| `MediaSessions.#services` ist eine `Map<Session, …>` mit starken Schlüsseln; `release()` hat **keinen Aufrufer**. Jedes je geöffnete private Fenster hinterlässt dauerhaft eine Session-Referenz plus Registry plus Findings — auch datenschutzrelevant, Findings sind Browserverlauf auf anderem Weg. | `MediaSessions.ts:101`, `:141`; `WindowRegistry.ts:200-213` |
| `MediaSessions.forgetTab()` hat ebenfalls keinen Aufrufer — bis zu 40 Findings je geschlossenem Tab bleiben liegen | `MediaSessions.ts:136`, `BrowserWindowController.ts:399-443` |
| **Der Disposer von `installRequestPipeline` wird verworfen** — jedes private Fenster hinterlässt dauerhaft einen `onBeforeRequest`-Listener, dessen Closure die `WindowRegistry` festhält | `WindowRegistry.ts:263` |
| `SessionUserRuleEditor.#added` pusht nur `result.added` und verwirft die von `trimToLimit` gekappte Liste — umgeht damit die 500-Regel-Grenze, wächst unbegrenzt | `UserRuleStore.ts:265` |
| `FaviconStore.#failed` wächst mit der Zahl besuchter Domains ohne abrufbares Icon, geleert nur durch `clear()` | `FaviconStore.ts:154`, `:253` |
| `OverlayLayer.ts:272/279/288` registriert drei Listener ohne Gegenstück — sterben mit dem WebContents, brechen aber als einzige Stelle die sonst durchgehaltene Disziplin | `OverlayLayer.ts` |

> **Revision 2 — der Disposer-Leak hat eine größere zweite Hälfte.** `#createPrivateSession` (`WindowRegistry.ts:233-236`) erzeugt **pro privatem Fenster eine eigene Session** (`private-1`, `private-2`, …), auf die `#prepareSession` (`:238-279`) Hardening, Download-Subscription und Pipeline installiert. Diese Sessions werden **nie freigegeben** — `session.fromPartition` hält sie für die Prozesslebensdauer. Jedes je geöffnete private Fenster hinterlässt damit nicht nur einen Listener, sondern eine komplette Session mit eigenem In-Memory-Cache, eigenen Cookies und eigenem `MediaService`. `clearStorageData()`/`clearCache()` bei `onClosed` (`:200-213`) leert sie, gibt sie aber nicht frei. **Das ist die teurere Hälfte von Q3.**

**Zwingend gemeinsam mit V2 umzusetzen** — die Media-Lecks sind heute latent, weil die Erkennung nicht verdrahtet ist. Sie werden real in dem Moment, in dem V2 die Hooks anschließt. **Und V2 reicht dafür nicht:** `forgetTab` muss an `closeTab` (`BrowserWindowController.ts:399-443`) und `release` an `onClosed` (`WindowRegistry.ts:196-214`) — beides Dateien, die V2 sonst nicht anfasst.

**Aufwand** korrigiert: **1,5 Tage** (statt 1).

### Q4 — Die 16 toten Einstellungen abarbeiten

`tests/architecture.test.ts:777-798` führt 15 Einstellungen als Schulden; `appearance.showBookmarksBar` besteht den Test nur, weil eine Menü-Checkbox den Wert liest — es sind **mindestens 16**.

| Einstellung | Entscheidung | Begründung |
|---|---|---|
| `advanced.unloadInactiveTabs`, `advanced.unloadAfterMinutes` | **bauen** | R2 — das Kernziel |
| `network.killSwitch` (Default **`true`**) | **bauen oder entfernen, mit Vorrang** | Ein Privacy-Browser mit einem Kill-Switch, der ein Boolean in einer Datei ist. Der eigene Test benennt es als das Ernsteste. |
| `network.proxyMode`, `network.proxyUrl` | **bauen** | `session.setProxy` kommt im Quellbaum nicht vor. Ohne Proxy kein Firmeneinsatz. |
| `privacy.partitionStatePerSite` | **bauen oder entfernen** | „one partition per browsing mode, never per site" |
| `privacy.malwareProtection` | **entfernen** | „no reputation check exists" — ein Schutz, den es nicht gibt, ist die gefährlichste Attrappe von allen |
| `appearance.theme` | **bauen** | D2 |
| `appearance.showBookmarksBar` | **bauen** | mit U10 (Lesezeichenleiste) |
| `appearance.tabBarPosition` | **entfernen** | „the strip is always drawn in one place" |
| `splitView.showTileHeaders` | prüfen | |
| `search.suggestFromBookmarks`, `search.suggestFromOpenTabs`, `search.remoteSuggestions`, **`search.suggestFromHistory`** | **bauen** | Omnibox-Vorschläge (U3, Tab-Suche im selben Zug). `suggestFromHistory` steht in der Schuldenliste und fehlte in Revision 1 dieser Tabelle. |
| `advanced.spellcheckLanguages` | **bauen** | `setSpellCheckerLanguages` kommt nicht vor; mit W7 |
| `advanced.customShortcuts` | **bauen** | U10 — schreibgeschütztes JSON mit falschem Beschreibungstext |

Zur Ehrenrettung: **die Beschreibungstexte sagen die Wahrheit** (`settings-text.de.ts:22-23` „Noch ohne Wirkung"). Das ist der offenste Umgang damit, den man sehen kann — aber es ersetzt die Entscheidung nicht. Bis eine Einstellung gebaut ist, gehört sie in der UI sichtbar deaktiviert, nicht nur textlich relativiert.

**Aufwand** 3–5 Tage, verteilt über die anderen Wellen.

### Q5 — Sicherheitsbefunde

**Das Fundament ist gut und soll das bleiben:** AES-256-GCM mit authentifiziertem Header, frischer Nonce pro Seal, scrypt N=2¹⁷ (~128 MB, ~0,5 s je Versuch), zwei verschachtelte Schichten (Keystore **und** Master-Passwort), zwei getrennte Schlüssel für Profildaten und Tresor. `sandbox`/`contextIsolation`/`nodeIntegration: false` in allen drei View-Typen, durch Fitness-Funktionen gehalten. Das Zwei-Tore-Modell mit identitätsbasierter Chrome-Erkennung ist überdurchschnittlich sauber.

**Offene Punkte:**

| Schwere | Befund | Maßnahme |
|---|---|---|
| hoch | Berechtigung „ask" = stilles „deny" | V1 |
| hoch | `network.killSwitch` verspricht Schutz und implementiert nichts | Q4 |
| hoch | Kein Weg an einem Zertifikatsfehler vorbei → Nutzer wechselt den Browser, was das schlechtere Sicherheitsergebnis ist | W1 |
| mittel | Fingerprint-Maskierung erreicht **iframes und Worker nicht** — ein Drittanbieter-iframe liest ungemaskte Canvas/WebGL/Audio-Werte. Ehrlich dokumentiert, bleibt eine reale Umgehung. | bewerten: `nodeIntegrationInSubFrames`-freier Weg über einen `document-start`-Injektor für alle Frames |
| mittel | `--disable-component-update` deaktiviert auch **CRLSet-/Revocation-Updates**, nicht nur Telemetrie. Widerrufene Zertifikate werden schlechter erkannt; die Konsequenz wird nirgends abgewogen. | Entscheidung dokumentieren oder Revocation separat versorgen |
| mittel | Nur `passwords.html` hat `frame-ancestors 'none'`; die anderen sieben internen Seiten verlassen sich allein auf `navigation-policy.ts` | CSP für alle acht, plus Fitness-Funktion |
| mittel | Antwortvalidierung läuft in Release-Builds (`NODE_ENV` wird nie gesetzt) | H5 |
| niedrig | scrypt-Parameter im Schlüsselfile sind nicht authentifiziert — Ergebnis ist DoS, nie eine Schwächung; sauber analysiert in `vault-key.ts:50-56` | dokumentieren, keine Aktion |
| — | `--disable-features-in-background` existiert in Chromium nicht; Kommentar über `disable-speech-api` beschreibt „Speculative prefetch/prerender" — Kommentar und Code passen nicht zusammen | R1 bzw. Korrektur |

### Q6 — Modulgrößen

Fünf Dateien reißen das eigene Budget von 780 Zeilen (`scripts/metrics.mjs:228`):

| Zeilen | Datei | Bewertung |
|---|---|---|
| 1063 | `BrowserWindowController.ts` | zu viel: Lebenszyklus + Layout + Overlay + Fullscreen + Tastenleiter. Vier Controller sind bereits ausgelagert; weitere folgen. |
| 1053 | `shared/ipc/contract.ts` | grenzwertig — als Single Source of Truth erwartbar; die Inline-zod-Schemata gehören in Geschwister-`schema.ts` (Muster existiert: `settings/schema.ts`) |
| 975 | `main/index.ts` | zu viel: `main()` allein ~738 Zeilen. Eine Composition Root, die niemand mehr überblickt — und genau dort passieren die Verdrahtungsfehler. |
| 953 | `shared/tabgroups/model.ts` | zu viel |
| 787 | `internal/PasswordsPage.tsx` | zu viel |

**Fix.** `main()` in benannte Phasen zerlegen (`openStores`, `wireSessions`, `wireWindows`, `wireMenus`) — das macht V4 überhaupt erst prüfbar. **Aufwand** 2 Tage.

**Ergänzung Revision 2:** Das eigene Budget in `scripts/metrics.mjs:248` erlaubt **maximal eine** Datei über der 780-Zeilen-Grenze („files over the per-file line bar: max 1"). Real sind es fünf — das Budget wird um den Faktor 5 gerissen, nicht bloß „verletzt".

### N9 — `applySessionHardening` wird nie erneut angewandt

`applySessionIdentity` (`hardening.ts:199-211`) ruft `session.setUserAgent` einmalig. Die `fingerprint.*`-Settings sind als `applies: 'new-tab'` deklariert — aber ein neuer Tab **in derselben Session** bekommt trotzdem den alten User-Agent. Die Deklaration lügt, und damit auch die Settings-UI. **Aufwand** 2 h. Gehört in den Q4-Umkreis.

### Q7 — Dokumentation nachziehen

`README.md` ist deutlich veraltet: behauptet, „Verlauf, Lesezeichen, Passwörter, Downloads und Sitzung fehlen" (alle fünf existieren), nennt 617 Tests (es sind ~4150), 5 Feature-Dateien (es sind 12), 29 Fitness-Funktionen (es sind ~70) und dass Extensions „durch Abschnitt 8 der Spezifikation ausgeschlossen" seien (`ExtensionStore.ts:71` ruft `session.extensions.loadExtension`). `docs/STATUS.md` ist dagegen ungewöhnlich ehrlich und stellenweise die bessere Quelle.

**Fix.** README auf den Code-Stand bringen; die Feature-Matrix aus der Bewertung als Grundlage nutzen. **Aufwand** halber Tag.

---

## 10. Extensions — Einordnung, keine Maßnahme

**Verifiziert: echte Chrome-Extensions, kein Platzhalter.** `ExtensionStore.ts:71,94` ruft `session.extensions.loadExtension(path, { allowFileAccess: false })`; Persistenz ist selbst gebaut, weil Electron sie nicht liefert; der Pfad kommt aus dem OS-Ordnerdialog im Main-Prozess, nie aus der IPC-Anfrage.

**Aber nur die halbe Plattform:** kein `.crx`/Web Store, kein Toolbar-Button, kein Popup, keine Options-Seite (Electron 43 kennt `action`/`browserAction`/`pageAction` nicht), kein `declarativeNetRequest` (**uBlock Origin Lite und aktuelles MV3-AdGuard laufen nicht**), kein `chrome.downloads`, keine Extensions in privaten Fenstern.

Praktisch: MV2-Erweiterungen mit `chrome.webRequest` können blockieren, sind aber nicht konfigurierbar, weil Dashboard und Symbol fehlen. **Das ist ein 5-%-Feature, kein Ökosystem-Anschluss** — und der Grund, warum der native Blocker existiert. Diese Einordnung gehört in die Dokumentation (Q7), nicht in den Backlog.

---

## 11. Reihenfolge und Abhängigkeiten

**Revision 2 hat sechs Abhängigkeiten korrigiert:**

```
M0.1 Smoke-Test ──┐
M0.2 Baseline ────┼──► Abnahme aller RAM-/Zeitzahlen
M0.4 Throttling ──┘──► Vorbedingung für R1 (nicht nur Abnahme)

Welle 1   N2 → W4 → R2 → R1      (NICHT R1 → R2: R2 zerstört WebContents,
          R3, R4, N1, N5           R1 ruft auf jedem relayout() darauf)
          H4 vor R2, falls R2 pageState persistiert
Welle 2   V1, V3, V5 parallel · V2 ⟂ Q3 · V4 nach Q6
Welle 3   W1 nach V5 · W3 nach V1 · W2/W5 erst nach Sicherheitsfreigabe
Welle 4   H3 vor R1 (beide fassen relayout/setFractions an)
          H2 + H3 gemeinsam (beide bauen #scheduleBroadcast um)
Welle 5   U1 zuerst · U6 unabhängig · U7 nach V5
Welle 6   D1 → D2 → D4 → D5 (strikte Kette) · D3 sofort
Welle 7   Q3 ⟂ V2 · Rest laufend
```

**Die sechs Korrekturen im Einzelnen:**
1. **R1 → R2 war die falsche Richtung.** R2 zerstört WebContents, R1 ruft auf jedem `relayout()` eine Methode darauf. Richtig: N2 (Guards) → R2 → R1.
2. **W4 ist keine unabhängige Welle-3-Maßnahme, sondern Voraussetzung von R2** — der einzige Weg, „unbestätigte Eingaben" zu erkennen.
3. **H4 vor R2**, wenn R2 Historiendaten in die Sitzung schreibt. Alternativ hält R2 `pageState` nur im Speicher — eine bewusste Entscheidung, keine Selbstverständlichkeit.
4. **H3 vor R1** — beide fassen den `relayout`/`setFractions`-Pfad an und ziehen in entgegengesetzte Richtungen.
5. **H2 und H3 gemeinsam** — zwei Umbauten derselben Funktion `#scheduleBroadcast`.
6. **V2 ⟂ Q3 reicht nicht:** V2 braucht zusätzlich `forgetTab` an `closeTab` und `release` an `onClosed`, beides in Dateien, die V2 sonst nicht anfasst.

**Realistische Planung — Revision 2.** Die ursprüngliche Zwei-Wochen-Tabelle war Fantasie: schon die eigenen Schätzungen summierten sich auf 14–16 Personentage für 10 Tage. Mit den Aufwandskorrekturen sind es **24–30 Personentage** für den hier geplanten Umfang.

| Tag | Maßnahme | Warum jetzt |
|---|---|---|
| 1 | M0.1–M0.5 (Benutzer) · **N1** (`seal()`-Bug) · N2 (Guards) · N5 (früheres `show()`) · H5 · D3 · U5 | sechs Korrekturen unter je 30 min, davon ein echter Datenverlust-Bug |
| 2 | R3a **mit** `mainFrame`-Zurückstellung · R3d · N6 (GPU messen) | 600–1500 ms, ohne den Blocker im Restore-Fall zu öffnen |
| 3–5 | V5 (vier fehlende Seiten) | HTTP-Seiten funktionieren wieder; größte Wirkung pro Zeile |
| 6 | V1 (inkl. Check-Handler) · V3 | drei fertige Systeme werden sichtbar |
| 7 | U1 (aktive Kachel) · U2 (Overlay-Dismiss) · H3+H2 gemeinsam | die zentrale Bedienfrage des Kernfeatures |
| 8–9 | H1 · H4 | „blitzschnell" im Betrieb, und Vorbedingung für R2 |
| 10–15 | W4 → R2 (mit N3) | der größte Einzelhebel, realistisch bemessen |
| 16–17 | Q6 → V4 | verhindert die Rückkehr der teuersten Fehlerklasse |
| danach | **R1 nur, wenn M0.4 einen Effekt belegt** · Welle 3 nach expliziten Sicherheitsentscheidungen zu W2/W3/W5 · Wellen 5–7 nach Bedarf |

**R1 rutscht bewusst nach hinten.** Es ist die Maßnahme mit dem höchsten Verhältnis von behauptetem Nutzen zu belegtem Mechanismus — und die einzige, deren Nutzen vollständig von einer Messung abhängt, die noch aussteht.

---

## 12. Was dieser Plan bewusst nicht vorschlägt

| Verworfen | Grund |
|---|---|
| `--process-per-site` | Ein Renderer-Crash reißt alle Tabs derselben Site mit; Chromium warnt selbst davor |
| Site Isolation abschalten | Gäbe die Sandbox auf; `docs/ARCHITECTURE.md:355` benennt es korrekt als Nicht-Option |
| Chromium-Fork statt Electron | Nicht wartbar für ein Projekt dieser Größe — das ist die Gründungsentscheidung und sie war richtig |
| Widevine/DRM nachrüsten | Braucht einen castlabs-ECS-Build und kollidiert mit `--disable-component-update`; eine Architekturentscheidung, keine Aufgabe |
| Vollständige MV3-Extension-Plattform | Electron liefert `declarativeNetRequest` und die Action-APIs nicht; das wäre ein eigenes Projekt |
| Sync/Cloud | Widerspricht der Produktthese („kein Account, keine Cloud") |
| Weitere Tests für Favicon-/Thumbnail-Stores | `thumbnail-store.test.ts` (1070 Z.), `favicon-store.test.ts` (965 Z.) und `tabgroups-model.test.ts` (995 Z.) sind zusammen länger als Passwort-Vault plus Krypto. Der Aufwand gehört nach Q1, nicht hierher. |

---

## 13. Grenzen dieses Plans

- **Alle Leistungszahlen sind Schätzungen** aus statischer Analyse (Codestruktur, gemessene Bundle-Bytes, bekannte Chromium-Kennzahlen). Gemessen wurden ausschließlich Dateigrößen in `out/` und `dist/` sowie die Coverage-Werte. Welle 0 existiert, um das zu ändern.
- **Die App wurde nicht gestartet.** Was Chromium unter Electron 43 tatsächlich rendert (Standard-Fehlerseiten, Zertifikats-Interstitials, die Menüleiste unter Windows/Linux bei `titleBarStyle: 'hidden'`) ist unverifiziert. Falls die Menüleiste dort nicht gezeichnet wird, wären **sämtliche Menüs unsichtbar** und die Auffindbarkeit bräche auf sieben Toolbar-Tooltips zusammen — das ist der einzige offene Punkt, den nur ein Blick in die laufende App klären kann.
- **Nicht zu Ende recherchiert:** Datei-Upload und Drag&Drop von Dateien in Seiten, Zustellung von Web-Notifications, Service-Worker/PWA-Installation, Barrierefreiheits-APIs. `webUtils` und `desktopCapturer` haben null Treffer — ein Indiz, kein Vollbefund.
- **Kontrastwerte** sind rechnerisch aus den Token-Hexwerten nach WCAG-Formel ermittelt, nicht am Bildschirm gegengeprüft (in Revision 2 unabhängig nachgerechnet und bestätigt: 1,471 bzw. 1,337).
- **Die Electron-Semantik von `webContents.close()`** ist in Revision 2 geklärt — siehe W4. Diese Einschränkung entfällt.

### Was in Revision 2 nicht am Code prüfbar blieb

Diese Aussagen stammen aus Electron-/Chromium-Kenntnis und sind nur in der laufenden App oder gegen die Chromium-Quelle verifizierbar. Sie tragen jeweils eine Maßnahme:

| Aussage | Trägt | Wie zu klären |
|---|---|---|
| Entfernen von `--disable-renderer-backgrounding` gibt die Renderer-Prozesspriorität und damit Blinks `MemoryPurgeManager` wieder frei | **R1** — der gesamte behauptete RAM-Gewinn | M0.4 plus RSS-Messung vor/nach |
| `--disable-features-in-background` existiert in Chromium nicht | R1 (Teilmaßnahme) | Chromium-Quelle; das Streichen kostet ohnehin nichts |
| Ein zweiter `appendSwitch('disable-features')` überschreibt den ersten | **R5** — Regressionsgefahr | Die Auflage (nur über `DISABLED_FEATURES`) deckt beide Fälle ab |
| `IsSuitableHost`/`ProcessLock` entwerten `--renderer-process-limit` bei intakter Site Isolation | **R5** — der behauptete Gewinn | `app.getAppMetrics()` vor/nach |
| V8s `max_semi_space_size`-Default liegt bereits bei ~8 MB | R5 (Teilmaßnahme) | Messung |
| Chromium fragt in manchen Pfaden den `PermissionCheckHandler` vor dem Request-Handler | **V1** — ob der Prompt überhaupt erscheint | M0.1 |
| Chromiums HTTP-Disk-Cache greift für eigene Schemata nicht | R4a — Wirkung vermutlich 0 | Netzwerkzeiten der Startseite |
| Electron 43 liefert PDFium mit `plugins: true` überhaupt aus | **W5** — die ganze Maßnahme | M0.1 |
| Ob die Anwendungsmenüleiste unter Windows/Linux bei `titleBarStyle: 'hidden'` gezeichnet wird | Auffindbarkeit **aller** Menüs — falls nein, bricht sie auf sieben Toolbar-Tooltips zusammen | Nur ein Blick in die laufende App auf diesen Plattformen |
</content>
</invoke>
