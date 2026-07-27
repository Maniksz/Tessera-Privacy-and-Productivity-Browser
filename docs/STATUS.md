# Stand der Arbeit

Vollständige Durchsicht aller angemerkten Punkte: was gebaut ist, wie es belegt wurde, und was
offen ist. Gepflegt bei jedem Durchgang; die Reihenfolge folgt der Reihenfolge, in der die Punkte
gemeldet wurden.

**Legende** — ✅ gebaut und belegt · 🟡 teilweise · ⬜ offen · ❓ braucht eine Entscheidung

---

## Die 15 Punkte vom Anfang

| # | Punkt | Stand | Belegt durch |
|---|---|---|---|
| 1 | Drag & Drop in den Split mit Anzeige, wohin geteilt wird | ✅ | Smoke-Test mit echten Mausereignissen: 5 Zonen bei Einzelansicht, Markierung folgt dem Zeiger, linke Hälfte `left: 0, width: 716/1440`, Ablegen erzeugt den Split |
| 2a | Suchleiste bei „home" leer | ✅ | Smoke: `address bar is empty at home -> ""` |
| 2b | Startseite „geht nicht wirklich" | ⬜ | Noch nicht angefasst — siehe Gruppe 4 |
| 3 | Verlauf existiert nicht | ⬜ | Nur der Protokollname `tessera://history` ist reserviert |
| 4 | Layout-Tasten alle oben rechts | ✅ | Ein Knopf mit Dropdown; Smoke prüft 1 Knopf, 5 Einträge, genau 1 aktiv |
| 5 | Kein Settings-Knopf | 🟡 | Knopf da und funktionsfähig, aber noch ein Overlay statt eines Tabs |
| 6 | Kein Extension-Knopf | 🟡 | Dito |
| 7 | Tabs werden in der Multi-View nicht zur Tab-Gruppe | ⬜ | — |
| 8 | In der Multi-View nur „main page" zurück; Wischen; Leiste am oberen Rand | 🟡 | **Ursache behoben**: ein Klick in eine Kachel setzte die aktive Kachel nicht, `split:setActiveTile` hatte keinen Aufrufer. Smoke: `clicking into a tile makes its tab the active one -> true`. Hover-Leiste und Wischen fehlen |
| 9 | Icons oben links zu klein | ✅ | 32×32 Knopf mit 20 px SVG |
| 10 | Kein Home-Knopf | ✅ | Smoke: 4 Navigationsknöpfe |
| 11 | Kachel-Icons der Startseite: Favicon oder Screenshot lokal | 🟡 | Entschieden: **Screenshot mit Favicon als Rückfall**, nie im privaten Modus, über „Daten löschen" entfernbar. Der Favicon-Cache ist in Arbeit; die Screenshots folgen |
| 12 | Der Browser braucht einen Namen | ❓ | **Vorarbeit fertig**: `src/shared/product.ts` ist die eine Quelle für Name, Schema und appId; drei Fitness-Funktionen halten das fest, samt namentlicher Schuldenliste, die nur schrumpfen kann. Die Umbenennung ist damit eine Zeile plus zwei Paketdateien. Der Name selbst braucht deine Entscheidung |
| 13 | Kachel-Icons der Startseite größer | ⬜ | Teil von Gruppe 4 |
| 14 | Nicht alle Tabs schließbar; „new tab" bleibt übrig | ✅ | Smoke: 1 Tab übrig nach dem Schließen aller |
| 15 | Was ich noch finde | 🟡 | Laufend gemeldet; dieses Dokument ist die Liste |

## Die vier Punkte danach

| Punkt | Stand | Anmerkung |
|---|---|---|
| Settings als eigener Tab mit eigener View | ⬜ | Entwurf steht: **pro-Seite-Rechtemodell** statt der globalen Interna-Liste, plus **Sperre für von Webinhalten ausgelöste Navigation** zu `tessera://`. Der bestehende Test schreibt fest, dass keine interne Seite `settings:set` erreichen darf — deshalb ist das globale Modell nicht erweiterbar, sondern muss ersetzt werden |
| Drag & Drop wie der Windows-Anker, mit exakter Anzeige | ✅ | Jede Kachel ist an ihren Rändern weiter teilbar; erreichbar sind 2, 3 und 4 Kacheln |
| Extensions: AdGuard, uBlock Origin, Video-Download | ⛔ | **Als Erweiterungen nicht möglich.** Siehe unten |
| Layout-Knopf klappt nicht auf | ✅ | Ursache war die Fensterschichtung, nicht das Menü — siehe `docs/solutions/ui-issues/chrome-popups-behind-content-views.md` |

### Warum die Erweiterungen nicht tragen

Electron 43 unterstützt laut eigener Dokumentation nicht:

| gebraucht für | API |
|---|---|
| uBlock Origin Lite, aktuelles AdGuard (MV3) | `declarativeNetRequest` |
| Video-Download, Stream-Capture | `chrome.downloads` |
| jedes Symbol, Popup, jede Optionsseite | `action` / `browserAction` / `pageAction` |

`chrome.webRequest` ist vorhanden, also könnte uBlock Origin in der MV2-Fassung *blockieren* — aber
ohne Dashboard und ohne Symbol nicht konfigurierbar. Entschieden: **nativ bauen.**

## Später gemeldet

| Punkt | Stand |
|---|---|
| Layout wählen soll leere Kacheln füllen | ✅ Füllen **mit Aufräumen**: unberührte Füller werden beim Verkleinern geschlossen, alles Angefasste bleibt (Spec 2). Ein Schalter, `splitView.adaptLayoutToTabs` |
| Tab schließen soll die Kachel entfernen | ✅ Erst wird ein geladener, ausgeblendeter Tab hineingezogen; nur wenn nichts übrig ist, verschwindet die Kachel |
| Rein ziehen auf 3 oder 4 Kacheln geht nicht | ✅ Randzonen gab es nur für die Einzelansicht; jetzt für jede teilbare Kachel |
| Neuer Tab in der Multi-View ersetzt den ersten | ✅ Eine leere Kachel gewinnt immer gegen eine belegte |
| DOM-Elemente selbst blocken wie uBO | ⬜ Teil des nativen Inhaltsblockers |

## Später gemeldete Fehler und Wünsche

| Punkt | Stand |
|---|---|
| Fenster lässt sich nicht am Kopf ziehen | ✅ Die Ziehfläche hatte **null Breite**: `.tabbar` erklärte sich als ziehbar, aber die Tab-Leiste darin hatte `no-drag` und `flex: 1`. Jetzt tragen die Tabs es, nicht ihr Behälter |
| Layout-Icons nur weiß, konturiert gewünscht | ✅ `.iconbutton--wide svg` überschrieb das gemeinsame `fill: none; stroke: currentColor`. Zeichenfläche musste auf `-1 -1 18 18` wachsen, weil ein Strich mittig auf seiner Kante liegt |
| Layouts mit drei und vier Kacheln **nebeneinander** | ✅ `1x3`/`1x4`. Ich hatte „1x1x1" zunächst als Stapel gelesen und musste den Auftrag mitten im Lauf korrigieren. Der Kern ist nicht das Zeichnen: alle bisherigen Aufteilungen haben höchstens **eine** Trennlinie pro Achse, drei Spalten haben zwei, und die müssen in Ordnung bleiben — unabhängig geklemmt rutscht die zweite über die erste und erzeugt eine Kachel mit negativer Breite |
| App-Symbol ist noch das von Electron | ✅ **Platzhalter**, programmatisch erzeugt von `scripts/make-icon.mjs` ohne neue Abhängigkeit. Motiv ist die Split-View, Geometrie wörtlich aus `LayoutIcon.tsx`, Farben aus `tokens.css`. Deterministisch, mit electron-builders eigenem Resolver als `isFallback: false` bestätigt. Das echte Zeichen gehört zum Namen |
| Verlauf geht immer noch nicht | 🟡 **Zeichnet jetzt auf**, und die sechs Kanäle haben Handler. Der Recorder sitzt im Tab, nicht im Fenster — der Tab kennt Adresse und Titel selbst, und ein privates Fenster hält ein Objekt ohne jeden Pfad zur Datei. Es fehlt die **Seite** `tessera://history` |

## Gebaut und verdrahtet

Der teuerste Zustand im Projekt war: fertige, getestete Systeme, die nichts tun, weil die
Verbindungsstellen fehlen. Dieser Zustand ist aufgelöst — alles unten läuft im echten Programm.

| System | Belegt womit |
|---|---|
| Verschlüsselte Ablage | Auf der Platte als `OBENC`-Umschlag nachgewiesen, unterschiedliche Nonces, kein Klartext. Die Startflags liegen bewusst unverschlüsselt in einer eigenen Datei: `bootstrapFlags()` liest **vor `app.whenReady()`**, wo `safeStorage` unter Linux noch nicht antwortet |
| Werbeblocker | Im Smoke-Test: **4 von 4 Listen geladen**, 174 050 Zeilen geparst, 113 604 Netzregeln, 49 783 Ausblendregeln, 4 228 abgelehnt (2,4 %, überwiegend `$popup`) |
| Kosmetische Filter | Einspritzung in die Seite über den Preload. Zwei Kanäle, weil es zwei Momente gibt: die hostspezifischen Regeln **synchron** bei `document-start` (sonst blitzt die Werbung auf), die generischen nachträglich und merkmalsindiziert — die Seite meldet ihre Klassennamen, der Kern antwortet nur mit dem, was passen kann |
| Element-Picker | Kern, Preload und Oberfläche im Shadow-DOM. Drei Aufrufwege: Kontextmenü, `Strg+Shift+E`, Blocker-Menü |
| Verlauf | Ende zu Ende belegt: Besuch aufgezeichnet, gefunden, gelöscht; `tessera://history` rendert |
| Favicons | Im laufenden Programm: `naturalWidth = 1` über die Schemagrenze `file://` → `tessera://` |
| Thumbnails | Im laufenden Programm: 480×300, dekodiert, richtige Proportionen |
| Tab-Gruppen | Chip, Farbband, Einklappen, Inline-Umbenennen, Kontextmenü |
| Fingerprint-Maskierung | In der Sitzung verdrahtet. iframes und Worker bleiben unmaskiert — der Preis dafür, Chromium nicht zu forken |
| Medien-Erkennung | Beobachtung in der Anfrage-Pipeline, HLS- und DASH-Manifeste, Download mit benannten Verweigerungsgründen |
| Berechtigungs-Dialog | Auf der Overlay-Schicht, mit Warteschlange. Escape blockiert; ein privates Fenster merkt sich nichts |

Der Schlussstein ist das **pro-Seite-Rechtemodell**. Jede interne Seite bekommt nur ihre eigenen
Kanäle — die Startseite Quicklinks, die Settings-Seite Settings, der Verlauf den Verlauf. Vorher
teilten alle dieselben sieben, und eine gemeinsame Liste hätte `settings:set` enthalten müssen, damit
eine Settings-Seite möglich ist: dann hätte die **Startseite** jede Einstellung umschreiben können,
also genau die Seite, auf die eine Website am plausibelsten verlinkt.

Der Verlauf bekommt `history:open` statt `nav:navigate`, weil der Kern das Ziel aus dem Absender
auflöst — die Seite steuert sich selbst und nichts anderes. Abonnements sind ebenfalls eine
Berechtigung: die Startseite darf `settings:changed` nicht hören.

## Noch zu bauen, aus der Ursprungs-Spezifikation

**Diese Tabelle war überholt und ist nachgezogen.** Sie führte fünf Bereiche als offen, von denen vier
fertig sind — nachgeprüft, Datei für Datei, nicht aus dem Gedächtnis. Das ist selbst der Befund: ein
Statusdokument, das Erledigtes als offen führt, ist so irreführend wie eines, das Offenes verschweigt.

| Bereich | Stand | Beleg bzw. was fehlt |
|---|---|---|
| Settings und Erweiterungen als eigene Tabs | ✅ | `SettingsPanel.tsx` und `SettingsPage.tsx` rendern beide `renderer/shared/SettingsView.tsx`, wie zugesagt eine Komponente |
| Pro-Kachel-Navigationsleiste | ✅ | `overlay/TileBarSurface.tsx`; der Tastaturweg ist da (`focusTileBar` hat einen Menüeintrag mit Beschleuniger), also kein Maus-Only-Feature |
| Sitzungswiederherstellung | ✅ | `session-restore/apply.ts`. Der Blocker für Tab-Gruppen ist gelöst und nicht umgangen: `adoptTabId` hebt den Zähler über jede wiederhergestellte ID, `retainTabs` wird **einmal** mit der Vereinigung aller Fenster gerufen |
| Lesezeichen, Downloads, Passwörter | ✅ | Alle drei Seiten existieren. Beim Tresor fehlt die *Verdrahtung*, nicht die Seite — siehe „Der Tresor, als Nächstes" |
| Lesemodus, Suchen-in-Seite | ✅ | `reader/reader-mode.ts`, `overlay/FindBarSurface.tsx` |

## Was unterwegs gefunden wurde

Fehler, die niemand gemeldet hat und die kein Nutzer hätte zurückverfolgen können. Aufgeschrieben,
weil die Ursache jedes Mal aussagekräftiger ist als der Fehler.

| Fund | Warum er unsichtbar war |
|---|---|
| **Vier Stores wurden beim Beenden nie geflusht** | `history`, `favicons`, `thumbnails`, `tabGroups` hatten alle ein `flush()` und standen nicht in `before-quit`. Ein Besuch von vor 30 Sekunden war einfach nicht in der Datei. Vier Auslassungen, jede in einer anderen Datei als der Store. Stores registrieren sich jetzt beim Öffnen; ein Fitnesstest prüft die Vollständigkeit und fand sofort einen fünften |
| **`refresh()` war nicht serialisiert** | Der Hintergrund-Refresh vom Start und ein Listenwechsel liefen gleichzeitig auf demselben Manifest; einer löschte Dateien, die der andere gerade geschrieben hatte. Sichtbar als Blocker mit weniger Listen als heruntergeladen |
| **HTTPS-only nahm nackte IPs nicht aus** | Der Kommentar behauptete „Loopback und nackte IPs", der Code prüfte nur `localhost`. Ein lokaler Server auf `http://127.0.0.1:3000` landete auf der Zwischenseite, ein Unterelement wurde still auf `https` umgebogen und schlug fehl |
| **`Strg+L` tat nichts** | Ein Beschleuniger existiert nur, wo ein Menüeintrag ihn deklariert. Das Kürzel stand in der Tabelle, erschien in den Einstellungen und feuerte nie. Ein Fitnesstest hält jetzt jede Aktion an einen Eintrag — und fand diesen beim ersten Lauf |
| **Der Berechtigungsdialog zeigte „0 warten"** | Der Dialog wird beim ersten Antrag gezeigt, als noch nichts wartete; ein zweiter zog die Anzeige nicht nach. Für den Nutzer sah der zweite Dialog aus wie ein erster, der sich nicht schließt |
| **Die Verlaufsseite kündigte die ganze URL an** | `registrableDomain` erwartet einen Host und gibt Unbekanntes unverändert zurück. Die „ganze Seite löschen"-Schaltfläche klang damit für einen Screenreader wie die daneben |
| **Der Favicon-Dateiname war die Domain** | Der Index ist verschlüsselt, Dateinamen nicht — ein Verzeichnislisting war eine Leseliste, ohne jeden Schlüssel. Jetzt ein Hash |

## Entschieden, noch nicht gebaut

Diese Entscheidungen sind gefallen und hier festgehalten, damit sie nicht mit einer Sitzung verloren gehen.

### Passwort-Tresor

Reihenfolge: **erst lokaler Tresor mit Master-Passwort plus Chrome-Import**, die Netzwerk-Synchronisation als
eigener Durchgang — aber die Sync-Naht wird jetzt definiert, damit sie später andockt statt umgebaut zu werden.

Der Grund für das Master-Passwort steht ausführlich in `src/shared/passwords/reveal.ts` und ist die Grundlage
der Entscheidung: **`safeStorage` kann keine Wiederauthentifizierung leisten.** Es umschließt einen Schlüssel
mit dem Schlüsselspeicher der Plattform, und jeder davon entschlüsselt für den angemeldeten Benutzer, ohne zu
fragen. Ein Dialog, der das Systempasswort erfragt und gegen nichts prüft, wäre Theater — und Theater an der
sensibelsten Stelle eines Browsers ist schlechter als eine ehrlich benannte Grenze.

Der Entwurf, wie dort beschrieben: eigener Tresor-Schlüssel getrennt vom Lokaldaten-Schlüssel, in
`passwords.key` zweifach umschlossen — vom Schlüsselspeicher wie bisher und von einem aus dem Master-Passwort
abgeleiteten Schlüssel. `scrypt`, N = 2¹⁷, bis Argon2id als Abhängigkeit da ist. Der Schlüssel lebt nur im
Hauptprozess-Speicher, solange entsperrt ist, und fällt beim Sperren, nach Untätigkeit und wenn das letzte
Fenster schließt.

Später: Adapter für KDBX (eine Datei auf einer Netzfreigabe, kein Server, kein Dritter) und Vaultwarden im
eigenen Netz. Ausdrücklich offen und beim Bauen zu klären: **eine Cloud-Instanz derselben Software widerspricht
der Prämisse dieses Produkts.** Ein Adapter, der beides kann, muss das mindestens sichtbar machen.

### Laufzeitabhängigkeiten: 2 → 4

Zwei namentlich benannte Plätze für Kryptografie, für nichts anderes. Kryptografie ist die eine Stelle in
diesem Projekt, wo „schreib es selbst" die falsche Antwort ist: ein selbstgeschriebenes Argon2 kann funktional
richtig sein und den Schlüssel trotzdem über einen Zeit- oder Cache-Seitenkanal verlieren, und das findet keine
Durchsicht hier. Ein selbstgeschriebener Readability-Ersatz kann sich höchstens im Absatz irren.

### Preload-Budget bleibt bei 22 kB

Bewusst *nicht* mitgewachsen, während der Hauptprozess auf 320 kB gehoben wurde. Der Hauptprozess wird einmal
pro Start geparst, der Preload einmal pro Seite in jedem Tab — ein Kilobyte dort kostet das Hundertfache. Das
Autofill hat ihn auf 27 kB gebracht; die Antwort ist, die *Oberflächen*-Hälften von Element-Picker und Autofill
bei Bedarf nachzuladen, nicht das eine Budget zu weiten, das am meisten zählt.

## Gemeldet, noch offen

Vier Punkte aus der Benutzung, wörtlich festgehalten, weil drei davon Verhaltensänderungen sind und einer ein
Fehlerbericht. **Drei sind erledigt, einer zur Hälfte** — die Zeilen bleiben stehen, weil die Begründung im
Code auf sie verweist.

| Punkt | Was zu tun ist |
|---|---|
| ~~**Kachelleiste nur im Kachelmodus**~~ **erledigt** | `tileBarStep` gibt bei `rects.length <= 1` jetzt `hide` zurück. Die Entscheidung liegt dort und nicht in der Oberfläche, weil ein Renderer, der eine vom Kern gebaute und eingemessene Darstellung nicht zeichnet, die Schicht mit einer unsichtbaren Fläche zurücklässt, die Zeigerereignisse schluckt |
| ~~**Leiste früher ausfahren**~~ **erledigt** | `TILE_BAR_REVEAL_WITHIN` von 6 auf **16 px**. Die Invariante ist im Kommentar festgehalten: strikt unter `TILE_BAR_HEIGHT`, das strikt unter `TILE_BAR_POINTER_AWAY` liegt — treffen sich die beiden Schwellen, beantworten Ausfahren und Einfahren dieselbe Position auf aufeinanderfolgenden Messungen verschieden, und genau das Flackern soll das Paar verhindern. Ein Test heftet die Reihenfolge fest |
| **Neuer Tab soll ein neuer Tab sein** | Widerspricht dem aktuellen Verhalten: `TileOccupancyController` füllt leere Kacheln absichtlich, weil drei Kacheln mit „zieh einen Tab hierher" eine Anweisung statt eines Browsers waren. Der Wunsch ist aber klar — ein neuer Tab gehört ins **volle** Layout, nicht in eine Kachel. Betrifft auch Gruppen-Tabs. Das ist eine bewusste Umkehr einer früheren Entscheidung und braucht: neuer Tab → Layout `1x1`, und die Kachelfüllung nur noch beim ausdrücklichen Layoutwechsel. **Erste Hälfte gebaut** (`claimTileForNewTab` legt die Kacheln weg) |
| **…aber die Anordnung darf dabei nicht verloren gehen** | Nachtrag des Benutzers: „er soll die layout gruppe der anderen tabs nicht auflösen, daher brauchen wir ja die tab gruppen." Die weggelegten Kacheln blieben geladen und im Streifen, aber *welches Layout* und *welche Kachel je Tab* war weg — es gab keinen Weg zurück. Die Anordnung gehört damit auf die **Tab-Gruppe**: beim Wegräumen aufnehmen (bestehende Gruppe wiederverwenden, sonst eine anlegen), beim Zurückkehren auf einen Gruppen-Tab wiederherstellen. Ohne die zweite Hälfte ist es eine Erinnerung, die niemand lesen kann. **Gebaut und in der echten App belegt** — `TabGroup.layout` trägt Layout-Id und einen Eintrag je Kachel, `keepArrangement` nimmt beim Wegräumen auf, `takeArrangementFor` gibt beim Anklicken zurück und *verbraucht* die Aufnahme dabei (eine zweite Aktivierung würde sonst spätere Arbeit des Benutzers stillschweigend zurücknehmen). Der Smoke-Test fährt die Schleife, die ein Benutzer fährt: zurück zur verdrängten Seite → Anordnung ist da; ein Tab **ohne** Aufnahme → weiterhin ganzes Fenster; zweite Verdrängung → Anordnung kommt wieder |
| ~~**Ziehen auf die mittlere Kachel geht nicht**~~ **erledigt** | Der Verdacht traf zu und war zweiteilig. Geometrie: eine Lücke gehört *einer* Spalte, eine mittlere Spalte kann also nicht von beiden Seiten gleichzeitig beschnitten werden — beide Bänder der Mittelspalte waren Duplikate und nahmen zusammen 60 % der Fläche, sodass nur 40 % einen einfachen Ablegevorgang annahmen. Verhalten: `applyDrop` macht den Layoutwechsel jetzt mit `rehome: false`, weil das Nachrücken die neu entstandene Kachel mit dem erstbesten geladenen Tab füllte und die verdrängte Seite damit vom Schirm nahm. Geprüft über `LAYOUT_IDS` erschöpfend, plus benannte Tests für die Mittelkachel von `1x3` und beide von `1x4`. Und weil die Meldung aus der Benutzung kam, auch dort: `runEveryDragCheck` in `scripts/smoke.mjs` zieht in der echten App mit synthetischer Maus **jede** Zone **jedes** Layouts an, gezielt auf die Mitte ihrer eigenen Trefferfläche — und prüft zwei Dinge, von denen das zweite das interessante ist: dass die Seite dort landet, wo der Indikator es versprach, *und* dass keine bereits sichtbare Seite dabei verschwindet. Achtzehn der vierundzwanzig Teilungszonen fielen bei der zweiten Prüfung durch, beide Zonen der Mittelspalte darunter |

## Stand zum Wiederaufnehmen

Geschrieben am Ende eines Durchgangs, in dem sieben Agenten am Sitzungs- oder API-Limit abgebrochen sind. Die
Arbeit liegt jeweils auf der Platte; was fehlt, steht hier.

### Der Baum

`pnpm typecheck` **0** über vier Projekte, `pnpm lint` sauber, `pnpm test` **119 Dateien / 3358 grün**.
Erledigt seit dem letzten Eintrag:

- `tests/features/steps/content-blocker.steps.ts` geschrieben — die sechs Szenarien liefen gegen eine echte
  `FilterSubscription` über ein echtes Verzeichnis, nur das Netz ist gefälscht. Drei Dinge daran sind Absicht
  und im Kopf der Datei begründet: `maxAgeMs: 0` (sonst gilt die Kopie im Cache als frisch und der Fetcher wird
  nie gerufen — die Szenarien über fehlgeschlagene Downloads wären leer), Zuordnung gegen `defaultSettings()`
  statt gegen die Szenario-Einstellungen (sonst wäre „Blocker aus → Anfrage erlaubt" auch bei geladenen Regeln
  wahr), und die Einstellungen als Closure statt als Kopie.
- **Drei kopierte Tests waren flackernd, nicht falsch.** „uses the coalescing window it was given" stand in
  `favicon-store`, `history-store`, `tabgroup-store` und `thumbnail-store` — jeweils mit gefälschten Zeitgebern
  und einer Schleife, die 100 Mal auf die Datei wartet. Das ist ein Zeitbudget in Verkleidung: allein grün, im
  vollen Lauf rot, jedes Mal eine andere Datei. Jetzt deterministisch — beobachtet wird, dass **kein Zeitgeber
  eingeplant** wurde (`vi.spyOn(globalThis, 'setTimeout')`), und die Datei wird nach `store.flush()` gelesen,
  das sich in dieselbe Warteschlange einreiht. Gegengeprobe gemacht: mit `debounceMs ?? 250` → `250` fällt der
  Test, die Zusicherung läuft also nicht leer.

### F11 — und der Grund, warum es nicht ging

Zwei Fehler übereinander, beide behoben:

1. **`accel()` gibt nur die erste Belegung zurück.** `bindings.ts` sagt in seinem eigenen Kopf, die übrigen
   seien „equivalent alternatives" — sie waren nichts. Ein `MenuItem` trägt genau einen Accelerator, jeder
   Aufrufer las Element null, und damit waren `Control+PageDown`, `Control+PageUp`, `Alt+D`, `F6`, `F3`,
   `Control+F5`, `Control+Shift+I` und die Zoom-Tasten des Ziffernblocks in der Einstellungsliste sichtbar und
   tot. Behoben in `src/main/menu/alternative-accelerators.ts`: jede Alternative wird als **verborgener
   Geschwistereintrag** desselben Menüeintrags registriert, mit demselben Handler (Identität, keine Kopie).
   Auf macOS steht nun `windowFullscreen: ['Control+Command+F', 'F11']` — die Plattformkonvention zuerst, weil
   das Menü sie zeigt, F11 daneben, weil Leute mit ihr in den Händen von Windows kommen.
2. **Die Aktion war im Kachelmodus tot.** `applyPolicy()` setzt `setFullScreenable(false)`, sobald ein
   Mehrkachel-Layout mit Kachel-Vollbild aktiv ist — und `setFullScreen` auf so einem Fenster ist kein Fehler,
   sondern Stille. Die Taste tat also genau in dem Modus nichts, für den dieser Browser existiert. Neu:
   `TileFullscreenController.toggleFullscreen()` entscheidet, was die Taste bedeutet — im Einzelfenster das
   Fenstervollbild, im geteilten Layout das **Vollbild der aktiven Kachel**, weil „der Vollbild-Bereich ist die
   Kachel" überall sonst schon das heißt.

Zwei Fitness-Funktionen dazu: dass der Mechanismus überhaupt auf die Vorlage angewandt wird, und dass **kein
Ankreuz-Eintrag** eine Aktion mit zweiter Taste bekommt — ein verborgener Klon hat sein eigenes `checked`, eine
geklonte „Lesezeichenleiste anzeigen"-Taste würde also immer denselben Wert schreiben statt umzuschalten.

### Kürzel in den Tooltips — und die zwei Stellen, die absichtlich keine bekommen

Sieben Schaltflächen zeigen jetzt ihre Taste (zurück, vor, neu laden, Startseite, Kachel maximieren,
Einstellungen, neuer Tab), in der Schreibweise der Plattform: auf macOS Symbole in Apples fester Reihenfolge
`⌃⌥⇧⌘`, sonst Wörter mit `+`. Überschreibungen werden geehrt, ohne neuen Kanal — der Renderer bekommt
`advanced.customShortcuts` schon über `settings:getAll`. Trenner ist ein **Zeilenumbruch**: zwei Leerzeichen
können im Tooltip still zusammenfallen (`Reload Ctrl+R` als ein Satz), ein Gedankenstrich bräuchte pro Sprache
eine Konvention, und `TabBar.tsx` schreibt bereits eine zweite Zeile in ein `title`.

Zwei Stellen bleiben ohne, und beide Begründungen sind Fehlervermeidung, nicht Auslassung:

- **Die Kachelleiste.** `accel('back')` navigiert den **aktiven** Tab, und Hovern ändert die aktive Kachel
  nicht. Ein „Alt+Links" an der Zurück-Schaltfläche einer *anderen* Kachel würde also eine Taste anschreiben,
  die eine **andere Seite** navigiert — schlimmer als eine tote Taste.
- **Die Schaltfläche, die das Layoutmenü öffnet.** Sie wendet kein Layout an, sie öffnet ein Menü. Die Taste
  der Anordnung, in der das Fenster schon ist, wäre die Antwort auf eine Frage, die niemand gestellt hat.

Und eine Stelle, die nachgezogen wurde: die **Layoutmenü-Einträge**. Vier der sieben Anordnungen haben eine
Taste, und dieses Menü ist der **einzige** Ort, an dem sie sichtbar sein können — im Anwendungsmenü werden sie
über eine Schleife registriert, also buchstabiert sie kein Menü aus. Jetzt in einer eigenen Spalte, wo ein Auge
in einem Menü danach sucht, nicht im Tooltip.

Dafür liest die Overlay-Schicht Plattform und Überschreibungen **selbst**. Sie ist ein zweiter Renderer und
teilt den Zustand der Chrome-Oberfläche nicht; die Alternative war, die Darstellung fertigen Anzeigetext tragen
zu lassen. Entschieden gegen: eine Darstellung sagt, *was auf dem Schirm ist* — wie eine Taste für eine
Plattform buchstabiert wird, ist Sache des Renderers. Rechte ändern sich dafür nicht, der Overlay-View läuft
schon mit der `chrome`-Rolle.

**Preis: gemessen null.** Erwartet worden war, dass die Kürzel-Tabellen ein zweites Bündel belasten. Sie tun
es nicht: Vite legt sie in den geteilten Chunk `LayoutIcon-*.js`, den Toolbar und Overlay schon beide laden,
also zählen sie einmal. Renderer-JavaScript steht vor und nach der Änderung bei **335 kB**; das
Overlay-Bündel wuchs um 549 Byte. Falls es später doch zurückgezahlt werden muss, ist der Weg ein Kanal mit
schon aufgelösten Zeichenketten — nicht, diese Entscheidung zu verschieben.

### Die Kachelleiste zeigte „vor" erst nach neuem Fokus

Gemeldet, und der Grund war die Bauart: die Darstellung ist eine **Momentaufnahme**. `canGoBack`,
`canGoForward`, `loading` und die Adresse werden einmal gelesen, wenn die Leiste erscheint — also navigierte
ein Druck auf „zurück" die Seite und ließ die Leiste im Zustand von vorher stehen.

Neu ist `tileBarRefresh` in `shared/split/tile-bar.ts`, gerufen aus derselben zusammengefassten Runde, in der
auch der Tab-Streifen sein Update bekommt. Zwei Dinge daran sind nicht offensichtlich:

- **Es vergleicht, bevor es neu darstellt.** Eine per Tastatur geöffnete Leiste hält den Fokus und hat ein
  Adressfeld, in das jemand halb getippt haben kann. Bei jeder Tab-Änderung gerufen — was die Korrektheit
  ausmacht — würde ein bedingungsloses Neudarstellen dieses Feld zurücksetzen. Gleiche Darstellung → `nothing`.
- **Es behält die Auslösung, die die Leiste geöffnet hat.** Genau die entscheidet, ob die Schicht den Fokus
  nimmt. Als Zeiger-Leiste neu dargestellt, würde eine per Kürzel geöffnete Leiste bei der ersten Navigation
  den Fokus verlieren — der Tastaturweg (Spezifikation 7) würde sich selbst brechen.

Der Vergleich ist Feld für Feld statt strukturell, damit ein später hinzugefügtes Feld nicht stillschweigend
jede Auffrischung zu einer Neudarstellung macht. **Lücke:** `TileInputController` hat weiterhin keine eigene
Testdatei; die reine Entscheidung ist in `tests/tile-bar.test.ts` mit acht Fällen abgedeckt, die Naht nicht.

### Zoom als Geste, pro Kachel

Gewünscht für Laptops, „so wie z. B. back guesture per tile". Gebaut, mit einem Fund unterwegs:

**Die Kachel ist hier gratis richtig.** `zoom-changed` kommt am `webContents` an, der die Geste bekommen hat —
Chromium leitet Pinch und `Ctrl`-Rad an die Ansicht unter dem Zeiger, nicht an die fokussierte. Die
Navigationsgesten brauchen für dieselbe Frage eine ganze Funktion (`decideNavigationGesture`), weil ihre
Ereignisse ohne Position am Fenster ankommen.

**Aber Zoom ist absichtlich pro Domain, nicht pro Kachel** (Spezifikation 1: „dieselbe Seite zweimal geöffnet
muss in beiden Tabs gleich aussehen", `zoomRegistry`). Die Geste geht deshalb durch `setZoomPercent` und ändert
daran nichts. Folge, die man wissen sollte statt sie zu entdecken: **zwei Kacheln mit derselben Seite zoomen
gemeinsam.** Zoom je Kachel wäre eine andere Spezifikation, nicht eine kleinere Änderung — Entscheidung beim
Benutzer.

**Und ein Raster statt `± 10`.** Das Menü rechnete `percent ± 10`, was für einen Tastendruck geht und für ein
Trackpad nicht: ein Pinch schickt einen Strom von Ereignissen, zehn pro Stufe kriecht oder überschießt, und es
landet auf 83 % und 117 % — Werte, die kein Browser anzeigt. `ZOOM_STOPS` ist Chromiums eigenes Raster, und
**beide Wege gehen hindurch**, sonst kommt Hineinzoomen mit der Tastatur und Herauszoomen mit dem Trackpad
nicht dort heraus, wo es angefangen hat. Der unangenehme Fall ist ein Wert, der gar nicht auf dem Raster liegt
— nach Jahren von `± 10` ist eine gespeicherte 120 gewöhnlich —, und die Antwort ist die nächste Stufe *jenseits*
des aktuellen Werts in Fahrtrichtung, nicht die nächstgelegene: sonst ginge der erste Druck rückwärts.

### Ein Test, der behauptete, was die Oberfläche absichtlich nicht zeichnet

Der Smoke-Test prüfte `the one pane there is holds the new tab` über die Kachel-Plakette im Tab-Streifen —
und `TabBar.tsx` zeichnet die nur, solange `tileCount > 1`, mit Grund: eine „Kachel 1"-Plakette am einzigen
Tab eines einzelnen Panels benennt eine Zuordnung, an der es nichts zuzuordnen gibt. Genau in dem Zustand,
um den die Prüfung ging — Fenster auf ein Panel eingeklappt — fehlt die Plakette also für einen Tab, der
sehr wohl eine Kachel hat, und die Prüfung schloss das Gegenteil der Wahrheit. Sie war nie gelaufen: der
Baum war rot, als sie geschrieben wurde.

Jetzt über `split:changed` aus dem Kern (`tileTabIds`) statt über die Plakette. Die Lehre ist die
allgemeinere: eine Zusicherung über die Oberfläche prüft, was gezeichnet wird — nicht, was gilt.

### Offene Fragen, gefunden aber nicht entschieden

| Frage | Stand |
|---|---|
| **Eine Gruppe einzuklappen nimmt nichts auf** | Einklappen gibt die Kacheln der Mitglieder frei, und *diese* Verdrängung wird nicht aufgenommen — Ausklappen verliert die Anordnung also weiterhin. `keepArrangement` aus `setCollapsed` zu rufen ist der naheliegende nächste Schritt; die Grenze steht im Kommentar von `setCollapsed`, damit die zwei Pfade nicht verwechselt werden |
| **`#rehomeHiddenTabs` hängt nicht an `adaptLayoutToTabs`, `fillEmptyTiles` schon** | Bei ausgeschalteter Anpassung öffnet ein Layoutwechsel keine neuen Füllseiten, setzt aber weiterhin geladene versteckte Tabs in die neuen Panels. Verteidigbar — wer ausdrücklich vier Panels wählt, will vermutlich Seiten darin — aber nirgends aufgeschrieben, und der Kommentar zwei Zeilen darüber sagt „off means panes stay as they are". Verhalten nicht geändert, weil danach nicht gefragt wurde |
| **Gemischte Herkunft nimmt nichts auf** | Wenn die Kacheln teils Mitglieder einer Benutzergruppe und teils lose Tabs halten, wird die Anordnung *nicht* aufgenommen. Absicht: `addGroup` nimmt Mitglieder ihrer alten Gruppe weg, eine Aufnahme würde also die selbstgebaute Gruppe des Benutzers verkleinern oder auflösen. Eine vergessene Anordnung kostet einen Ziehvorgang; eine stillschweigend umgebaute Gruppe hat kein Zurück |
| **Drei Module fehlen in der Stryker-Erlaubnisliste** | `TabGroupStore.ts`, `tabgroups/strip.ts`, `tabgroups/schema.ts`. Vorbestehend. `alternative-accelerators.ts` ist eingetragen, und neu prüft eine Fitness-Funktion, dass **jeder Eintrag der Liste überhaupt eine Datei trifft** — der Konfig-Kommentar warnt selbst vor „einem Glob, der nichts trifft", geprüft wurde das nie. Gegenprobe gemacht: ein umbenannter Pfad lässt sie fallen |
| **`coverage/` steht nicht in `.gitignore`** | `pnpm test:coverage` hinterlässt ein unverfolgtes Verzeichnis |

### Noch offen aus demselben Fund: zwölf tote Tasten — nachgezählt

**Korrektur einer früheren Zählung in diesem Dokument.** Die Erlaubnisliste `withoutMenuItem` in
`tests/architecture.test.ts` nennt vierzehn Aktionen als „absichtlich ohne Menüeintrag", und daraus war
geschlossen worden, alle vierzehn seien tot. Nachgeprüft, Aktion für Aktion, stimmt das für die meisten
**nicht**: `nextTab`, `previousTab`, `tileLeft/Right/Up/Down`, `toggleTileMaximized` und `focusTileBar` haben
sehr wohl Menüeinträge, und `splitLayout1`–`4` bekommen ihren über `accel(shortcut)` mit *variablem* Argument in
der `LAYOUT_IDS`-Schleife — weshalb eine Suche nach dem Literal `accel('splitLayout1')` sie übersah. Die
Ausnahmeliste ist also zu weit gefasst, nicht die Verdrahtung zu dünn.

Wirklich nirgends registriert sind:

| Tot | Beleg |
|---|---|
| `Escape` (`escape`) und `Command+.` / `Escape` (`stop`) | Kommen in `src/main/menu/` überhaupt nicht vor |
| `Control+9` / `Command+9` (`lastTab`) | `grep -rn lastTab src/main/` findet nichts |
| `Control+1`…`Control+8` (Tab nach Position) | `TAB_BY_INDEX_ACCELERATORS` wird in `src/` von **niemandem** gelesen — nur von einem Test, der prüft, dass die Tabelle acht Einträge hat. Eine Tabelle, die existiert, auf ihre Länge geprüft wird und an nichts hängt |

**Alle zwölf sind verdrahtet.** Die neun unkritischen als verborgene Menüeinträge
(`menu/tab-position-accelerators.ts`), ohne neuen i18n-Schlüssel — die Beschriftung eines verborgenen
Eintrags wird nie gezeichnet. Die Reihenfolge ist dabei **nicht** `#tabOrder`, sondern was der Streifen
wirklich zeichnet (`displayOrder()` minus `tabsHiddenByCollapse`): `#tabOrder` enthält die Mitglieder einer
*eingeklappten* Gruppe, und `Strg+3` hätte darüber eine Seite in eine Kachel geöffnet, zu der im Streifen
nichts steht, was sie schließen oder wechseln könnte.

`escape` und `stop` laufen über `before-input-event`, und die getroffene Entscheidung ist strenger als nötig
und deshalb richtig: **die Seite behält die Taste immer, `preventDefault` wird auf keinem Pfad gerufen.** Weder
ein Cursor in einem Textfeld der Seite noch ein eigener `Escape`-Handler der Seite ist vom Hauptprozess aus
erkennbar, wenn das Ereignis feuert — jede verbrauchende Regel wäre eine Vermutung, deren falsche Antwort ein
Browser ist, der einen Website-Dialog nicht schließen kann. `isLoading()` macht es konkret: es bleibt für eine
Seite mit einem hängenden Unterelement wahr, „während des Ladens verbrauchen" hätte also einer solchen Seite
`Escape` dauerhaft entzogen. Ein Quelltext-Test fällt, wenn `preventDefault` in `Tab.ts` wieder auftaucht.

**Und eine Behauptung, die ich mehrfach wiederholt habe, ist falsch:** diese Tasten seien „in der
Einstellungsliste sichtbar". Sind sie nicht — `shortcuts:getBindings` hat in `src/renderer/**` **keinen
einzigen Abnehmer**, die Einstellungsseite zeichnet überhaupt keine Kürzelliste. Der Handler berechnet
Konfliktnotizen und übersetzt sie für niemanden. Damit ist auch der Grund, den ich für die Dringlichkeit
angegeben habe, ein anderer: nicht „angezeigt und tot", sondern **nirgends angezeigt und tot**.

### TypeScript 7 — gemessen, nicht geraten

TS 7.0.2 ist stabil und als `ts7@npm:typescript@7.0.2` **schon installiert** (Entwicklungsabhängigkeit, zählt
nicht auf die Laufzeitvorgabe). Ergebnis der Messung:

- **Null Typfehler** über alle vier Projekte. TS 7 ist mit 5.9 über diesen Code einer Meinung, auch bei
  `exactOptionalPropertyTypes`, auf das hier viel aufbaut. Das war die offene Frage und sie ist beantwortet.
- Die einzige Arbeit sind **vier `tsconfig`-Dateien**: `baseUrl` ist in TS 7 entfernt, und `paths` müssen
  relativ sein (`./src/shared/*` statt `src/shared/*`). 14 Meldungen, alle dieser Art, keine im Code.
- **Der Umstieg ist trotzdem noch nicht dran.** `@typescript-eslint/parser@8.65.0` — die neueste — deklariert
  `typescript: ">=4.8.4 <6.1.0"`, schließt TS 7 also aus, und es gibt keinen `next`-Tag mit etwas Neuerem.
  Typbewusstes Linting fällt damit weg, und das sind hier keine Kosmetikregeln: `no-unnecessary-condition` und
  `no-unnecessary-type-assertion` haben in einem Durchgang einen totgeglaubten Wächter, einen Cast mit einem
  ungültigen Wert darunter und vier verschluckte Ablehnungen gefunden. Dazu hängt
  `@stryker-mutator/typescript-checker` an derselben API.
- Empfohlener Weg: 5.9 bleibt die Autorität für `pnpm typecheck`, ESLint und Stryker; TS 7 kommt als schnelle
  Vorprüfung der inneren Schleife dazu. Der echte Umstieg ist ein Einzeiler, sobald typescript-eslint nachzieht.
- **Falle beim Nebeneinander-Installieren:** `pnpm add -D ts7@npm:typescript@7.0.2` liefert ebenfalls ein
  `tsc`-Binary, und pnpm überschreibt damit `node_modules/.bin/tsc` — `pnpm typecheck` läuft dann still mit
  TS 7 statt mit 5.9. Beim Messen wieder entfernt. Wer den Doppelbetrieb einrichtet, muss die Skripte auf
  `node_modules/typescript/bin/tsc` beziehungsweise `node_modules/ts7/bin/tsc` festnageln, sonst entscheidet die
  Installationsreihenfolge, welcher Compiler das Tor bewacht.
- Noch nicht gemessen: ein **fairer** Geschwindigkeitsvergleich. Der erste Versuch verglich 5.9 mit warmem
  `.tsbuildinfo` gegen TS 7 kalt und ist deshalb wertlos — beide kalt messen.

### Der Tresor — erledigt, und die Prämisse dieses Abschnitts war falsch

**Korrektur.** Hier stand „fertig und getestet: `vault-key.ts`, `PasswordVault`, `vault-codec.ts`, der
Chrome-CSV-Import, `PasswordApi`, `AutofillService`". Gebaut waren sie. **Getestet war keines davon** — jedes
lag bei **0 % Coverage**, ohne eine einzige Testdatei. Und die sechs Punkte darunter, von der
Overlay-Passworteingabe bis zu `installAutofill()`, waren bis auf den Preload **schon auf der Platte**. Die
Liste beschrieb also fast durchweg das Gegenteil der Lage: erledigt geglaubtes war ungeprüft, ungebaut
geglaubtes war gebaut.

Das ist der eigentliche Befund. „Getestet" war eine Behauptung, die niemand nachgesehen hat, und sie hat einen
Tresor mit Verschlüsselung als abgeschlossen ausgegeben.

Nachgeholt: sieben Testdateien, rund 2900 Zeilen. `crypto/**` von ~37 % auf **100 % in allen vier Maßen**,
`shared/overlay/**` von 96,4 auf 100 %, global **94,95 / 94,45 / 93,18 / 95,32** — alle Schwellen wieder
gehalten, keine gesenkt.

**Drei echte Fehler kamen dabei heraus**, und der erste ist der lehrreichste:

1. **`chrome-import.ts` prüfte `text.startsWith('')`** — ein leeres String-Literal statt `'﻿'`. Immer
   wahr, also wurde **das erste Zeichen jeder importierten CSV verworfen**. Chromes Export überlebte das aus
   Zufall (`name,url,…` → `ame,url,…`; Spalten werden über Namen gefunden, und die beschädigte war die einzige
   optionale). **Firefox' Export beginnt mit `url`** — dort traf es eine Pflichtspalte, die Datei kam als
   `unknown-columns` zurück, und der Benutzer bekam „falsche Datei" über eine Datei, die genau richtig war.
   Firefox ist eine dokumentiert unterstützte Quelle. Ein unsichtbares Zeichen in einem Literal ist nicht
   reviewbar; der Regressionstest baut deshalb über die *erste Spalte*, nicht über das BOM — ein
   `name`-zuerst-Fixture kann den Fehler nicht fangen, und genau darum blieb er liegen.
2. **`vault-key.ts` brach seinen eigenen `@throws`-Vertrag.** Node prüft scrypts Kosten *synchron* und wirft;
   im Promise-Executor wurde das zur unveränderten Ablehnung. Eine beschädigte `passwords.key` mit `n: 3`
   ließ `unlock` also mit einem Node-Fehlercode über IPC scheitern, statt `unreadable` zu liefern — für das
   die Seite eine eigene Erklärung hat.
3. **Ein ablehnender Tresor ließ den Weiter-Knopf tot und die Ablehnung unbehandelt.** `#submit` hatte
   `try/finally` ohne `catch` und wird als `void` gerufen: ein E/A-Fehler entkam, und Node beendet den Prozess
   bei unbehandelten Ablehnungen — ein Plattenfehler beim Entsperren war damit ein Weg, den Browser
   abzuschießen.

### Was am Tresor offen bleibt: das Preload-Budget

Nicht geliefert, und die Begründung ist wertvoller als die Zahl. Gebraucht: ≤ 22 499 B. Vorhanden: **28 714 B**.

Der hier notierte Weg — die Oberflächen-Hälften von Autofill und Picker herausziehen — **reicht nicht**: das
Muster ist für beide Features längst vollständig umgesetzt (`picker-chrome.ts` und `passwords/chrome.ts`
schicken jedes Stylesheet und jeden Satz aus dem Kern), übrig ist ausführbarer DOM-Aufbau, rund **2–2,5 kB**
statt der nötigen 6,2. Und „bei Bedarf nachladen" hat hier **keinen Mechanismus**: `sandbox: true` auf jeder
Ansicht, und `electron.vite.config.ts` setzt `inlineDynamicImports: true` mit dem Kommentar, der genau das
erklärt — ein sandboxed Preload kann `require('./chunks/…')` nicht, ein geteilter Build übersetzt und
scheitert zur Laufzeit.

Was das Budget erreicht, ist ein **Rollen-Split**, gemessen: ein reiner Inhalts-Einstieg wiegt 22 908 B, ein
reiner Chrome-/Intern-Einstieg 3 882 B. Zusammen mit den Oberflächen-Hälften landet der Inhalts-Preload bei
≈ 20,4 kB. Dafür braucht es zwei eigenständige Einstiege in `electron.vite.config.ts` und ein rollenbewusstes
`preloadFile()` durch `Tab.ts`, `OverlayLayer.ts` und `BrowserWindowController.ts`. Das ist die nächste
Aufgabe an dieser Stelle — und ausdrücklich **nicht** `new Function` über Quelltext aus dem Kern, was Eval im
Preload wäre.

### Der Tresor, ursprüngliche Liste (erledigt außer 6)

1. **Die Passworteingabe auf der Overlay-Schicht** — eine sechste Präsentationsart. Entschieden und nicht
   verhandelbar: das Master-Passwort verlässt den Hauptprozess nie, kein Kanal nimmt eines an, der Renderer
   erfährt nur `'unlocked' | 'wrong-password' | 'cancelled' | 'unreadable'`. Ein Test wacht darüber
   (`internal-page-wiring.test.ts`, „carries no channel whose payload could hold a master password").
   Die Art **wartet auf eine Antwort** wie `permission-request`: verlässt sie die Schicht ohne eine, muss das als
   abgebrochen auflösen und nicht hängen — genau dieser Fehler ist in diesem Projekt schon einmal passiert.
2. **`resetVault` legt die verschlüsselte Datei auf Wunsch beiseite**, bevor sie verworfen wird, mit der
   Erklärung im selben Atemzug, dass die Kopie ohne das Passwort unlesbar ist.
3. Kanäle und Vertrag für `requestUnlock`, `lock`, `beginSetMasterPassword`, `resetVault`, `import`.
4. **44 i18n-Schlüssel** in beiden Sprachen. `passwords.protectionNotice` und `passwords.unencryptedNotice` sind
   jetzt Waisen im Katalog und gehören weg.
5. **`installAutofill()` wird nie aufgerufen** und kein `AutofillService` wird je gebaut — Autofill läuft
   überhaupt nicht.
6. **Preload auf unter 22 kB** (aktuell 27). Das Budget wird bewusst nicht gehoben: der Preload wird einmal pro
   Seite in jedem Tab geparst. Die Oberflächen-Hälften von Autofill und Element-Picker sollen bei Bedarf
   nachgeladen werden; für den Picker ist das Muster schon da (`picker-chrome.ts` schickt Stil und Wortlaut aus
   dem Kern).

### Danach — alles Offene an einer Stelle

Von den Benutzungsmeldungen sind alle vier abgearbeitet (siehe „Gemeldet, noch offen"). Was bleibt:

**Blockiert etwas anderes**

| Offen | Warum es zuerst kommt |
|---|---|
| **Der Tresor**, sechs Schritte oben | Zieht als Einziges die Coverage unter die Schwelle (`crypto/**` bei ~37 %) und hält den Preload über seinem Budget. Autofill läuft überhaupt nicht: `installAutofill()` wird nie gerufen |
| **Erster Lauf des neuen Harness** | Bis dahin ist nichts seit dem letzten grünen Lauf in der echten App belegt. Sechs unzugeordnete Fehlschläge warten auf Einordnung; drei Verdachtsmomente stehen in der Reihenfolge, in der sie auszuschließen sind |

**Entscheidungen, die beim Benutzer liegen**

| Frage | Was daran hängt |
|---|---|
| **Zwölf tote Tasten** | `Escape`, `stop`, `Strg+9`, `Strg+1`–`8`. Die neun unkritischen brauchen nur Menüeinträge; `escape`/`stop` dürfen **nicht** über das Menü und brauchen `before-input-event` |
| **Zoom: pro Domain oder pro Kachel?** | Heute pro Domain (Spezifikation 1), zwei Kacheln mit derselben Seite zoomen also gemeinsam |
| **Eingeklappte Gruppe nimmt keine Anordnung auf** | Ausklappen verliert die Kachelaufteilung weiterhin. `keepArrangement` aus `setCollapsed` zu rufen ist der naheliegende Schritt |
| **`#rehomeHiddenTabs` hängt nicht an `adaptLayoutToTabs`** | `fillEmptyTiles` schon. Verteidigbar, aber nirgends aufgeschrieben, und der Kommentar daneben sagt das Gegenteil |
| **`electron-builder.yml` Zeile 3 und 95** | Steht weiterhin „tessera contributors". Welcher Name dort hingehört, ist nicht meine Entscheidung |
| **Netz-Sync des Tresors** | KDBX/Vaultwarden, ausdrücklich später — aber die Naht dafür sollte jetzt definiert werden, solange der Tresor offen ist |

**Handwerk, ohne Entscheidungsbedarf**

- **Drei Module fehlen in der Stryker-Erlaubnisliste**: `TabGroupStore.ts`, `tabgroups/strip.ts`, `tabgroups/schema.ts`. Neuer Mutationslauf steht ohnehin aus; der letzte ergab 84,88 % über 7999 Mutanten.
- **Sechs Dateien über der Zeilenmarke**, `catalog.ts` (1152) und `contract.ts` (1022) voran. Für `BrowserWindowController` ist der nächste Schritt schon benannt (`#wireWindowEvents` nach `window-events.ts`).
- **Zwei Fitness-Funktionen, die Agenten vorgeschlagen haben und die ich nicht geschrieben habe:** jede gespiegelte `z.object`-Form braucht eine Zusicherung in **beide** Richtungen (eine einseitige lässt ein Feld still von der Leitung fallen), und keine Schaltfläche mit Kürzel darf eine Aktion aus einer Liste toter Tasten nennen.
- **`docs/QA.md`** braucht eine Zeile: mit In-Prozess-Eingaben kann das Anfassen der Maschine während eines Laufs eine Zone scheitern lassen, was genau wie ein Produktfehler aussieht.
- **TypeScript 7** — gemessen null Typfehler, absichtlich verschoben; Blocker ist `@typescript-eslint/parser` (`<6.1.0`).

## Der Smoke-Test darf nicht mehr über CDP laufen

Vorgabe des Benutzers, mitten in einem Lauf, danach präzisiert: **„wir können so gut wie alles machen, was den
ms defender auf meinem mac nicht triggert und bei internal it alamiert."**

Die Ursache ist **kein Zufall des Werkzeugs, sondern seine Bauart.** `scripts/smoke.mjs` startet
`out/main/index.js` mit `--remote-debugging-port=9333` und öffnet dann CDP-WebSockets dagegen. Einen
Chromium-Prozess mit offenem Debug-Port zu starten und über CDP zu steuern **ist** die
Standard-Technik zum Auslesen von Cookies und gespeicherten Passwörtern — genau deshalb schlägt Defender an,
und die Meldung geht an die interne IT. Ein anderer Port oder ein zweiter Versuch ändert daran nichts.

Die Grenze ist damit **CDP, nicht das Testen**. Normal und weiterhin Standard: `pnpm typecheck`, `pnpm lint`,
`pnpm test`, `pnpm build`, `node scripts/metrics.mjs`, Stryker.

### Umgebaut: der Treiber steuert von innen

Die Prüfungen hingen nie an CDP, nur der Treiber. Der ist ersetzt:

| Vorher (CDP, von außen) | Jetzt (kein Port, kein Socket) |
|---|---|
| `Runtime.evaluate` über WebSocket | `webContents.executeJavaScript` |
| `Input.dispatchMouseEvent` | `webContents.sendInputEvent` |
| `fetch` auf die Zielliste, um die Overlay-Schicht zu finden | die `OverlayLayer` liegt im selben Prozess vor |
| `spawn` mit Debug-Schalter | Startflag `--run-checks=<modul>`, die App fährt ihre eigenen Prüfungen |

`scripts/smoke.mjs` ist damit auf 81 Zeilen Starter geschrumpft, die Prüfungen liegen in
`scripts/smoke-checks.mjs`, der Adapter in `scripts/smoke-driver.mjs`. Zwei Dinge waren dabei nicht
Kosmetik:

- **Das Flag muss im gepackten Build verweigert werden.** Ein ausgelieferter Browser, dem man auf der
  Kommandozeile sagen kann, ein beliebiges Modul von der Platte zu laden und auszuführen, ist keine
  Entwicklungshilfe, sondern ein Weg zur Codeausführung mit freundlichem Namen. `readCheckModule` prüft
  `packaged` zuerst; eine Fitness-Funktion prüft, dass der *Aufrufer* `app.isPackaged` übergibt — der
  Einheitstest kann nur zeigen, dass die Funktion verweigert, nicht dass jemand die richtige Frage stellt.
- **Die Prüfungen dürfen nicht ins Hauptbündel.** Zweitausend Zeilen Zusicherungen, die jeder Benutzer bei
  jedem Start mitparst, in einem Budget, das schon reißt. Sie werden zur Laufzeit per `import()` geladen;
  belegt über `grep` gegen `out/main/index.js` (0 Treffer) und über eine Fitness-Funktion, die einen
  statischen Import aus `scripts/` verbietet — die Größenmetrik würde eine Umstellung erst Monate später
  bemerken.

Dazu eine dritte Schranke: **keine Datei in `src/`, `scripts/`, `tests/` darf einen Debug-Schalter oder einen
Debugger-Socket nennen.** Gegen die Schreibweise des Schalters geprüft, nicht gegen die Wörter — sonst stolpern
die Kommentare, die das Verbot erklären, darüber. Ihr eigenes Suchmuster ist aus Fragmenten
zusammengesetzt, weil der Test sonst über sich selbst fällt und die verlockende Reparatur wäre, den Scanner
von seiner eigenen Regel auszunehmen. Alle drei gegengeprobt.

### Was beim ersten echten Lauf zu prüfen ist

Der Umbau ist **nicht** in der laufenden App belegt — bewusst, siehe oben. Ein Lauf war angefangen und wurde
abgebrochen; er kam auf **62 Prüfungen: 56 grün, 6 rot**, alle sechs im ersten Layout des Ziehdurchlaufs.
`1x1 0-tile`, `0-right` und `0-bottom` waren dabei grün, samt ihrer genau versprochenen Rechtecke — die
Koordinatenübersetzung stimmt also für drei von fünf Zonen dieses Layouts, und das ist der stärkste
Einzelbeleg, der vorliegt. Die zwei Ausfälle sind **nicht zugeordnet**. In dieser Reihenfolge auszuschließen:

1. **Vordergrund.** `sendInputEvent` an ein unfokussiertes Fenster wird lautlos verworfen — eine Aussetzung,
   die es unter CDP nicht gab. Schlimmer: `BrowserWindowController.onBlur` **bricht das Ziehen ab und schließt
   die Overlay-Schicht**, ein Fokusverlust beendet also die Geste und Zurückfokussieren macht das nicht
   rückgängig. Inzwischen wird vor jedem Ereignis fokussiert; beim abgebrochenen Lauf war das noch nicht drin.
   Erster Lauf: starten und die Maschine nicht anfassen.
2. **Der echte Mauszeiger.** `0-left` hob die *rechte* Hälfte hervor — die letzte dem Kern bekannte
   Zeigerposition lag rechts. Ein Zeiger, der über der Schicht ruht, hebt eine eigene Zone hervor. Zeiger vor
   dem Lauf aus dem Fenster legen.
3. **Ein echter Produktfehler.** Nicht auszuschließen — genau dieser Durchlauf hat den Fehler der mittleren
   Kachel gefunden, und die zwei ausgefallenen Zonen sind zwei der vierundzwanzig.

Ebenfalls unbelegt: dass `import()` eines `.mjs` im Hauptprozess von Electron trägt (die erzeugte Form ist
richtig, das Modul hat kein `await` auf oberster Ebene), und die genaue Gesamtzahl — das Harness gibt sie jetzt
selbst aus (`All N checks passed.`), niemand muss sie glauben.

Nicht in der echten App geprüft ist damit alles seit dem letzten grünen Lauf: Tooltip-Kürzel, Layout-Kürzel im
Menü, Zoom-Geste, Auffrischen der Kachelleiste, Fenstermenü auf allen Plattformen, und das Harness selbst.

## Bekannte Risiken

| Risiko | Warum es offen ist |
|---|---|
| `setFullScreenable(false)` als Mechanismus für Kachel-Vollbild ist **nur auf macOS geprüft** | Windows und Linux, besonders Wayland-Compositor, sind das größte Unbekannte. Erster Punkt in `docs/QA.md` |
| Optische Transparenz der Overlay-Schicht | Braucht einen Screenshot des zusammengesetzten Fensters; Bildschirmaufnahme ist in der Entwicklungsumgebung blockiert. Funktional belegt, optisch nicht |
| ~~Die Ziehprüfung im Smoke-Test flackert~~ **behoben, und die Ursache war dieselbe wie bei den Store-Tests** | Zwei von vier Läufen fielen durch, jedes Mal an einer *anderen* Zone — was nach Produktfehler aussieht und eine Stoppuhr war: nach dem Mausdruck wartete die Prüfung fest 600 ms darauf, dass die Zonen über `overlay:presented` zurückkommen, und weitere 350 ms darauf, dass die Overlay-Schicht die Hervorhebung zeichnet. Auf einer belasteten Maschine reicht keins von beidem. Jetzt wird auf den **Zustand** gewartet (`waitFor`), nicht auf die Uhr — und der letzte Messwert wird zurückgegeben statt zu werfen, damit die Zusicherung des Aufrufers die Fehlermeldung bleibt. Fünf Läufe hintereinander grün, 440 Prüfungen |
| Tab-Gruppen überleben keinen Neustart | Nicht ein Fehler, sondern die fehlende Sitzungswiederherstellung. Die Alternative wäre schlimmer: fremde neue Tabs in alten Gruppen |
| Drei Größenbudgets angehoben | Preload 16→22 kB, Hauptprozess 200→250→320 kB, größte Datei 750→780 Zeilen. Jede mit Begründung *und* mit dem nächsten Schritt im Kommentar — was eine weitere Anhebung rechtfertigen würde und was nicht |
| **Fünf Budgets stehen darüber, absichtlich nicht angehoben** | Hauptprozess **359 kB** (Grenze 320), Preload **29 kB** (22), Renderer-JavaScript **331 kB** (320), größte Datei **1152 Zeilen** (780), ungetestete Renderer-Zeilen **4436** (2800). Die Kommentare nennen ihren nächsten Schritt selbst, und keiner davon ist „höher setzen": beim Hauptprozess das Laden der Manifest-Auswertung des Medien-Downloaders auf Abruf, beim Preload das Herausziehen der **Oberflächen**-Hälften von Element-Picker und Autofill. Die 320 wurden bereits *für* dieses Funktionsbündel angehoben; eine dritte Anhebung dafür wäre keine Begründung mehr, sondern eine Gewohnheit |
| **Die Zeilen-Marke maß nur die schlimmste Datei** | Ein Fund aus dieser Runde, und er war schlimmer als er aussah. Die Marke gilt *pro Datei*, gemessen wurde aber nur das Maximum — sobald eine Datei darüber stand, konnte jede weitere lautlos vorbeiziehen. Genau das war passiert: `shared/tabgroups/model.ts` erreichte 873 Zeilen, vierzig Zeilen davon entfernt, überhaupt gemeldet zu werden, während die Zahl auf dem Schirm weiter `catalog.ts` nannte. Neue Prüfung `files over the per-file line bar` — und die Antwort ist **sechs**: `catalog.ts` (1152), `contract.ts` (1022), `BrowserWindowController.ts` (918), `tabgroups/model.ts` (873), `main/index.ts` (861), `PasswordsPage.tsx` (788) |
| Kein Mutationslauf über die neuen Module | Die Stryker-Liste ist eine **Erlaubnisliste**: eine Auslassung ist unsichtbar. Die neuen Verzeichnisse fehlen noch darin |

## Qualitätsstand

Zuletzt gemessen bei diesem Durchgang:

| Prüfung | Ergebnis |
|---|---|
| Tests | 3955 grün, 2 bedingt übersprungen (135 Dateien) |
| Zeilen-Coverage | 95,3 % (Schwelle 90 %) |
| Branch-Coverage | 94,5 % (Schwelle 85 %) |
| Statements / Functions | 95,0 % / 93,2 % (Schwelle 90 %) |
| Mutations-Score | 85 % (Schwelle 70 %) — Lauf steht aus, der Tresor ist neu in der Liste |
| Metriken | **8 von 14** — sechs überschritten, alle benannt, keine davon angehoben |
| Smoke-Test in echter App | **nicht gelaufen** (Vorgabe); letzter vollständiger Lauf: 440 Prüfungen grün, vor dem Harness-Umbau |

Die Coverage stand bei 84,8 % und ist ohne eine gesenkte Schwelle zurück: der Tresor hat seine Tests bekommen
(`crypto/**` von ~37 % auf 100 %), und die letzte reißende Bereichsschwelle lag an **meinem eigenen**
`gestures/zoom.ts` — zwei `?? 100`-Rückfälle auf ein nicht-leeres Literal, also Zweige, die kein Test
erreichen kann, während der Kommentar daneben selbst schrieb, dass sie nicht durchfallen können. Entfernt statt
die Schwelle zu senken; die Enden der Zoom-Leiter hält jetzt eine Zusicherung.
| Smoke-Test in echter App | **440 Prüfungen, alle grün** |
| typecheck | vier Projekte sauber: node, web, preload, components |
| lint | sauber (`--max-warnings 0`) |

Die beiden übersprungenen Tests laufen gegen die **echten** heruntergeladenen Filterlisten und
überspringen sich selbst, wenn kein Korpus vorliegt — `describe.skipIf(corpus.length === 0)`.
