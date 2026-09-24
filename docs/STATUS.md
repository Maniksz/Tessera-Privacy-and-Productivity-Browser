# Stand der Arbeit

Vollständige Durchsicht aller angemerkten Punkte: was gebaut ist, wie es belegt wurde, und was
offen ist. Gepflegt bei jedem Durchgang; die Reihenfolge folgt der Reihenfolge, in der die Punkte
gemeldet wurden.

**Legende** — ✅ gebaut und belegt · 🟡 teilweise · ⬜ offen · ❓ braucht eine Entscheidung · ⛔ verworfen

> **Zuletzt gegen den Code geprüft:** 24.09.2026 (Roadmap Herbst 2026, U5). Geprüft sind die Tabellen am
> Anfang, „Noch zu bauen", die Entscheidungen, die Härtung und die bekannten Risiken; die Durchgangsberichte
> vom Juli sind Geschichte und bleiben so stehen, wie sie damals galten. Neu ist „Roadmap Herbst 2026" weiter
> unten. Davor zuletzt am 29.07.2026 (dritter Durchgang desselben Tages) — dort stimmte in vier Fällen der
> Eintrag nicht mehr. Wer diesen Kasten liest und das Datum alt findet, sollte den Tabellen
> nicht glauben, sondern nachsehen: **dieses Dokument hat sich jetzt fünfmal selbst widerlegt** — die
> Tabelle „Noch zu bauen", die Prämisse des Tresor-Abschnitts, zwei Durchgänge davor, und der dritte
> Durchgang, der das Settings-Panel seit jeher ein „Overlay" nannte, das es nie war.
>
> Der vierte Fall ist der teuerste bisher, weil er Arbeit ausgelöst hätte, die es nicht gibt: **der
> Rollen-Split des Preloads stand als „nächste Aufgabe" und war seit dem Init-Commit gebaut**, samt
> zweitem Bundle, rollenbewusstem `preloadFile()`, eigenem Budget in `metrics.mjs` und einer 148-zeiligen
> Fitness-Funktion. Ein Statusdokument, das Gebautes als offen führt, bestellt Doppelarbeit. Was am
> Preload wirklich offen ist, steht jetzt unter „Preload-Budget".

---

## Die 15 Punkte vom Anfang

| # | Punkt | Stand | Belegt durch |
|---|---|---|---|
| 1 | Drag & Drop in den Split mit Anzeige, wohin geteilt wird | ✅ | Smoke-Test mit echten Mausereignissen: 5 Zonen bei Einzelansicht, Markierung folgt dem Zeiger, linke Hälfte `left: 0, width: 716/1440`, Ablegen erzeugt den Split |
| 2a | Suchleiste bei „home" leer | ✅ | Smoke: `address bar is empty at home -> ""` |
| 2b | Startseite „geht nicht wirklich" | ✅ | `StartPage.tsx` mit `QuickLinkTile`, `QuickLinkDialog`, eigenem Kanalsatz. Bildkette und Kachelmaß siehe 11 und 13 |
| 3 | Verlauf existiert nicht | ✅ | `HistoryPage.tsx` + `history.html`; Ende zu Ende belegt (aufgezeichnet, gefunden, gelöscht), `history:open` statt `nav:navigate` |
| 4 | Layout-Tasten alle oben rechts | ✅ | Ein Knopf mit Dropdown; Smoke prüft 1 Knopf, 5 Einträge, genau 1 aktiv |
| 5 | Kein Settings-Knopf | ✅ | Der Knopf ist da und öffnet seit dem dritten Durchgang **den Tab** `tessera://settings`. Das Panel daneben ist gelöscht: eine Oberfläche, ein Eingang. Der frühere Eintrag hier nannte es ein „Overlay" — das war es nie, siehe „Einstellungen: eine Seite statt eines Panels" |
| 6 | Kein Extension-Knopf | ✅ | Dito über `ExtensionsView.tsx`; `extensions.html` ist ein eigener Tab |
| 7 | Tabs werden in der Multi-View nicht zur Tab-Gruppe | ✅ | **Gebaut.** Die Anordnung wird jetzt bei *jedem* Settle geschrieben statt einmal beim Verdrängen, und genau das macht den Rest möglich: eine Aufnahme, die nie veraltet, muss auch nie verbraucht werden. Details und die drei Entscheidungen unter „Multi-View ist eine Tab-Gruppe" |
| 8 | In der Multi-View nur „main page" zurück; Wischen; Leiste am oberen Rand | ✅ | Drei Teile, alle drei da: aktive Kachel folgt dem Klick (`split:setActiveTile`), Hover-Leiste als `overlay/TileBarSurface.tsx`, Wischen über `decideNavigationGesture` in `TileInputController` — nach Zeiger geroutet, nicht nach Fokus |
| 9 | Icons oben links zu klein | ✅ | 32×32 Knopf mit 20 px SVG |
| 10 | Kein Home-Knopf | ✅ | Smoke: 4 Navigationsknöpfe |
| 11 | Kachel-Icons der Startseite: Favicon oder Screenshot lokal | ✅ | Screenshot mit Favicon als Rückfall, die Kette liegt in `shared/quicklinks/cards.ts` (`cardImageSequence`), damit Renderer und CSS nicht auseinanderlaufen können. Privater Modus fotografiert nichts: `discardingThumbnailCapturer` hält weder Store noch Verzeichnis noch Kamera |
| 12 | Der Browser braucht einen Namen | ✅ | **Entschieden: Tessera.** `src/shared/product.ts` ist die eine Quelle für Name, Schema (`tessera://`) und appId; drei Fitness-Funktionen halten das fest. Offen bleibt nur das echte App-Symbol, heute ein Platzhalter aus `scripts/make-icon.mjs` |
| 13 | Kachel-Icons der Startseite größer | ✅ | `.tile__icon` ist volle Kartenbreite bei `aspect-ratio: 8/5` — dasselbe Maß wie `THUMBNAIL_TARGET` (480×300), also wird nichts zweimal beschnitten. Zwei Bildregeln statt einer, weil `object-fit` auch *hoch*skaliert und ein 32-px-Favicon auf Kartenhöhe ein Schmierer wäre; der Rückfall bleibt bei 48 px |
| 14 | Nicht alle Tabs schließbar; „new tab" bleibt übrig | ✅ | Smoke: 1 Tab übrig nach dem Schließen aller |
| 15 | Was ich noch finde | 🟡 | Laufend gemeldet; dieses Dokument ist die Liste — und war zweimal die falsche. Siehe „Der Befund dieser Runde" |

## Die vier Punkte danach

| Punkt | Stand | Anmerkung |
|---|---|---|
| Settings als eigener Tab mit eigener View | ✅ | **Beide Hälften fertig.** Das Rechtemodell schließt, was eine interne Seite *rufen* darf; die Sperre schließt jetzt, wer sie *öffnen* darf. Siehe „Navigationssperre zu `tessera://`" — dort steht auch die zweite Lücke, die bei der Arbeit auffiel und die kein `will-navigate`-Handler je gefunden hätte |
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
| DOM-Elemente selbst blocken wie uBO | ✅ Neu gebaut, weil es still scheiterte („keins der Elemente verschwindet"): der Commit gab `void` zurück und verwarf Regeln auf fünf Wegen ohne Meldung, und im privaten Fenster erreichte eine Regel nie eine Seite. Jetzt friert der Klick die Auswahl ein, eine Leiste auf der Overlay-Schicht zeigt Selektor und gemessene Trefferzahl, lässt breiter und enger ziehen, und jeder Versuch endet in einem von acht benannten Ausgängen. Die Vorschau läuft als Zusatz-Stylesheet nur in der pickenden Ansicht; nach dem Bestätigen wird sie aufgehoben, die Regel geschrieben, neu ausgeliefert und nachgemessen, erst dann heißt es „wirksam". Private Fenster bekommen ihre Regeln pro Ansicht, nie über den globalen Engine-Slot; gespeicherte Regeln lassen sich dort ein-, aber nicht ausschalten. Die Regelverwaltung ist ein Textfeld, das keine Regel löscht, die es nicht gezeigt hat; an der 500er-Grenze wird abgelehnt statt die älteste Regel zu verdrängen. Plan: `docs/plans/2026-08-09-001-fix-element-picker-plan.md`. Die zwei Grenzen bleiben Absicht: keine Netzregeln aus dem Picker, keine Regel ohne Host |

## Später gemeldete Fehler und Wünsche

| Punkt | Stand |
|---|---|
| Fenster lässt sich nicht am Kopf ziehen | ✅ Die Ziehfläche hatte **null Breite**: `.tabbar` erklärte sich als ziehbar, aber die Tab-Leiste darin hatte `no-drag` und `flex: 1`. Jetzt tragen die Tabs es, nicht ihr Behälter |
| Layout-Icons nur weiß, konturiert gewünscht | ✅ `.iconbutton--wide svg` überschrieb das gemeinsame `fill: none; stroke: currentColor`. Zeichenfläche musste auf `-1 -1 18 18` wachsen, weil ein Strich mittig auf seiner Kante liegt |
| Layouts mit drei und vier Kacheln **nebeneinander** | ✅ `1x3`/`1x4`. Ich hatte „1x1x1" zunächst als Stapel gelesen und musste den Auftrag mitten im Lauf korrigieren. Der Kern ist nicht das Zeichnen: alle bisherigen Aufteilungen haben höchstens **eine** Trennlinie pro Achse, drei Spalten haben zwei, und die müssen in Ordnung bleiben — unabhängig geklemmt rutscht die zweite über die erste und erzeugt eine Kachel mit negativer Breite |
| App-Symbol ist noch das von Electron | ✅ **Platzhalter**, programmatisch erzeugt von `scripts/make-icon.mjs` ohne neue Abhängigkeit. Motiv ist die Split-View, Geometrie wörtlich aus `LayoutIcon.tsx`, Farben aus `tokens.css`. Deterministisch, mit electron-builders eigenem Resolver als `isFallback: false` bestätigt. Das echte Zeichen gehört zum Namen |
| Verlauf geht immer noch nicht | ✅ **Erledigt.** Der Recorder sitzt im Tab, nicht im Fenster — der Tab kennt Adresse und Titel selbst, und ein privates Fenster hält ein Objekt ohne jeden Pfad zur Datei. Die Seite `tessera://history` gibt es (`HistoryPage.tsx`, `history.html`); „Beim Beenden löschen" nimmt den Verlauf seit Roadmap U11 mit, auch nach einem Absturz |

## Gebaut und verdrahtet

Der teuerste Zustand im Projekt war: fertige, getestete Systeme, die nichts tun, weil die
Verbindungsstellen fehlen. Dieser Zustand ist aufgelöst — alles unten läuft im echten Programm.

| System | Belegt womit |
|---|---|
| Verschlüsselte Ablage | Auf der Platte als `OBENC`-Umschlag nachgewiesen, unterschiedliche Nonces, kein Klartext. Die Startflags liegen bewusst unverschlüsselt in einer eigenen Datei: `bootstrapFlags()` liest **vor `app.whenReady()`**, wo `safeStorage` unter Linux noch nicht antwortet |
| Werbeblocker | Im Smoke-Test: **4 von 4 Listen geladen**, 174 050 Zeilen geparst, 113 604 Netzregeln, 49 783 Ausblendregeln, 4 228 abgelehnt (2,4 %, überwiegend `$popup`) |
| Kosmetische Filter | Einspritzung in die Seite über den Preload. Zwei Kanäle, weil es zwei Momente gibt: die hostspezifischen Regeln **synchron** bei `document-start` (sonst blitzt die Werbung auf), die generischen nachträglich und merkmalsindiziert — die Seite meldet ihre Klassennamen, der Kern antwortet nur mit dem, was passen kann |
| Element-Picker | Sitzung als reiner Zustandsautomat (`shared/filters/picker-session.ts`), Markierung und Klick-Abfangen im Preload, Bestätigungsleiste als Overlay-Art `picker-bar`. Drei Aufrufwege: Kontextmenü, `Strg+Shift+E`, Blocker-Menü — alle mit derselben Vorbedingung |
| Verlauf | Ende zu Ende belegt: Besuch aufgezeichnet, gefunden, gelöscht; `tessera://history` rendert |
| Favicons | Im laufenden Programm: `naturalWidth = 1` über die Schemagrenze `file://` → `tessera://` |
| Thumbnails | Im laufenden Programm: 480×300, dekodiert, richtige Proportionen |
| Tab-Gruppen | Chip, Farbband, Einklappen, Inline-Umbenennen, Kontextmenü |
| Fingerprint-Maskierung | In der Sitzung verdrahtet. iframes und Worker bleiben unmaskiert — der Preis dafür, Chromium nicht zu forken |
| Medien-Erkennung | Beobachtung in der Anfrage-Pipeline, HLS- und DASH-Manifeste, Download mit benannten Verweigerungsgründen |
| Berechtigungs-Dialog | Auf der Overlay-Schicht, mit Warteschlange. Escape blockiert; ein privates Fenster merkt sich nichts. **Korrektur 23.09.2026:** der Dialog war bis dahin *nicht* angeschlossen — `PermissionArbiter.ask()` hatte keinen Produktionsaufrufer, „Fragen" war ein stilles Nein (IMPROVEMENT-PLAN V1). Jetzt verdrahtet, siehe „Härtung nach dem Projekt-Review" |

Der Schlussstein ist das **pro-Seite-Rechtemodell**. Jede interne Seite bekommt nur ihre eigenen
Kanäle — die Startseite Quicklinks, die Settings-Seite Settings, der Verlauf den Verlauf. Vorher
teilten alle dieselben sieben, und eine gemeinsame Liste hätte `settings:set` enthalten müssen, damit
eine Settings-Seite möglich ist: dann hätte die **Startseite** jede Einstellung umschreiben können,
also genau die Seite, auf die eine Website am plausibelsten verlinkt.

Der Verlauf bekommt `history:open` statt `nav:navigate`, weil der Kern das Ziel aus dem Absender
auflöst — die Seite steuert sich selbst und nichts anderes. Abonnements sind ebenfalls eine
Berechtigung: die Startseite darf `settings:changed` nicht hören.

**Nachgeprüft und halb.** `mayInternalPageInvoke(page, channel)` und `mayInternalPageListen(page, channel)`
fragen wirklich die Seite, `INTERNAL_PAGE_INVOKE_CHANNELS` ist pro Seite geschlüsselt — der Schlussstein
liegt. Aber der Halbsatz oben („genau die Seite, auf die eine Website am plausibelsten verlinkt") beschreibt
einen Angreifer, der eine interne Seite *öffnet*, und **dagegen gibt es nichts**. Siehe „Der Befund dieser
Runde".

## Noch zu bauen, aus der Ursprungs-Spezifikation

**Diese Tabelle war überholt und ist nachgezogen.** Sie führte fünf Bereiche als offen, von denen vier
fertig sind — nachgeprüft, Datei für Datei, nicht aus dem Gedächtnis. Das ist selbst der Befund: ein
Statusdokument, das Erledigtes als offen führt, ist so irreführend wie eines, das Offenes verschweigt.

| Bereich | Stand | Beleg bzw. was fehlt |
|---|---|---|
| Settings und Erweiterungen als eigene Tabs | ✅ | Settings ist jetzt **nur noch** ein Tab (`SettingsPage.tsx` über `renderer/shared/SettingsView.tsx`); das Panel ist entfernt. Erweiterungen haben weiterhin beides |
| Pro-Kachel-Navigationsleiste | ✅ | `overlay/TileBarSurface.tsx`; der Tastaturweg ist da (`focusTileBar` hat einen Menüeintrag mit Beschleuniger), also kein Maus-Only-Feature |
| Sitzungswiederherstellung | ✅ | `session-restore/apply.ts`. Der Blocker für Tab-Gruppen ist gelöst und nicht umgangen: `adoptTabId` hebt den Zähler über jede wiederhergestellte ID, `retainTabs` wird **einmal** mit der Vereinigung aller Fenster gerufen |
| Lesezeichen, Downloads, Passwörter | ✅ | Alle drei Seiten existieren, der Tresor ist verdrahtet (`installAutofill()` in `src/main/index.ts`, siehe „Der Tresor — erledigt"). Die Lesezeichenseite nennt seit Roadmap U4 eine neuere, ungültige oder schreibgeschützte Datei wie die Passwortseite |
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

## In diesem Durchgang gebaut (29.07.2026, zweiter Durchgang)

Acht Arbeitspakete. Eines entfiel, weil es schon gebaut war; eines wartet auf eine Angabe. Jede
Entscheidung, die unterwegs getroffen wurde, steht hier — nicht nur, was sie ist, sondern was sie kostet.

### Navigationssperre zu `tessera://` — die Sicherheitslücke, und die zweite daneben

Gebaut, und der Befund war größer als der Auftrag.

Die Sperre selbst liegt in `src/main/browser/navigation-policy.ts`, Electron-frei und bei 100 % in allen
vier Maßen. `Tab.ts` hängt sie an **`will-frame-navigate`** und `will-redirect`. Der Angelpunkt ist eine
Zusicherung aus Electrons eigener Typdatei (`electron.d.ts:17472`, Electron 43.2.0): *„This event will not
emit when the navigation is started programmatically with APIs like `webContents.loadURL`."* Genau deshalb
darf die Regel eine pauschale Ablehnung sein — jeder Weg des Kerns (Adressleiste, `history:open`,
`bookmarks:open`, `quicklinks:open`, Startseite, neuer Tab, verzögerte Wiederherstellung, Lesemodus) geht
durch `Tab.loadUrl` und erreicht den Handler nie. `will-frame-navigate` statt `will-navigate`, weil es
laut derselben Datei die Obermenge ist und auch Unterrahmen erfasst; beide zu registrieren hieße, jede
Hauptrahmen-Navigation zweimal zu beurteilen und zweimal abzulehnen.

**Umleitungen werden anders beurteilt als Seiteninhalt**, und das ist die Stelle, an der eine pauschale
Regel den eigenen Browser gebrochen hätte: `RequestPipeline` biegt eine `http://`-Navigation selbst auf
`tessera://https-only` um. Eine Umleitung wird deshalb nur abgelehnt, wenn ihr Ziel eine Seite ist, die
`internalPageOf` kennt — und `https-only` wie `about` stehen bewusst auf keiner Rechteliste. Verworfen:
`RequestPipeline` seine eigenen Umleitungen markieren zu lassen, was einen unfälschbaren Kanal erfinden
würde, um etwas herzuleiten, das die Rechteliste schon beantwortet.

**Die zweite Lücke, die in diesem Dokument nie stand.** `history:open` und `bookmarks:open` nahmen
`url: z.string()` ohne jede Schemaprüfung und liefen durch `resolveOmniboxInput`, das `tessera:`
unverändert durchreicht. Die **Verlaufsseite** konnte ihren eigenen Tab nach `tessera://settings`
navigieren und kam mit Settings-Rechten zurück — eine Rechteausweitung ganz ohne Webinhalt, die kein
`will-navigate`-Handler je gesehen hätte, weil sie ein Aufruf des Kerns *ist*. Geschlossen im Vertrag über
`openableUrl`. Ausdrücklich weiterhin erlaubt: eine interne Adresse zu *speichern* (`bookmarks:create`) —
harmlos, sobald das Öffnen gesperrt ist.

Zwei Fitness-Funktionen halten beides fest. **Was das Dokument falsch beschrieb:** `setWindowOpenHandler`
ließ nie „nur `https?:` durch" — es antwortet auf **jede** Disposition mit `{ action: 'deny' }`, und der
Ausdruck entscheidet nur, ob der Kern *selbst* einen Tab öffnet. Die Schlussfolgerung stimmte, der
Mechanismus nicht.

**Offen und bewusst nicht angefasst:** `about` und `https-only` stehen in `KNOWN_PAGES`, haben aber keine
HTML-Datei und liefern heute 404 — auch die HTTPS-only-Zwischenseite. Die Sperre macht das nicht
schlimmer (sie lässt die Umleitung durch), behebt es aber auch nicht.

### Multi-View ist eine Tab-Gruppe

Gebaut, und die tragende Idee ist nicht die, die hier vorhergesagt wurde. Dieses Dokument erwartete
**zwei Begriffe** — eine einmalige Verdrängungsaufnahme und eine dauerhafte Gruppenanordnung. Gebaut
wurde **einer**: die Anordnung wird bei jedem Settle neu geschrieben, in derselben zusammengefassten
Runde, die auch den Tab-Streifen auffrischt. Eine Aufnahme, die nie veraltet, kann nicht das Falsche
wiederherstellen — also braucht sie auch nicht verbraucht zu werden. Der zweite Begriff wurde damit
überflüssig, statt gebaut zu werden.

> **Zurückgenommen am 10.08.2026 — die drei Entscheidungen unten gelten nicht mehr.** Der Plan
> `docs/plans/2026-08-09-001-fix-tabgruppen-eigentum-plan.md` kippt sie mit KD1 („eine Gruppe gehört
> ausschließlich dem Benutzer") und KD4 („Absorption durch Gruppen entfällt ersatzlos"). Die Kosten, die
> hier als akzeptiert notiert sind, waren in der Benutzung teurer als beim Beschluss: die Kachel-Automatik
> legte Gruppen an, ohne dass jemand eine wollte, und trug in eine benannte Gruppe Mitglieder ein, die der
> Benutzer nie hinzugefügt hatte — für ihn nicht von seinen eigenen Änderungen zu unterscheiden und nicht
> rückgängig zu machen. Der Gedanke bleibt stehen, weil er nicht falsch war, sondern zu teuer: **eine
> Aufnahme, die nie veraltet, ist richtig — sie an die Gruppe zu binden, war es nicht.** Die Anordnung hat
> jetzt einen eigenen, unsichtbaren Träger (`src/shared/arrangements/`, `ArrangementController`), auf den
> nur die Automatik schreibt, und `src/shared/tabgroups/` trägt kein `layout` mehr. Was hier folgt, ist
> Vorgeschichte.

Drei Entscheidungen des Benutzers, mit ihren Kosten:

- **Eine Gruppe entsteht, sobald gekachelt ist** — nicht nur beim Teilen, auch nach einer
  Sitzungswiederherstellung. Kosten: ab zwei belegten Kacheln steht ein Farbchip im Streifen, auch wenn
  niemand eine Gruppe wollte. *(Überholt durch KD1/R1: Kacheln legt keine Gruppe mehr an.)*
- **Gemischte Herkunft nimmt immer die bestehende Gruppe** und die losen Tabs treten ihr bei. Das kehrt
  die alte Verweigerung um. Kosten, ausdrücklich akzeptiert: eine benannte Gruppe bekommt Mitglieder, die
  der Benutzer nicht selbst hinzugefügt hat, und der Streifen sortiert sich um. Das alte Argument ist im
  Code stehen geblieben statt gelöscht zu werden — es war nicht falsch, es wurde überstimmt. *(Überholt
  durch KD4/R3: die Absorption ist ersatzlos entfallen, das alte Argument gilt wieder. Ein Tab, der neben
  Gruppenmitglieder gekachelt wird, bleibt gruppenlos.)*
- **Zwei verschiedene Gruppen unter den Kacheln nehmen weiterhin nichts auf.** Das ist die eine Stelle,
  an der die konservative Lesart gewählt wurde: die Entscheidung des Benutzers betraf Gruppenmitglieder
  gemischt mit *losen* Tabs. Zwei selbstgebaute Gruppen zu verschmelzen zerstört eine davon
  (`addTabToGroup` löst eine leergeräumte Quellgruppe auf) und hat kein Zurück. *(Gegenstandslos: keine
  Kachelung nimmt mehr etwas auf, was eine Gruppe wäre.)*

**Die Idempotenz ist kein Detail, sondern die Bedingung.** Der Pass läuft in derselben Runde, die bei
jeder Titeländerung feuert; ohne eine „nichts geändert"-Antwort schreibt er ein Dokument pro Ereignis auf
die Platte, und weil ein Schreibvorgang wiederum sendet, plant die Runde ihre eigene Nachfolgerin. Beides
ist gegengeprobt: die Vergleichsfunktion abschalten macht den Test rot.

**Einklappen bekommt keinen eigenen Aufruf**, und das war eine beauftragte Änderung. Sie ist unter der
Wartung überflüssig — die Anordnung stand schon geschrieben, als die Kacheln freigegeben wurden. Damit
entfällt auch das Hindernis: `TabGroupHost` hat keinen Zugriff auf den Split und hätte für einen eigenen
Aufruf verbreitert werden müssen. **Die Naht wurde nicht verbreitert.**

**Aufgelöst wird nie automatisch.** Eine Gruppe lebt, bis der Benutzer sie auflöst oder sie leer läuft.

**Ein Fehler, der dabei ans Licht kam und behoben ist.** `#firstHiddenTab` hieß „hat keine Kachel" und
meinte „geladen, aber nicht auf dem Schirm" — die Mitglieder einer *eingeklappten* Gruppe haben aber
ebenfalls keine Kachel, weil `setCollapsed` sie absichtlich freigibt. Ein Layoutwechsel oder ein
geschlossener Nachbar setzte also genau den Tab wieder in eine Kachel, der eben weggeklappt worden war,
und stellte damit den Zustand her, den `setCollapsed` in seinem eigenen Kommentar zu verhindern
verspricht: eine Seite auf dem Schirm, zu der im Streifen nichts steht, was sie schließen könnte. Die
neue Absorptionsregel verschärfte das noch — der nächste Settle hätte den losen Nachbarn in die
eingeklappte Gruppe gezogen. Behoben über `isHiddenByCollapse` auf der Belegungsnaht, zwei Tests,
gegengeprobt.

### Zoom pro View

Gebaut. Der Kern liegt in `src/shared/zoom/model.ts` — ein eigenes Modul, weil `Tab.ts` von der
Coverage ausgenommen ist und Klemmung und Rückfall dort Fragen wären, die niemand stellen kann.

**Was dieses Dokument falsch behauptete, und es war der zentrale Satz:** „ein Zoom pro Domain ist eine
Einstellung … gehört in die Sitzung, nicht in die Settings-Datei." Es gab nichts zu verschieben.
`zoomRegistry` war eine `Map` im Speicher, die **nie in irgendeine Datei geschrieben wurde** — der Zoom
pro Domain überlebte keinen Neustart. Gebaut wurde also nicht eine Verschiebung, sondern eine neue
Speicherung plus das Löschen einer Map. Eine Migration gibt es nicht und braucht es nicht.

Die beiden offenen Fragen sind beantwortet: eine neue Kachel startet bei `appearance.defaultZoom`, und
der Zoom **überlebt eine Navigation** in derselben Kachel — gezoomt ist die Ansicht, nicht die Seite.
Gespeichert wird er in der Sitzung, was den Absatz in `session/model.ts` widerlegt, der „kein Zoom"
begründet; er ist nachgezogen.

`number | null` statt einer nackten Zahl: `null` heißt „nie gezoomt, folgt der Einstellung". Nur so
bleibt `appearance.defaultZoom` für unberührte Kacheln wirksam, ohne eine bewusst gezoomte zu
überschreiben — und nur so bedeutet „Zoom zurücksetzen" wieder *folgen* statt *auf den heutigen Wert
setzen*. Angewandt wird er über `webPreferences.zoomFactor` im Konstruktor, weil das der einzige
Zeitpunkt vor dem ersten Zeichnen ist: `setZoomFactor` wirkt auf den Ursprung, auf dem die Ansicht steht,
und eine Ansicht ohne geladene Seite hat keinen.

**Und eine zweite Grenze, die erst die Benutzung zeigte:** die Zoom-*Geste* auf dem Trackpad erreicht
diesen Code überhaupt nicht — `zoom-changed` ist laut Electrons Typdatei ein Mausrad-Ereignis. Siehe
„Zoom klappte nicht" im dritten Durchgang. Alles unten gilt für Tastatur, Menü und Strg+Rad.

**Die Grenze, die niemand vorhergesehen hat und die du kennen musst:** Chromiums Zoomkarte ist pro
Ursprung und pro Sitzung. Zwei Kacheln auf **demselben Host** teilen sich deshalb weiterhin den *lebenden*
Faktor — der zuletzt gezoomte gewinnt —, obwohl die gespeicherten Werte getrennt bleiben und sich bei der
nächsten Navigation wieder durchsetzen. Auch den lebenden Fall zu trennen bräuchte Chromiums isolierten
Zoom-Modus, den Electron nicht freigibt; der einzige andere Weg wäre `webFrame` aus dem Inhalts-Preload,
also eine Brücke in einer besuchten Seite, die Spezifikation 6 verbietet. `ZOOM_STOPS` und die Regel
„nächste Stufe jenseits des aktuellen Werts" sind unangetastet.

### Kachelleiste: Home und Schließen, und `#rehomeHiddenTabs` am Schalter

Beides gebaut, **ohne einen einzigen neuen i18n-Schlüssel** — `toolbar.home` und `tab.close` gab es
schon, und diese Datei borgt sich ohnehin bereits vier `toolbar.*`-Schlüssel.

Der Schalter `splitView.adaptLayoutToTabs` steuert das Nachrücken jetzt an **drei** Stellen, und die
dritte stand nirgends in diesem Dokument: `afterTabClosed` zog einen versteckten Tab in die frei
gewordene Kachel, *bevor* seine eigene `adaptEnabled`-Prüfung lief. „Aus heißt aus" war durch das Ändern
einer Zeile nicht zu erreichen. Jede der drei Stellen ist einzeln begründet; bei `applyDrop` liegt die
Grenze bei `#reseat` — die verdrängte Seite gehört zur Geste, fremde versteckte Tabs nicht.

**Die sichtbare Folge, und sie ist der Grund für die zwei Knöpfe:** mit ausgeschalteter Anpassung
hinterlässt ein geschlossener Tab ein Loch, das weder schrumpft noch nachrückt. Home ist, was man drückt,
wenn die Kachel *geleert* statt entfernt werden soll.

Reihenfolge: zurück, vor, neu laden/stopp, **Home**, Adressfeld, **Schließen ganz rechts**. Die ersten
vier spiegeln die Haupt-Toolbar, damit die Gewohnheit überträgt; Schließen sitzt so weit wie möglich von
ihnen entfernt, weil es die einzige Aktion in dieser Leiste ohne Rückweg ist. Beide Knöpfe übergeben
`{ tabId }` und tragen **kein** Kürzel im Tooltip, aus dem schon notierten Grund.

**Ein Zeichen musste neu gezeichnet werden.** Das nackte Kreuz war vergeben: es ist in derselben Leiste
das Stopp-Zeichen, und während des Ladens wären beide gleichzeitig sichtbar — zwei identische Kreuze
nebeneinander für „Laden abbrechen" und „Seite vernichten". Schließen ist deshalb ein Kreuz **im Ring**,
mit `r=6.5` auf der Fläche des Stopp-Kreuzes, damit die Zeile ihren Rhythmus behält.

### Handwerk

- **Stryker-Erlaubnisliste**: `tabgroups/strip.ts`, `tabgroups/schema.ts` und das neue
  `browser/navigation-policy.ts` eingetragen.
- **`catalog.ts` geteilt: 1219 → 94 Zeilen.** Nach Sprache (`catalog.en.ts` 665, `catalog.de.ts` 521),
  nicht nach Namensraum, weil ein Renderer immer nur eine Sprache zeichnet. Verlustfreiheit ist nicht
  „durchgesehen", sondern belegt: sha256 der ausgeschnittenen Literale gegen die Git-Fassung, plus ein
  Laufzeitvergleich aller 436 Schlüssel × 2 Sprachen durch `translate()`. Der Compiler-Schutz
  (`MessageKey = keyof typeof en`, `de … satisfies Catalog`) ist unverändert und wurde in beide
  Richtungen gegengeprobt. **Noch nicht eingelöst:** die Bündel sind dadurch nicht kleiner — `catalogs`
  nennt beide Module weiterhin eifrig. Das faule Nachladen der zweiten Sprache ist ein eigener Schritt.
- **`#wireWindowEvents` → `window-events.ts`.** Der `closed`-Handler bleibt im Controller, wie die
  Metrik es verlangt. **Die Naht ist nicht `WindowInternals`**, obwohl der Kommentar in `metrics.mjs` das
  vorschlägt: `createWindowSeams` baut `drag`, `fullscreen` und `tileInput` *aus* `internals`, ein
  `WindowInternals` mit diesen darin wäre zirkulär und von nichts zu konstruieren. Stattdessen eine enge
  lokale Schnittstelle, wie bei `TileInputHost`. Ertrag ehrlich: 1009 → 977 Zeilen, die Marke bleibt
  gerissen. Der Gewinn ist ein anderer — die neun Handler lagen in einer Datei, die von der Coverage
  **ausgenommen** ist, und sind jetzt zu 100 % gemessen, mit einer Untergrenze in `vitest.config.ts`,
  damit die Auslagerung nicht durch Vernachlässigung zurückgenommen werden kann.
- **`TileInputController`: von 0 % auf 100 %** in allen vier Maßen, 17 Tests. Sechs Nahtstellen, die
  vorher niemand prüfen konnte, darunter die, dass eine abziehende Maus **keinen Berechtigungsdialog**
  von der Schicht nimmt. Sechs Mutanten gegengeprobt.
- **`shortcuts:getBindings` entfernt** — Kanal, Vertrag, Handler, `shortcutBindingSchema`, `conflictFor`.
  **`KNOWN_CONFLICTS` bleibt**, und das ist die Falle, in die eine frühere Durchsicht gelaufen war: die
  Tabelle hängt nicht am Kanal, sondern an zwei echten Zusicherungen in zwei anderen Dateien — dass keine
  Standardbelegung auf einer geschluckten Taste sitzt, und dass jede vorgeschlagene Alternative selbst
  wohlgeformt ist. Sie zu löschen hätte beide lautlos entfernt. Die drei `shortcuts.conflict.*`-Schlüssel
  bleiben ebenfalls: `messageKey` ist als `MessageKey` typisiert und damit die Referenz, die sie am Leben
  hält.
- **Die beauftragte Fitness-Funktion ist anders gebaut worden, als sie bestellt war.** Bestellt war
  „keine Schaltfläche darf eine Aktion aus einer Liste toter Tasten nennen". **Diese Liste gibt es
  nicht** — `withoutMenuItem` ist in seinen eigenen Kommentaren als *keine* Totenliste beschrieben, alle
  zwölf Tasten sind verdrahtet, und die Regel wäre an `LayoutMenuSurface.tsx` falsch-positiv gefallen.
  Gebaut wurde die ehrliche Umkehrung: *keine Schaltfläche darf ein Kürzel für eine Aktion anzeigen, die
  nirgends registriert ist.* Entscheidend ist, dass die Menge der registrierten Aktionen **berechnet**
  wird — aus `accel('…')`-Literalen, aus `LAYOUT_SHORTCUTS` und aus der `PageKeyAction`-Union — und nicht
  als Ausnahmeliste gepflegt. Genau eine gepflegte Ausnahmeliste war hier schon einmal um acht Einträge
  zu großzügig und hat acht Aktionen ungeprüft gelassen. Ein nicht auflösbares Argument lässt den Test
  **fallen**, statt es zu überspringen. Vier Gegenproben, alle rot.
- **Eine Fitness-Funktion war leer geworden**: „kein Produktname in übersetzten Sätzen" las nur
  `catalog.ts` — nach der Teilung eine Datei ohne Sätze. Liest jetzt das ganze Verzeichnis.

### Was entfiel und was wartet

**Das Preload-Budget: der Rollen-Split war bereits gebaut.** Kein Auftrag, sondern eine Korrektur — siehe
den Kasten oben und „Preload-Budget".

**Vollbild und Kachelgröße: nicht angefangen.** Das Arbeitspaket nennt den betroffenen Player als
`<<HIER EINSETZEN>>` und wurde nie ausgefüllt. Ohne einen konkreten Player ist die Änderung genau das,
wovor der Abschnitt unten warnt: eine Heuristik, die in der Theorie funktioniert und im Wohnzimmer
flackert.

## Aus der Benutzung gemeldet (29.07.2026, dritter Durchgang)

Sieben Punkte, alle aus dem Betrieb der echten App. Vier davon waren Fehler, die kein Test sah, und
zwei davon lagen an einer Stelle, an der ein Kommentar recht hatte und der Code nicht.

### Zoom klappte nicht — zwei Ursachen, und nur eine ist behebbar

**Ursache A, behoben: „hinein" war nie belegt.** `zoomIn` hing an `Control+Plus` / `Command+Plus`,
und `Plus` ist die **umgeschaltete** Taste — die Akkorde waren also Strg+Umschalt+= und ⌘⇧=.
Herauszoomen funktionierte weiter, weil `-` unverschoben ist. Diese Asymmetrie ist genau das, wonach
der Fehlerbericht aussieht: Minus zoomt, Plus tut nichts. `=` ist jetzt zusätzlich gebunden, auf
beiden Plattformen, wie Chrome und Firefox es tun. `Plus` bleibt an erster Stelle, weil `accel()`
die erste Belegung ans Menü gibt und das Menü zeigen soll, was auf der Taste steht.

**Ursache B, nicht behebbar wie gebaut: der Trackpad-Pinch erreicht uns nie.** Electrons eigene
Typdatei sagt zu `zoom-changed`: *„Emitted when the user is requesting to change the zoom level
**using the mouse wheel**."* Die ganze Geste hängt an diesem Ereignis, und Chromium behandelt einen
Pinch als eigene Seitenskalierung, die diesen Weg nicht nimmt. Die Geste war ausdrücklich für
Laptops gewünscht („so wie z. B. back guesture per tile") und stand hier als gebaut — **belegt war
sie nie**, und dieses Dokument sagt an anderer Stelle selbst, dass sie nie in der App geprüft wurde.

Ein Hebel existiert und ist nicht gezogen: `Tab.ts` hört bereits auf `input-event`, und Electrons
`InputEvent.type` kennt `gesturePinchBegin/Update/End`. Aber die typisierte Nutzlast trägt nur `type`
und `modifiers`, **keinen Skalierungsfaktor** — die Richtung müsste aus einem Feld gelesen werden,
das die Typdatei nicht zusagt. Das ist eine Vermutung über eine fremde Laufzeitform, und sie ist von
hier aus nicht prüfbar. Offen, siehe „Offene Fragen".

### Escape stieg die Leiter von der falschen Seite herunter

Gemeldet: „wenn f11 gedrückt und ich mache ein video klein, schließt sich f11."

Ein Video kleiner zu machen **ist** ein Escape-Druck. Der erreicht über `before-input-event` den
Hauptprozess, `pageKeyAction` antwortet `escape-ladder`, und `SplitController.escape()` prüfte
`#windowFullscreen` **zuerst** — also verließ der erste Druck das Fenster-Vollbild. Ein Tastendruck,
zwei Wirkungen, und der Benutzer sieht nur die zweite.

**Der Kommentar hatte die ganze Zeit recht.** `TileFullscreenController.escape()` versprach in
seinem Docblock „from a page's fullscreen inside a tile, out of the tile's fullscreen, then out of a
maximised tile, then out of the window's own fullscreen" — also von innen nach außen. Die Reihenfolge
ist jetzt die versprochene.

**Und die Umstellung hatte eine Falle, die mitbehoben werden musste.** Vorher gab `escape()` in einem
Vollbildfenster immer `exit-window-fullscreen` zurück, `applyPolicy()` lief also nie auf einem
Fenster, das im Vollbild *bleibt*. Jetzt kommen die zwei inneren Sprossen **innerhalb** des Vollbilds
ab, und beide riefen `applyPolicy()` — was `setFullScreenable(false)` auf einem Vollbildfenster
gesetzt hätte, und `window-events.ts` schreibt selbst auf, was das bedeutet: der zweite Escape, der
das Vollbild verlassen soll, wäre Stille gewesen. Ein Fehler gegen einen schlimmeren getauscht.
`applyPolicy` steigt jetzt früh aus, solange das Fenster im Vollbild ist; `leave-full-screen` setzt
die Sperre ohnehin wieder.

**`escalation` und `escape()` laufen bewusst in entgegengesetzte Richtungen**, und beide sagen das
jetzt in ihrem eigenen Docblock: `escalation` beantwortet „wie viel Fenster hat der Inhalt bekommen"
(das Äußerste gewinnt, es steuert, ob die Chrome-Leisten weg sind), `escape()` beantwortet „was kommt
als Nächstes ab" (das Innerste). Sichtbare Folge, die wie ein Fehler aussieht und keiner ist: **ein
`escape()` muss `escalation` nicht ändern.**

**Nicht behoben, mit Absicht:** wer das Video über den *Knopf des Players* verkleinert, löst keinen
Tastendruck aus. Dafür gibt es einen plausiblen Weg durch Electrons eigene Buchhaltung, der C++ im
vorkompilierten Binary ist. Blind dagegen zu bauen hätte die Beweislage zerstört — jetzt, da der
Tastaturweg sauber ist, isoliert ein Fortbestehen des Symptoms genau diesen zweiten Weg.

### Cmd+W im Vollbild — ein Ersatzweg, der bewusst zu wenig schließt

Gemeldet als „strg+w"; vom Benutzer bestätigt als **⌘W auf macOS**, funktioniert normal, tot im
Vollbild. Auf unserer Seite wurde alles ausgeschlossen: eine Belegung pro Plattform, der Menüeintrag
wird unbedingt gebaut, `Menu.setApplicationMenu` ist prozessweit, und **nichts in diesem Projekt
versteckt, ersetzt oder leert das Menü im Vollbild** — kein `setMenuBarVisibility`, kein
`setAutoHideMenuBar`, kein `globalShortcut`. Bleibt Electrons Weiterreichen einer unbehandelten Taste
aus einer `WebContentsView` an die Menü-Tabelle, das von hier weder zu ändern noch zu prüfen ist.

Also ein zweiter Weg über `before-input-event`, **nur** bei `escalation === 'window-fullscreen'`,
ohne `preventDefault` (die Regel, dass die Seite die Taste immer behält, gilt weiter und wird von
einem Test gehalten). Der Doppelschluss ist unmöglich gemacht, und die gewählte Form ist eine
**Abbestellung**, keine Unterdrückung: der Tastendruck *scharfschaltet* ein Schließen, und jedes
Schließen aus jedem Weg bläst es ab. Eine Abbestellung kann nur eine Anfrage verwerfen, die der
andere Weg schon bedient hat; eine Unterdrückung nur eine, die niemand bedient hat.

**Der Preis steht im Code:** zwei Drücke unter 150 ms schließen im Vollbild einen Tab statt zweier.
Der Grund ist nicht die Tastenwiederholung — die filtert `keyMeaning` längst — sondern dass eine
Abbestellung nicht zuzuordnen ist: ein Menüklick und ein Tastenäquivalent sind derselbe Rückruf mit
denselben Argumenten. Bei zwei ausstehenden Schließungen müsste geraten werden, und das falsche Raten
schließt eine Seite, die gerade gelesen wird. Der Fehler liegt damit auf der erholbaren Seite.

### Kachelleiste: Maximieren — und die Regel zählte das Falsche

Der Knopf sendet `split:toggleTileMaximized` mit **`{ tileIndex }`**, nicht mit `{ tabId }` — das
erste Bedienelement dieser Leiste, das über die Position adressiert, weil der Kanal ein Rechteck
bewegt und eine Tab-Id kein Rechteck benennt. Kein neuer Kanal, keine neue Berechtigung, kein neuer
i18n-Schlüssel (`split.maximize` gab es schon). Zeichen sind vier Eckwinkel — die Mitte bleibt leer,
und genau dort liegen die beiden Zeichen, mit denen es zu verwechseln wäre: das Stopp-Kreuz und das
Schließen-Kreuz im Ring.

**Dabei fiel eine Behauptung, die ich selbst aufgestellt hatte.** Ich hatte vorgegeben, die
Kachelleiste könne über einer maximierten Kachel nie erscheinen. Das war falsch, und der Agent hat es
geprüft statt geglaubt: `tileBarStep` versteckte bei `rects.length <= 1`, aber `tileRects` behält
**einen Eintrag je Kachel des Layouts** und setzt nur die eingeklappten auf `null` — eine maximierte
Kachel in einem `1x2` zählte also als zwei. Die Leiste erschien über einer maximierten Kachel und
verdoppelte damit genau die Toolbar, für die sie einspringt; nebenbei geriet der neue Knopf in den
einen Zustand, in dem er *wiederherstellt*, während sein Tooltip „Kachel maximieren" sagt. Die Regel
zählt jetzt die Rechtecke, die es gibt. Der Zustand ist damit weg statt beschriftet.

### Einstellungen: eine Seite statt eines Panels, und Text aus dem Hauptprozess

Der Toolbar-Knopf und `Strg+,` öffneten ein Panel im Chrome-Renderer; nur `Extras ▸ Einstellungen im
Tab` öffnete die Seite. **Dieses Dokument nannte das Panel ein „Overlay", was in der eigenen
Vokabular dieses Projekts falsch ist** — `settings` steht nicht in `OVERLAY_KINDS`, die Schicht
zeichnet es nicht, es lag nie im Overlay-Bündel. Es *sah* so aus, weil `window:setOverlay` die
Inhaltsansichten aussetzt.

Jetzt öffnen alle Wege den Tab, das Panel ist gelöscht, und der doppelte Menüeintrag ist weg.

**Und der größere Teil von „richtige Beschreibungen" war nicht die fehlende Beschreibung, sondern die
fehlende Übersetzung.** Die Beschriftungen wurden aus dem Schlüsselnamen erzeugt (`humanise`), ein
deutscher Benutzer las „Block third party cookies" — eine lebende Verletzung von Spezifikation 7 über
alle 76 Einstellungen, dazu rohe Enum-Werte wie `disable_non_proxied_udp` in jeder Auswahlliste.

**Der Text kommt aus dem Hauptprozess, nicht aus dem Sprachkatalog**, und das ist eine
Budget-Entscheidung mit einem zweiten, besseren Grund. Der Katalog-Chunk stand bei **45 810 von
46 000 Bytes**, von einer Fitness-Funktion erzwungen — 152 Beschreibungen hätten ihn auf ~66 kB
gebracht. Wichtiger: der Katalog wird von *jeder* internen Seite vor dem ersten Zeichnen geholt, also
hätten Startseite, Verlauf, Downloads und Tresor Prosa bezahlt, die nur die Einstellungen zeigen.
Jetzt liegen die Tabellen in `src/main/settings/`, reisen über `settings:describe` mit und kosten den
Renderer **null Bytes**. 76 Beschriftungen, 58 Beschreibungen, 23 Auswahltabellen.

Die Regel für eine Beschreibung: wenn die Beschriftung nicht sagen kann, was sich ändert; wenn es
Kosten oder eine Reichweite gibt, die der Name verschweigt; wenn etwas an Dritte geht; **wenn die
Einstellung erklärt und noch nicht eingelöst ist**; oder wenn zwei Einstellungen dasselbe tun. Der
vierte und fünfte Fall sind der Grund für die hohe Zahl — und der fünfte hat unterwegs zwei echte
Doppelungen gefunden (`splitView.onlyActiveTileAudible` / `muteAllButActive` sind ein `if (a || b)`,
und `session.restoreOnStart` dupliziert `startupBehaviour: 'restore'`, was der Kern in seinem eigenen
Docblock als Defekt führt). Beide sagen es jetzt.

Zwei Katalog-Schlüssel wurden dadurch zu Waisen und sind entfernt: `menu.tools.settingsTab` und
`settings.close`.

### „Scan now" in den Einstellungen — und die Fitness-Funktion, die genau danach benannt war

Der Wunsch war durch einen Test gesperrt, und der Test nannte ihn wörtlich.
`tests/architecture.test.ts` verbot **jeden** `updates:*`-Kanal, mit dieser Begründung: *„the pressure
to add one is real and reasonable-sounding — a settings page wanting a 'check now' button — and the
cost is that any page in any tab can then make the browser talk to GitHub on demand."*

**Der Test wurde nicht gelöscht, sondern verengt**, weil sich seit seiner Entstehung zwei Dinge
geändert haben und eines nicht. Geändert: Kanäle werden heute **pro interner Seite** vergeben, nicht
an „jede Seite", und `decideAccess` weist Webinhalte vorab ab. Und die Navigationssperre aus dem
zweiten Durchgang verhindert, dass eine Webseite `tessera://settings` überhaupt öffnet, um sich deren
Rechte zu borgen — das war der Weg, über den „any page in any tab" wahr gewesen wäre. Nicht geändert:
die Sorge selbst. Ein Kanal, den mehr als die Settings-Seite erreicht, wäre weiterhin falsch.

Die neue Zusicherung lautet: **keine interne Seite außer `settings` erreicht die Update-Prüfung.** Sie
hat zwei Arme, weil jeder allein zu umgehen wäre — der eine liest den Kanalnamen aus dem *Rumpf* der
Handler-Registrierung heraus (wer den Kanal umbenennt, lässt den Test fallen statt ihn zu leeren), der
andere fegt den ganzen `updates:`-Namensraum, damit ein zweiter Kanal die Regel erbt. Gegengeprobt:
die Erlaubnis zusätzlich an `start` vergeben macht den Test rot.

Der Knopf steht über der Abschnittsliste, nicht als Zeile darin — eine **Aktion** ist keine
Einstellung, und als Deskriptor hätte sie einen Zurücksetzen-Knopf bekommen, der nichts zurücksetzt.
Kein neuer i18n-Schlüssel: `updates.checkNow` gab es schon. Während der Prüfung ist der Knopf
deaktiviert; das Ergebnis meldet der native Dialog, den `checkOnDemand()` ohnehin zeigt — ein zweiter
Text auf der Seite hätte dasselbe zweimal gesagt, und einen „prüfe …"-Schlüssel gibt es nicht und darf
es im Budget auch nicht geben.

**Die Unehrlichkeit, die der Knopf sichtbarer macht, ist nur halb behoben.** `updates.channel`
steht auf `alpha`, und GitHubs „latest release" schließt Vorabversionen aus — wer auf `stable`
stellt, bekommt für immer „keine neue Version". Ein Knopf weit oben wird viel öfter gedrückt als ein
Eintrag im Hilfe-Menü, macht die falsche Antwort also häufiger. Halb behoben: steht der Kanal auf
`stable`, zeigt der Block neben dem Knopf die **Beschreibung der Einstellung selbst** — der Satz ist
schon vorhanden, in beiden Sprachen, und erscheint nur in dem Fall, in dem die Antwort falsch ist.
Nicht behoben: der Dialog sagt weiterhin „Keine neue Version", und das ist gelogen. Der saubere Fix
braucht eine neue Meldung — rund 240 Bytes gegen ~190 Bytes Katalog-Spielraum, passt also erst nach
dem faulen Laden des Katalogs. Alternative ohne neuen Schlüssel: `stable` gar nicht erst anbieten,
solange keine Nicht-Vorabversion existiert. Steht unter „Offene Fragen".

Drei Kommentare waren dadurch falsch geworden und sind nachgezogen: der Abschnitt „Why nothing can
make a page trigger this" in `UpdateService.ts`, der Satz „There is no IPC channel for it either" am
Menüeintrag, und die Rückgabebegründung in `install-updates.ts`.

### Update-Prüfung beim Start: 5 Minuten → 3 Sekunden

Die Hälfte der alten Begründung ist überstimmt, die andere gilt weiter, und der Unterschied ist,
warum es nicht null ist. Überstimmt: dass ein kurz geöffneter Browser gar nicht prüfen soll — auf
einem Alpha-Build ist ein Neustart genau der Moment, in dem sein Besitzer es wissen will. Weiter
wahr: der Start ist der belebteste Moment, und eine Netzanfrage im Wettlauf mit dem ersten Zeichnen
kostet etwas Sichtbares. **Null ist außerdem kein möglicher Wert** — `start()` liest `first > 0` als
„plane nichts", das ist die Hintertür, auf der jeder Test in dieser Datei beruht.

**Der bestehende Test konnte das nicht halten.** Er prüft gegen die importierte Konstante, bleibt
also für jeden Wert grün, auch für die fünf Minuten. Ein Test, der nicht fallen kann, macht keine
Entscheidung dauerhaft — die Zahl tut es. Neu ist eine Zusicherung auf beide Grenzen, gegengeprobt.

### Vollbild und Kachelgröße — was auf unserer Seite geht und was nicht

Gemeldet: ein Player, der im Vollbild steht, passt sich nicht an, wenn die Kachel ihre Größe ändert. Gefragt:
„kann man das auch auf unserer seite machen?" **Teilweise, und die Grenze ist wichtiger als die Antwort.**

Was heute passiert: `relayout()` ruft `tab.setBounds(rect)`, das Ansichtsfenster der Seite ändert sich,
Chromium feuert `resize`, und die UA-Regel für `:fullscreen` füllt das Element. **Ein Player, der über CSS
skaliert, folgt also schon.** Wer nicht folgt, hat seine Maße einmal in Pixeln gerechnet — `canvas.width`,
eine gemessene Videobox — und rechnet sie nur in seinem `fullscreenchange`-Handler neu. Und genau das Ereignis
feuert bei einer reinen Größenänderung nicht.

Daraus folgt beides:

- **Was nicht geht:** eine Seite dazu bringen, einen Wert neu zu lesen, den sie gecacht hat. Ein synthetisches
  `resize` hilft nicht — das echte ist schon geflogen und wurde ignoriert.
- **Was geht:** den Vollbildübergang **erneut auslösen**, damit der `fullscreenchange`-Handler des Players
  läuft. Die halbe Mechanik liegt schon da: `askPageToExitFullscreen` ruft
  `executeJavaScript('document.exitFullscreen?.()', true)`, und das `true` ist `userGesture` — genau das, was
  ein erneutes `requestFullscreen` braucht.

Drei Dinge, die dabei nicht Kosmetik sind:

1. **Muss entprellt werden.** Beim Ziehen einer Trennlinie feuert `setBounds` pro Frame. Ein Aus-und-wieder-Ein
   pro Frame wäre ein Stroboskop. Der Auslöser ist das *Ende* der Größenänderung, nicht die Änderung.
2. **Es ist sichtbar.** Kurzes Schwarz, und viele Player zeigen ihre Bedienelemente beim Eintritt wieder. Für
   manche Leute ist ein einmal falsch skalierter Player besser als ein Flackern bei jedem Ziehen — das ist der
   Grund, das Verhalten überhaupt zur Frage zu machen und nicht still einzubauen.
3. **Es ist eine Heuristik, kein Fix.** Ob es beim gemeldeten Player wirkt, ist nur an dem Player zu sehen.
   Ein Element, dessen Referenz der Player nicht mehr hält, nimmt ein `requestFullscreen` nicht an; dann bleibt
   es beim Aussteigen, was schlechter ist als nichts zu tun.

Deshalb: **welcher Player?** Ohne einen konkreten Fall ist das eine Änderung, die in der Theorie funktioniert
und im Wohnzimmer flackert.

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

Bewusst *nicht* mitgewachsen, während der Hauptprozess auf 320 kB gehoben wurde. Der Hauptprozess wird
einmal pro Start geparst, der Preload einmal pro Seite in jedem Tab — ein Kilobyte dort kostet das
Hundertfache. Die Entscheidung steht.

**Zweimal stand hier die falsche Antwort, und die zweite ist die lehrreichere.**

Zuerst: die *Oberflächen*-Hälften von Element-Picker und Autofill bei Bedarf nachladen. Das ist gemessen
zu wenig (2–2,5 kB) und hat unter `sandbox: true` plus `inlineDynamicImports` überhaupt keinen
Mechanismus.

Dann: der **Rollen-Split** — „das ist die nächste Aufgabe an dieser Stelle". **Der war zu diesem Zeitpunkt
längst gebaut**, und zwar vollständig: zwei eigenständige Rollup-Durchläufe in `electron.vite.config.ts`,
`PreloadRole` und `preloadFile(role)` in `paths.ts`, alle drei Aufrufstellen mit literaler Rolle, ein
zweites Budget in `metrics.mjs` (Chrome-Preload 3 kB gegen 5) und `tests/preload-roles.test.ts` mit 148
Zeilen darüber. Laut `git log` seit dem Init-Commit.

**Warum die gemessene Zahl trotzdem nicht eintrat.** Die Messung sprach von einem „reinen
Chrome-/**Intern**-Einstieg" mit 3 882 B. Genau das ging nicht, und der Grund steht in
`src/preload/index.ts:62-69`: **eine interne Seite *ist* ein Tab**, und der Preload einer Ansicht steht
bei ihrer Erzeugung fest. Die Brücke für interne Seiten musste also im Inhalts-Bündel bleiben. Der
Chrome-Einstieg kam dadurch leichter heraus als veranschlagt (3 188 B), der Inhalts-Einstieg schwerer
(26 422 B statt 22 908 B).

**Damit ist der hier beschriebene Weg erschöpft, nicht offen.** Es gibt keine weitere Aufteilung, die
diese 3,9 kB zurückholt. Ein dritter, rein interner Preload würde bedeuten, die `WebContentsView` beim
Navigieren nach `tessera://` neu zu erzeugen — was Verlauf und Zustand des Tabs kostet. Was tatsächlich
noch Gewicht hergibt, ist der ausführbare DOM-Aufbau in Autofill, Picker und Fingerprint-Maskierung
selbst; das ist Arbeit an diesen Features, keine Bündelarchitektur mehr. **Wer diesen Absatz als Auftrag
liest, baut etwas zum zweiten Mal.**

Nebenbei korrigiert: die 28 714 B weiter unten sind vorsplit und tot, und der Satz, der Preload sei „von
29 auf 26 kB gefallen, ohne dass jemand daran gearbeitet hätte", liest die Ursache falsch — es waren der
Rollen-Split und der `manualPureFunctions: ['Set']`-Gewinn (`channels.ts` 3 804 → 1 564 B).

## Gemeldet, noch offen

Vier Punkte aus der Benutzung, wörtlich festgehalten, weil drei davon Verhaltensänderungen sind und einer ein
Fehlerbericht. **Drei sind erledigt, einer zur Hälfte** — die Zeilen bleiben stehen, weil die Begründung im
Code auf sie verweist.

| Punkt | Was zu tun ist |
|---|---|
| ~~**Kachelleiste nur im Kachelmodus**~~ **erledigt** | `tileBarStep` gibt bei `rects.length <= 1` jetzt `hide` zurück. Die Entscheidung liegt dort und nicht in der Oberfläche, weil ein Renderer, der eine vom Kern gebaute und eingemessene Darstellung nicht zeichnet, die Schicht mit einer unsichtbaren Fläche zurücklässt, die Zeigerereignisse schluckt |
| ~~**Leiste früher ausfahren**~~ **erledigt** | `TILE_BAR_REVEAL_WITHIN` von 6 auf **16 px**. Die Invariante ist im Kommentar festgehalten: strikt unter `TILE_BAR_HEIGHT`, das strikt unter `TILE_BAR_POINTER_AWAY` liegt — treffen sich die beiden Schwellen, beantworten Ausfahren und Einfahren dieselbe Position auf aufeinanderfolgenden Messungen verschieden, und genau das Flackern soll das Paar verhindern. Ein Test heftet die Reihenfolge fest |
| ~~**Neuer Tab soll ein neuer Tab sein**~~ **erledigt, beide Hälften** | Widersprach dem damaligen Verhalten: `TileOccupancyController` füllte leere Kacheln absichtlich, weil drei Kacheln mit „zieh einen Tab hierher" eine Anweisung statt eines Browsers waren. Umgekehrt wie gewünscht — `claimTileForNewTab` legt die Kacheln weg und gibt die eine zurück, die bleibt. Die zweite Hälfte ist die Zeile darunter: ohne Aufnahme der Anordnung wäre die Umkehr ein Verlust gewesen |
| **…aber die Anordnung darf dabei nicht verloren gehen** | Nachtrag des Benutzers: „er soll die layout gruppe der anderen tabs nicht auflösen, daher brauchen wir ja die tab gruppen." Die weggelegten Kacheln blieben geladen und im Streifen, aber *welches Layout* und *welche Kachel je Tab* war weg — es gab keinen Weg zurück. Die Anordnung gehört damit auf die **Tab-Gruppe**: beim Wegräumen aufnehmen (bestehende Gruppe wiederverwenden, sonst eine anlegen), beim Zurückkehren auf einen Gruppen-Tab wiederherstellen. Ohne die zweite Hälfte ist es eine Erinnerung, die niemand lesen kann. **Gebaut und in der echten App belegt** — `TabGroup.layout` trägt Layout-Id und einen Eintrag je Kachel, `keepArrangement` nimmt beim Wegräumen auf, `takeArrangementFor` gibt beim Anklicken zurück — und *verbrauchte* die Aufnahme dabei, damit eine zweite Aktivierung nicht spätere Arbeit zurücknimmt. **Das gilt seit dem zweiten Durchgang des 29.07.2026 nicht mehr:** die Anordnung wird bei jedem Settle neu geschrieben, kann also nicht veralten, und wird deshalb nicht mehr verbraucht. Der Smoke-Test fährt die Schleife, die ein Benutzer fährt: zurück zur verdrängten Seite → Anordnung ist da; ein Tab **ohne** Aufnahme → weiterhin ganzes Fenster; zweite Verdrängung → Anordnung kommt wieder. **Der Träger ist am 10.08.2026 gewechselt (KD1, KD2):** das Bedürfnis war richtig und die Schleife bleibt, aber die Anordnung gehört *nicht* auf die Tab-Gruppe. Sie an die Gruppe zu binden hieß, die Automatik zur zweiten Schreiberin an einer Struktur zu machen, die dem Benutzer gehört — sie legte Gruppen an und änderte Mitgliedschaften, ohne dass er etwas getan hätte. Die Aufnahme liegt jetzt auf einem eigenen, unsichtbaren Träger (`src/shared/arrangements/`, `ArrangementController`, `arrangements.json`); `TabGroup.layout`, `keepArrangement` und `takeArrangementFor` gibt es nicht mehr |
| ~~**Ziehen auf die mittlere Kachel geht nicht**~~ **erledigt** | Der Verdacht traf zu und war zweiteilig. Geometrie: eine Lücke gehört *einer* Spalte, eine mittlere Spalte kann also nicht von beiden Seiten gleichzeitig beschnitten werden — beide Bänder der Mittelspalte waren Duplikate und nahmen zusammen 60 % der Fläche, sodass nur 40 % einen einfachen Ablegevorgang annahmen. Verhalten: `applyDrop` macht den Layoutwechsel jetzt mit `rehome: false`, weil das Nachrücken die neu entstandene Kachel mit dem erstbesten geladenen Tab füllte und die verdrängte Seite damit vom Schirm nahm. Geprüft über `LAYOUT_IDS` erschöpfend, plus benannte Tests für die Mittelkachel von `1x3` und beide von `1x4`. Und weil die Meldung aus der Benutzung kam, auch dort: `runEveryDragCheck` in `scripts/smoke.mjs` zieht in der echten App mit synthetischer Maus **jede** Zone **jedes** Layouts an, gezielt auf die Mitte ihrer eigenen Trefferfläche — und prüft zwei Dinge, von denen das zweite das interessante ist: dass die Seite dort landet, wo der Indikator es versprach, *und* dass keine bereits sichtbare Seite dabei verschwindet. Achtzehn der vierundzwanzig Teilungszonen fielen bei der zweiten Prüfung durch, beide Zonen der Mittelspalte darunter |

## Stand zum Wiederaufnehmen

Geschrieben am Ende eines Durchgangs, in dem sieben Agenten am Sitzungs- oder API-Limit abgebrochen sind. Die
Arbeit liegt jeweils auf der Platte; was fehlt, steht hier.

### Der Baum

`pnpm typecheck` **0** über vier Projekte, `pnpm lint` sauber, `pnpm test` **119 Dateien / 3358 grün** —
*Momentaufnahme jenes Durchgangs; der aktuelle Stand steht unter „Qualitätsstand".*
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
   Mehrkachel-Layout mit Kachel-Vollbild aktiv ist — und `setFullScreen` auf so einem Fenster ist kein
   Fehler, sondern Stille. Die Taste tat also genau in dem Modus nichts, für den dieser Browser existiert.

   **Korrektur einer falsch verstandenen Anforderung.** Die erste Fassung legte die Taste im Kachelmodus
   auf das Vollbild der *aktiven Kachel* — eine in sich stimmige Lesart von „der Vollbild-Bereich ist die
   Kachel", und nicht, was die Taste bedeutet. Gemeldet mit genau diesen Worten: „mit f11 meinte ich, dass
   der browser selbst fullscreen geht und nicht videos/inhalte."

   Jetzt nimmt F11 **immer das Fenster**, in jedem Layout, mit den Kacheln darin. Dafür muss die Sperre
   gehoben werden, und der Grund, warum das nicht einfach ein Aufruf ist: `fullScreenable` ist **ein**
   Fenster-Flag und kann einen Menschen an einer Taste nicht von einer Seite an einer API unterscheiden.
   Die Sperre existiert für die Seite — ein Video in einer Kachel darf die anderen drei nicht schwärzen —
   also wird sie für die Anfrage des Menschen gehoben und beim **Verlassen** des Vollbilds wieder gesetzt.
   Beim Betreten wiederherzustellen würde den Benutzer im Vollbild einsperren; das Verlassen ist der
   früheste sichere Zeitpunkt und braucht kein zweites Flag, um sich den Grund zu merken.

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
jede Auffrischung zu einer Neudarstellung macht. ~~**Lücke:** `TileInputController` hat keine eigene
Testdatei.~~ **Geschlossen** — `tests/tile-input-controller.test.ts`, 17 Fälle, 100 % in allen vier Maßen.

### Zoom als Geste, pro Kachel

Gewünscht für Laptops, „so wie z. B. back guesture per tile". Gebaut, mit einem Fund unterwegs:

**Die Kachel ist hier gratis richtig.** `zoom-changed` kommt am `webContents` an, der die Geste bekommen hat —
Chromium leitet Pinch und `Ctrl`-Rad an die Ansicht unter dem Zeiger, nicht an die fokussierte. Die
Navigationsgesten brauchen für dieselbe Frage eine ganze Funktion (`decideNavigationGesture`), weil ihre
Ereignisse ohne Position am Fenster ankommen.

**Zoom war absichtlich pro Domain, nicht pro Kachel** (Spezifikation 1: „dieselbe Seite zweimal geöffnet
muss in beiden Tabs gleich aussehen", `zoomRegistry`). **Das ist Geschichte** — am 29.07.2026 umgekehrt
und im selben Durchgang gebaut; siehe „Zoom pro View". Was von diesem Absatz gilt: die Geste trifft die
richtige Kachel weiterhin gratis, und das ist der Fund, der ihn wert war.

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

**Alle vier Einträge dieser Tabelle sind abgearbeitet** und stehen unter „In diesem Durchgang gebaut":
das Einklappen nimmt die Anordnung auf (erledigt, indem der Aufruf überflüssig wurde statt gebaut),
`#rehomeHiddenTabs` hängt am Schalter (an drei Stellen, nicht an einer), gemischte Herkunft nimmt die
bestehende Gruppe, und die zwei fehlenden Stryker-Einträge sind eingetragen.

Was an ihrer Stelle offen ist, ist neu und stand hier nie:

| Frage | Stand |
|---|---|
| **Zwei Kacheln auf demselben Host teilen den lebenden Zoomfaktor** | **Entschieden (24.09.2026): wir leben damit.** Chromiums Zoomkarte ist pro Ursprung und pro Sitzung; trennen ließe es sich nur über einen isolierten Zoom-Modus, den Electron nicht freigibt, oder eine Brücke in der besuchten Seite, die Spezifikation 6 verbietet. Seitenzoom gibt es nur über Strg/Cmd + und −, und nur dann tritt es auf |
| **Gruppen-Chips bei jeder Kachelung** | Folge der Entscheidung „eine Gruppe entsteht, sobald gekachelt ist". Erwartbar sind ein bis drei Chips pro Sitzung, nicht einer pro Teilung — `reuse` fängt die Wiederholung ab. Ob das im Streifen als Ordnung oder als Lärm ankommt, sieht man erst in der Benutzung |
| **`about` und `https-only` liefern 404** | **Erledigt (Roadmap U7, U8).** Beide Seiten haben ihre HTML-Datei und ihren Vite-Eintrag; der „Über“-Eintrag und die HTTPS-only-Zwischenseite öffnen |
| **Der Trackpad-Pinch zoomt nicht** | **Entschieden (24.09.2026): nicht gebaut.** Der Pinch vergrößert über den Zoom von macOS, und das reicht; der Seitenzoom bleibt bei Strg/Cmd + und −. Damit entfällt der Bau auf eine unzugesagte Nutzlast von `gesturePinchUpdate` |
| **Vollbild verlassen über den Knopf des Players** | **Behoben (`a9d9429`), Prüfung in der App offen.** Der Benutzer bestätigte: F11, ein Video ins Vollbild, über den Knopf des Players wieder heraus, und manchmal ging das F11 mit. Der Schutz, der das Fenster-Vollbild zurückholt, lief nur in eingeschränkten Layouts (Kacheln unter Kachel-Scope); eine einzelne Kachel und Fenster-Scope überließ er Electrons eigener Buchführung, ob das Fenster schon im Vollbild war — und die liegt manchmal falsch (Vermutung über C++ im Binary, nicht prüfbar von hier). `TileFullscreenController` führt jetzt eine eigene Buchführung beim Vollbild-Wunsch der Seite, in jedem Layout. Ein bewusstes Verlassen (Taste, Menü, letzte Sprosse der Escape-Leiter) wird markiert und nie mit Wiedereintritt beantwortet. Unter macOS kann das Fenster sichtbar kurz heraus- und wieder hineinanimieren |
| **`TileFullscreenController` hat einen unerreichbaren Zweig** | 85,7 % Zweige, weil `escape()` `fullscreenTile` liest, nachdem das Urteil es schon als nicht-null bewiesen hat. Deshalb *keine* Untergrenze eingetragen — eine Zahl unter 100 dort würde den Zweig ratifizieren statt ihn zu entfernen. Ihn zu entfernen hieße, `SplitController.escape()` die Kachel mit dem Urteil zurückgeben zu lassen |
| **`stable` bekommt eine falsche Antwort** | **Behoben (`825e919`), Prüfung in der App offen.** Die Antwort war sogar eine andere als hier notiert: GitHub beantwortet die JSON-Anfrage von `electron-updater` nach `/releases/latest` mit 406, weil es keine Nicht-Vorabversion gibt, und das galt als Netzfehler — der Dialog sagte „GitHub nicht erreichbar“. Jetzt ein eigenes Ergebnis `no-stable-release` (`check-failure.ts`, getestet): Dialog und Hinweis in den Einstellungen sagen, dass es noch keine stabile Version gibt und „Alpha“ die aktuellen bekommt. Die Texte liegen im Hauptprozess, der Katalog wächst nicht |
| **Die Katalog-Teilung ist noch nicht bezahlt** | **Erledigt (`58e0b15`).** Je Sprache ein eigener Chunk (`catalog.en`, `catalog.de`), jede Oberfläche lädt nur die angezeigte; en 25,68 kB, de 28,56 kB bei 30 kB Budget je Chunk |

### Zwölf tote Tasten — erledigt, nachgezählt, und die Erlaubnisliste mit

**Korrektur einer früheren Zählung in diesem Dokument.** Die Erlaubnisliste `withoutMenuItem` in
`tests/architecture.test.ts` nennt vierzehn Aktionen als „absichtlich ohne Menüeintrag", und daraus war
geschlossen worden, alle vierzehn seien tot. Nachgeprüft, Aktion für Aktion, stimmt das für die meisten
**nicht**: `nextTab`, `previousTab`, `tileLeft/Right/Up/Down`, `toggleTileMaximized` und `focusTileBar` haben
sehr wohl Menüeinträge, und `splitLayout1`–`4` bekommen ihren über `accel(shortcut)` mit *variablem* Argument in
der `LAYOUT_IDS`-Schleife — weshalb eine Suche nach dem Literal `accel('splitLayout1')` sie übersah. Die
Ausnahmeliste ist also zu weit gefasst, nicht die Verdrahtung zu dünn.

**Auch das ist inzwischen nachgezogen:** `withoutMenuItem` nennt heute **sechs** Aktionen statt vierzehn — nur
noch `escape`, `stop` und `splitLayout1`–`4`, jede mit ihrer eigenen Begründung im Test statt einer gemeinsamen.
`lastTab` wurde bewusst *aus* der Liste geholt und in `appMenu.ts` als Literal `accel('lastTab')` aufgelöst,
damit der Scan es findet — anstatt es in dieselbe Schleife zu legen, die die acht Positionstasten registriert
und die für jeden Test unsichtbar bleibt. Eine Ausnahmeliste, die man erweitert, wenn ein Test unbequem wird,
ist genau der Weg, auf dem die vierzehn entstanden sind.

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
Einstellungsliste sichtbar". Sind sie nicht — `shortcuts:getBindings` hatte in `src/renderer/**` **keinen
einzigen Abnehmer**, die Einstellungsseite zeichnet überhaupt keine Kürzelliste. Damit war auch der Grund
für die Dringlichkeit ein anderer: nicht „angezeigt und tot", sondern **nirgends angezeigt und tot**.
**Der Kanal ist inzwischen entfernt** (Entscheidung des Benutzers, 29.07.2026). Die Tabelle
`KNOWN_CONFLICTS` blieb: sie hing nie am Kanal, sondern an zwei Zusicherungen in zwei anderen Dateien.

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

### Der Tresor, ursprüngliche Liste (erledigt außer 6 — nachgeprüft)

1. **Die Passworteingabe auf der Overlay-Schicht** — eine sechste Präsentationsart. Entschieden und nicht
   verhandelbar: das Master-Passwort verlässt den Hauptprozess nie, kein Kanal nimmt eines an, der Renderer
   erfährt nur `'unlocked' | 'wrong-password' | 'cancelled' | 'unreadable'`. Ein Test wacht darüber
   (`internal-page-wiring.test.ts`, „carries no channel whose payload could hold a master password").
   Die Art **wartet auf eine Antwort** wie `permission-request`: verlässt sie die Schicht ohne eine, muss das als
   abgebrochen auflösen und nicht hängen — genau dieser Fehler ist in diesem Projekt schon einmal passiert.
2. **`resetVault` legt die verschlüsselte Datei auf Wunsch beiseite**, bevor sie verworfen wird, mit der
   Erklärung im selben Atemzug, dass die Kopie ohne das Passwort unlesbar ist.
3. Kanäle und Vertrag für `requestUnlock`, `lock`, `beginSetMasterPassword`, `resetVault`, `import`.
4. **44 i18n-Schlüssel** in beiden Sprachen. ~~`passwords.protectionNotice` und
   `passwords.unencryptedNotice` sind jetzt Waisen und gehören weg.~~ **Entfernt** — im Katalog steht nur
   noch der Kommentar, der erklärt, was sie ersetzte.
5. ~~**`installAutofill()` wird nie aufgerufen**~~ **Verdrahtet.** `src/main/index.ts:394` baut den
   `AutofillService`, `:406` ruft `installAutofill(autofill)`, die Preload-Hälfte hängt an
   `src/preload/index.ts:254`. Und die Lücke ist jetzt bewacht: `tests/architecture.test.ts:580` ist
   namentlich „der Test, der `installAutofill()` gefangen hätte".
6. **Preload auf unter 22 kB** — weiterhin der einzige offene Punkt, aktuell **26 kB**. Aber der Weg,
   der hier zweimal stand, ist keiner mehr: das Nachladen hat keinen Mechanismus, und der Rollen-Split
   **war schon gebaut**. Siehe „Preload-Budget" für das, was übrig ist — Arbeit an Autofill, Picker und
   Maskierung selbst, nicht an der Bündelarchitektur.

### Danach — alles Offene an einer Stelle

Neu geschrieben nach dem zweiten Durchgang des 29.07.2026. Die drei Punkte, die hier als „blockiert etwas
anderes" standen, sind zu einem geschrumpft.

**Blockiert etwas anderes**

| Offen | Warum es zuerst kommt |
|---|---|
| **Erster Lauf des neuen Harness** | Unverändert der wichtigste offene Punkt, und er ist jetzt der einzige seiner Art: nichts aus diesem Durchgang ist in der echten App belegt. Der Umbau des Treibers selbst ebenso wenig. **Läuft nur der Benutzer** |
| ~~Navigationssperre zu `tessera://`~~ | **Gebaut**, samt der zweiten Lücke bei `history:open`/`bookmarks:open`, die hier nie stand |
| ~~Preload-Budget, Punkt 6 des Tresors~~ | Reißt weiter mit 26 kB, aber es ist **keine bekannte Aufgabe mehr** — der aufgeschriebene Weg war schon gegangen. Siehe „Preload-Budget" |

**Entscheidungen des Benutzers, alle vom 29.07.2026**

| Frage | Entscheidung | Stand |
|---|---|---|
| Der Name und das echte App-Symbol | Name: **Tessera** (`src/shared/product.ts`). Symbol zurückgestellt | Name ✅, Symbol Platzhalter |
| Apple Developer-ID | Zurückgestellt, keine vorhanden | unverändert |
| Soll eine Multi-View eine Tab-Gruppe sein? | **Ja**, und zwar **immer wenn gekachelt ist** | ✅ gebaut |
| Gemischte Herkunft beim Teilen | **Immer die bestehende Gruppe nehmen** | ✅ gebaut, mit der Ausnahme für zwei Gruppen |
| Zoom: pro Domain oder pro Kachel? | **Pro View**, überlebt Navigation und Neustart | ✅ gebaut |
| Eingeklappte Gruppe nimmt keine Anordnung auf | **Ja, aufnehmen** | ✅ erledigt, indem der Aufruf überflüssig wurde |
| `#rehomeHiddenTabs` am Schalter | **Der Schalter steuert beides. Aus heißt aus** | ✅ gebaut, an drei Stellen |
| `shortcuts:getBindings` | **Kanal entfernen** | ✅ entfernt, `KNOWN_CONFLICTS` bleibt |
| Netz-Sync des Tresors | Ja, aber erst nach dem lokalen Tresor | unverändert offen |

**Braucht eine Angabe von dir**

| Offen | Was fehlt |
|---|---|
| **Vollbild und Kachelgröße** | Der betroffene Player. Das Arbeitspaket ließ die Stelle leer. Ohne einen konkreten Fall ist es eine Heuristik mit sichtbarem Flackern als Preis — siehe den Abschnitt dazu |

**Features, die nie gebaut wurden**

| Offen | Anmerkung |
|---|---|
| **Der native Inhaltsblocker als Ganzes** | Netzregeln, Kosmetikfilter und die eigenen Element-Regeln laufen. Was fehlt, ist das *Dashboard* — die Stelle, an der uBO Listen, Ausnahmen und Zähler zeigt |
| **Video-Download als Feature** | Medien-Erkennung und `MediaDownloader` sind da. Ob das die Absage der Download-Erweiterung einlöst, ist nie gegen die ursprüngliche Erwartung geprüft worden |

**Handwerk, ohne Entscheidungsbedarf**

- **Budgetabbau geht weiter.** Größte Datei ist jetzt `contract.ts` (1036) — und für sie ist, anders als
  für ihre Vorgängerin, **kein nächster Schritt aufgeschrieben**. Danach `BrowserWindowController.ts`
  (1034, weiter zu zerlegen), `tabgroups/model.ts` (954, in diesem Durchgang gewachsen),
  `main/index.ts` (953), `PasswordsPage.tsx` (788).
- **Ungetestete Renderer-Zeilen: 3900 gegen 2800**, unverändert — der einzige der sechs Budgets, an dem
  dieser Durchgang nichts geändert hat.
- **Mutationslauf steht weiter aus** und ist jetzt älter als Tresor, Element-Regeln, Update-Module *und*
  diesen Durchgang. Die Liste hat drei neue Einträge bekommen.
- **Die Katalog-Teilung faul machen** — siehe „Offene Fragen".
- **TypeScript 7** — gemessen null Typfehler, absichtlich verschoben; Blocker ist
  `@typescript-eslint/parser` (`<6.1.0`).
- **`scripts/smoke-checks.mjs` braucht drei kleine Korrekturen** durch die Gruppen-Änderung, siehe
  „Was beim ersten echten Lauf zu prüfen ist".

### Erledigt, hier aber weiter als offen geführt

Nachgeprüft in dieser Runde, Datei für Datei. Jeder Eintrag stand als Schuld in diesem Dokument und war
bezahlt:

| Stand hier | Wirklichkeit |
|---|---|
| „`coverage/` steht nicht in `.gitignore`" | Steht drin, `.gitignore:5-7`, mit Begründung im Kommentar |
| „`installAutofill()` wird nie aufgerufen" | `src/main/index.ts:406`; ein Test trägt die Lücke namentlich |
| „Zwei i18n-Waisen gehören weg" | Entfernt; nur der erklärende Kommentar blieb |
| „`TabGroupStore.ts` fehlt bei Stryker" | Eingetragen, `stryker.config.json:112` |
| „`docs/QA.md` braucht eine Zeile" | Sie steht da, `docs/QA.md:192` — mit beiden Ursachen, nicht nur der einen |
| „Zwölf tote Tasten" | Alle verdrahtet, und die Erlaubnisliste `withoutMenuItem` ist von vierzehn auf **sechs** geschrumpft: nur noch `escape`, `stop` und `splitLayout1`–`4`, jede mit ihrem Grund im Test |
| „Der Rollen-Split ist die nächste Aufgabe am Preload" | **Gebaut, seit dem Init-Commit** — zwei Rollup-Durchläufe, `preloadFile(role)`, ein zweites Budget in `metrics.mjs`, `tests/preload-roles.test.ts` mit 148 Zeilen. Der Eintrag hätte Doppelarbeit ausgelöst |
| „`zoomRegistry` ist eine Einstellung und gehört in die Sitzung" | Es war eine `Map` im Speicher, die **nie in eine Datei geschrieben wurde**. Nichts zu verschieben, keine Migration |
| „`#rehomeHiddenTabs` hängt an einer Stelle nicht am Schalter" | Es waren **drei** Stellen. `afterTabClosed` stand in keiner Fassung dieses Dokuments |
| „Die Lücke ist Navigation von Webinhalten" | Das war die halbe Lücke. `history:open` und `bookmarks:open` nahmen jede URL — eine Rechteausweitung ganz ohne Webinhalt |
| „Tab-Gruppen überleben keinen Neustart" | Die Sitzungswiederherstellung rekonziliert sie: `retainTabs` einmal mit der Vereinigung aller Fenster, nach dem Öffnen |

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

**Zuerst: drei Prüfungen im Harness stimmen nicht mehr, und das ist keine Regression.** Die
Gruppen-Änderung lässt jede Kachelung eine Gruppe erzeugen, und `runTabGroupChecks` läuft, nachdem sechs
frühere Abschnitte Splits hinterlassen haben. Drei Zusicherungen zählen global statt auf ihre eigene
Gruppe: `bandedTabs` (erwartet 2), `after.chips` und `after.banded` (erwarten 0 nach dem Auflösen von
„Work"). Sie müssen auf die Gruppe eingeschränkt werden, um die es geht — oder alle Gruppen zu Beginn des
Abschnitts aufgelöst werden. Nachgerechnet, nicht gelaufen. `runLayoutAdaptationChecks` besteht dagegen
unverändert; nur der Kommentar dort ist jetzt falsch — die zweite Rückkehr gelingt nicht mehr, *weil auch
sie aufgezeichnet wurde*, sondern weil die Aufnahme nie verbraucht wird.


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

## Releases und Updates

Gewünscht: „wenn ich nun pushe, soll der browser merken, da ist ein update", plus ein lokaler Befehl für
Alpha-Freigaben. Entschieden vom Benutzer: **GitHub dauerhaft** als Quelle, **automatisch prüfen aber nichts
ohne Genehmigung herunterladen**, und **keine Apple-Developer-ID** vorhanden.

### Der Fund, der das Ganze getragen hat

`electron-updater` war **schon eine Laufzeitabhängigkeit und wurde von nichts importiert.** Dieselbe Klasse
wie `installAutofill()`: bezahlt, nie verdrahtet. Die Mechanik für „Update ohne Neuinstallation" lag also
bereits im Baum.

### Warum SSH dafür nicht genügt, und was stattdessen geht

SSH authentifiziert den Git-Transport. Eine GitHub-Freigabe anzulegen ist die REST-API über HTTPS, die keine
SSH-Schlüssel annimmt — dafür gibt es keinen SSH-Weg. Ein *Tag* zu pushen braucht dagegen nur den Schlüssel,
der schon da ist, und `.github/workflows/release.yml` veröffentlicht von der anderen Seite mit
`secrets.GITHUB_TOKEN`, den GitHub für diesen einen Lauf prägt und danach verwirft. **Kein Token auf einer
Maschine.**

Der zweite Grund ist gewichtiger als die Bequemlichkeit: **ein lokales Release ist bauartbedingt
unvollständig.** `electron-builder` packt nur für die Plattform, auf der es läuft — ein auf dem Mac
geschnittenes Release trägt `latest-mac.yml` und sonst nichts, Windows- und Linux-Nutzer sehen also **nie** ein
Update, weil die Datei, die ihr Updater liest, nie hochgeladen wurde. Kein fehlender Komfort, sondern ein
Release, das für zwei Drittel der beworbenen Plattformen still nicht funktioniert.

Ablauf: `pnpm run release:alpha` hebt nur die Version (`0.1.0 → 0.1.1-alpha.0`) und **druckt** die
Git-Befehle — committen und taggen bleibt beim Benutzer. `release:alpha:local` ist der Token-Weg für ein
schnelles Einzelartefakt; er liest den Token aus dem macOS-Schlüsselbund, weil ein Token im Shell-Profil eine
Klartextdatei und einer auf der Kommandozeile ein Eintrag in `~/.zsh_history` ist.

### Was angehängt wird, und was daran wichtig ist

| Runner | Artefakte |
|---|---|
| macOS | `.dmg`, **`.zip`**, `latest-mac.yml` |
| Windows | `.exe` (NSIS), `latest.yml` |
| Linux | `.AppImage` (x64 und arm64), `latest-linux.yml` |

Die `.zip` ist kein Beifang: **Squirrel.Mac aktualisiert aus einem Zip, nicht aus einem Dmg.** Und die
`latest*.yml` sind der eigentliche Feed — Version, Dateinamen, SHA-512-Summen. Genau die fehlen bei von Hand
hochgeladenen Dateien, weshalb so ein Release vollständig aussieht und nichts aktualisiert.

`.deb` und `.rpm` sind **entfernt**, nicht vergessen: beide brauchen einen Paket-*Maintainer*, den
electron-builder aus `author.email` zieht — und es gibt keine Adresse, die dort richtig wäre. Die in git
zeigt auf einen Arbeitgeber, der als Urheber dieses Projekts ausdrücklich abgelehnt wurde, und ein
Platzhalter ist in einem ausgelieferten Paket schlimmer als ein fehlendes Paket: wer daran schreibt,
bekommt Schweigen statt einer Antwort. Der Build fiel genau darüber, nachdem AppImage x64 und arm64 schon
fertig waren. AppImage braucht keinen Maintainer, läuft ohne Installation auf jeder Distribution und ist
das Format, das `electron-updater` auf Linux am zuverlässigsten aktualisiert. Die Abhängigkeitslisten für
beide bleiben in `electron-builder.yml` stehen — inert ohne Ziel, aber sie waren die Recherche wert.
Und drei Runner veröffentlichen gleichzeitig in dasselbe Tag — `electron-builder` sucht die Freigabe zum Tag
und legt sie sonst an, was selten ein Wettlauf sein kann; sichtbar als doppelte oder fehlende Freigabe,
reparierbar durch einen erneuten Lauf. `fail-fast: false` ist Absicht: ein Release mit zwei von drei Feeds ist
reparierbar, ein abgebrochenes nicht nachvollziehbar.

### Die Versionsordnung als eigenes Modul

`src/main/updates/version.ts`, 27 Tests, weil jeder Fehler darin einen Nutzer trifft: `alpha.2` schlägt als
Text `alpha.10` — ein **Downgrade, als Update angeboten**. Eine Freigabe ist neuer als alle ihre
Vorabversionen, was das Gegenteil der alphabetischen Antwort ist; falsch gemacht bleibt ein Alpha-Tester für
immer auf einer Vorabversion. Dazu ein Property-Test über eine zehnstufige Leiter, weil ein handgeschriebener
Vergleich einzeln richtig und in Kombination inkonsistent sein kann.

### macOS bleibt vorerst unsigniert

`electron-builder.yml` verlangt `hardenedRuntime` und `notarize: true`, was ohne Developer-ID mitten im Build
scheitert. Beide Wege — Workflow und lokales Skript — erkennen die Abwesenheit **vorher**, sagen es und bauen
unsigniert weiter, mit der Folge im gleichen Satz: eine unsignierte Mac-App installiert sich von Hand und kann
sich **nicht selbst aktualisieren**. Zwei Override-Zeilen zu entfernen ist die ganze Änderung, sobald das
Zertifikat existiert.

**Seit 23.09.2026 gilt das für alle drei Plattformen.** Windows und Linux installierten Updates bis dahin
selbst, ohne Signaturprüfung: ohne `publisherName` prüft `electron-updater` kein Authenticode, und AppImage
hat keine Signatur. `IN_PLACE_UPDATES` hat jetzt eine Zeile je Plattform, alle aus, jede mit dem, was sie
einschalten würde; jedes unsignierte Build führt zur Release-Seite (U15, `46b0aa9`).

## Härtung nach dem Projekt-Review (23.09.2026)

Plan: `docs/plans/2026-09-23-002-fix-review-hardening-plan.md`, Branch `fix/review-hardening`. Behoben sind
die verifizierten Befunde des Projekt-Reviews vom selben Tag aus Main-Prozess, Build und CI; die
Renderer-UX-Befunde des Reviews sind bewusst nicht dabei. Alle 19 Einheiten sind gebaut; U18 in anderer Reihenfolge als geplant (Umformatierung vor den Merges).

✅ heißt in dieser Tabelle: gebaut, durch Tests und Architekturtests belegt. **In der laufenden App und im
gepackten Build ist nichts davon belegt**; was dort zu prüfen ist, steht darunter und liegt beim Benutzer.

| Einheit | Befund und was jetzt gilt | Stand | Commit |
|---|---|---|---|
| U1 | Es gab nur einen Tag-Workflow ohne Coverage, die Floors liefen nie. Jetzt `gates.yml` bei jedem Push und PR: Typecheck, Lint, Build, Formatprüfung, `test:coverage` mit Floors; `release.yml` ruft dieselben Gates. Rechte nur lesend außer beim Veröffentlichen, Actions per SHA gepinnt. Die Formatprüfung war bis U18 nicht blockierend; seit Roadmap U3 (`a57fde3`) ist sie es, und der Architekturtest erlaubt `continue-on-error` nirgends mehr. `pnpm quality` prüft die Floors wieder, weil die Formatprüfung jetzt zuletzt läuft | ✅ | `340110a`, `a3a852f` |
| U2 | `.stryker-tmp/` war versioniert. Nicht mehr; Agenten-Worktrees sind ignoriert | ✅ | `599e1b3` |
| U3 | Eine zweite Instanz lief trotz fehlendem Lock weiter in `main()` gegen die Stores der ersten. Jetzt endet sie sofort und übergibt ihre Adresse. Ein Link, der den Browser startet, wird gepuffert (argv unter Windows und Linux, `open-url` unter macOS), nach der Sitzungswiederherstellung geöffnet, nur `http(s)`, nie in einem privaten Fenster | ✅ | `98c207d` |
| U4 | Beim Schließen des letzten Fensters ging die letzte Tresor-Änderung verloren, ein zweites Beenden startete alles neu, ein hängender Schreibvorgang hielt den Prozess ewig. Jetzt ein Zustandsautomat mit 10 s für die Flushes und 30 s für das Löschen beim Beenden, Nachholen beim nächsten Start; Sperren und Zurücksetzen des Tresors warten auf ein laufendes Sperren. Siehe `docs/ARCHITECTURE.md`, „Herunterfahren" | ✅ | `fb70779`, `aa6766b`, `5db3824` |
| U5 | Acht Stellen schrieben Temp-then-rename ohne `fsync` und mit festem Temp-Namen. Jetzt ein Helfer, `atomic-write.ts`, mit eindeutigem Namen und `sync` auf Datei und Verzeichnis; Reste werden beim Öffnen und in jedem Löschpfad entfernt | ✅ | `17cb1ba` |
| U6 | Ein einziger schemafremder Eintrag ließ `JsonStore` auf Standardwerte fallen, und das nächste Speichern überschrieb die Datei; `version: 2` galt als kaputt. Jetzt die Ladepipeline mit vier Ausgängen: migriert hinter `.v<N>.bak`, neuer nur lesend, kaputt erst als `.unreadable` kopiert. Unbekannte Felder bleiben; Löschen nimmt die Kopien mit. Siehe `docs/ARCHITECTURE.md`, „Stores laden", und `docs/QA.md` 7.6–7.10 samt Wiederherstellung | ✅ | `832481a` |
| U7 | Passwörter und Lesezeichen parsen Eintrag für Eintrag: ein kaputter Eintrag kostet nur sich selbst, bleibt roh in der Datei, erscheint nie in Autofill oder Export; die Seiten nennen die Zahl | ✅ | `832481a` |
| U8 | Chrome-Fenster und Overlay-Schicht lehnen jede Navigation, jedes Popup und jede Webview ab, die Chrome-Renderer jeden Drop. Der Router glaubt einer Chrome-Identität nur aus ihrem Hauptframe an der geladenen Adresse | ✅ | `aa6766b` |
| U9 | Fuses aus: `runAsNode`, `NODE_OPTIONS`, Node-Inspector; an: Cookie-Verschlüsselung, Asar-Integrität, nur aus Asar laden. Ein gepacktes Build mit Remote-Debugging-Schalter endet, geprüft über `hasSwitch`, also jede Schreibweise, die Chromium annimmt. `ELECTRON_RENDERER_URL` gilt im gepackten Build nicht | ✅ | `aa6766b` |
| U10 | `configurePublicSuffixes` hatte keinen Aufrufer, also waren `bank.com.sg` und `evil.com.sg` eine Site, und Autofill bot das Passwort der einen auf der anderen an. Jetzt lädt der Kern die Public Suffix List zur Laufzeit, prüft sie vor dem Speichern und spielt sie nur beim Start ein. Siehe `docs/ARCHITECTURE.md`, „Public Suffix List", und `docs/QA.md` 6.1 und 6.10 | ✅ | `e91441b` |
| U11 | Jede Seite konnte per `<img>` auf `tessera://favicon` und `tessera://thumbnail` prüfen, welche Sites besucht wurden. Jetzt braucht der Abruf ein Token pro Start, ein falsches bekommt dieselbe leere Antwort wie ein Fehltreffer; Cache-Bilder in der Oberfläche sind nicht ziehbar | ✅ | `a3716f4` |
| U12 | Eine interne Seite fiel auf das fokussierte Fenster zurück, sodass die Einstellungsseite eines privaten Fensters die Regeln des normalen Profils schreiben konnte. Jetzt handelt sie für das Fenster ihres Tabs, ohne Treffer gar nicht | ✅ | `2d6c08f` |
| U13 | „Fragen" war ein stilles Nein (IMPROVEMENT-PLAN V1). Jetzt fragt der Arbiter bei Anfrage und Prüfung; gemerkt wird nur eine Antwort des Nutzers. Kamera, Mikrofon und Bildschirmfreigabe unverändert | ✅ | `51f4369` |
| U19 | Ein Hintergrund-Tab konnte seinen Dialog über die Seite im Vordergrund legen. Jetzt wartet die Anfrage, bis ihr Tab aktiv ist; Tab zu oder Origin gewechselt lehnt einmalig ab; die Knöpfe sind erst nach etwa 500 ms scharf | ✅ | `a519a98` |
| U14 | Unter Linux mit `basic_text` meldet `safeStorage` Verschlüsselung, siegelt aber mit einem festen Passwort, und das Profil galt als geschützt. Jetzt stuft der Kern den Schutz zur Laufzeit als schwach ein; ein neues Profil startet dort unverschlüsselt, ein bestehendes bleibt lesbar und sagt, dass es nicht wirklich geschützt ist. Ein Tresor-Schlüssel neuerer Version gilt als neuer, nicht als Anlass für einen Reset | ✅ | `46dfdfd` |
| U15 | Windows und Linux installierten unsignierte Updates selbst. Jetzt führen alle drei Plattformen zur Release-Seite, siehe „macOS bleibt vorerst unsigniert" | ✅ | `46b0aa9` |
| U16 | Ein Punkt am Hostende oder Benutzerangaben in der URL schoben den Host unter `\|\|domain^` weg. Jetzt wie uBlock Origin, dazu `@@…$document` und `@@…$important` | ✅ | `2e59ab1` |
| U17 | Der Router war von der Coverage ausgeschlossen und ohne eigenen Test. Jetzt eigene Tests über ein gefälschtes `electron`, Floors für `ipc/router.ts` und den Passwort-Code | ✅ | `d37930e`, `832481a` |
| U18 | Einmalige Prettier-Umformatierung samt `.git-blame-ignore-revs`; danach wird die Formatprüfung in `gates.yml` blockierend. Umformatiert wurde vor den Merges (`45d8111`, `b8b611e`); die offenen Branches kamen danach und wurden beim Mergen formatiert | ✅ | `45d8111`, `b8b611e`, `a57fde3` (Roadmap U3) |

Nebenbei: die Filter- und Pipeline-Dateien auf ihre alten Floors gebracht, die nie als Gate liefen (`77cbd8f`,
`5318bc1`); Duplikate der neuen Module zusammengelegt (`c01a94a`); ein Einstellungs-Test, der unter Last
zufällig fiel (`0d25d81`); vier Quelldateien mit rohem NUL-Byte, die git als binär ansah und ohne Diff zeigte
(`5f9f166`). Der Mutationsbericht in `reports/mutation/` ist auf diesem Branch nicht erneuert.

### Bewusst nicht geändert

- **Kamera, Mikrofon und Bildschirmfreigabe** verhalten sich in jeder Einstellung wie vorher; „Fragen" bleibt
  dort ein stilles Nein. Das ist die Haltung des Benutzers, keine Lücke, und sie steht über IMPROVEMENT-PLAN V1.
- **Alle Berechtigungen stehen ab Werk weiter auf „Verweigern".** Der Dialog erscheint nur, wenn jemand eine
  Berechtigung auf „Fragen" stellt.
- **`grantFileProtocolExtraPrivileges` bleibt an**, solange die Chrome-UI über `file://` lädt. Siehe
  „Bekannte Risiken".
- **„Beim Beenden löschen" und die Netzwerkspuren (U11).** Mit den Cookies gehen Auth- und Host-Cache und die
  Code-Caches. Das ungefilterte `session.clearData()` (Network Persistent State, TransportSecurity, Reporting/NEL)
  läuft nur, wenn auch Seitenspeicher und Cache gewählt sind — der Standard und der Rückfall einer unlesbaren
  Notiz —, weil es sonst Kategorien mitnähme, die niemand gewählt hat. Heruntergeladene Dateien bleiben, laufende
  Downloads bleiben in der Liste. „Formulardaten" ist aus der Auswahl verschwunden; ein gespeichertes `formData`
  wird beim Laden verworfen, die übrige Auswahl bleibt.
- Code-Signing, die Renderer-UX-Befunde und die übrigen Main-Prozess-Befunde des Reviews stehen im Plan unter
  „Deferred to Follow-Up Work".

### Was nur der Benutzer prüfen kann

Laufende App (`pnpm dev`) und gepackter Build. Kein Agent startet die App.

| Prüfung | Erwartung |
|---|---|
| Kaltstart über einen Link (Windows und Linux: Adresse in argv; macOS: `open-url`) | Der Link geht nicht verloren, öffnet nach der Sitzungswiederherstellung im zuletzt fokussierten normalen Fenster, nie in einem privaten |
| Zweite Instanz starten, mit und ohne Adresse (QA 4.7) | Sie öffnet keinen Store und kein Fenster; die Adresse landet in der laufenden |
| Windows: Passwort ändern, letztes Fenster per X schließen, neu starten (QA 7.11) | Die Änderung ist da, der Prozess endet ohne Hänger |
| `pnpm dev`: Chrome-UI per Vite neu laden | Der Navigations-Guard aus U8 lässt das Neuladen durch |
| Gepackter Build auf macOS, Windows und Linux | Startet, die Chrome-UI lädt (Asar-Integrität, Ad-hoc-Signatur auf Apple Silicon). `ELECTRON_RUN_AS_NODE=1` startet keinen Node-Prozess, `--inspect` öffnet keinen Debugger, `--remote-debugging-port` beendet den Start |
| Eine Berechtigung auf „Fragen", etwa Standort, mit mehreren Tabs | Der Dialog erscheint nur über dem fragenden Tab; ein Hintergrund-Tab wartet, bis er aktiv ist; Fenster schließen ohne Antwort merkt nichts. Kamera auf „Fragen" wird ohne Dialog verweigert |
| Benachrichtigungen auf „Fragen" | Die Seite fragt überhaupt an und bricht nicht schon an der Prüfung ab (Plan, Risiken) |
| Linux mit `--password-store=basic` | Einstellungen und Tresor nennen den Schutz schwach; ein neues Profil startet unverschlüsselt; ein bestehendes bleibt lesbar |
| Eine Testseite, die `tessera://favicon` und `tessera://thumbnail` per `<img>` abfragt | Treffer und Fehltreffer sehen gleich aus |
| Tab-Leiste und Startseite | Favicons und Vorschaubilder erscheinen weiter, die Oberfläche hängt das Token also richtig an |

## Roadmap Herbst 2026

Plan: `docs/plans/2026-09-24-0756-feat-roadmap-aufraeumen-versprechen-neues-plan.md`, Branch
`feat/roadmap-herbst-2026`. Stand dieses Abschnitts: 24.09.2026, nach `06b275a`.

✅ heißt auch hier: gebaut, durch Tests und Architekturtests belegt. **In der laufenden App ist nichts davon
belegt**; kein Agent startet die App. Was dort zu prüfen ist, steht in der Tabelle darunter.

| Einheit | Was gelandet ist | Stand | Commit |
|---|---|---|---|
| — | Der Plan | ✅ | `cf336b1` |
| U1 | Autofill U2 und U3 auf main: die Vorschlagsliste liegt auf der Overlay-Schicht. Autofill U4 bis U7 stehen aus (Roadmap U14) | ✅ | `96c6609` |
| U6 | Die Beschriftungen der nativen Menüs kommen aus Text im Kern, nicht mehr aus dem Katalog | ✅ | `cb634c7` |
| U2 | Tab-Gruppen gehören dem Benutzer; die Anordnung der Kacheln liegt auf einem eigenen Träger | ✅ | `e42c1aa` |
| U3 | Die Formatprüfung ist in `gates.yml` blockierend, `continue-on-error` gibt es nirgends mehr | ✅ | `a57fde3` |
| U4 | Die Lesezeichenseite nennt eine neuere, ungültige oder schreibgeschützte Datei. Mutationslauf: 82,26 % bei `46b435b`, zuletzt **82,89 %** bei `8a46262` (201 Dateien, 23 156 Mutanten, 10 646 getötet, 2 161 überlebt, 87 Zeitüberschreitungen; Schwelle 70) | ✅ | `795152b`, `54bc7d7`, dieser Stand |
| U10 | Eine Seite mit `beforeunload` fragt vor dem Schließen und Verlassen nach | ✅ | `3306bc6` |
| U9 | Eine Kachel zeigt, warum eine Seite nicht lud oder abstürzte | ✅ | `e4322be` |
| U11 | Dateninventar; „Beim Beenden löschen" nimmt Verlauf und Downloads mit und holt nach einem Absturz nach | ✅ | `fb991bc` |
| U5 | README, STATUS, TESTING und die Beschreibung von `appearance.theme` auf dem echten Stand | ✅ | dieser Stand |
| U7, U8 | About-Seite und HTTPS-only-Zwischenseite | ⬜ | in Arbeit |
| U14 | Autofill U4 bis U7: Badge im Feld statt Liste in der Seite, Füllen per Einmal-Beleg, Wächter über die echte Verdrahtung (`tests/autofill-wiring.test.ts`, `passwords.feature`), Schlüssel in der Toolbar, `Strg+Shift+K` mit Menüeintrag und Eintrag im Seiten-Kontextmenü. `decideOffer` und die Liste in der Seite aus `fe33648` sind entfernt | ✅ | dieser Stand |
| U15 | Tab-Entladen: ein Timer für die ganze App (einmal pro Minute) entlädt Tabs, die `advanced.unloadAfterMinutes` lang unbenutzt waren (Standard an, 30 Minuten). Die Regel ist pur (`shared/session/unload-policy.ts`, Floor 100 %): Kachel, Ton, laufende oder pausierte Medien, angeheftet, lädt, DevTools, Vollbild, wartende Frage (Picker, Berechtigung, Popup/Umleitung, Speicherleiste, Ausfüllanfrage), ungesendete Eingabe (neuer Preload-Kanal `tessera:unsaved-input`), interne Seite, Fehlerzustand und eine Seite, die zuletzt widersprach, halten den Tab. Entladen geht über den Schließ-Vertrag im Modus `discard` (nie ein Dialog, nie `finish`); der Verlauf liegt nur im Speicher (`TabDiscards`), nie in `TabState` oder der Sitzung. Beim Aktivieren oder Ziehen in eine Kachel: neue View an Index 0 mit derselben Verdrahtung, `navigationHistory.restore()` am alten Index, eingeklappte Gruppe klappt auf, `onViewReplaced` meldet die neue ID an die Berechtigungen. Der Tab-Streifen zeigt entladene Tabs gedimmt. `tab-view.ts`, `tab-contract.ts` und `permission-tabs.ts` gleichen das Wachstum von `Tab.ts` und `BrowserWindowController.ts` aus | ✅ | dieser Stand |
| U16 | Medien-MVP für gemuxte Quellen: `WindowRegistry` hängt `MediaSessions.observe(session)` an Pipeline (`onRequest`) und Härtung (`onResponse`), ohne dritten Listener. Schließen eines Tabs (über `#finishClose` und beim Fensterende) ruft `forgetTab`, ein privates Fenster gibt beim Schließen seine Medien-Sitzung frei; Löschen mit Cookies und Panic rufen `forgetAll` (vorher `release`, das den weiter gefütterten Dienst vom Zugriff abhängte). Medienknopf in der Werkzeugleiste mit Zahl der Funde des aktiven Tabs, Vollfenster-Panel (nachgeladen), das dem aktiven Tab folgt. `MediaDownloader` reserviert das Ziel über `resolveSavePath`/`downloadDirectoryOf` und legt `.part` exklusiv an (`wx`); zwei gleichnamige Downloads bekommen `clip.mp4` und `clip-2.mp4`, ein leeres `downloads.directory` schreibt nicht mehr ins Arbeitsverzeichnis. Der Download erscheint über `DownloadManager.track()` in der Download-Anzeige mit Fortschritt; Abbrechen dort oder im Panel entfernt `.part`. Neuer Wächter `shared/media/url-guard.ts` (Floor 100 %): nur http(s), kein Loopback, Link-Local, privater oder anderer nicht-öffentlicher Bereich (IPv4, IPv6, eingebettetes IPv4, `localhost`), für progressive Adressen, Varianten, Segmente, Init-Segmente, Manifest-Lesen und Weiterleitungsziele; neue Absage `address-not-allowed` | ✅ | dieser Stand |
| U19 | Site-Menü hinter dem Schloss: Das Schloss ist ein `<button>` (Name = Verbindungsstatus, `aria-haspopup="menu"`, in der Tab-Reihenfolge) und öffnet über den neuen Kanal `site:menu` (ersetzt `blocker:menu`) dasselbe native Menü wie der Schild (KTD13). Inhalt: Verbindungsstatus (`securityStateOf` aus `Tab.ts` nach `shared/site/model.ts` gezogen), das Blocker-Menü unverändert (Zähler, Picker, eigene Regeln, Schalter je Site und global), gespeicherte Berechtigungen der Origin je mit „Vergessen“ plus „Alle vergessen“, Zoom der Kachel (+, −, zurücksetzen über dieselben Aufrufe wie `zoom:step`/`zoom:reset`), Fingerprint-Schutz als Schalter mit Hinweis, dass offene Tabs den alten Plan behalten. Kamera, Mikrofon und Bildschirmfreigabe werden weder gezeigt noch von „Alle vergessen“ erfasst. Ein privates Fenster bekommt `PermissionStore.answersFor('private')` = `forgetfulSiteAnswers` (zeigt und vergisst nichts). `PermissionStore.forget(origin, topics?)` vergisst nur die genannten Themen. Vorlage `menu/site-menu-items.ts` und `shared/site/**` mit Floor 100 % und Stryker-Eintrag; der Handler liegt testbar in `ipc/site-handlers.ts`. Neue Texte nur im Kern (`menu-text.*`), kein Katalogschlüssel | ✅ | dieser Stand |
| U18 | Vorschläge in der Adressleiste: neue Overlay-Art `omnibox-suggestions` in jeder Tabelle von `surface.ts` (eigene Region `toolbar` mit Rechteck unter dem Feld, nicht in `TILE_BOUND_KINDS`; nimmt keinen Fokus, auch nicht bei Updates; Rang 0,25: über der Kachelleiste, unter Suchleiste, Picker-Leiste, `autofill-suggest`, Download-Panel und jeder Frage). Das Feld schickt je Tastendruck Text, Feldrechteck und laufende Nummer über `omnibox:suggest`; der Kern (`ipc/omnibox-handlers.ts`, Regeln pur in `shared/omnibox/suggest.ts`) liest nur die eingeschalteten Quellen — Verlauf (nie im privaten Fenster), Lesezeichen samt Quick Links, die eigenen offenen Tabs ohne den vorderen —, lässt die Stores vorfiltern (Verlauf höchstens 300 Treffer), rankt mit U17 und verwirft veraltete Nummern; ein Pfeil mit gleichem Text verschiebt nur die Markierung. Zeile 0 ist „`<Text>` öffnen“ bzw. „Mit `<Suchmaschine>` suchen“ und ersetzt `.omnibox__hint`. Pfeile, Enter, Escape (erst Liste zu, dann Text zurück) und IME in `Omnibox.onKeyDown`; Wahl bei `pointerdown` in der Liste; offene-Tab-Zeile → `tabs:activate`, sonst `nav:navigate`. Der Kern schließt: Wahl/Navigation (`navigateFromInput`), Tabwechsel (`activateTab`), Klick in eine Seite, Fensterfokus weg, Größenänderung, Layoutwechsel, Escape (`omnibox:close`); nie beim `blur` des Felds. `OverlayLayer.dismiss` gibt die Tastatur an die Chrome zurück, wenn die versteckte Schicht sie noch hält. `search.suggestFrom*` (drei) haben `notYetRead` samt „noch ohne Wirkung“ verlassen, `search.remoteSuggestions` bleibt drauf. Floors 100 % für `shared/omnibox/**` und `ipc/omnibox-handlers.ts`, Stryker-Einträge | ✅ | dieser Stand |
| U23 | Verschlüsseltes Backup und Wiederherstellen (R36–R38, KTD17, KTD18): eine Datei mit Kopf `TESSERA-BACKUP` (Format, App-Version, Dokumentversionen, scrypt-Parameter, frisches 16-Byte-Salz, Nonce) als AAD, das Archiv erst komprimiert, dann in einem Durchgang AES-256-GCM (`backup/format.ts`). Vor der KDF werden Dateigröße (256 MB), Kopfgröße, Format, exakte scrypt-Liste (N=2^17, r=8, p=1, wie der Tresor) und neuere App- oder Dokumentversionen abgelehnt; nichts wird vor `final()` benutzt, Entpacken endet bei 512 MB. Inhalt: die Dateien der Backup-Spalte des Inventars (Verlauf, Berechtigungen, Lesezeichen, Quick Links, Einstellungen, eigene Filterregeln) über den laufenden Codec geöffnet; der Tresor nur mit Master-Passwort, als Chiffretext mit einem Schlüssel nur unter dem Master-Passwort (`masterOnlyVaultKey`), beim Staging mit der Schlüsselbund-Hülle dieses Geräts neu verpackt (`wrapMasterOnlyVaultKey`). Workspaces kommen dazu, sobald U21 ihre Datei in die Profilzeile des Inventars legt (der Inventartest schlägt dann fehl, `DOCUMENT_VERSIONS` verlangt ihre Version). Wiederherstellen: Vorschau, Berechtigungen, Filterregeln und jede abweichende Sicherheitseinstellung (neues Kennzeichen `SECURITY_RELEVANT_SETTINGS` für jede Einstellung, per Typ und Fitness-Test erzwungen) nur nach Haken; nicht bestätigte Schlüssel fallen vor dem Versiegeln heraus und behalten beim Einspielen den aktuellen Wert. Staging neben der Zieldatei (`<datei>.restore`), Sicherungskopie beim Einspielen (`<datei>.before-restore`), beide als Kopien in `quarantine.ts`, sodass Löschen, Beenden, Panic und Tresor-Reset sie mitnehmen; Manifest `restore-pending.json` versiegelt und zuletzt geschrieben, zuletzt gelöscht. Beim Start nach dem Nachholen und dem Schutz, vor jedem Store (`applyRestoreAtStart`); ein Manifest einer neueren Version bleibt liegen. Abschnitt „Sichern und Wiederherstellen“ auf der Einstellungsseite, vier Kanäle `backup:*` nur dort; der Kern öffnet beide Dialoge. Floors 100 % für `src/main/backup/**` und `src/shared/backup/**`, Stryker-Einträge | ✅ | dieser Stand |
| U20 | Kachel-Kopfzeilen (R34, KTD14, KTD22): mit `splitView.showTileHeaders` trägt jede Kachel eines geteilten Layouts einen 28 px hohen Streifen mit Favicon, Titel und „stumm“-Symbol (`TileHeaders.tsx`, Chrome-DOM in der Lücke). Die View rückt um die Kopfzeile nach unten und wird um sie kürzer; eine pure Funktion (`shared/split/tile-header.ts`) liefert Flags und Rechtecke für Kern (`SplitController.tiles` → `planViews`) und Renderer (`useTileRects`). Keine Kopfzeile bei `1x1`, maximierter Kachel und in der Kachel mit Seiten-Vollbild (nur dort; die anderen Kacheln behalten ihre). Kachelleiste und ihr Einblendband liegen unter der Kopfzeile (`TileInputHost.viewRects`), Such- und Picker-Leiste folgen `view.getBounds()` ohnehin, U9-Fehleranzeige zeichnet im verkleinerten Rechteck. Standard jetzt `false` (Q1); aus der `notYetRead`-Liste, Hinweistext in beiden Sprachen ersetzt. **Gilt erst nach Prüfung in der App als fertig** (Execution note) | 🟡 | offen |
| U24 | Import aus anderen Browsern (R39, KTD19, Q3): Einstellungen → „Aus anderen Browsern importieren“ listet die Profile von Chrome, Edge, Chromium und Firefox, die es auf diesem Rechner gibt (`main/import/profiles.ts`, Pfade je Plattform aus injizierter Umgebung; `Local State` für Profilnamen, `profiles.ini` für Firefox; ein fehlender Browser erscheint nicht). Die Seite schickt nur die Profil-ID, der Kern sucht die Profile bei jeder Anfrage neu und liest nur deren Dateien. Lesezeichen: Chrome/Edge/Chromium aus dem JSON `Bookmarks` (`shared/import/chrome-bookmarks.ts`), Firefox aus `moz_bookmarks`/`moz_places` derselben schreibgeschützten `places.sqlite`-Kopie (`shared/import/firefox-places.ts`, Tags ausgelassen); beides über `graftImportedBookmarks` in den Ordner „Importierte Lesezeichen“, der jetzt wiederverwendet wird: gleichnamige Ordner werden betreten, eine Adresse, die der Zielordner schon hat, zählt als Duplikat (gilt auch für den HTML-Import). `javascript:` und `place:` werden gezählt verworfen. HTML-Import bleibt als Ausweg (Kanal `bookmarks:import` jetzt auch für die Einstellungsseite, mit Anleitung für Firefox). Verlauf: `History` bzw. `places.sqlite` samt `-wal`/`-shm` per `mkdtemp` kopiert, mit `node:sqlite` (`readOnly`, `readBigInts`) gelesen, das Temp-Verzeichnis in `finally` entfernt (`main/import/history-sqlite.ts`; `node:sqlite` erst beim ersten Import geladen). Epochen über `chromeTimeToMs`/`firefoxTimeToMs` (`shared/import/epochs.ts`, exakt über BigInt). `planHistoryImport` (`shared/import/visits.ts`) führt nach `historyUrlOf` zusammen (Besuche summiert), verwirft Zukunftsdaten und nicht speicherbare Adressen und füllt nur freien Platz unter 10 000; die Vorschau (`import:previewHistory`) nennt vorher, wie viele wegfallen, der eigene Verlauf wird nie verdrängt. `HistoryStore.readOnly` (Datei schreibgeschützt oder versiegelt) → Ablehnung; gesperrte Datei → „{Browser} schließen“. Passwörter nur per CSV, mit Knopf zur Passwortverwaltung. Startseite: Karte beim ersten Start (`ImportOfferCard.tsx`), verschwindet nach dem ersten Schließen oder einem erfolgreichen Import; Kennzeichen `importOfferClosed` im Quick-Link-Dokument (keine neue Datei, reist im Backup mit). Sieben Kanäle `import:*` (vier nur Einstellungen, drei nur Startseite), Handler testbar in `ipc/import-handlers.ts`. Floors 100 % für `shared/import/**`, `main/import/**`, `ipc/import-handlers.ts`, Stryker-Einträge | ✅ | dieser Stand |
| U22 | Tab-Suche und Tab-Streifen (R31, R32, KTD16): `Strg+Shift+A` (macOS `Cmd+Shift+A`, wie Chrome und Edge) öffnet über den Menüeintrag „Fenster → Tabs durchsuchen…“ (neue Aktion `searchTabs` in allen drei Tabellen, gegen `KNOWN_CONFLICTS` und alle Belegungen geprüft) ein Vollfenster-Panel (`TabSearchPanel.tsx`, nachgeladen; `window:setOverlay` hält die Views an). Kandidaten sind `state.tabs` in `displayOrder()`, auch Mitglieder eingeklappter Gruppen; leeres Feld listet alle, sonst reiht U17 (`shared/search/tab-search.ts` faltet die nach Adresse zusammengelegten Zeilen wieder auf, damit zwei Tabs derselben Seite beide erscheinen; höchstens 8). Pfeile bewegen die Markierung, Enter öffnet sie (zuerst die erste Zeile), Escape schließt, Klick öffnet. Aktivieren geht über `tabs:activate`; das Aufklappen der Gruppe macht der Kern wie bisher (`activateTab` → `TabDiscards.wake` → `unfoldGroupOf`), Szenario in `tab-groups.feature`. Streifen: aktiver Tab per `scrollIntoView({ inline: 'nearest', block: 'nearest' })` bei Wechsel und beim Aufklappen seiner Gruppe; Verlauf als `mask-image` an der Kante nur, solange dort wirklich mehr liegt (gemessen nach jedem Render, bei Scroll und `ResizeObserver`), `scroll-padding-inline` hält den Tab aus dem Verlauf; senkrechtes Mausrad scrollt den Streifen seitwärts; beim Ziehen scrollt er in 32 px am Rand je Frame (`edgeScrollStep`, schneller je näher). Vier Katalogschlüssel `tabsearch.*` je Sprache, Menütext im Kern. Floor über `shared/search/**` (100 %), Stryker-Eintrag | ✅ | dieser Stand (Prüfung in der App offen) |
| U21 | Workspaces (R35, KTD15): das Layout-Menü (Overlay) hat unter den sieben Layouts „Speichern als…“ und die Liste der gespeicherten Workspaces, nachgeladen in `WorkspacesMenu` (eigener Chunk); ein Namensfeld und eine Rückfrage im Menü ersetzen den Prompt. Ein Workspace ist Name, Layout, Brüche (nur die des Layouts) und ein Platz je Kachel mit Adresse oder leer (`shared/workspaces/model.ts`; ein 2×2 mit drei belegten Kacheln ergibt vier Plätze, einer leer). Eigener Store `workspaces.json` (`WorkspaceStore`, `paths.workspacesFile`), versiegelt wie die übrigen, `critical` mit Migrationskette, eintragsweise tolerant (ein Workspace mit unbekanntem Layout bleibt roh erhalten), ohne Obergrenze und ohne Verdrängung; der Architekturtest lässt jetzt Lesezeichen, Passwörter und Workspaces als `critical` zu, mit Begründung. Eine Datei einer neueren Version wird gelistet und geöffnet, „speichern“ und Entfernen antworten `read-only`, das Menü sagt es. Ein vergebener Name (ohne Groß/Klein) antwortet `exists` und überschreibt erst nach „Speichern“ in der Rückfrage (Platz und ID bleiben). Öffnen: pro Platz ein offener Tab mit derselben Adresse (in Streifenfolge, keiner doppelt, keiner aus einer eingeklappten Gruppe), sonst ein neuer Tab im Hintergrund; alle Kacheln ohne passenden Platz werden vor dem Layoutwechsel geräumt, damit der Wechsel nichts verwaist und kein Füll-Tab geschlossen wird; dann `restoreArrangement` (ohne Füllen, ohne Umziehen), danach die Brüche. Kein Tab wird geschlossen, Tabs ohne Platz bleiben offen. Private Fenster öffnen, speichern nicht (`private`, Eintrag deaktiviert). Inventar: `workspacesFile` in der Profilzeile (Panic behält, Backup trägt), damit in `BACKUP_DOCUMENTS`, `DOCUMENT_VERSIONS` und der Wiederherstellungsliste (Titel `workspaces.title`); ein Backup wartet auf ihren Flush. Vier Kanäle `workspaces:*` nur für die Chrome (Tupel in `workspaces/model.ts`), Handler testbar in `ipc/workspace-handlers.ts` gegen echten `SplitController` und `TileOccupancyController`. Floors 100 % für `shared/workspaces/**`, `WorkspaceStore.ts`, `ipc/workspace-handlers.ts`, Stryker-Einträge | ✅ | dieser Stand (Prüfung in der App offen) |
| Review | Fünf Befunde aus `ce-code-review` (Lauf `20260924-173154-fad5d57d`, alle P2) behoben: #5 Tresor-Wiederherstellung alles oder nichts, ein Dokument, das nicht umziehen kann, schickt seinen Schlüssel zurück in die Staging-Kopie; #3 ein Schließen, das auf ein wartendes Verwerfen trifft, wird ein Schließen und zeigt die Rückfrage; #6 ein Verwerfen, dessen Seite in 5 s nicht antwortet, bleibt geladen statt erzwungen (R12); #2 `requestCatalog` und `prepareBundledI18n` lehnen nie ab, ein fehlender Katalog-Chunk zeigt Schlüssel statt eines leeren Fensters; #1 die Import-Vorschau gehört zu ihrer Quelle, „Importieren“ nimmt die Quelle der gezeigten Zahlen. Danach KTD21 nachgezogen: `surface.ts` 1366 → 1108 (Autofill-Vorschläge und Download-Panel in eigene Module, Overlay-Chunk bytegleich), `DownloadManager.ts` 799 → 723 (Seam-Typen nach `seams.ts`); Dateien über der Marke wieder 9 wie am 24.09.2026 | ✅ | `0d334f1`, `06b275a` |

### Bündel nach R40

Main- und Renderer-Bündel dürfen wachsen, jede Einheit notiert ihren Zuwachs in kB mit dem Feature. Größte
Datei, Dateien über der Marke, Katalog und Coverage dürfen nicht schlechter werden als am 24.09.2026. Alle
Größen dezimal (Bytes ÷ 1000), wie im Build-Log.

| Einheit | Feature | Main-Prozess | Katalog-Chunk | `BrowserWindowController.ts` |
|---|---|---|---|---|
| Ausgang 24.09.2026 | — | 510,1 kB | 48,84 kB | 1527 Zeilen |
| U6 | Menütexte aus dem Kern | — | 48,84 → 43,96 kB | — |
| U2 | Tab-Gruppen, eigener Träger für Anordnungen | +3,9 kB | — | 1527 → 1476 |
| U4 | Hinweise auf der Lesezeichenseite | — | +0,8 kB | — |
| U10 | Nachfrage bei `beforeunload` | in den +13,4 kB unten | — | 1476 → 1469 |
| U9 | Fehler- und Absturzanzeige in der Kachel | in den +13,4 kB unten | +0,4 kB | 1469 → 1462 |
| U11 | Dateninventar, Löschen beim Beenden | in den +13,4 kB unten | — | — (`src/main/index.ts` 1462 → 1404) |
| **Stand nach `fb991bc`** | | **527,45 kB** (U9 bis U11 zusammen ≈ +13,4 kB) | **45,12 kB** von 48 | 1462 |
| U14 | Autofill: Badge, Auswahl auf der Overlay-Schicht, Toolbar-Schlüssel, Kürzel, Kontextmenü | 546,42 → 555,61 kB (+9,2 kB) | 46,51 → 46,94 kB | — (1457, unverändert) |
| U15 | Tab-Entladen: Timer, Verwerfen, neue View mit `restore()`, gedimmter Tab | 555,61 → 560,05 kB (+4,4 kB) | 46,94 → 47,08 kB (+0,14 kB, ein Tooltip-Satz je Sprache) | 1457 → 1410 (`Tab.ts` 1130 → 1080, `src/main/index.ts` 1381 → 1380, `WindowRegistry.ts` 697 unverändert) |
| U16 | Medien-MVP: Beobachtung, Freigabe, Medienknopf, Panel, Ziel über `target-path.ts`, Download-Anzeige, Adress-Wächter | 560,05 → 563,30 kB (+3,25 kB) | 47,08 → 47,18 kB (+0,10 kB, ein Knopftext je Sprache) | 1410 unverändert (`src/main/index.ts` 1380 unverändert, `WindowRegistry.ts` 697 → 716, `Tab.ts` und `contract.ts` unberührt). Renderer-Hauptchunk 26,21 → 27,66 kB; das Panel liegt in einem nachgeladenen Chunk (`MediaPanel`, 9,16 kB) |
| U19 | Site-Menü hinter dem Schloss | nicht gemessen (in dieser Einheit lief kein Build) | unverändert (kein Katalogschlüssel; 17 neue Texte je Sprache in `menu-text.*`) | unberührt (`src/main/ipc/handlers.ts` 971 → 905, `src/main/index.ts` 1380 unverändert, `Tab.ts` 1080 → 1075, `contract.ts` 1319 unverändert, `channels.ts` 742 → 743) |
| U18 | Vorschläge in der Adressleiste | nicht einzeln messbar: gemeinsamer Build mit dem Backup-Worker (U23), 575 kB zusammen | en 22,08 → 22,16 kB, de 24,53 → 24,61 kB (zwei Schlüssel je Sprache: `omnibox.suggestions`, `omnibox.switchToTab`) | 1410 unverändert (`surface.ts` 1336 → 1366, `contract.ts` 1319 → 1318, `handlers.ts` 905 → 904, `src/main/index.ts` 1380 unberührt, `channels.ts` 743 → 746). Overlay-Hauptchunk 19,43 kB von 20 kB; die Liste liegt nachgeladen in `OmniboxSuggestionsSurface` (1,37 kB). Renderer-Hauptchunk 28,51 kB, Chrome-Preload 3 504 B |
| U23 | Verschlüsseltes Backup und Wiederherstellen | gemeinsamer Build mit U18: 595,34 kB zusammen (`out/main/index.js`) | en 22,16 → 23,73 kB, de 24,61 → 26,39 kB (25 Schlüssel `backup.*` je Sprache; die Titel der Einträge kommen aus vorhandenen Schlüsseln) | `src/main/index.ts` 1380 → 1372 (`warnAboutStoreLoad` zog nach `store-load.ts`), `contract.ts` 1318 → 1320 (Import und Spread von `backupInvokeContract`), `channels.ts` 746 → 767, `handlers.ts` unberührt. Einstellungsseite 16,17 kB, Chrome-Preload 3 579 B, Tab-Preload 41 782 B |
| U20 | Kachel-Kopfzeilen | gemeinsamer Build mit dem Import-Worker: 596,86 kB zusammen (`out/main/index.js`), nicht einzeln messbar | en 23,73 → 23,75 kB, de 26,39 → 26,41 kB (ein Schlüssel je Sprache: `split.muted`, Name des „stumm“-Symbols) | 1410 → 1408 (`relayout` holt die Kacheln aus `SplitController.tiles`); `SplitController.ts` 354 → 383, `window-seams.ts` 337 → 342, `TileInputController.ts` 124 → 132, `App.tsx` 375 → 390; `src/main/index.ts`, `Tab.ts`, `contract.ts`, `surface.ts`, `handlers.ts`, `channels.ts` unberührt. Renderer-Hauptchunk 29,90 kB (gemeinsamer Build) |
| U24 | Import aus anderen Browsern | gemeinsamer Build mit U20: 613,97 kB zusammen (`out/main/index.js`; 595,34 nach U23), nicht einzeln messbar; `node:sqlite` bleibt extern (`import("node:sqlite")` im Bundle, keine native Abhängigkeit) | en 23,75 → 25,29 kB, de 26,41 → 28,14 kB (22 Schlüssel je Sprache: 19 `import.*`, 3 `start.import*`; Knöpfe und Fehlertext aus vorhandenen Schlüsseln, Ordnername `bookmarks.importedFolder`) | `src/main/index.ts` 1372 unberührt, `handlers.ts` 904 → 903 (eine Aufrufstelle, Kommentare gekürzt), `contract.ts` 1320 → 1319, `channels.ts` 767 → 777 (Kanalnamen als Tupel in `shared/import/model.ts`, damit die Datei unter 780 bleibt). Einstellungsseite 20,53 kB, Startseite 10,34 kB, Chrome-Preload 3 731 B, Tab-Preload 41 957 B |
| U22 | Tab-Suche und Tab-Streifen | gemeinsamer Build mit dem Workspace-Worker: 616,31 kB zusammen (`out/main/index.js`), nicht einzeln messbar; U22 fügt dem Kern nur einen Menüeintrag und zwei Menütexte hinzu | gemeinsamer Build: en 25,29 → 25,68 kB, de 28,14 → 28,56 kB; der Anteil von U22 sind vier Schlüssel `tabsearch.*` je Sprache, ≈ 0,14 bzw. 0,15 kB | unberührt (`BrowserWindowController.ts`, `src/main/index.ts`, `contract.ts`, `Tab.ts`, `surface.ts`, `handlers.ts`, `channels.ts`); `App.tsx` 390 → 409, `TabBar.tsx` 360 → 455, `useTabDrag.ts` 143 → 220, `appMenu.ts` 528 → 539. Renderer-Hauptchunk 29,90 → 31,58 kB von 60 (gemeinsamer Build, der Workspace-Code liegt nicht darin), die Suche liegt nachgeladen in `TabSearchPanel` (4,41 kB), Stylesheet 12,38 kB |
| U21 | Workspaces | gemeinsamer Build mit dem Tab-Suche-Worker: 620,13 kB zusammen (`out/main/index.js`; 613,97 nach U24), nicht einzeln messbar | gemeinsamer Build: en 25,29 → 25,68 kB, de 28,14 → 28,56 kB; der Anteil von U21 sind sechs Schlüssel `workspaces.*` je Sprache, ≈ 0,25 bzw. 0,26 kB (Speichern und Abbrechen aus `bookmarks.*`) | nicht länger als vorher: `BrowserWindowController.ts` 1408 → 1408 (Getter `occupancy`, Absätze in fünf Docblocks zusammengezogen), `src/main/index.ts` 1372 → 1370, `handlers.ts` 903 → 901, `contract.ts` 1319 → 1319, `channels.ts` 777 → 777 (je Import und Spread, Kommentare gekürzt); `Tab.ts`, `surface.ts` unberührt. `LayoutMenuSurface.tsx` 143 → 169. Overlay-Hauptchunk 19,43 → 19,83 kB von 20 (Lazy-Grenze, Nachmessen, Fokus nur beim Öffnen); die Liste und das Feld liegen nachgeladen in `WorkspacesMenu` (2,57 kB), Overlay-Stylesheet 12,54 kB |

Der Main-Prozess liegt damit weiter über seinem Budget von 320 kB, und das ist nach der Key Decision
„Bundle-Budgets dürfen mit notiertem Zuwachs wachsen" zulässig, solange der Zuwachs hier steht. Den Anteil von
U9, U10 und U11 einzeln misst niemand nach, weil zwischen den Einheiten kein Build lief; die Summe ist gemessen.
Der Preload der Tabs stand vor U14 bei 41,6 kB; das ist die Messlatte für Roadmap U14 (R25), nicht 35 kB.

**Preload-Tor U14, gemessen mit `pnpm build`:** vor U14 **41 638 B**, nach U14 **41 448 B** (−190 B). Das Badge,
die Tastaturbedienung und die Antwort auf die Frage des Kerns nach dem Formular kosten mehr als die entfernte
Liste in der Seite; bezahlt ist das innerhalb des Autofill-Codes selbst — eine Prüfschleife statt drei in
`wire.ts`, die Namenswahl beim Speichern über dieselbe Funktion wie beim Füllen in `fields.ts`, kompakterer
Aufbau der Speicherleiste. Der Chrome-Preload wächst um die drei neuen Kanalnamen (3 357 → 3 473 B, Budget
5 kB).

**Preload U15, gemessen mit `pnpm build`:** vor U15 **41 448 B**, nach U15 **41 707 B** (+259 B): ein
`input`- und ein `submit`-Listener und der Kanal `tessera:unsaved-input`. Chrome-Preload unverändert (3 473 B). Die Auswahlfläche liegt in einem eigenen, nachgeladenen Chunk (2,68 kB), sonst wäre der Overlay-Chunk
über seine 20 kB gegangen (18,73 → 19,19 kB). Renderer-Hauptchunk 24,71 → 26,11 kB (Schlüssel in der Toolbar).

### Aus dem Code-Review offen

Befunde, die das Review als Restrisiko oder Testlücke gemeldet hat und die dieser Durchgang nicht behebt. Keiner
verhindert ein Ergebnis des Plans; jeder ist eine eigene kleine Einheit.

| Punkt | Was passiert | Wo |
|---|---|---|
| Später „Ja“ nach aufgegebenem Verwerfen | Antwortet die Seite nach den 5 s doch ohne Einwand, zerstört Chromium die View trotzdem; der Tab hält sich dann für „nicht verworfen“ und schließt wie bei `window.close()`. Nichts geht verloren, überrascht aber. Electron kann ein `close` nicht zurücknehmen | `unload-guard.ts` `#deadline` |
| Umgekehrte Reihenfolge von #3 | Ein Schließen hängt an einem stummen Renderer, dann verwirft der Sweep denselben Tab; das Verwerfen hängt sich an und läuft als Schließen mit. Außerdem ruft ein gelungenes, zusammengelegtes Schließen den Rückruf des Verwerfens vor `#finish` | `unload-guard.ts:137-149`, `tab-unloader.ts:286-296` |
| „Beim Beenden löschen: Downloads“ behält laufende | `DownloadStore.clear()` behält aktive Einträge, ein beim Beenden laufender Download steht beim nächsten Start wieder in der Liste | `clear-data.ts:158` |
| Panic beim Schließen des letzten Fensters | Unter Windows/Linux beendet das letzte Fenster die App, während Panic noch löscht; gewartet wird nur `FLUSH_TIMEOUT_MS` (10 s) | `panic.ts`, `index.ts` `window-all-closed` |
| Panic-Notiz über zwei Starts und ein Restore dazwischen | Die Notiz wird vor dem Restore nachgeholt und löscht dessen gestagte Verlaufs- und Rechte-Kopien | `panic.ts`, `stage-restore.ts` |
| Restore, den dieser Lauf nicht lesen kann | Wechselt der Schutzmodus zwischen zwei Starts, bleibt ein gestagter Restore bei jedem Start `kept` und meldet sich nicht | `stage-restore.ts:338-357` |
| Omnibox: späte Antwort nach geschlossener Liste | Eine verspätete `omnibox:suggest`-Antwort kann die Liste nach Klick in die Seite oder Tabwechsel wieder öffnen | `answerOmniboxRequest` |
| Medien: Adress-Wächter und Abbrechen | Der Wächter prüft nur IP-Literale (kein Hostname auf private Adressen per DNS), `session.fetch` folgt Weiterleitungen vor der Prüfung; Abbrechen während des HLS-Manifestabrufs wirkt erst danach | `url-guard.ts`, `MediaSessions.ts:83`, `MediaDownloader.ts:239` |
| Kill Switch mit System-Proxy | Urteil pro Origin mit 60-s-Cache; ein PAC-Skript, das nach Pfad oder Zeit entscheidet, kann einzelne Anfragen `DIRECT` schicken | `resolveTarget` |
| Format-Tor | `format:check` prüft `tests/**/*.tsx` und Konfigurationsdateien im Wurzelverzeichnis nicht | `package.json:33` |
| Katalog-Chunk nach Fehler | `loadCatalog` behält ein abgelehntes Versprechen im Cache, ein fehlgeschlagener Chunk wird bis zum Neuladen nicht erneut versucht | `load-catalog.ts` |
| Zwei Schnittstellen `UnloadContents` | Gleicher Name, verschiedene Form in `unload-guard.ts:55` und `tab-unloader.ts:42` | Wartbarkeit |

### Was nur der Benutzer prüfen kann

Laufende App (`pnpm dev`). Kein Agent startet die App. Jede Zeile ist offen, bis der Benutzer sie bestätigt.

| Einheit | Prüfung | Erwartung |
|---|---|---|
| Nachtrag | Vollbild: einzelne Kachel, Strg+Cmd+F (sonst F11), ein Video ins Vollbild, mehrmals über den Vollbild-Knopf des Players heraus | Das Fenster bleibt jedes Mal im Vollbild (unter macOS evtl. kurz heraus und zurück); die Taste oder Escape bei kleinem Video verlassen es weiterhin |
| Nachtrag | Einstellungen: Kanal „Nur stabile Versionen“, dann „Nach Updates suchen“ | Dialog „Noch keine stabile Version“ mit Hinweis auf „Alpha“, nicht „GitHub nicht erreichbar“ |
| U10 | **Vor der Änderung** (Stand vor `3306bc6`): eine Seite mit `beforeunload` öffnen und wegnavigieren | Festhalten, ob die Navigation still blockiert war. Der Plan vermutet es; belegt ist es nicht |
| U10 | Ob `preventDefault` auf `will-prevent-unload` bei einer `WebContentsView` wirkt | „Verlassen" verlässt die Seite tatsächlich |
| U10 | Tab schließen und Fenster schließen auf einer solchen Seite | Dialog mit „Bleiben" und „Verlassen"; beides tut, was es sagt |
| U10 | Cmd+Q und Update installieren | Keine Nachfrage |
| U10 | Link-Navigation und Neu laden auf einer solchen Seite | Dialog; „Verlassen" und „Bleiben" wirken |
| U10 | Tab in einer eingeklappten Gruppe | Der Streifen zeigt die Gruppe aufgeklappt, bevor der Dialog erscheint |
| U10 | Standardknopf des Dialogs | „Bleiben". Chrome nimmt „Verlassen"; hier ist das eine Produktentscheidung, festgehalten |
| U9 | Fehleranzeige in einer und in mehreren Kacheln: unbekannte Domain, offline, Zertifikatsfehler, beendeter Renderer, Sperre durch den Blocker gegen Sperre durch die Telemetrie-Stufe | Die Anzeige erscheint in der richtigen Kachel und nennt den richtigen Grund |
| U9 | Dasselbe in einer maximierten Kachel | Die Anzeige passt in die Kachel |
| U9 | „Neu laden" | Die Anzeige verschwindet |
| U9 | „Trotzdem öffnen" | Die Seite lädt |
| U11 | `docs/QA.md` 7.12 bis 7.15 | Wie dort beschrieben |
| U2 | Gruppe einklappen, kacheln, mit Tab-Gruppen neu starten | Die Gruppen und ihre Anordnung kommen wieder |
| U1, U14 | Autofill-Durchgang aus dem Verification Contract des Autofill-Plans: gesperrter Tresor → Badge → Auskunft mit Entsperren → Liste; entsperrt ohne Eintrag → „nichts gespeichert“; `http://` außerhalb Loopback → Grund; Eintrag wählen → Name und Passwort im Formular, Schreibmarke im Feld; Seitenzoom 150 % → Liste am Feld, Scrollen schließt sie; Tastatur: Feld, Tab aufs Badge, Enter, Pfeile, Enter | Wie beschrieben |
| U14 | Toolbar-Schlüssel: gesperrt, offen mit Treffer (Punkt), offen ohne Treffer; Klick bei gesperrtem Tresor | Drei unterscheidbare Zustände; der Klick öffnet die Master-Passwort-Abfrage |
| U14 | Toolbar-Schlüssel und `Strg+Shift+K` (macOS `Cmd+Shift+K`) auf einer Anmeldeseite, ohne vorher in die Seite zu klicken | Die Liste erscheint unter dem Schlüssel (beim Kürzel am Feld), die Wahl füllt aus |
| U14 | Rechtsklick in ein Passwortfeld, dann „Gespeichertes Passwort einsetzen“; Rechtsklick anderswo | Der Eintrag steht nur im Passwortfeld und öffnet dieselbe Liste |
| U14 | Tresor sperrt sich nach 15 Minuten, während die Seite offen ist | Der Schlüssel wechselt ohne Tabwechsel auf „gesperrt“ |
| U15 | `advanced.unloadAfterMinutes` auf 1, eine Seite mit Verlauf (zwei Klicks tief, heruntergescrollt) in einem Tab ohne Kachel liegen lassen, zwei Minuten warten | Der Tab steht gedimmt im Streifen; `app.getAppMetrics()` zeigt seinen Renderer nicht mehr, der Speicher sinkt |
| U15 | Denselben Tab aktivieren | Kurz eine leere Kachel, dann die Seite an derselben Stelle mit Zurück und Vor; Stummschaltung und Zoom wie vorher |
| U15 | Ausnahmen in der echten App: pausiertes Video, Textfeld mit Text ohne Fokus, angehefteter Tab, offene DevTools, wartende Berechtigungsfrage, Popup-Frage | Keiner davon wird entladen |
| U15 | Seite mit `beforeunload` im Hintergrund liegen lassen | Sie bleibt geladen, es erscheint kein Dialog, und sie wird bis zur nächsten Navigation nicht wieder gefragt |
| U15 | Annahmen über Electron 43: `webContents.close({ waitForBeforeUnload: true })` meldet bei einer `WebContentsView` erst `close`, dann `destroyed`; `navigationHistory.restore()` bringt die Scroll-Position zurück; `removeChildView` auf eine schon entfernte View ist harmlos | Kein Tab schließt sich beim Entladen, die Scroll-Position kommt zurück, Schließen eines entladenen Tabs wirft nichts |
| U15 | Dasselbe im privaten Fenster | Entladen und Zurückkommen wie oben, danach nichts auf der Platte |
| U16 | Seite mit einem progressiven MP4 (auch ohne Dateiendung in der Adresse) abspielen | Der Medienknopf zeigt eine Zahl; ohne Medien bleibt er gedimmt und ohne Zahl |
| U16 | Zwei Tabs, nur einer spielt Video; zwischen ihnen wechseln, auch per `Strg+Tab` bei offenem Medien-Panel | Zahl und Panel zeigen jeweils die Funde des aktiven Tabs |
| U16 | Im Panel „Speichern“ | Der Download erscheint sofort in der Download-Anzeige mit Fortschritt; die fertige Datei liegt im eingestellten Ordner (bei leerer Einstellung im System-Downloadordner) und spielt ab |
| U16 | Denselben Fund zweimal nacheinander speichern; einen laufenden Download in der Anzeige und einmal im Panel abbrechen | Zweite Datei heißt `name-2.ext`; nach dem Abbruch liegt keine `.part`-Datei im Ordner, die Zeile sagt „abgebrochen“ |
| U16 | Gemuxtes HLS (unverschlüsselt, mit `#EXT-X-ENDLIST`) speichern | Eine abspielbare `.ts`-Datei; eine Quelle, deren Segmente auf `127.0.0.1` oder ein lokales Netz zeigen, wird mit Grund abgelehnt |
| U16 | Tab schließen, privates Fenster schließen, „Browserdaten löschen“ mit Cookies | Die Funde sind danach weg; ein offenes Panel wird leer |
| U16 | Ob `session.fetch` bei einer Weiterleitung `response.url` auf das Ziel setzt | Eine Weiterleitung auf eine lokale Adresse endet als Fehler statt als Datei |
| U19 | Auf das Schloss klicken, dann auf den Schild; das Schloss per Tab-Taste erreichen und mit Enter/Leertaste öffnen | Beide öffnen dasselbe Menü an der Mausposition bzw. am Fenster; oben steht der Verbindungsstatus, darunter die Blocker-Einträge wie bisher |
| U19 | Eine Seite, der Standort und Kamera erlaubt wurden; Menü öffnen, „Standort: Erlaubt“ → „Vergessen“, dann neu laden | Nur Standort steht im Menü, Kamera nicht; nach dem Vergessen fragt die Seite beim nächsten Zugriff wieder nach dem Standort, die Kamera bleibt ohne Nachfrage erlaubt |
| U19 | „Alle Berechtigungen dieser Seite vergessen“ | Alle gelisteten Antworten sind weg, eine gespeicherte Kamera- oder Mikrofon-Antwort bleibt |
| U19 | Dasselbe Menü in einem privaten Fenster | „In privaten Fenstern werden keine Berechtigungen gespeichert“, keine Einträge |
| U19 | Zwei Kacheln, Zoom + im Menü der aktiven Kachel; einmal mit zwei verschiedenen Hosts, einmal mit demselben Host | Bei verschiedenen Hosts ändert sich nur die aktive Kachel (Zoom-Badge nur dort). Bei demselben Host kann die andere Kachel optisch mitgehen — bekanntes Risiko „Zoom: zwei Kacheln auf demselben Host teilen den lebenden Faktor“ |
| U19 | Blocker-Schalter „Auf dieser Seite blockieren“ im Menü des Schlosses | Wirkt wie bisher über den Schild: Schild gestrichelt, Eintrag in `privacy.blockerOffForSites` |
| U19 | Fingerprint-Schutz im Menü aus- und wieder einschalten | Die Einstellung wechselt; ein schon offener Tab behält seinen Plan, ein neuer Tab bekommt den neuen |
| U19 | Schloss auf `http://`, `https://`, einer Seite mit Zertifikatsfehler und `tessera://settings` | Die erste Zeile sagt jeweils „nicht verschlüsselt“, „verschlüsselt“, „Zertifikat ist ungültig“, „Tessera-Seite“; das Schloss sieht aus wie vorher (jetzt mit Hover-Fläche) |
| U18 | In die Adressleiste „wiki“ tippen, wenn Verlauf, ein Lesezeichen und ein zweiter Tab passen | Unter dem Feld erscheint über der Seite eine Liste: zuerst „Mit DuckDuckGo suchen“, dann die Treffer; die Liste ist klickbar, die Schreibmarke bleibt im Feld und tippen geht weiter |
| U18 | Pfeil runter/hoch, Enter; einmal auf einer Tab-Zeile („Zu diesem Tab wechseln“), einmal auf einer Verlaufszeile; Enter ohne Pfeil | Tab-Zeile wechselt zum Tab, Verlaufszeile öffnet die Adresse im aktiven Tab, Enter ohne Pfeil öffnet bzw. sucht den getippten Text |
| U18 | Mit der Maus auf eine Zeile klicken | Die Zeile öffnet sich beim Drücken (nicht erst beim Loslassen); danach nimmt die Tastatur wieder Eingaben an (z. B. `Strg+L` und tippen) |
| U18 | Escape bei offener Liste, dann noch einmal | Erst schließt die Liste und der Text bleibt, dann steht wieder die Adresse der Seite im Feld |
| U18 | Japanisch oder Chinesisch per IME tippen und die Komposition mit Enter bestätigen | Enter übernimmt nur die Komposition, es öffnet keine Zeile und navigiert nicht |
| U18 | Liste schließen durch: Klick in die Seite, anderes Fenster/App fokussieren, Tab wechseln, Fenstergröße ändern, Layout wechseln | Die Liste verschwindet jedes Mal; beim Wechsel ins andere Fenster klärt sich auch, ob ein Klick in die Liste selbst das Fenster „blur“ meldet (er darf es nicht) |
| U18 | Suchleiste (`Strg+F`) offen lassen und in der Adressleiste tippen | Die Suchleiste bleibt, keine Liste; nach dem Schließen der Suchleiste erscheint die Liste beim nächsten Tastendruck |
| U18 | Privates Fenster, „wiki“ tippen | Keine Verlaufszeilen; Lesezeichen und eigene Tabs schon |
| U18 | Liste offen, auf Zurück oder Neu laden in der Werkzeugleiste klicken | Bekannte Lücke: die Liste bleibt stehen, bis ein anderer Auslöser sie schließt (siehe Bericht U18) |
| U23 | Einstellungen → „Sichern und Wiederherstellen“: Passphrase mit 11 Zeichen, dann zwei verschiedene, dann zweimal dieselbe mit 12 oder mehr; „Backup anlegen…“ | Der Knopf bleibt aus, bis beide gleich und lang genug sind; der Kern öffnet den Speichern-Dialog, danach „Backup gespeichert.“ Die Datei endet auf `.tessera-backup` und beginnt lesbar mit `TESSERA-BACKUP` |
| U23 | Dasselbe einmal ohne und einmal mit Master-Passwort | Ohne: „Ohne Master-Passwort bleibt der Passwort-Tresor draußen.“ Mit: „Der Passwort-Tresor kommt mit …“ |
| U23 | Rundreise auf echten Profildaten: Backup anlegen, ein Lesezeichen löschen und eine Einstellung ändern, „Wiederherstellen…“ mit der Passphrase, alles anhaken, „Beim nächsten Start einspielen“, Tessera beenden und starten | Lesezeichen, Verlauf, Quick Links und Einstellungen sind wie im Backup; neben den Dateien im Profilordner liegen `*.before-restore` mit dem Stand vor dem Einspielen; `restore-pending.json` ist weg |
| U23 | Wiederherstellen mit falscher Passphrase und mit einer Datei, in der ein Byte geändert wurde | „Falsche Passphrase oder beschädigte Datei.“, keine Vorschau, im Profilordner entsteht nichts |
| U23 | Backup mit Proxy „manuell“ und einer Proxy-Adresse, auf einem Profil ohne Proxy wiederherstellen, ohne die Sicherheitseinstellungen anzuhaken | Die Vorschau listet Proxy-Modus und -Adresse mit Wert; nach dem Neustart ist der Proxy weiter aus, die übrigen Einstellungen sind übernommen |
| U23 | Tresor mit Master-Passwort wiederherstellen, neu starten, Passwortseite öffnen | Der Tresor ist gesperrt und öffnet nur mit dem Master-Passwort aus dem Backup; die Einträge sind da |
| U23 | Wiederherstellen anfordern, dann vor dem Neustart „Browserdaten löschen“ mit Verlauf | Beim nächsten Start kommt der Verlauf aus dem Backup nicht zurück, die übrigen gewählten Einträge schon |
| U20 | Einstellungen → Split View → „Kopfzeile je Kachel anzeigen“ einschalten, Layout `1x2`, dann `2x2` und `1+2` | Jede Kachel mit Tab hat oben einen Streifen mit Favicon und Titel; die Seite beginnt direkt darunter und ist nicht verdeckt (auf einer Seite mit Inhalt ganz oben, z. B. einer Kopfleiste, ist deren oberer Rand sichtbar). Leere Kacheln haben keinen Streifen |
| U20 | Bestehendes Profil nach dem Update, ohne die Einstellung anzufassen | Festhalten, ob die Kopfzeilen schon an sind: ein früher geschriebenes `settings.json` trägt noch das alte `true`, die neue Vorgabe `false` gilt nur für Profile ohne gespeicherten Wert. Gegebenenfalls einmal ausschalten |
| U20 | Teiler zwischen den Kacheln mit Kopfzeilen ziehen, auch auf Höhe der Kopfzeile; Doppelklick auf einen Teiler; Teiler per Tastatur | Die Griffe liegen weiter in den Lücken und lassen sich überall greifen; die Kopfzeilen wandern mit den Kacheln, ohne Versatz und ohne Streifen blanker Chrome darunter |
| U20 | Maus an den oberen Rand einer Seite unter der Kopfzeile führen (Kachelleiste `hover`), dann `Strg+Shift+L` (macOS `Cmd+Shift+L`) | Die Kachelleiste erscheint unter der Kopfzeile, nicht auf ihr; über der Kopfzeile selbst erscheint sie nicht. Einblenden und Ausblenden flackern nicht |
| U20 | Tab in einer Kachel stumm schalten, wieder laut | Das „stumm“-Symbol erscheint und verschwindet in dieser Kopfzeile |
| U20 | Eine Kachel maximieren und zurück; `1x1`; Video in einer Kachel in den Vollbildmodus (Kachel-Vollbild), dann F11 | Maximiert und `1x1`: keine Kopfzeile, Seite füllt die Kachel. Kachel-Vollbild: nur diese Kachel ohne Kopfzeile, die anderen behalten sie und verschieben sich nicht. F11: Kopfzeilen bleiben an ihrer Kachel, Teiler greifbar |
| U20 | `Strg+F` und die Element-Auswahl des Blockers in einer Kachel mit Kopfzeile; eine Seite, die nicht lädt (unbekannte Domain) | Such- und Picker-Leiste sitzen in der Seite unter der Kopfzeile; die Fehleranzeige füllt die Fläche unter der Kopfzeile, die Kopfzeile bleibt sichtbar |
| U20 | Einstellung wieder ausschalten | Alles wie vorher: Seiten beginnen an der Kachelkante, Kachelleiste an der Kachelkante |
| U24 | Einstellungen → „Aus anderen Browsern importieren“ auf einem Rechner mit Chrome (oder Edge/Chromium) und Firefox | Die Liste zeigt „Chrome — <Profilname>“ und „Firefox — <Profil>“; ein nicht installierter Browser fehlt. Zuerst prüfen: der Aufruf funktioniert überhaupt (`node:sqlite` im gebauten Electron), sonst meldet „Verlauf übernehmen…“ „Die Datei ließ sich nicht lesen“ |
| U24 | Chrome-Profil: „Lesezeichen übernehmen“, dann noch einmal | Leiste von Chrome liegt auf der Leiste, der Rest unter „Weitere Lesezeichen“ → „Importierte Lesezeichen“ mit Unterordnern; Meldung „N übernommen, 0 schon vorhanden, M übersprungen“ (M = Bookmarklets). Beim zweiten Mal „0 übernommen, N schon vorhanden“, nichts doppelt |
| U24 | Firefox-Profil: „Lesezeichen übernehmen“ | Symbolleiste auf der Leiste, Menü und „Weitere Lesezeichen“ im Importordner, keine Schlagwort-Ordner; „Meistbesucht“ und ähnliche zählen als übersprungen |
| U24 | „Verlauf übernehmen…“ bei laufendem und bei geschlossenem anderen Browser | Laufend: unter Windows „Chrome benutzt die Datei. Schließ Chrome …“, unter macOS/Linux meist Erfolg (Kopie). Geschlossen: Vorschau „X kommen hinzu, Y zusammengeführt, Z übersprungen“, bei vollem Verlauf zusätzlich „Weitere W passen nicht …“; erst „Verlauf übernehmen“ schreibt. Danach im Verlauf die übernommenen Seiten mit richtigem Datum (nicht 1970, nicht 2393) |
| U24 | Nach dem Import im Temp-Verzeichnis des Systems nachsehen | Kein Ordner `tessera-import-*` bleibt liegen |
| U24 | Neues Profil, Startseite öffnen; „Importieren…“; dann das ×; Tessera neu starten | Die Karte steht unter dem Titel; „Importieren…“ öffnet die Einstellungen in einem neuen Tab und scrollt zum Abschnitt Import. Nach × ist sie weg und bleibt nach dem Neustart weg (auch nach einem erfolgreichen Import). Ein bestehendes Profil sieht die Karte nach dem Update einmal |
| U24 | „Gespeicherte Passwörter verwalten“ im Import-Abschnitt | Öffnet die Passwortseite; der CSV-Import dort ist der einzige Weg für Passwörter |
| U22 | `Strg+Shift+A` (macOS `Cmd+Shift+A`), dann „Fenster → Tabs durchsuchen…“ im Menü | Beide öffnen das Panel über dem Fenster, das Feld hat den Fokus, alle Tabs des Fensters stehen darin; die Seiten dahinter sind ausgeblendet und kommen beim Schließen zurück |
| U22 | Im Panel nach einem Teil des Titels, dann nach einem Teil der Adresse tippen; Pfeil runter/hoch, Enter; einmal mit Maus klicken; einmal Escape | Die Liste filtert bei jedem Tastendruck; Enter öffnet die markierte Zeile (ohne Pfeil die erste), Klick öffnet die Zeile, Escape schließt ohne Wechsel und verlässt dabei kein geteiltes Layout |
| U22 | Eine Gruppe einklappen, dann per Tab-Suche einen ihrer Tabs öffnen | Der Tab ist gefunden, die Gruppe klappt auf, der Tab ist aktiv und im Streifen zu sehen |
| U22 | So viele Tabs öffnen, dass der Streifen überläuft; per `Strg+Tab`, `Strg+1`…`9` und Tab-Suche zu Tabs am anderen Ende wechseln | Der aktive Tab rutscht jedes Mal in den sichtbaren Teil und steht nicht unter dem Verlauf; an einer Kante mit weiteren Tabs läuft der Streifen weich aus, ohne Überlauf gibt es keinen Verlauf, am Ende des Streifens nur auf der anderen Seite |
| U22 | **Windows:** Mausrad über dem Tab-Streifen, einmal über einem Tab, einmal über der leeren Fläche rechts vom letzten Tab (Drag-Region) | Über den Tabs scrollt der Streifen seitwärts. Festhalten, ob das Rad auch über der Drag-Region ankommt; `-webkit-app-region: drag` kann dort alle Mausereignisse schlucken |
| U22 | **Windows:** einen Tab an den rechten, dann den linken Rand des übervollen Streifens ziehen und dort still halten; dann loslassen | Der Streifen scrollt weiter, solange der Zeiger am Rand ruht, und hört auf, sobald er zurückweicht; die Einfügemarke folgt; Loslassen sortiert an der markierten Stelle ein. Festhalten, ob das Ziehen über der Drag-Region abreißt (Fenster wird verschoben statt Tab gezogen) |
| U22 | macOS: `Cmd+Shift+A` mit Fokus in einer Seite | Das Panel öffnet sich (der Menüeintrag fängt die Taste vor der Seite ab) |
| U21 | Layout `2x2` mit drei belegten Kacheln, einen Teiler verschieben; Layout-Menü → „Speichern als…“, Namen eingeben, Enter | Das Feld hat sofort den Fokus; danach steht der Name mit dem 2×2-Symbol unter den Layouts. Das Menü sitzt vollständig im Fenster, auch nachdem die Liste nachgeladen wurde (nichts abgeschnitten, keine Bildlaufleiste) |
| U21 | Tabs schließen und andere öffnen, dann den Workspace im Menü wählen | Wieder `2x2` mit dem verschobenen Teiler, die drei Seiten an ihrem Platz, die vierte Kachel leer; ein schon offener Tab mit derselben Adresse wird genommen, nicht doppelt geöffnet; kein Tab ist geschlossen, die übrigen stehen weiter im Streifen |
| U21 | Tessera beenden und neu starten (Sitzungswiederherstellung aus), Workspace öffnen | Er ist noch da und öffnet wie vorher |
| U21 | „Speichern als…“ mit einem schon vergebenen Namen (auch in anderer Groß/Kleinschreibung); einmal „Abbrechen“, einmal „Speichern“ | Die Rückfrage „„Name“ ersetzen?“ erscheint; Abbrechen führt zurück ins Feld, der alte Workspace bleibt; Speichern ersetzt ihn an seiner Stelle |
| U21 | Privates Fenster: Layout-Menü öffnen | „Speichern als…“ ist ausgegraut; ein gespeicherter Workspace öffnet trotzdem im privaten Fenster |
| U21 | Workspace mit × entfernen; `workspaces.json` im Profilordner | Er verschwindet aus der Liste; die Datei ist versiegelt wie die übrigen |
| U21 | In `workspaces.json` (mit einem unversiegelten Profil) `"version": 2` setzen, neu starten, Layout-Menü öffnen | Die Workspaces stehen da und öffnen; „Speichern als…“ ist aus, darunter „Von einer neueren Version: nur lesbar.“, kein × |
| U21 | Mit Pfeiltasten durch das Layout-Menü | Die Pfeile erreichen nach den Layouts die Workspaces und „Speichern als…“ (nicht, wenn ausgegraut) |

## Bekannte Risiken

| Risiko | Warum es offen ist |
|---|---|
| `setFullScreenable(false)` als Mechanismus für Kachel-Vollbild — **auf Windows bestätigt**, Linux offen | Vom Benutzer am 29.07.2026 gemeldet: „auf windows klappen die full screens innerhalb der kacheln." Damit ist das größte Unbekannte dieses Risikos abgeräumt — der Mechanismus trägt auf zwei von drei Plattformen. Offen bleibt **Linux, besonders Wayland**, wo ein Compositor die Fenstergröße anders verhandelt. Erster Punkt in `docs/QA.md` |
| **Ein Player im Vollbild passt sich einer geänderten Kachelgröße nicht an** | Ebenfalls am 29.07.2026 gemeldet, und es ist die Kehrseite des Befundes darüber: das Kachel-Vollbild trägt, aber der Inhalt darin folgt nicht immer. Ursache und was auf unserer Seite möglich ist, steht unter „Vollbild und Kachelgröße" |
| **`grantFileProtocolExtraPrivileges` bleibt an** (seit 23.09.2026 benannt) | Die Chrome-UI lädt über `file://` und braucht das Fuse vermutlich für ihre Module. Solange es an ist, darf ein `file://`-Dokument in einem Tab andere lokale Dateien per `fetch` lesen, etwa eine heruntergeladene HTML-Datei die unverschlüsselten Profildateien. Offene Produktfrage an den Benutzer: `file:` aus der Tab-Navigation nehmen, bis die Chrome-UI auf ein eigenes Schema umgezogen ist. Siehe Plan, Open Questions |
| Optische Transparenz der Overlay-Schicht | Braucht einen Screenshot des zusammengesetzten Fensters; Bildschirmaufnahme ist in der Entwicklungsumgebung blockiert. Funktional belegt, optisch nicht |
| ~~Die Ziehprüfung im Smoke-Test flackert~~ **behoben, und die Ursache war dieselbe wie bei den Store-Tests** | Zwei von vier Läufen fielen durch, jedes Mal an einer *anderen* Zone — was nach Produktfehler aussieht und eine Stoppuhr war: nach dem Mausdruck wartete die Prüfung fest 600 ms darauf, dass die Zonen über `overlay:presented` zurückkommen, und weitere 350 ms darauf, dass die Overlay-Schicht die Hervorhebung zeichnet. Auf einer belasteten Maschine reicht keins von beidem. Jetzt wird auf den **Zustand** gewartet (`waitFor`), nicht auf die Uhr — und der letzte Messwert wird zurückgegeben statt zu werfen, damit die Zusicherung des Aufrufers die Fehlermeldung bleibt. Fünf Läufe hintereinander grün, 440 Prüfungen |
| ~~Tab-Gruppen überleben keinen Neustart~~ **behoben** | Die Sitzungswiederherstellung rekonziliert sie. Die damals genannte Gefahr — fremde neue Tabs in alten Gruppen — ist der Grund für die Reihenfolge in `session-restore/apply.ts`: jede wiederhergestellte Id muss existieren, *bevor* `retainTabs` läuft, und `retainTabs` läuft **einmal** mit der Vereinigung aller Fenster. Pro Fenster gerufen würde das zweite die Gruppen des ersten leerräumen |
| ~~Von Webinhalten erreichbare interne Seiten~~ **geschlossen** | `will-frame-navigate` und `will-redirect` sperren jetzt, und die zweite, hier nie notierte Hälfte — `history:open`/`bookmarks:open` nahmen jede URL — ist im Vertrag geschlossen. Siehe „Navigationssperre zu `tessera://`" |
| **Zoom: zwei Kacheln auf demselben Host teilen den lebenden Faktor** | Chromiums Zoomkarte ist pro Ursprung. Neu mit „Zoom pro View" und nicht behebbar, ohne eine Brücke in eine besuchte Seite zu legen. Siehe „Offene Fragen" |
| **`about` und `https-only` liefern 404** | Erledigt (Roadmap U7, U8) |
| Drei Größenbudgets angehoben | Preload 16→22 kB, Hauptprozess 200→250→320 kB, größte Datei 750→780 Zeilen. Jede mit Begründung *und* mit dem nächsten Schritt im Kommentar — was eine weitere Anhebung rechtfertigen würde und was nicht |
| **Sechs Budgets stehen darüber, absichtlich nicht angehoben** | Nach diesem Durchgang: größte Datei **1036 Zeilen** (Grenze 780, vorher 1219), Dateien über der Marke **5** (1, vorher 6), ungetestete Renderer-Zeilen **3900** (2800, unverändert). Die drei Größenzahlen — Hauptprozess 375 kB, Renderer-JavaScript 339 kB, Preload 26 kB — **sind nicht neu gemessen**: `pnpm build` konnte in diesem Durchgang nicht laufen, `metrics.mjs` liest also ein Bündel von vor dieser Arbeit. Sie sind zu erneuern, bevor jemand sie zitiert. Die Kommentare nennen ihren nächsten Schritt selbst, und keiner davon ist „höher setzen" — beim Hauptprozess das Laden der Manifest-Auswertung des Medien-Downloaders auf Abruf. **Beim Preload nennt der Kommentar den Rollen-Split, und der ist gebaut**; dort steht jetzt keine bekannte nächste Maßnahme mehr, siehe „Preload-Budget". Die 320 wurden bereits *für* dieses Funktionsbündel angehoben; eine dritte Anhebung dafür wäre keine Begründung mehr, sondern eine Gewohnheit |
| **Die Zeilen-Marke maß nur die schlimmste Datei** | Ein Fund aus einer früheren Runde, und er war schlimmer als er aussah. Die Marke gilt *pro Datei*, gemessen wurde aber nur das Maximum — sobald eine Datei darüber stand, konnte jede weitere lautlos vorbeiziehen. Genau das war passiert: `shared/tabgroups/model.ts` erreichte 873 Zeilen, vierzig Zeilen davon entfernt, überhaupt gemeldet zu werden, während die Zahl auf dem Schirm weiter `catalog.ts` nannte. Neue Prüfung `files over the per-file line bar`. Nach diesem Durchgang **fünf**, und `catalog.ts` ist ganz von der Liste verschwunden (1219 → 94): `contract.ts` (1036), `BrowserWindowController.ts` (1034), `tabgroups/model.ts` (954), `main/index.ts` (953), `PasswordsPage.tsx` (788). Zu beachten: die neue Spitzenreiterin `contract.ts` ist die erste, für die **kein nächster Schritt aufgeschrieben** ist |
| Mutationslauf ist älter als drei Funktionsbündel | Die Stryker-Liste ist eine **Erlaubnisliste**: eine Auslassung ist unsichtbar, und die Fitness-Funktion, die jeden Eintrag gegen eine echte Datei prüft, kann das Fehlen eines Eintrags nicht sehen. `crypto/**`, `passwords/**` und die Update-Module sind eingetragen, und seit diesem Durchgang auch `tabgroups/strip.ts`, `tabgroups/schema.ts` und `browser/navigation-policy.ts`. Der letzte Lauf (84,88 %) liegt vor dem Tresor und damit erst recht vor diesem Durchgang |

## Qualitätsstand

**Stand 24.09.2026.** Letzter voller Testlauf: **6126 grün in 203 Dateien**. Die Bündelgrößen sind am
Build vom 24.09.2026 gemessen und stehen unter „Roadmap Herbst 2026": Main-Prozess 527,45 kB (Budget 320),
Renderer-JavaScript 371 kB (320), Preload 41,6 kB (22), Chrome-Preload 3,3 kB (5), Katalog 45,12 kB (48).
Coverage und Mutationsbewertung sind in diesem Durchgang nicht neu gemessen; die Tabelle darunter ist der
Stand vom 29.07.2026.

Neu gemessen am Ende des dritten Durchgangs (29.07.2026). **Eine Ausnahme, unverändert wichtig:** `pnpm build`
konnte auch diesmal nicht laufen, also sind die vier Bündelgrößen die vom 28.07. — sie beschreiben
einen Stand vor zwei Durchgängen Arbeit. Alles andere ist frisch.

| Prüfung | Ergebnis | Vorher |
|---|---|---|
| typecheck | vier Projekte sauber | gleich |
| lint | sauber (`--max-warnings 0`) | gleich |
| Tests | **4157 grün**, 2 bedingt übersprungen (**142 Dateien**) | 4106 / 142 |
| Zeilen-Coverage | **95,97 %** (Schwelle 90 %) | 95,98 % |
| Branch-Coverage | **95,05 %** (Schwelle 85 %) | 95,13 % |
| Metriken | **9 von 15** — sechs über der Marke, keine angehoben | 9 von 15 |
| Größenmetriken | **nicht neu gemessen** — `pnpm build` lief nicht | — |
| Mutations-Score | 85 % (Schwelle 70 %) — Lauf steht weiterhin aus; seit Roadmap Herbst 2026 **82,89 %** (24.09.2026, `8a46262`), siehe dort | gleich |
| Smoke-Test in echter App | **nicht gelaufen** (Vorgabe des Benutzers) | gleich |

**Eine Metrik ist schlechter geworden, und das gehört hierher und nicht in eine Fußnote.** Die größte
Datei stand am Ende des zweiten Durchgangs bei **1036** Zeilen und steht jetzt bei **1064**. Beide
Verursacher sind bestellte Arbeit: `contract.ts` wuchs um die Beschreibungsfelder und den
Update-Kanal, `BrowserWindowController.ts` um die Verdrahtung des ⌘W-Ersatzwegs.

Die Hälfte davon ist zurückgeholt, und zwar nicht durch Verschieben von Zeilen, sondern durch eine
Trennung, die ohnehin richtig ist: das Wire-Schema von `SettingDescriptor` liegt jetzt in
`shared/settings/schema.ts` statt inline im Vertrag (1079 → 1054), nach demselben Muster wie
`tabgroups/schema.ts` und aus demselben Grund — `control.ts` ist bewusst zod-frei, weil es der
Renderer importiert. Ebenso ist der Update-Handler nach `ipc/update-handlers.ts` gegangen, wie es
`media-handlers.ts` und `download-handlers.ts` vormachen; `handlers.ts` war mit 787 Zeilen über die
Marke gerutscht und steht wieder bei 772. **Dateien über der Marke sind dadurch bei 5 geblieben und
nicht auf 6 gestiegen.**

Nicht zurückgeholt sind die 28 Zeilen, um die die größte Datei jetzt über ihrem Stand von vorhin
liegt. `BrowserWindowController.ts` ist wieder die Spitzenreiterin, und für sie ist der nächste
Schritt benannt — weiter zerlegen, wie `#wireWindowEvents` es vorgemacht hat.

**Und der Vertrag hat jetzt einen benannten nächsten Schritt**, den er im letzten Durchgang noch
nicht hatte: die verbleibenden Inline-Schemata in Geschwister-`schema.ts`-Module ziehen, wie es für
`SettingDescriptor` gerade geschehen ist. Damit ist keine der fünf Dateien über der Marke mehr ohne
Antwort auf „und wie wird sie kleiner".

**Zwei neue Untergrenzen** in `vitest.config.ts`, beide bei 100 %: `browser/page-keys.ts` und
`browser/SplitController.ts` — die Escape-Leiter und die Tasten, die sie treiben, waren beide falsch,
ohne dass ein Test es sehen konnte. `TileFullscreenController.ts` steht bewusst **nicht** dort: es
liegt bei 85,7 % Zweigen auf einem unerreichbaren Null-Wächter, und eine Zahl darunter würde den
Wächter ratifizieren statt ihn zu entfernen.

## Der Befund dieser Runde

Drei Dinge, und wie beim letzten Mal sind es überwiegend Aussagen über dieses Dokument.

**Erstens: ein Eintrag hat Doppelarbeit bestellt.** Der Rollen-Split des Preloads stand an vier Stellen
als „der Weg" und „die nächste Aufgabe" — gebaut war er seit dem Init-Commit, mit zweitem Bundle, eigenem
Budget und einer 148-zeiligen Fitness-Funktion darüber. Der Unterschied zum letzten Befund ist der Preis:
Erledigtes als offen zu führen war bisher irreführend, hier wäre es teuer geworden. Die Prüfung vor der
Arbeit hat das abgefangen, und deshalb ist sie die Regel, nicht die Ausnahme.

**Zweitens: die interessanteste Entscheidung war, etwas *nicht* zu bauen.** Für die Multi-View-Gruppe
sagte dieses Dokument zwei Begriffe voraus, eine einmalige Verdrängungsaufnahme und eine dauerhafte
Gruppenanordnung, und nannte das „der eigentliche Entwurf". Gebaut wurde einer. Sobald die Anordnung bei
jedem Settle neu geschrieben wird, kann sie nicht veralten — und die ganze Begründung für das Verbrauchen
fällt weg, mitsamt dem zweiten Begriff und mitsamt der separat beauftragten Änderung „`keepArrangement`
aus `setCollapsed` rufen", die damit ersatzlos überflüssig wurde. Ein Auftrag, der sich beim Bauen
auflöst, ist ein besseres Ergebnis als einer, der ausgeführt wird.

Dasselbe Muster ein zweites Mal, kleiner: die beauftragte Fitness-Funktion „keine Schaltfläche darf eine
Aktion aus einer Liste toter Tasten nennen" nannte eine Liste, die es nicht gibt. Als Bestellung gebaut
wäre sie an einer legitimen Stelle falsch-positiv gefallen. Gebaut wurde die Umkehrung, mit einer
**berechneten** statt gepflegten Menge — weil genau eine gepflegte Ausnahmeliste hier schon einmal acht
Aktionen ungeprüft gelassen hat.

**Drittens: zwei Fehler, die niemand gemeldet hatte, und beide standen an einer Naht.**

Der eine ist eine Rechteausweitung, die kein `will-navigate`-Handler je gefunden hätte, weil sie kein
Webinhalt ist: `history:open` nahm jede URL, `resolveOmniboxInput` reicht `tessera:` durch, also konnte
die Verlaufsseite sich selbst nach `tessera://settings` navigieren. Die Lücke, die dieses Dokument
seitenlang beschrieb, war die halbe Lücke.

Der andere ist ein Wort mit zwei Bedeutungen. `#firstHiddenTab` prüfte „hat keine Kachel" und meinte
„geladen, aber nicht sichtbar" — Mitglieder einer eingeklappten Gruppe haben aber ebenfalls keine Kachel,
weil `setCollapsed` sie absichtlich freigibt. Also setzte ein Layoutwechsel genau den Tab zurück in eine
Kachel, der eben weggeklappt worden war, und stellte den Zustand her, den `setCollapsed` in seinem
eigenen Kommentar zu verhindern verspricht. Der Kommentar war richtig, der Code hielt ihn nicht, und
zwischen beiden lag nur ein Adjektiv. Gefunden wurde er nicht durch einen Test, sondern weil die neue
Absorptionsregel ihn verschlimmert hätte.

**Und eine Zahl, die dieses Dokument bewusst nicht nennt.** Drei der sechs gerissenen Budgets sind die
Bündelgrößen, und die konnten nicht neu gemessen werden — `pnpm build` lief in diesem Durchgang nicht.
Sie stehen im Qualitätsstand als das, was sie sind: Werte von vorher. Eine Zahl von gestern als heutige
auszugeben ist der Fehler, den dieses Dokument schon dreimal gemacht hat.
