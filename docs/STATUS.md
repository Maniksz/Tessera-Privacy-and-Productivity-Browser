# Stand der Arbeit

Vollständige Durchsicht aller angemerkten Punkte: was gebaut ist, wie es belegt wurde, und was
offen ist. Gepflegt bei jedem Durchgang; die Reihenfolge folgt der Reihenfolge, in der die Punkte
gemeldet wurden.

**Legende** — ✅ gebaut und belegt · 🟡 teilweise · ⬜ offen · ❓ braucht eine Entscheidung · ⛔ verworfen

> **Zuletzt gegen den Code geprüft:** 29.07.2026 (dritter Durchgang desselben Tages). Jeder Punkt, der in
> diesem Durchgang angefasst wurde, ist vor der Arbeit gegen die Datei geprüft worden — und in vier Fällen
> stimmte der Eintrag nicht mehr. Wer diesen Kasten liest und das Datum alt findet, sollte den Tabellen
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
| 12 | Der Browser braucht einen Namen | ❓ | **Vorarbeit fertig**: `src/shared/product.ts` ist die eine Quelle für Name, Schema und appId; drei Fitness-Funktionen halten das fest, samt namentlicher Schuldenliste, die nur schrumpfen kann. Die Umbenennung ist damit eine Zeile plus zwei Paketdateien. Der Name selbst braucht deine Entscheidung |
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
| DOM-Elemente selbst blocken wie uBO | ✅ Der Element-Picker schreibt über `cosmeticRuleFor` in den `UserRuleStore`, `onChange` ruft `filterSubscription.reloadUserRules()`, `FilterEngine` liest sie als eigenen Listenkörper. Zwei Grenzen sind Absicht: `describeUserRule` verweigert jede Regel, die eine *Netzanfrage* blocken würde (eine selbstgeschriebene Netzregel kann eine Seite unreparierbar machen), und ohne Host gibt es keine Regel — eine generische hätte den Selektor überall versteckt. Ein privates Fenster bekommt über `editorFor` seinen eigenen Editor |

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

Drei Entscheidungen des Benutzers, mit ihren Kosten:

- **Eine Gruppe entsteht, sobald gekachelt ist** — nicht nur beim Teilen, auch nach einer
  Sitzungswiederherstellung. Kosten: ab zwei belegten Kacheln steht ein Farbchip im Streifen, auch wenn
  niemand eine Gruppe wollte.
- **Gemischte Herkunft nimmt immer die bestehende Gruppe** und die losen Tabs treten ihr bei. Das kehrt
  die alte Verweigerung um. Kosten, ausdrücklich akzeptiert: eine benannte Gruppe bekommt Mitglieder, die
  der Benutzer nicht selbst hinzugefügt hat, und der Streifen sortiert sich um. Das alte Argument ist im
  Code stehen geblieben statt gelöscht zu werden — es war nicht falsch, es wurde überstimmt.
- **Zwei verschiedene Gruppen unter den Kacheln nehmen weiterhin nichts auf.** Das ist die eine Stelle,
  an der die konservative Lesart gewählt wurde: die Entscheidung des Benutzers betraf Gruppenmitglieder
  gemischt mit *losen* Tabs. Zwei selbstgebaute Gruppen zu verschmelzen zerstört eine davon
  (`addTabToGroup` löst eine leergeräumte Quellgruppe auf) und hat kein Zurück.

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
| **…aber die Anordnung darf dabei nicht verloren gehen** | Nachtrag des Benutzers: „er soll die layout gruppe der anderen tabs nicht auflösen, daher brauchen wir ja die tab gruppen." Die weggelegten Kacheln blieben geladen und im Streifen, aber *welches Layout* und *welche Kachel je Tab* war weg — es gab keinen Weg zurück. Die Anordnung gehört damit auf die **Tab-Gruppe**: beim Wegräumen aufnehmen (bestehende Gruppe wiederverwenden, sonst eine anlegen), beim Zurückkehren auf einen Gruppen-Tab wiederherstellen. Ohne die zweite Hälfte ist es eine Erinnerung, die niemand lesen kann. **Gebaut und in der echten App belegt** — `TabGroup.layout` trägt Layout-Id und einen Eintrag je Kachel, `keepArrangement` nimmt beim Wegräumen auf, `takeArrangementFor` gibt beim Anklicken zurück — und *verbrauchte* die Aufnahme dabei, damit eine zweite Aktivierung nicht spätere Arbeit zurücknimmt. **Das gilt seit dem zweiten Durchgang des 29.07.2026 nicht mehr:** die Anordnung wird bei jedem Settle neu geschrieben, kann also nicht veralten, und wird deshalb nicht mehr verbraucht. Der Smoke-Test fährt die Schleife, die ein Benutzer fährt: zurück zur verdrängten Seite → Anordnung ist da; ein Tab **ohne** Aufnahme → weiterhin ganzes Fenster; zweite Verdrängung → Anordnung kommt wieder |
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
| **Zwei Kacheln auf demselben Host teilen den lebenden Zoomfaktor** | Chromiums Zoomkarte ist pro Ursprung und pro Sitzung. Die gespeicherten Werte sind getrennt und setzen sich bei der nächsten Navigation durch, aber solange beide auf demselben Host stehen, gewinnt der zuletzt gezoomte. Trennen ließe sich das nur über Chromiums isolierten Zoom-Modus, den Electron nicht freigibt, oder über `webFrame` aus dem Inhalts-Preload — eine Brücke in einer besuchten Seite, die Spezifikation 6 verbietet. **Zu entscheiden: leben wir damit** |
| **Gruppen-Chips bei jeder Kachelung** | Folge der Entscheidung „eine Gruppe entsteht, sobald gekachelt ist". Erwartbar sind ein bis drei Chips pro Sitzung, nicht einer pro Teilung — `reuse` fängt die Wiederholung ab. Ob das im Streifen als Ordnung oder als Lärm ankommt, sieht man erst in der Benutzung |
| **`about` und `https-only` liefern 404** | Beide stehen in `KNOWN_PAGES`, haben aber keine HTML-Datei und keinen Vite-Eintrag. Betrifft den „Über"-Menüeintrag und die **HTTPS-only-Zwischenseite**. Gefunden bei der Navigationssperre, bewusst nicht mitgebaut — es ist eine fehlende Seite, keine Sperre |
| **Der Trackpad-Pinch zoomt nicht** | `zoom-changed` ist laut Electron ein Mausrad-Ereignis; ein Pinch nimmt diesen Weg nie. Der einzige Hebel ist `input-event` mit `gesturePinchUpdate`, dessen typisierte Nutzlast aber keinen Skalierungsfaktor trägt — die Richtung käme aus einem Feld, das die Typdatei nicht zusagt. **Zu entscheiden: bauen wir auf eine unzugesagte Laufzeitform, mit einem Test, der rot wird, wenn sie verschwindet** |
| **Vollbild verlassen über den Knopf des Players** | Der Tastaturweg ist behoben. Bleibt das Symptom, wenn man das Video über seinen eigenen Knopf verkleinert, liegt es in Electrons Buchhaltung (C++, nicht prüfbar von hier). Bewusst nicht blind behoben — der Fix hätte die Beweislage zerstört. **Braucht eine Beobachtung aus der echten App** |
| **`TileFullscreenController` hat einen unerreichbaren Zweig** | 85,7 % Zweige, weil `escape()` `fullscreenTile` liest, nachdem das Urteil es schon als nicht-null bewiesen hat. Deshalb *keine* Untergrenze eingetragen — eine Zahl unter 100 dort würde den Zweig ratifizieren statt ihn zu entfernen. Ihn zu entfernen hieße, `SplitController.escape()` die Kachel mit dem Urteil zurückgeben zu lassen |
| **`stable` bekommt eine falsche Antwort** | GitHubs „latest release" schließt Vorabversionen aus, und bisher ist jede Freigabe eine. Wer den Kanal auf `stable` stellt, hört für immer „keine neue Version" — und der neue Knopf macht diese Antwort viel sichtbarer. Der Hinweis neben dem Knopf mildert es; der **Dialog** sagt es weiterhin falsch. Sauber wäre eine eigene Meldung (~240 Bytes gegen ~190 freie) oder `stable` gar nicht anzubieten, solange es keine Nicht-Vorabversion gibt |
| **Die Katalog-Teilung ist noch nicht bezahlt** | Die Quelle ist geteilt, das Bündel nicht: `catalogs` nennt beide Sprachen eifrig. Erst faules Nachladen der zweiten Sprache senkt Renderer-JavaScript, und der Katalog wird vor dem ersten Zeichnen geholt — also mit Risiko |

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
| Der Name und das echte App-Symbol | Zurückgestellt — „lassen wir erstmal so" | unverändert |
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

## Bekannte Risiken

| Risiko | Warum es offen ist |
|---|---|
| `setFullScreenable(false)` als Mechanismus für Kachel-Vollbild — **auf Windows bestätigt**, Linux offen | Vom Benutzer am 29.07.2026 gemeldet: „auf windows klappen die full screens innerhalb der kacheln." Damit ist das größte Unbekannte dieses Risikos abgeräumt — der Mechanismus trägt auf zwei von drei Plattformen. Offen bleibt **Linux, besonders Wayland**, wo ein Compositor die Fenstergröße anders verhandelt. Erster Punkt in `docs/QA.md` |
| **Ein Player im Vollbild passt sich einer geänderten Kachelgröße nicht an** | Ebenfalls am 29.07.2026 gemeldet, und es ist die Kehrseite des Befundes darüber: das Kachel-Vollbild trägt, aber der Inhalt darin folgt nicht immer. Ursache und was auf unserer Seite möglich ist, steht unter „Vollbild und Kachelgröße" |
| Optische Transparenz der Overlay-Schicht | Braucht einen Screenshot des zusammengesetzten Fensters; Bildschirmaufnahme ist in der Entwicklungsumgebung blockiert. Funktional belegt, optisch nicht |
| ~~Die Ziehprüfung im Smoke-Test flackert~~ **behoben, und die Ursache war dieselbe wie bei den Store-Tests** | Zwei von vier Läufen fielen durch, jedes Mal an einer *anderen* Zone — was nach Produktfehler aussieht und eine Stoppuhr war: nach dem Mausdruck wartete die Prüfung fest 600 ms darauf, dass die Zonen über `overlay:presented` zurückkommen, und weitere 350 ms darauf, dass die Overlay-Schicht die Hervorhebung zeichnet. Auf einer belasteten Maschine reicht keins von beidem. Jetzt wird auf den **Zustand** gewartet (`waitFor`), nicht auf die Uhr — und der letzte Messwert wird zurückgegeben statt zu werfen, damit die Zusicherung des Aufrufers die Fehlermeldung bleibt. Fünf Läufe hintereinander grün, 440 Prüfungen |
| ~~Tab-Gruppen überleben keinen Neustart~~ **behoben** | Die Sitzungswiederherstellung rekonziliert sie. Die damals genannte Gefahr — fremde neue Tabs in alten Gruppen — ist der Grund für die Reihenfolge in `session-restore/apply.ts`: jede wiederhergestellte Id muss existieren, *bevor* `retainTabs` läuft, und `retainTabs` läuft **einmal** mit der Vereinigung aller Fenster. Pro Fenster gerufen würde das zweite die Gruppen des ersten leerräumen |
| ~~Von Webinhalten erreichbare interne Seiten~~ **geschlossen** | `will-frame-navigate` und `will-redirect` sperren jetzt, und die zweite, hier nie notierte Hälfte — `history:open`/`bookmarks:open` nahmen jede URL — ist im Vertrag geschlossen. Siehe „Navigationssperre zu `tessera://`" |
| **Zoom: zwei Kacheln auf demselben Host teilen den lebenden Faktor** | Chromiums Zoomkarte ist pro Ursprung. Neu mit „Zoom pro View" und nicht behebbar, ohne eine Brücke in eine besuchte Seite zu legen. Siehe „Offene Fragen" |
| **`about` und `https-only` liefern 404** | In `KNOWN_PAGES`, ohne HTML-Datei. Trifft den „Über"-Eintrag und die HTTPS-only-Zwischenseite. Bei der Navigationssperre gefunden, bewusst nicht mitgebaut |
| Drei Größenbudgets angehoben | Preload 16→22 kB, Hauptprozess 200→250→320 kB, größte Datei 750→780 Zeilen. Jede mit Begründung *und* mit dem nächsten Schritt im Kommentar — was eine weitere Anhebung rechtfertigen würde und was nicht |
| **Sechs Budgets stehen darüber, absichtlich nicht angehoben** | Nach diesem Durchgang: größte Datei **1036 Zeilen** (Grenze 780, vorher 1219), Dateien über der Marke **5** (1, vorher 6), ungetestete Renderer-Zeilen **3900** (2800, unverändert). Die drei Größenzahlen — Hauptprozess 375 kB, Renderer-JavaScript 339 kB, Preload 26 kB — **sind nicht neu gemessen**: `pnpm build` konnte in diesem Durchgang nicht laufen, `metrics.mjs` liest also ein Bündel von vor dieser Arbeit. Sie sind zu erneuern, bevor jemand sie zitiert. Die Kommentare nennen ihren nächsten Schritt selbst, und keiner davon ist „höher setzen" — beim Hauptprozess das Laden der Manifest-Auswertung des Medien-Downloaders auf Abruf. **Beim Preload nennt der Kommentar den Rollen-Split, und der ist gebaut**; dort steht jetzt keine bekannte nächste Maßnahme mehr, siehe „Preload-Budget". Die 320 wurden bereits *für* dieses Funktionsbündel angehoben; eine dritte Anhebung dafür wäre keine Begründung mehr, sondern eine Gewohnheit |
| **Die Zeilen-Marke maß nur die schlimmste Datei** | Ein Fund aus einer früheren Runde, und er war schlimmer als er aussah. Die Marke gilt *pro Datei*, gemessen wurde aber nur das Maximum — sobald eine Datei darüber stand, konnte jede weitere lautlos vorbeiziehen. Genau das war passiert: `shared/tabgroups/model.ts` erreichte 873 Zeilen, vierzig Zeilen davon entfernt, überhaupt gemeldet zu werden, während die Zahl auf dem Schirm weiter `catalog.ts` nannte. Neue Prüfung `files over the per-file line bar`. Nach diesem Durchgang **fünf**, und `catalog.ts` ist ganz von der Liste verschwunden (1219 → 94): `contract.ts` (1036), `BrowserWindowController.ts` (1034), `tabgroups/model.ts` (954), `main/index.ts` (953), `PasswordsPage.tsx` (788). Zu beachten: die neue Spitzenreiterin `contract.ts` ist die erste, für die **kein nächster Schritt aufgeschrieben** ist |
| Mutationslauf ist älter als drei Funktionsbündel | Die Stryker-Liste ist eine **Erlaubnisliste**: eine Auslassung ist unsichtbar, und die Fitness-Funktion, die jeden Eintrag gegen eine echte Datei prüft, kann das Fehlen eines Eintrags nicht sehen. `crypto/**`, `passwords/**` und die Update-Module sind eingetragen, und seit diesem Durchgang auch `tabgroups/strip.ts`, `tabgroups/schema.ts` und `browser/navigation-policy.ts`. Der letzte Lauf (84,88 %) liegt vor dem Tresor und damit erst recht vor diesem Durchgang |

## Qualitätsstand

Neu gemessen am Ende des dritten Durchgangs. **Eine Ausnahme, unverändert wichtig:** `pnpm build`
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
| Mutations-Score | 85 % (Schwelle 70 %) — Lauf steht weiterhin aus | gleich |
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
