# QA-Prozeduren

Dieses Dokument deckt ab, was Automatisierung **nicht** prüfen kann. Alles, was
sich automatisieren lässt, gehört in einen Test und nicht auf diese Liste — eine
manuelle Checkliste, die Dinge enthält, die eine Maschine erledigen könnte, wird
irgendwann nicht mehr abgearbeitet.

Was hier steht, hat einen von drei Gründen:

1. **Es braucht echte Hardware** — Hardware-Videodekodierung, mehrere Monitore mit
   unterschiedlicher Skalierung, ein schwacher Laptop.
2. **Es braucht einen Menschen** — ob eine Oberfläche verständlich ist, ob ein
   Screenreader etwas Sinnvolles vorliest.
3. **Es braucht die jeweilige Plattform** — Fensterdekoration, Tastenkürzel, die vom
   Betriebssystem abgefangen werden.

## Automatisiert — vor jedem manuellen Durchgang

```bash
pnpm run quality        # typecheck, lint, coverage, metrics
pnpm run test:bdd       # Gherkin-Szenarien
pnpm run test:smoke     # baut und prüft die laufende Anwendung
pnpm run test:mutation  # Mutationstests (dauert einige Minuten)
```

Ein manueller Durchgang bei rotem automatisierten Lauf ist verschwendete Zeit.

## 1. Split View — Kachel-Vollbild

Der riskanteste Teil der Anwendung und der einzige, dessen Kernmechanismus
plattformabhängig ist. `setFullScreenable(false)` unterdrückt den Fensterwechsel,
und ob das auf jedem Fenstermanager greift, kann nur ein Versuch zeigen.

**Pro Plattform durchführen: Windows 11, Ubuntu (GNOME), Ubuntu (KDE), macOS.**

| # | Schritt | Erwartung |
|---|---|---|
| 1.1 | 2×2-Layout, vier Videos laden | Alle vier spielen |
| 1.2 | Vollbild-Button im Video in Kachel 0 | Video füllt **nur Kachel 0**, Fenster bleibt Fenster, die anderen drei spielen weiter |
| 1.3 | Player-Oberfläche im Vollbild ansehen | Der Player zeigt seine Vollbild-Steuerung, hält sich also für im Vollbild |
| 1.4 | Esc | Zurück zur normalen Kachel, kein Layout-Verlust |
| 1.5 | Auf 1×1 wechseln, Vollbild im Video | Echtes Fenster-Vollbild, Tab-Leiste und Adressleiste verschwinden |
| 1.6 | Esc | Zurück zum Fenster |
| 1.7 | Im 2×2: Strg/⌘+Umschalt+Eingabe | Kachel füllt das Fenster, Layout bleibt erhalten |
| 1.8 | Nochmal dasselbe Kürzel | Raster wieder da, Trennerpositionen unverändert |

**Bekannter Zweifel:** unter Wayland verhalten sich Fenstermanager bei
`fullScreenable` unterschiedlich. Wenn 1.2 dort fehlschlägt, ist das ein
Architektur-Befund und kein Bug — dann bitte notieren, welcher Compositor und
welche Version.

## 2. Parallele Wiedergabe und Drosselung

Die Anforderung aus Abschnitt 2 lautet, dass nicht-fokussierte Kacheln **nicht**
gedrosselt werden. Das lässt sich nur mit echten Videos und einem Blick auf die
Systemauslastung prüfen.

| # | Schritt | Erwartung |
|---|---|---|
| 2.1 | 2×2, vier 1080p-Streams, 10 Minuten laufen lassen | Keine Kachel friert ein oder läuft langsamer |
| 2.2 | Kachel 3 fokussieren, Kachel 0 beobachten | Kachel 0 läuft mit unveränderter Bildrate weiter |
| 2.3 | Fenster minimieren, 2 Minuten warten, wiederherstellen | Alle vier Streams laufen weiter, keiner hat pausiert |
| 2.4 | Auf anderen virtuellen Desktop wechseln und zurück | wie 2.3 |
| 2.5 | **Hardware-Dekodierung prüfen** | Siehe unten |

### Hardware-Dekodierung verifizieren

Der wichtigste Einzelwert für Performance, und Chromium fällt bei fehlender
Unterstützung **stillschweigend** auf Software zurück.

- **macOS:** Aktivitätsanzeige, Spalte „GPU-Zeit". Bei vier 1080p-Streams sollte
  der GPU-Prozess Arbeit zeigen und die CPU pro Renderer unter ~5 % liegen.
- **Windows:** Task-Manager, Reiter Leistung, GPU → „Video Decode" muss Auslastung
  zeigen.
- **Linux:** `intel_gpu_top` beziehungsweise `radeontop`. Zeigt die Video-Engine
  keine Last, läuft Software-Dekodierung.

Bei Software-Dekodierung: notieren, auf welcher Hardware und mit welchem Codec.
Das ist die Grundlage für die geplante Laufzeitprüfung mit sichtbarem Hinweis.

## 3. Schwache Hardware

Mindestens ein Durchgang auf einem Gerät von 2015 oder älter mit 8 GB RAM. Ohne
das ist jede Performance-Aussage eine Behauptung.

| # | Schritt | Erwartung |
|---|---|---|
| 3.1 | Kaltstart bis Fenster sichtbar | Unter 3 Sekunden |
| 3.2 | 20 Tabs öffnen, Speicher beobachten | Kein Swapping; nicht-gekachelte Tabs werden entladen |
| 3.3 | 2×2 mit vier Streams | Bewertung notieren; bei Rucklern die Sparmodus-Optionen prüfen |
| 3.4 | Neuer Tab, Startseite | Kacheln erscheinen ohne sichtbare Verzögerung |
| 3.5 | 200 Quick Links anlegen, Startseite öffnen | Scrollen bleibt flüssig |

## 4. Plattform-Konventionen

**Pro Plattform separat.** Ein Feature, das nur auf einer Plattform funktioniert,
verstößt gegen Abschnitt 10.

| # | Schritt | Windows | Linux | macOS |
|---|---|---|---|---|
| 4.1 | Fensterbedienelemente | rechts, von Tab-Leiste unverdeckt | rechts (bzw. desktop-üblich) | links, Ampel unverdeckt |
| 4.2 | Menüleiste | im Fenster | im Fenster | systemweit oben |
| 4.3 | Fenster maximieren, Kacheln prüfen | Raster füllt das Fenster ohne Lücke | ” | ” |
| 4.4 | Fenster über zwei Monitore mit unterschiedlicher Skalierung ziehen | Kacheln bleiben korrekt, kein Versatz | ” | ” |
| 4.5 | Als Standardbrowser registrieren, Link aus einer anderen App öffnen | öffnet in tessera | ” | ” |
| 4.6 | Sprungliste / Dock-Menü | „Neues Fenster", „Neues privates Fenster" | ” | ” |
| 4.7 | Zweite Instanz starten | reicht die Adresse an die laufende weiter | ” | ” |

### Tastenkürzel, die das System abfängt

Aus Abschnitt 9 bekannt und **erwartet fehlschlagend** — geprüft wird, ob die
Einstellungsseite das erkennt und eine Alternative nennt.

| # | Kombination | Plattform | Erwartung |
|---|---|---|---|
| 4.8 | Strg+Alt+Pfeil | Linux (GNOME/KDE) | Erreicht die App nicht; Einstellungen zeigen Hinweis samt Alternative |
| 4.9 | ⌃+Pfeil | macOS | Gehört dem System; deshalb nutzt der Kachelwechsel ⌃⌥+Pfeil |
| 4.10 | Strg+Umschalt+Pfeil in einem Textfeld | Windows | Wählt wortweise aus, kapert nichts |
| 4.11 | Alle Kürzel aus Abschnitt 9 durchgehen | alle | Jedes tut, was die Tabelle sagt |

## 5. Barrierefreiheit

Braucht einen Menschen mit einem Screenreader. Automatisierte Prüfungen finden
fehlende Labels, nicht ob das Vorgelesene Sinn ergibt.

| # | Schritt | Erwartung |
|---|---|---|
| 5.1 | NVDA (Windows) / Orca (Linux) / VoiceOver (macOS): Tab-Leiste durchgehen | Jeder Tab wird mit Titel und Kachelzuordnung vorgelesen |
| 5.2 | Adressleiste fokussieren | Sicherheitszustand wird angekündigt, nicht nur das Symbol |
| 5.3 | Layout-Umschalter | Jedes Layout hat einen aussagekräftigen Namen |
| 5.4 | Startseite, Kacheln durchgehen | Name und Ziel werden vorgelesen; Ordner mit Anzahl |
| 5.5 | Kachel-Dialog öffnen | Fokus springt hinein, Tab bleibt im Dialog, Esc schließt |
| 5.6 | Trenner mit Tastatur | Als Trenner angekündigt, Pfeiltasten verschieben ihn |
| 5.7 | **Nur mit Tastatur** eine Kachel anlegen, öffnen, umsortieren, löschen | Ohne Maus vollständig möglich |
| 5.8 | Bei 200 % Systemschriftgröße | Nichts abgeschnitten, nichts überlappt |
| 5.9 | Bei aktivem Kontrastmodus | Fokusrahmen sichtbar, Text lesbar |

## 6. Privatsphäre — was der Rechner tatsächlich sendet

Die Integrationstests prüfen die Filterlogik. Was hier geprüft wird, ist der
tatsächliche Netzwerkverkehr — der einzige Beweis, der zählt.

| # | Schritt | Erwartung |
|---|---|---|
| 6.1 | Mitschnitt (Wireshark/mitmproxy) beim Kaltstart, keine Seite geöffnet | **Keine** Verbindung zu Google-, Update- oder Telemetrie-Hosts; `publicsuffix.org` höchstens einmal pro Tag und im selben Kanal wie die Filterlisten |
| 6.2 | Eine Seite öffnen, Anfragen vergleichen | Nur was die Seite braucht; kein Extra-Verkehr aus dem Unterbau |
| 6.3 | Verschlüsselte Namensauflösung an, DNS-Port 53 beobachten | Kein Klartext-DNS |
| 6.4 | Kill-Switch an, Proxy manuell `socks5://127.0.0.1:9050`: Proxy laufen lassen und laden, dann Proxy stoppen und neu laden, im normalen und im privaten Fenster | Mit Proxy lädt die Seite ohne Neustart; ohne Proxy zeigt jede Kachel „Der Proxyserver antwortet nicht." (`-130`), und der Mitschnitt zeigt keine direkte Verbindung |
| 6.4a | Kill-Switch an, Modus „System" mit einer Systemregel oder PAC, die `DIRECT` liefert | Die Einstellungsseite warnt sofort; eine Seite zeigt „Der Kill-Switch hat diese Seite gestoppt …" mit Knopf „Netzwerk-Einstellungen" |
| 6.4b | Kill-Switch aus, derselbe manuelle Proxy gestoppt | Die Seite lädt direkt (`,direct://`) |
| 6.5 | Auf einer WebRTC-Testseite die gemeldeten IPs prüfen, ohne und mit Proxy | Keine lokale IP sichtbar; mit Proxy auch keine öffentliche am Proxy vorbei |
| 6.6 | Kamera anfordern | Wird verweigert, ohne Systemabfrage |
| 6.7 | Auf einer Fingerprint-Testseite Werte vergleichen | Betriebssystem, Version, Sprache und Bildschirmwerte sind widerspruchsfrei |
| 6.8 | Privates Fenster: Seite besuchen, Fenster schließen, Profilordner prüfen | Keine neuen Dateien |
| 6.9 | „Beim Beenden löschen" an, beenden, Profilordner prüfen | Ausgewählte Kategorien sind weg |
| 6.10 | Bestandsprofil mit Element-Regel auf einer `.com.sg`-Seite: zweimal starten (der erste Start lädt die volle Public Suffix List, der zweite spielt sie ein) | Die Regel steht weiter aktiviert in der Liste, wird aber nicht angewendet; das Log nennt sie als zu breit |

**Zu 6.4:** Der Kill-Switch kennt nur den Proxy, den Tessera verwenden soll. Ein VPN
des Betriebssystems wird nicht erkannt; ein Test „VPN trennen" prüft ihn nicht. Im
Modus „System" gehen der PAC/WPAD-Abruf und `dnsResolve()` im PAC-Skript weiter
direkt hinaus. Ohne erreichbaren Proxy werden auch Filterlisten und Updates nicht
abgerufen.

**Zu 6.7:** ein *widersprüchlicher* Fingerprint ist schlechter als keine Maßnahme
(Abschnitt 4). Wenn die Browser-Kennung Windows meldet und die Zeitzone Europa/Berlin
sagt, ist das ein Befund und kein Detail.

**Zu 6.1:** Die Public Suffix List (`https://publicsuffix.org/list/public_suffix_list.dat`)
wird über `networkFetch` geholt, also mit Proxy-Regel, Kill-Switch und sicherem DNS wie
die Filterlisten. Ein Versuch pro 24 Stunden, und keiner, solange die angenommene Liste
jünger als sieben Tage ist. Im Mitschnitt muss die Anfrage denselben Weg nehmen wie die
Filterlisten-Downloads; eine Umleitung auf einen anderen Host wird abgelehnt. Eine
heruntergeladene Liste gilt erst ab dem nächsten Start.

**Zu 6.10 — der einmalige Wechsel:** Bisher bildete jedes Profil seine Site-Schlüssel mit
den eingebauten Suffixen. Der erste Start mit voller Liste ordnet deshalb einmal neu zu.
Betroffen sind Element-Regeln des Pickers (eine Regel für `com.sg` war gemeint für eine
Seite unter `com.sg` und würde jetzt alle treffen — sie wird erkannt, im Log gemeldet und
nicht angewendet, `enabled` bleibt unverändert; von Hand löschen oder neu picken) und der
Favicon-Index (Symbole unter dem alten Schlüssel werden beim nächsten Besuch neu geholt).
Nicht betroffen sind Site-Ausnahmen (nach Hostname geschlüsselt) und der
Fingerprint-Seed aus 6.7. Ein neues Profil läuft offline mit den eingebauten Suffixen,
bis ein Download gelingt.

## 7. Datenhaltung und Wiederherstellung

| # | Schritt | Erwartung |
|---|---|---|
| 7.1 | Quick Links anlegen, hart beenden (`kill -9`), neu starten | Alles bis zum letzten Schreibvorgang vorhanden, Datei nicht beschädigt |
| 7.2 | `quicklinks.json` von Hand beschädigen, starten | Startet mit leerem Satz, Hinweis erscheint |
| 7.3 | Fremden Schlüssel in `settings.json` schreiben, starten, Einstellung ändern | Fremder Schlüssel bleibt in der Datei |
| 7.4 | Split-Layout einrichten, beenden, starten | Layout, Trennerpositionen und Stummschaltung wiederhergestellt |
| 7.5 | Während eines Schreibvorgangs hart beenden | Keine halb geschriebene Datei; `.tmp` bleibt nicht liegen |
| 7.6 | `bookmarks.json` von Hand beschädigen (z. B. `"nodes": "x"`), starten | Startet mit leerem Satz; die Originaldatei liegt unverändert als `bookmarks.json.unreadable` daneben, das Log nennt den Pfad |
| 7.7 | Dieselbe beschädigte Datei zweimal hintereinander starten lassen, ohne etwas zu ändern | Nur eine `.unreadable`-Kopie |
| 7.8 | In `history.json` die Version auf `2` setzen (unverschlüsseltes Profil), starten, Seiten besuchen, beenden | Log meldet „newer version … changes made in this run are discarded“; die Datei ist danach byte-gleich |
| 7.9 | Dasselbe mit `bookmarks.json`, dann ein Lesezeichen anlegen | Vorhandene Lesezeichen sichtbar; Anlegen schlägt mit Fehler fehl; Datei byte-gleich |
| 7.10 | Neben `history.json` eine `history.json.v1.bak` und eine `history.json.unreadable` ablegen, im Verlauf „Alles löschen“ | Beide Kopien sind danach weg; ebenso für Downloads („Liste leeren“), den Tresor („Tresor zurücksetzen“) und „Beim Beenden löschen“ mit Verlauf und Downloads |
| 7.11 | Windows: Tresor entsperren, ein Passwort ändern, das letzte Fenster per X schließen, neu starten | Die Änderung ist da; der Prozess ist nach dem Schließen ohne Hänger beendet |
| 7.12 | „Beim Beenden löschen“ mit Verlauf und Downloads an, Seiten besuchen, eine Datei herunterladen, normal beenden, neu starten | Verlauf, Favicons, Vorschaubilder und Downloads-Liste leer; die heruntergeladene Datei liegt noch im Ordner; `clear-on-exit-pending.json` ist weg |
| 7.13 | Wie 7.12, aber während eines laufenden Downloads beenden | Der laufende Download steht nach dem Löschen noch in der Liste |
| 7.14 | „Beim Beenden löschen“ mit Verlauf an, Seiten besuchen, Prozess hart beenden (`kill -9`), neu starten | Der Verlauf ist leer, bevor das erste Fenster erscheint; `history.json` samt Kopien ist weg |
| 7.15 | „Beim Beenden löschen“ an, dann während des Laufs wieder aus, hart beenden, neu starten | Nichts wurde gelöscht; `clear-on-exit-pending.json` gibt es nicht |

### Wiederherstellen aus einer Sicherung oder Quarantäne-Kopie

Tessera legt eine Kopie an, bevor es eine Store-Datei ersetzt, und fasst die Kopie danach nicht mehr an:

- **`<datei>.v<N>.bak`** — die Datei in Version `N`, bevor eine Migration sie auf die aktuelle Version gehoben hat. Byte-gleich mit dem Original, also mit demselben Schlüssel verschlüsselt. Höchstens eine je Version; die erste bleibt.
- **`<datei>.unreadable`**, **`<datei>.unreadable.1`**, … — eine Datei, die diese Version gar nicht verwenden konnte (kaputtes JSON, falsche Form, eine Migration, die scheiterte). Byte-gleich mit dem Original; eine inhaltsgleiche Kopie wird nicht erneut angelegt.

Zurückspielen, wenn eine Migration oder eine Reparatur das falsche Ergebnis hatte:

1. Tessera beenden (nicht nur das Fenster schließen) und warten, bis der Prozess weg ist.
2. Die aktuelle Datei zur Seite legen, nicht löschen: `history.json` → `history.json.aktuell`.
3. Die Kopie unter den Originalnamen kopieren: `history.json.v1.bak` → `history.json`. Kopieren statt Umbenennen, damit die Sicherung erhalten bleibt, falls der Versuch wieder scheitert.
4. Starten. Eine `.v<N>.bak` wird erneut migriert; die vorhandene Sicherung dieser Version bleibt, wie sie ist. Eine `.unreadable`-Kopie wird nur gelesen, wenn sie vorher von Hand repariert wurde; sonst liegt sie danach wieder als Kopie daneben.

Grenzen: Eine Kopie ist nur mit dem Schlüssel lesbar, mit dem das Original verschlüsselt war; in einem verschlüsselten Profil lassen sich `.unreadable`-Kopien daher nicht von Hand reparieren, nur zurückspielen, sobald eine Version sie lesen kann. Zu `passwords.json` gehört der Tresor-Schlüssel `passwords.key`. Verlauf löschen, Downloads-Liste leeren, Tresor zurücksetzen und „Beim Beenden löschen“ entfernen die Kopien ihrer Kategorie.

## 8. Auslieferung

Pro Plattform vor jeder Freigabe.

| # | Schritt | Erwartung |
|---|---|---|
| 8.1 | Paket auf einem frischen System installieren | Keine Warnung des Betriebssystems |
| 8.2 | macOS: Gatekeeper | Startet ohne Rechtsklick-Umweg (Notarisierung greift) |
| 8.3 | Windows: SmartScreen | Keine Warnung (Authenticode greift) |
| 8.4 | Linux: alle drei Formate installieren | AppImage, deb und rpm starten |
| 8.5 | Update von der Vorversion | Einstellungen und Quick Links bleiben erhalten |
| 8.6 | Deinstallation | Keine Reste außer bewusst behaltenen Nutzerdaten |

## Befunde festhalten

Zu jedem Fehlschlag: Plattform, Version, Hardware, Schritt-Nummer, und was
stattdessen passiert ist. Bei Performance-Befunden zusätzlich, ob
Hardware-Dekodierung aktiv war — ohne diese Angabe ist die Messung nicht
einzuordnen.

Ein Fehlschlag, der sich automatisieren lässt, wird zu einem Test und verlässt
diese Liste. Die Liste soll kürzer werden, nicht länger.

## Beim In-Prozess-Smoke-Lauf die Maschine nicht anfassen

Der Ziehdurchlauf schickt echte Mauseingaben mit `webContents.sendInputEvent`, und daran hängen zwei
Bedingungen, die es über CDP nicht gab:

- **Ein Ereignis an ein unfokussiertes Fenster wird lautlos verworfen.** Schlimmer:
  `BrowserWindowController.onBlur` bricht ein laufendes Ziehen ab und schließt die Overlay-Schicht — ein
  Fokusverlust beendet die Geste also, und Zurückfokussieren macht das nicht rückgängig. Vor jedem Ereignis
  wird deshalb fokussiert; ein Fensterwechsel von Hand schlägt trotzdem durch.
- **Der echte Mauszeiger hebt eine eigene Zone hervor.** Ruht er über der Schicht, konkurriert seine Zone
  mit der geprüften, und der Fehlschlag sieht aus wie ein Produktfehler.

Also: starten, Zeiger aus dem Fenster legen, nichts anklicken, bis der Lauf durch ist. Ein Fehlschlag unter
Missachtung davon ist kein Befund.
