# Teststrategie

Sechs Ebenen, jede mit einer eigenen Frage. Wenn zwei Ebenen dieselbe Frage
beantworten, ist eine davon überflüssig.

| Ebene | Frage | Befehl |
|---|---|---|
| Typprüfung | Passen die beiden Seiten der IPC-Grenze zusammen? | `pnpm run typecheck` |
| Statische Analyse | Gibt es fallengelassene Promises, `any`-Lecks, veraltete Hook-Abhängigkeiten? | `pnpm run lint` |
| Unit-Tests | Tut jede Funktion, was sie soll — auch an den Rändern? | `pnpm run test:unit` |
| Gherkin-Szenarien | Tut der Browser, was die Spezifikation verlangt? | `pnpm run test:bdd` |
| Architekturtests | Halten die Entscheidungen, die niemand im Kopf behalten kann? | in `pnpm test` enthalten |
| Mutationstests | *Behaupten* die Tests etwas, oder führen sie nur Zeilen aus? | `pnpm run test:mutation` |
| Smoke-Test | Funktioniert das Zusammenspiel in der echten Anwendung? | `pnpm run test:smoke` |
| Metriken | Bewegen sich Größe, Abdeckung und Struktur in die richtige Richtung? | `pnpm run metrics` |
| QA-Prozeduren | Was nur ein Mensch oder echte Hardware prüfen kann | [QA.md](QA.md) |

`pnpm run quality` bündelt Typprüfung, Lint, Coverage und Metriken.

## Gherkin — warum überhaupt

Die Spezifikation ist in Prosa geschrieben und enthält Sätze wie *„Beim Reduzieren
des Layouts werden freiwerdende Tabs nicht geschlossen"*. Ein Unit-Test, der das
prüft, heißt `setLayout returns orphaned tab ids` — korrekt, aber man muss den Code
lesen, um zu sehen, ob es die Anforderung ist. Das Szenario dazu lautet:

```gherkin
Scenario: Shrinking the layout does not close tabs
  Given the "2x2" layout
  And tabs "a, b, c, d"
  When I assign tab "a" to tile 0
  ...
  And I switch to the "1x1" layout
  Then tile 0 shows tab "a"
  And tab "d" is not in any tile
  And no tab was closed
```

Das ist gegen die Spezifikation lesbar, ohne den Code zu kennen. Deshalb liegen die
Verhaltensanforderungen in `.feature`-Dateien und die Randfälle in Unit-Tests — nicht
weil BDD ein Prinzip ist, sondern weil die Spec in dieser Sprache geschrieben ist.

Fünf Feature-Dateien, 86 Szenario-Blöcke, die zu 144 Testfällen expandieren (Scenario Outlines mit Beispieltabellen): `quicklinks`, `split-view`, `privacy`,
`permissions-and-settings`, `address-bar`.

**Ein Detail, das überrascht:** quickpickle registriert Steps nach ihrem *Text*,
nicht nach dem Schlüsselwort. `When tile 0 is active` und `Then tile 0 is active`
kollidieren. Deshalb heißt der eine jetzt `When I focus tile 0`.

## Architekturtests — Fitness-Funktionen

`tests/architecture.test.ts` liest den Quellcode statt ihn auszuführen. Es schützt
die Entscheidungen, die ein Review sich merken müsste:

- **Schichtgrenzen** — `shared` ohne Electron und ohne Node, Renderer ohne Zugriff
  auf den Kern, Preload ohne Node-Builtins.
- **Bundle-Gewicht** — kein zod in einem Modul, das der Renderer zur Laufzeit
  importiert; Größenbudgets für die gebauten Bundles.
- **Sandbox-Regeln** — jede Web-View mit `sandbox: true`, keine Exposition ohne
  vorherige Rollenprüfung, unbekannte Rolle fällt auf die restriktive zurück.
- **IPC-Disziplin** — jeder Kanal genau einmal registriert, `ipcMain.handle` nur über
  den validierenden Router, ein `webRequest`-Listener pro Ereignis.
- **i18n** — kein sichtbarer String-Literal in einer Komponente.
- **CSP** — jede HTML-Datei hat eine Policy, keine erlaubt Inline-Skript.

Diese Tests haben unterwegs zwei eigene Mängel offengelegt, die erwähnenswert sind:

1. Der Test *„startet den Crash-Reporter nie"* schlug an — auf meinem **eigenen
   Kommentar**, der die absichtliche Abwesenheit dokumentiert. Ein Architekturtest,
   den Prosa täuschen kann, ist schlimmer als keiner, weil er dazu erzieht, ihn
   abzuschwächen. Deshalb entfernt `codeOnly()` jetzt Kommentare und
   String-Literale, bevor gesucht wird.

2. Der Test *„jede Renderer-Subscription wird abgemeldet"* schlug bei `App.tsx` an,
   das die Abmelde-Funktion direkt aus dem `useEffect` zurückgibt. Das ist korrektes
   Cleanup — React ruft sie auf. Der Test kannte das Muster nur nicht.

## Mutationstests — der Ehrlichkeitstest

Coverage sagt, dass eine Zeile ausgeführt wurde. Sie sagt nicht, dass ein Test es
merken würde, wenn die Zeile falsch wäre. Stryker verändert den Quellcode in kleinen
Schritten — `>` zu `>=`, `&&` zu `||`, eine Bedingung negiert — und prüft, ob ein
Test fehlschlägt.

Bewusst auf die reine Logik beschränkt: Adress-Erkennung, Domain-Grenzen,
Parameter-Bereinigung, Kachel-Geometrie, Filter-Pipeline, Header-Transformationen,
Berechtigungen, Sender-Policy, Split-Controller. Electron-gebundenen Code zu mutieren
würde Minuten für Mutanten aufwenden, die kein Unit-Test erreichen kann, und ein
niedriger Wert dort würde nichts über die Testqualität aussagen.

Aktueller Stand: **80,6 %** (730 getötet, 165 überlebt, 11 ohne Abdeckung).
Schwellen: 90 % gut, 80 % Warnung, unter 70 % schlägt fehl. Wenn `break` anspringt,
sind die ehrlichen Reaktionen, die fehlende Zusicherung zu ergänzen oder Code zu
löschen, von dem nichts abhängt — nicht, die Zahl zu senken.

**Zwei Konfigurationsfallen**, die hier aufgetreten sind:

- Unter pnpm findet Stryker seine Plugins nicht über den Standard-Glob. Sie müssen in
  `stryker.config.json` unter `plugins` explizit stehen.
- Der TypeScript-Checker führt einen Trockenlauf durch und fand dabei einen echten
  Typfehler, den ich noch nicht geprüft hatte: eine Assertion-Funktion, die ihren
  Zieltyp aus `Parameters<typeof isSettingsKey>[0]` ableitete. Das ist `unknown`, und
  `unknown & string` ist `string` — die Assertion verengte also nichts, kompilierte
  aber. Mutationstests haben hier gefunden, was ein vergessener Typecheck durchließ.

## Coverage-Schwellen

Global 90 % Zeilen und 85 % Zweige. Pro Bereich höher, wo ein stiller Fehler teuer
ist: Adress-Logik, Kachel-Geometrie, Quick-Link-Baum, Filter-Pipeline,
Berechtigungen, Header und Sender-Policy.

Wo eine Zahl unter 100 liegt, ist der verbleibende Zweig **ohne Änderung am Code
nicht erreichbar** — und jeder davon ist in `vitest.config.ts` benannt. Ein Gate, das
nie durchlaufen kann, ist kein strenges Gate, sondern ein kaputtes, und es erzieht
dazu, Fehlschläge zu ignorieren.

Electron-gebundene Module sind aus der Messung ausgenommen, nicht weil sie
unwichtig sind, sondern weil eine Zahl über nicht ausführbaren Code nichts bedeutet.
Sie werden vom Smoke-Test abgedeckt.

## Smoke-Test

`scripts/smoke.mjs` startet die gebaute Anwendung und steuert sie über das
DevTools-Protokoll. Er beantwortet die einzige Frage, die kein Unit-Test kann:
funktioniert das Ganze zusammen?

26 Checks, darunter die, die anderswo nicht prüfbar sind:

- `tessera://start` wird ausgeliefert, inklusive Assets
- die Brücke ist im Chrome-Renderer vorhanden, alle Vertragskanäle erreichen ihn
- ein Layout-Wechsel auf 2×2 erzeugt zwei Trenner
- ein unbekannter Einstellungsschlüssel wird abgelehnt, ein Wert außerhalb des
  Bereichs ebenso
- **die Startseite hat die enge Brücke, aber nicht die vollständige** — und wird bei
  `settings:set`, `tabs:close`, `split:setLayout`, `window:close` und
  Chrome-Ereignissen abgewiesen

Der letzte Punkt ist der wichtigste. Ein Unit-Test kann die Policy-Funktion prüfen;
nur dieser Test kann prüfen, dass die geprüfte Policy auch die wirksame ist.

## Metriken

`pnpm run metrics` misst und **schlägt fehl**, wenn eine Zahl eine Grenze
überschreitet. Jede Grenze hat einen Grund, keine ist dekorativ:

| Metrik | Grenze | Grund |
|---|---|---|
| Test-zu-testbarem-Quellcode | min 0,5 | Ein Boden, keine Zielgröße: Coverage und Mutation messen direkt, das hier warnt früh |
| Renderer-Zeilen ohne Unit-Test | max 3000 | Darüber braucht die UI Komponententests statt eines End-to-End-Durchgangs |
| Gherkin-Szenarien | min 40 | Verhalten muss irgendwo lesbar für Nicht-Programmierer stehen |
| Größte Quelldatei | max 750 Zeilen | So lang ist meist zwei ungetrennte Module |
| Kommentaranteil | min 0,15 | Die Begründungen sind der Teil, dessen Wiederentdeckung teuer ist |
| Laufzeit-Abhängigkeiten | max 8 | Jede ist ausgelieferter Code und Angriffsfläche |
| Renderer-JavaScript (Summe) | max 320 kB | Parse-Arbeit bei jedem Fensterstart |
| Preload | max 16 kB | Läuft vor jeder Seite |
| Main-Prozess | max 200 kB | Wird geparst, bevor das erste Fenster erscheinen kann |

Alle Größen in dezimalen kB (Bytes ÷ 1000), dieselbe Einheit wie im Build-Log.

Dazu kommen **Budgets pro Chunk** in `tests/architecture.test.ts`, die feiner greifen
als die Summe:

| Chunk-Muster | Grenze | Deckt ab |
|---|---|---|
| `index-*.js` | max 60 kB | Chrome-UI-Einstieg |
| `vendor-react-*.js` | max 240 kB | React, von beiden Einstiegen geteilt |
| `*.css` | max 24 kB | Stylesheets |

**Bekannte Lücke:** die geteilten `shared`-Chunks (`omnibox-*.js`) und der
Startseiten-Einstieg (`start-*.js`) passen auf keines dieser Muster und sind nur durch
das Summenbudget gedeckt. Ausgerechnet der Chunk, der die zod-Regression trug, hat also
kein eigenes Budget. Wer das schließt, ergänzt ein Muster für die geteilten Chunks.

Der Test überspringt nicht, wenn kein Build vorliegt — er läuft trivial durch. So
verlangt `pnpm test` keinen Build, aber ein Lauf nach dem Build hält die Grenze.

Die Bundle-Grenzen existieren, weil hier genau dieser Fehler passiert ist: der
Renderer enthielt 705 kB, davon etwa 500 kB zod, weil ein Modul reine Hilfsfunktionen
und Validierungsschemata in derselben Datei exportierte. Unsichtbar auf einem
schnellen Rechner, deutlich spürbar auf einem alten Laptop. Jetzt ist es ein roter
Test statt einer Entdeckung in einem halben Jahr. Die vollständige Diagnose steht in
[solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md](solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md).

## Was noch fehlt

- **Kein Browser-basierter Komponententest.** Die React-Komponenten werden über den
  Smoke-Test geprüft, nicht isoliert. Für Dialog-Logik und Tastaturnavigation wären
  Tests mit einer echten DOM-Umgebung besser.
- **Keine Performance-Regressionstests.** Bundle-Größen sind budgetiert, Startzeit und
  Speicher nach N Tabs nicht. Beides ist messbar und sollte dazukommen.
- **Kein Test für Kachel-Vollbild in einer echten Anwendung.** Der Zustandsautomat ist
  vollständig getestet, der Mechanismus (`setFullScreenable(false)`) nicht — er
  braucht ein echtes Fenster und einen echten Fenstermanager. Das steht in
  [QA.md](QA.md) und ist der wichtigste offene Punkt.
- **Kein visueller Regressionstest.** quickpickle bringt Screenshot-Vergleich mit;
  sinnvoll, sobald die Oberfläche sich stabilisiert hat.
