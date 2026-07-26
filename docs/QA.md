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
| 6.1 | Mitschnitt (Wireshark/mitmproxy) beim Kaltstart, keine Seite geöffnet | **Keine** Verbindung zu Google-, Update- oder Telemetrie-Hosts |
| 6.2 | Eine Seite öffnen, Anfragen vergleichen | Nur was die Seite braucht; kein Extra-Verkehr aus dem Unterbau |
| 6.3 | Verschlüsselte Namensauflösung an, DNS-Port 53 beobachten | Kein Klartext-DNS |
| 6.4 | Kill-Switch: VPN während des Ladens trennen | Verkehr stoppt, Statusanzeige wechselt |
| 6.5 | Auf einer WebRTC-Testseite die gemeldeten IPs prüfen | Keine lokale IP sichtbar |
| 6.6 | Kamera anfordern | Wird verweigert, ohne Systemabfrage |
| 6.7 | Auf einer Fingerprint-Testseite Werte vergleichen | Betriebssystem, Version, Sprache und Bildschirmwerte sind widerspruchsfrei |
| 6.8 | Privates Fenster: Seite besuchen, Fenster schließen, Profilordner prüfen | Keine neuen Dateien |
| 6.9 | „Beim Beenden löschen" an, beenden, Profilordner prüfen | Ausgewählte Kategorien sind weg |

**Zu 6.7:** ein *widersprüchlicher* Fingerprint ist schlechter als keine Maßnahme
(Abschnitt 4). Wenn die Browser-Kennung Windows meldet und die Zeitzone Europa/Berlin
sagt, ist das ein Befund und kein Detail.

## 7. Datenhaltung und Wiederherstellung

| # | Schritt | Erwartung |
|---|---|---|
| 7.1 | Quick Links anlegen, hart beenden (`kill -9`), neu starten | Alles bis zum letzten Schreibvorgang vorhanden, Datei nicht beschädigt |
| 7.2 | `quicklinks.json` von Hand beschädigen, starten | Startet mit leerem Satz, Hinweis erscheint |
| 7.3 | Fremden Schlüssel in `settings.json` schreiben, starten, Einstellung ändern | Fremder Schlüssel bleibt in der Datei |
| 7.4 | Split-Layout einrichten, beenden, starten | Layout, Trennerpositionen und Stummschaltung wiederhergestellt |
| 7.5 | Während eines Schreibvorgangs hart beenden | Keine halb geschriebene Datei; `.tmp` bleibt nicht liegen |

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
