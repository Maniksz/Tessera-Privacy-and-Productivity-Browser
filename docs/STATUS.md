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

| Bereich | Stand | Was fehlt |
|---|---|---|
| Settings und Erweiterungen als eigene Tabs | 🟡 | Panel und Tab sollen **dieselbe** Komponente rendern, damit nichts auseinanderläuft |
| Pro-Kachel-Navigationsleiste | 🟡 | Entschieden: auf der Overlay-Schicht bei Bedarf. Braucht zusätzlich einen Tastaturweg, sonst ist es ein Feature nur für die Maus (Spec 7) |
| Sitzungswiederherstellung | ⬜ | Einstellung vorhanden. **Blockiert die Tab-Gruppen**: Tab-IDs beginnen bei jedem Start wieder bei `tab-1`, also wird jede gespeicherte Gruppe beim Start geleert — die ehrliche Folge einer fehlenden Funktion, siehe `retainTabs` |
| Lesezeichen, Downloads, Passwörter | ⬜ | Protokollnamen reserviert, Seiten fehlen |
| Lesemodus, Suchen-in-Seite | ⬜ | Menüeinträge vorhanden |

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
Fehlerbericht.

| Punkt | Was zu tun ist |
|---|---|
| **Kachelleiste nur im Kachelmodus** | Bei einem einzigen Tab hat die Leiste keinen Zweck — die obere Werkzeugleiste steuert dieselbe Seite. `tileBarStep` müsste zusätzlich auf `split.tileCount > 1` prüfen; die Entscheidung gehört dorthin und nicht in die Oberfläche |
| **Leiste früher ausfahren** | `TILE_BAR_REVEAL_WITHIN` ist 6 px, das ist zu knapp am Rand. Höher setzen — und dabei prüfen, dass `TILE_BAR_POINTER_AWAY` weiterhin darüber liegt, sonst flackert die Leiste |
| **Neuer Tab soll ein neuer Tab sein** | Widerspricht dem aktuellen Verhalten: `TileOccupancyController` füllt leere Kacheln absichtlich, weil drei Kacheln mit „zieh einen Tab hierher" eine Anweisung statt eines Browsers waren. Der Wunsch ist aber klar — ein neuer Tab gehört ins **volle** Layout, nicht in eine Kachel. Betrifft auch Gruppen-Tabs. Das ist eine bewusste Umkehr einer früheren Entscheidung und braucht: neuer Tab → Layout `1x1`, und die Kachelfüllung nur noch beim ausdrücklichen Layoutwechsel |
| **Ziehen auf die mittlere Kachel geht nicht** | Fehlerbericht. `SPLIT_TARGETS` in `dropzones.ts` gibt jeder Kachel Randzonen; bei drei oder vier Spalten hat die mittlere links *und* rechts Nachbarn, und dort ist der Verdacht. Zu tun: **jede** Ziehmöglichkeit in jedem Layout durchtesten, nicht nur die gemeldete — der Smoke-Test prüft heute `1+2` und `2x2` und keine der mittleren Kacheln von `1x3` und `1x4` |

## Bekannte Risiken

| Risiko | Warum es offen ist |
|---|---|
| `setFullScreenable(false)` als Mechanismus für Kachel-Vollbild ist **nur auf macOS geprüft** | Windows und Linux, besonders Wayland-Compositor, sind das größte Unbekannte. Erster Punkt in `docs/QA.md` |
| Optische Transparenz der Overlay-Schicht | Braucht einen Screenshot des zusammengesetzten Fensters; Bildschirmaufnahme ist in der Entwicklungsumgebung blockiert. Funktional belegt, optisch nicht |
| Die 2×2-Ziehprüfung im Smoke-Test flackert | Ein Lauf von drei fiel durch, zwei grün. Zeitkritisch, nicht kaputt — aber noch nicht stabil, und ein flackernder Test ist auf Dauer ein ignorierter Test |
| Tab-Gruppen überleben keinen Neustart | Nicht ein Fehler, sondern die fehlende Sitzungswiederherstellung. Die Alternative wäre schlimmer: fremde neue Tabs in alten Gruppen |
| Drei Größenbudgets angehoben | Preload 16→22 kB, Hauptprozess 200→250 kB, größte Datei 750→780 Zeilen. Jede mit Begründung *und* mit dem nächsten Schritt im Kommentar — was eine weitere Anhebung rechtfertigen würde und was nicht |
| Kein Mutationslauf über die neuen Module | Die Stryker-Liste ist eine **Erlaubnisliste**: eine Auslassung ist unsichtbar. Die neuen Verzeichnisse fehlen noch darin |

## Qualitätsstand

Zuletzt gemessen bei diesem Durchgang:

| Prüfung | Ergebnis |
|---|---|
| Tests | 2373 grün, 2 bedingt übersprungen (84 Dateien) |
| Zeilen-Coverage | 99,6 % (Schwelle 90 %) |
| Branch-Coverage | 98,3 % (Schwelle 85 %) |
| Mutations-Score | 80 % (Schwelle 70 %) |
| Metriken | 13 von 13 im Rahmen |
| Smoke-Test in echter App | alle Prüfungen grün |
| typecheck | vier Projekte sauber: node, web, preload, components |
| lint | sauber (`--max-warnings 0`) |

Die beiden übersprungenen Tests laufen gegen die **echten** heruntergeladenen Filterlisten und
überspringen sich selbst, wenn kein Korpus vorliegt — `describe.skipIf(corpus.length === 0)`.
