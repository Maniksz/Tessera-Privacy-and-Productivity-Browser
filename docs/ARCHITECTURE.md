# Architektur

Dieses Dokument erklärt, *warum* der Code so aussieht. Was der Browser können soll,
steht in der Spezifikation; hier stehen die Entscheidungen und ihre Begründungen —
insbesondere dort, wo eine naheliegende Lösung still versagt hätte.

## Prozessmodell

```
┌─────────────────────────────────────────────────────────────┐
│ Main-Prozess (Node)                                         │
│   SettingsStore · WindowRegistry · RequestPipeline · Menü    │
└───────┬─────────────────────────────────────┬───────────────┘
        │ typisierte IPC                      │ Positionierung
        │ (contract.ts)                       │
┌───────▼──────────────────┐   ┌──────────────▼───────────────┐
│ Chrome-Renderer          │   │ Inhalts-Views, einer je Tab   │
│ Rolle: chrome            │   │ Rolle: content                │
│ volle Vertragsoberfläche │   │ Web-Seite: keine Brücke       │
│ Tab-Leiste, Toolbar      │   │ tessera://: enge Liste     │
│ React, sandboxed         │   │ eigener Prozess pro Tab       │
└──────────────────────────┘   └───────────────────────────────┘

Ein Preload für beide (src/preload/index.ts). Die Rolle kommt aus
webPreferences.additionalArguments, gesetzt vom Main-Prozess — die einzige
Quelle, die Seiteninhalt nicht beeinflussen kann.
```

Ein Fenster ist ein `BrowserWindow`, dessen eigener `webContents` die Oberfläche
rendert. Die Tabs sind `WebContentsView`-Instanzen, die *darüber* im Inhaltsbereich
positioniert werden. Das hat eine Konsequenz, die durch die ganze UI wirkt: **DOM
unterhalb des Inhaltsbereichs bekommt keine Mausereignisse.** Deshalb der Gutter
zwischen den Kacheln, und deshalb braucht Drag-&-Drop von Tabs in Kacheln später ein
temporäres Ausblenden der Views.

Die Inhalts-Views haben `sandbox: true`, `contextIsolation: true` und
`nodeIntegration: false`. Eine besuchte Seite bekommt keine `contextBridge`-Exposition
und damit keinen Kanal in den Kern; eine interne `tessera://`-Seite bekommt eine
enge Erlaubnisliste. Details unter
[Startseite und der interne Kanal](#startseite-und-der-interne-kanal).

## Die UI/Kern-Grenze

Zwei Dateien, absichtlich getrennt:

`shared/ipc/channels.ts` — nur Namen, keine Abhängigkeiten. Das sandboxed Preload
importiert diese Datei für seine Erlaubnislisten, und ein sandboxed Preload kann
nichts nachladen; alles muss mitgebündelt werden. Zod dort hineinzuziehen wäre
Verschwendung und zwecklos, weil der Main-Prozess ohnehin validieren muss — er ist
die Seite, die dem Renderer nicht trauen darf.

`shared/ipc/contract.ts` — Zod-Schemata pro Kanal. Der Kniff:

```ts
export const invokeContract = { … } satisfies Record<InvokeChannel, InvokeDefinition>
```

`satisfies` gegen `Record<InvokeChannel, …>` fängt beide Richtungen: ein Kanal ohne
Eintrag fehlt, ein Eintrag ohne Kanal ist eine überzählige Eigenschaft. Gleichzeitig
bleibt die präzise Inferenz erhalten, sodass `InvokeRequest<'tabs:create'>` den
echten Typ liefert und nicht `unknown`.

Drei Schichten schützen diese Grenze:

1. **Statisch.** Handler-Argumente und Rückgabewerte stammen aus dem Vertrag. Die
   Renderer-Seite bekommt dieselben Typen über `preload/api.d.ts` — nur Typen, die
   Schemata landen nie im Renderer-Bundle.
2. **Zur Laufzeit.** `ipc/router.ts` parst jede Anfrage gegen ihr Schema, bevor ein
   Handler sie sieht. Im Entwicklungsmodus wird auch die Antwort geprüft.
3. **Beim Start.** `assertAllChannelsRegistered()` wirft, wenn ein Vertragskanal
   keinen Handler hat. Sonst fiele das erst auf, wenn jemand darauf klickt.

Jeder Ereigniskanal hat eine Gegenrichtung: `on()` im Preload gibt die
Abmelde-Funktion zurück, und jeder Hook im Renderer ruft sie beim Aufräumen.

## Einstellungen

`shared/settings/definitions.ts` ist die einzige Quelle. Jeder Eintrag trägt sein
Schema, seinen Standardwert, seinen Bereich und seinen Wirkungszeitpunkt:

```ts
'splitView.fullscreenScope': def(z.enum(['tile','window']), 'tile', 'splitView'),
```

Die Hilfsfunktion `def` bindet den Standardwert an das eigene Schema, sodass ein
Standardwert, den das Schema ablehnen würde, ein Compile-Fehler ist statt ein
Startabsturz. Ein Test prüft zusätzlich zur Laufzeit, dass jeder Standardwert
validiert.

`SettingsStore.set` wirft `UnknownSettingKeyError` beziehungsweise
`InvalidSettingValueError`. Das wird zur abgelehnten IPC-Anfrage, die die Oberfläche
zeigen muss. Ein Schalter, der umspringt und nichts bewirkt, kann so nicht
entstehen.

Beim Laden aus der Datei gilt die umgekehrte Regel: unbekannte Schlüssel werden
*behalten* und gemeldet, ungültige Werte fallen auf den Standard zurück. Eine
ältere Version darf die Einstellungen einer neueren nicht zerstören, und eine
beschädigte Datei darf niemanden aus dem eigenen Browser aussperren.

Schreibvorgänge laufen über Write-Then-Rename, damit ein Absturz mitten im
Schreiben die vorherige Datei intakt lässt statt eine abgeschnittene zu hinterlassen.

## Split View

`shared/split/layout.ts` ist reine Geometrie ohne Seiteneffekte. Der Main-Prozess
positioniert damit native Views, der Renderer zeichnet damit Trenner-Griffe, die
Tests nageln damit das Verhalten fest. Eine Implementierung, deshalb kann der Griff,
den jemand zieht, nie woanders sein als die tatsächliche Grenze.

Zwei Detailentscheidungen:

**Grenzen werden gerundet, nicht Größen.** So teilen benachbarte Kacheln exakt eine
Kante und das Raster zeigt keine Ein-Pixel-Naht, egal wie breit das Fenster ist.

**Kachelnavigation ist geometrisch, nicht tabellarisch.** `tileInDirection` rechnet
mit Rechtecken statt mit einer Tabelle pro Layout. Damit bleibt sie korrekt, wenn
die Trenner in eine asymmetrische Anordnung gezogen wurden.

`main/browser/SplitController.ts` hält den Zustand: Layout, Trennerpositionen,
aktive Kachel, Tab-je-Kachel, Audio-je-Kachel, maximierte Kachel, Vollbild-Kachel.

### Die Eskalationsleiter

```
kein Zustand → Kachel-Vollbild → Kachel maximiert → Fenster-Vollbild
                        Esc geht jeweils eine Stufe zurück
```

`SplitController.escape()` gibt zurück, *welcher* Schritt getan wurde, statt den
Seiteneffekt selbst auszuführen — das Verlassen des Seiten-Vollbilds braucht den Tab,
das Verlassen des Fenster-Vollbilds das Fenster. Der Controller kennt den Zustand,
der Aufrufer kennt die Objekte.

### Der Vollbild-Mechanismus

Die zentrale Anforderung und der riskanteste Teil.

Normalerweise schaltet eine Vollbild-Anfrage der Seite das ganze Fenster um. Im
Split-Layout wäre das das Gegenteil des Gewünschten. Der Mechanismus:

```ts
this.window.setFullScreenable(layout === '1x1' || scope === 'window')
```

Ist das Fenster nicht vollbildfähig, wechselt es nicht — aber die Anfrage der Seite
wird weiterhin honoriert: `enter-html-full-screen` feuert,
`document.fullscreenElement` ist gesetzt, die Player-Oberfläche wechselt. Die Kachel
bleibt der Referenzrahmen. Genau das verlangt die Spezifikation: es reicht nicht, das
Video nachträglich zu skalieren, die Seite muss selbst glauben, im Vollbild zu sein.

Wichtig dazu: die Berechtigung `fullscreen` wird in `session/hardening.ts` *bewusst
gewährt*. Sie zu verweigern wäre kein Privacy-Gewinn, würde aber das Kernfeature
zerstören.

Geometrisch ändert Kachel-Vollbild nichts — die Kachel behält ihr Rechteck, alle
anderen bleiben sichtbar und laufen weiter. Nur „Kachel maximieren" ändert die
Geometrie, und zwar ohne das Layout zu verwerfen.

**Zu verifizieren:** `setFullScreenable(false)` als Unterdrückung ist
plattformabhängig. Auf Windows und Linux muss das nachgewiesen werden.

### Drosselung

Chromium drosselt Timer, Rendering und Raster-Arbeit in Inhalten, die es für
verdeckt oder im Hintergrund hält. In einem 2×2-Raster hält Chromium drei von vier
Kacheln für Hintergrund. Zwei Ebenen sind nötig:

- `backgroundThrottling: false` pro `WebContentsView`
- `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`,
  `--disable-backgrounding-occluded-windows` als Prozess-Schalter

Die Schalter müssen vor `app.whenReady()` gesetzt sein — Chromium liest seine
Kommandozeile während der Initialisierung. Deshalb liest `bootstrapFlags()` in
`main/index.ts` die zwei neustart-relevanten Einstellungen synchron aus der Datei,
bevor der asynchrone `SettingsStore` überhaupt geöffnet wird.

Dasselbe Zeitproblem eine Ebene höher: Fingerprint-Schutz muss vor dem ersten
Seitenskript greifen. Deshalb liegt der Injektionspunkt in `preload/content.ts` und
nicht in einem späteren Privacy-Modul — die Zeitgarantie soll in der Architektur
sichtbar sein.

## Privacy-Pipeline

`main/privacy/RequestPipeline.ts`. Die Spezifikation warnt davor, die Filterstufen
unabhängig zu registrieren, und Electron macht diese Warnung konkret:

> `session.webRequest.onBeforeRequest` hält genau **einen** Listener. Ein zweiter
> Aufruf ersetzt den ersten stillschweigend.

Blocker, Redirect-Filter und Parameter-Bereinigung als getrennte Registrierungen
gebaut heißt: wer zuletzt registriert, läuft — ohne Fehler, ohne Warnung, ohne
auffälliges Symptom. Deshalb ein Listener pro Ereignis und die Stufen als geordnetes
Array darin:

```
telemetry → blocker → redirect → tracking-params → https-upgrade
```

`STAGE_ORDER` wird beim Installieren gegen die tatsächliche Reihenfolge geprüft und
zusätzlich von einem Test festgenagelt. Die Reihenfolge ist Daten, nicht
emergentes Verhalten.

Die Filterlisten-Engine ist eine Schnittstelle (`FilterListEngine`) und derzeit
`null` — die Stufe wird übersprungen. Das ist Absicht: eine Eigenentwicklung, die
einen Bruchteil der Filtersyntax versteht und den Rest verwirft, ist schlechter als
eine erkennbar fehlende Stufe.

Sessions werden in `WindowRegistry` erzeugt, damit Härtung und Pipeline genau einmal
pro Session installiert werden. Pro Fenster zu installieren würde sie mehrfach
registrieren — und wegen des Ein-Listener-Verhaltens würde die zweite Installation
die erste ersetzen.

### Domain-Grenzen

`shared/url/domain.ts`. Zwei Fehlerklassen, die die Spezifikation namentlich nennt:

- **Naives „letzte zwei Labels"** macht aus `bbc.co.uk` und `evil.co.uk` dieselbe
  Partei. Deshalb eine Public-Suffix-Auswertung mit längstem Treffer.
- **Teilstring-Abgleich** auf `track.` oder `click.` blockt Paketverfolgung und
  Newsletter-Links. Deshalb matcht `hostMatchesRule` nur auf ganzen Labels.

Der eingebaute Suffix-Satz ist ein bewusst kleiner Startsatz.
`configurePublicSuffixes()` ist die Nahtstelle, um die echte Public Suffix List zu
laden und aktuell zu halten.

### Berechtigungen

Ohne `setPermissionRequestHandler` genehmigt Electron Kamera, Mikrofon, Standort und
Benachrichtigungen **ohne Rückfrage**. Das nicht zu konfigurieren ist keine neutrale
Entscheidung, sondern die freizügigste.

`setPermissionCheckHandler` ist ebenso nötig: ohne ihn beantwortet Chromium
`permissions.query()` aus eigenen Standardwerten, sodass eine Seite „granted" sehen
könnte für etwas, das der Request-Handler ablehnen würde.

Eine nicht zugeordnete Berechtigung wird abgelehnt. Neue Chromium-Versionen bringen
neue Berechtigungen mit; der Standard für alles, worüber nicht nachgedacht wurde,
muss „nein" sein.

## Herunterfahren

Löschen beim Beenden muss *abgeschlossen* sein, bevor der Prozess endet — sonst
läuft es ins Leere. `before-quit` bricht den ersten Beenden-Versuch ab, erledigt die
Arbeit asynchron und beendet dann wirklich. Dasselbe gilt für ungeschriebene
Einstellungen: `store.flush()` wird abgewartet.

## Plattformen

Drei handgepflegte Tastaturtabellen in `shared/shortcuts/bindings.ts`, nicht
voneinander abgeleitet. Eine mechanische Ersetzung von Strg durch die Befehlstaste
erzeugt Kollisionen — der Kachelwechsel landete auf macOS auf ⌘⌥+Pfeil und würde dort
den Tab-Wechsel überschreiben. Deshalb ⌃⌥+Pfeil. Ein Test prüft genau diese
Kollision.

`KNOWN_CONFLICTS` listet Kombinationen, die das Betriebssystem abfängt, mit
Nachricht und Alternative. Die Einstellungsseite soll das zeigen, statt eine Belegung
anzubieten, die nie feuert.

Fensterdekoration: `titleBarStyle: 'hidden'` überall, dazu `trafficLightPosition` auf
macOS und `titleBarOverlay` auf Windows und Linux. Die Oberfläche erhält den nötigen
Freiraum über `windowState().windowControlsInset` und lässt die Bedienelemente frei.

Pfade kommen ausschließlich aus `app.getPath()`.

## Bekannte Abkürzungen

Vollständig in der README unter „Was noch nicht da ist". Die drei, die
architektonisch relevant sind:

1. **Einstellungen sind unverschlüsselt.** `SettingsCodec` ist die Nahtstelle, die
   Implementierung fehlt.
2. **Favicons werden nicht geladen.** Die URLs werden erfasst, aber nichts wird
   abgerufen, bis der lokale Cache existiert — ein Abruf bei jedem Aufruf würde die
   Anforderung verletzen, die er erfüllen soll.
3. **Elektrons eigene Ereignisse sind namensbasiert verdrahtet.** `Tab.#wireEvents`
   weitet `WebContents` auf `NodeJS.EventEmitter` — eine echte Schnittstelle, kein
   `any`. Elektrons Überladungen pro Ereignis lassen sich nicht generisch
   ansprechen. Die Typregel, auf die es ankommt, betrifft die UI/Kern-Grenze, und die
   ist vollständig typisiert.

## Startseite und der interne Kanal

Die Startseite ist eine echte React-Anwendung, die über `tessera://start`
ausgeliefert wird. Damit sie Quick Links verwalten kann, braucht sie einen Kanal in
den Kern — und das ist die einzige Stelle, an der Inhalt, der in einer Content-View
läuft, überhaupt mit dem Kern spricht.

### Zwei Tore, nicht eines

**Tor 1 — was exponiert wird.** `src/preload/index.ts` liest seine Rolle aus
`process.argv`, gesetzt vom Main-Prozess über `webPreferences.additionalArguments`.
Seiteninhalt kann die Prozess-Kommandozeile nicht verändern, also ist das genauso
vertrauenswürdig wie die Wahl einer anderen Datei — und im Gegensatz zu einer
URL-Prüfung lässt es sich nicht von einem Dev-Server oder einer konstruierten Adresse
täuschen. Eine unbekannte Rolle gilt als `content`; der Standard muss der
restriktive sein.

Rolle `chrome` bekommt die volle Vertragsoberfläche. Ein `tessera://`-Dokument
bekommt `tesseraInternal` mit einer Erlaubnisliste von sieben Kanälen. Eine
besuchte Seite bekommt nichts.

**Tor 2 — was angenommen wird.** `src/main/ipc/sender-policy.ts` klassifiziert jeden
Absender unabhängig neu. Ein kompromittierter Renderer ist genau der Fall, in dem dem
Preload nicht zu trauen ist, also verlässt sich der Kern nicht darauf. Die Prüfung
läuft **vor** der Schema-Validierung: erst wer fragt, dann was gefragt wird.

`INTERNAL_INVOKE_CHANNELS` ist per `satisfies readonly InvokeChannel[]` eine echte
Teilmenge — ein Name, der kein Kanal ist, bricht den Build. Ein Architekturtest hält
zusätzlich `settings:set`, `tabs:close` und `window:close` davon fern.

### Warum ein Preload statt zweier

Zwei Einstiegsdateien, die dasselbe Modul importieren, lassen Rollup einen geteilten
Chunk erzeugen, den die Einstiege dann per `require('./chunks/…')` laden. Ein
sandboxed Preload kann das nicht — `require` ist dort auf wenige Builtins begrenzt.
Der Split-Build hätte sauber kompiliert und zur Laufzeit versagt. Eine
selbstständige Datei entfernt diesen Fehlerfall; ein Architekturtest prüft, dass das
gebaute Preload nur `electron` verlangt.

### Der Protokoll-Handler muss Assets ausliefern

`tessera://start/` liefert das Dokument, `tessera://start/assets/x.js` die
Skripte. Ohne die zweite Route wäre die Seite nacktes Markup ohne Hinweis auf die
Ursache. Jeder Pfad wird normalisiert und geprüft, dass er im Bundle bleibt — eine
interne Seite ist von Web-Inhalt aus per Link erreichbar, ihre URL ist also nicht
vertrauenswürdiger Eingabewert. Im Entwicklungsmodus werden Anfragen an den
Vite-Server weitergeleitet, sonst wären interne Seiten veraltet, während die Chrome-UI
neu lädt.

## Performance auf schwacher Hardware

### Die Spannung, die benannt werden muss

Abschnitt 2 verlangt zwei Dinge, die auf alter Hardware nicht beide erfüllbar sind:
nicht-fokussierte Kacheln dürfen nicht gedrosselt werden, *und* vier parallele
1080p-Streams müssen flüssig laufen. Auf einem Ultrabook von 2015 mit 8 GB ist das
nicht beides zu haben. Ein Versprechen, das die Hardware nicht hält, ist schlechter
als eine ehrliche Einstellung.

### Hardware-Dekodierung entscheidet alles

Mit VideoToolbox, D3D11 oder VA-API kostet ein 1080p-Stream ~3 % CPU. Ohne ~25 % pro
Stream — vier Streams sättigen dann vier Kerne. Der gefährliche Teil: Chromium fällt
bei fehlender Unterstützung **stillschweigend** auf Software zurück. Das ist die
häufigste Ursache für „es ruckelt und ich weiß nicht warum", und auf Linux mit VA-API
der Normalfall. Wie man es prüft, steht in [QA.md](QA.md#hardware-dekodierung-verifizieren);
eine Laufzeitprüfung mit sichtbarer Anzeige fehlt noch und ist der wichtigste
Performance-Punkt auf der Liste.

### RAM ist der bindende Engpass, nicht CPU

Jeder Tab ist ein eigener Renderer-Prozess. Vier Kacheln plus Chrome, Main, GPU und
Netzwerk sind acht Prozesse. Dagegen hilft, nicht-gekachelte Tabs zu entladen — mit
Kacheln als Ausnahme, wie Abschnitt 7 verlangt — und ein Prozess-Limit bei wenig
Speicher. Was *nicht* hilft: Site-Isolation abschalten. Das würde die Sandbox
aufgeben, also die Grundlage von Abschnitt 6.

### Was am Bundle gemessen wurde

Der Renderer lieferte 705 kB in einem Chunk aus, davon etwa 500 kB zod, weil
`quicklinks/model.ts` und `i18n/catalog.ts` reine Hilfsfunktionen und
Validierungsschemata aus derselben Datei exportierten. Ein Import der Funktion zog die
Bibliothek mit. Zusätzlich war die Minifizierung nicht aktiv.

Die Trennung in `model.ts` (rein) und `schema.ts` (Validierung) ist deshalb eine
Performance-Entscheidung, keine stilistische — und die Regel dahinter lautet: ein
`shared`-Modul, das ein Renderer importiert, bleibt frei von schweren Abhängigkeiten.
Dieselbe Trennung gilt für `i18n/catalog.ts` und `i18n/schema.ts`; es ist eine Regel,
kein Einzelfall. Vier typisierte Zuweisungen in `schema.ts` verhindern, dass die
Trennung zur Lüge wird — zwei pro Form, je eine in jede Richtung: gewinnt das Interface
ein Feld, das das Schema nicht kennt, oder umgekehrt, bricht die Typprüfung.

React lag außerdem zweimal im Bundle, einmal pro HTML-Einstieg. Eine
`manualChunks`-Regel legt es in einen geteilten `vendor-react`-Chunk, den beide
Einstiege nutzen — einmal kompiliert statt zweimal pro Fenster, und die zweite Seite
wird aus V8s Code-Cache bedient.

Build-Ziele sind auf Chromium 150 und Node 24 gepinnt, verifiziert am ausgelieferten
Framework. Ein älteres Ziel würde Polyfills und Hilfsfunktionen hinzufügen, die bei
jedem Fensterstart Parse-Zeit kosten — messbar genau auf den Geräten, die es sich am
wenigsten leisten können.

Damit die Trennung hält, läuft ein Architekturtest den Wert-Import-Graphen des
Renderers ab und stellt sicher, dass kein erreichbares `shared`-Modul zod
wert-importiert. Ein Grep über `src/shared` nach `zod` wäre falsch — der Kern braucht
es legitim; nur der vom Renderer erreichbare Teilgraph ist die Invariante. Die
vollständige Diagnose und die übertragbaren Regeln stehen in
[solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md](solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md).

### Der ehrliche Weg für alte Geräte

Ein explizites Sparmodus-Bündel: Hintergrundkacheln auf 30 fps begrenzen, Kachelzahl
begrenzen, Blur- und Shadow-Effekte aus. Standardmäßig aus, wie die Spezifikation
fordert, aber auffindbar und mit klarer Erklärung. `splitView.throttleInactiveTiles`
ist der erste Schalter dieser Gruppe und existiert; die übrigen fehlen.
