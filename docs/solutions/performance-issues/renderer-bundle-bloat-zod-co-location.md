---
title: "Renderer-Bundle enthielt zod, weil reine Helfer neben Schemata lagen"
date: 2026-07-25
category: performance-issues
module: renderer-bundle
problem_type: performance_issue
component: tooling
symptoms:
  - "Renderer-Build erzeugte einen 705-kB-Chunk `omnibox-*.js` für nur eine Toolbar plus Startseite"
  - "Der Chunk enthielt die komplette zod-Bibliothek — 297 `zod`-Referenzen, 64 `ZodString`, 23 `safeParse`"
  - "Die gebaute Ausgabe war 12.842 Zeilen lesbares, unminifiziertes JavaScript trotz korrektem React-Production-Build"
  - "React wurde zweimal eingebettet, einmal pro HTML-Einstieg, also dieselben ~140 kB zweimal pro Fenster geparst"
  - "Kein Test und keine Metrik schlug an; die Kosten fielen bei jedem Fensterstart an"
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - electron.vite.config.ts
  - src/shared/quicklinks/model.ts
  - src/shared/quicklinks/schema.ts
  - src/shared/i18n/catalog.ts
  - src/shared/i18n/schema.ts
  - tests/architecture.test.ts
  - scripts/metrics.mjs
tags:
  - bundle-size
  - zod
  - tree-shaking
  - esbuild-minify
  - electron-vite
  - code-splitting
  - module-boundaries
  - startup-performance
---

# Renderer-Bundle enthielt zod, weil reine Helfer neben Schemata lagen

## Problem

Der gebaute Renderer lieferte einen 705-kB-JavaScript-Chunk für nur eine Toolbar und
eine Startseite aus, weil ein `shared`-Modul reine Helfer **und** zod-Schemata
exportierte — ein Import von `childrenOf` zog damit die ganze Validierungsbibliothek
ins UI-Bundle. Zusätzlich war Minifizierung nie aktiviert, und React wurde in jeden
der beiden HTML-Einstiege separat eingebettet.

Die projektspezifische Begründung für die Modultrennung und die gemessenen Zahlen
stehen in [ARCHITECTURE.md → Was am Bundle gemessen wurde](../../ARCHITECTURE.md)
und [README → Performance](../../../README.md). Dieses Dokument beschreibt, was dort
nicht steht: **wie** die Ursache gefunden wurde, warum ein Bundler das nicht selbst
löst, und wie der Schutz konstruiert ist.

## Symptoms

- Ein Renderer-Chunk von rund 705 kB, benannt `omnibox-*.js`, für eine UI, deren
  eigener Quellcode unter 1.600 Zeilen liegt.
- Der Chunk enthielt eine Validierungsbibliothek, die der Renderer nie aufruft. Ein
  Grep in der gebauten Datei fand 297 `zod`-Referenzen, 64 `ZodString`, 10
  `ZodObject` und 23 `safeParse`.
- Die gebaute Datei war 12.842 Zeilen lesbares, nicht minifiziertes JavaScript —
  Bezeichner, Kommentare und Lizenzblöcke intakt.
- ~140 kB React wurden zweimal pro Fenster geparst und kompiliert: einmal für den
  Chrome-UI-Einstieg (`src/renderer/index.html`), einmal für die Startseite
  (`src/renderer/internal/start.html`).
- Das Preload erzeugte einen **geteilten Chunk** — den ein sandboxed Preload zur
  Laufzeit gar nicht per `require` laden kann.
- **Kein Test und keine Metrik schlug an.** Nichts war kaputt; die Kosten waren auf
  einem schnellen Rechner unsichtbar und fielen bei jedem Fensterstart an, am
  stärksten auf der älteren Hardware, die dieses Projekt ausdrücklich adressiert.

## What Didn't Work

**Dem Chunk-Namen vertrauen.** Rollup benennt einen Chunk nach einem seiner
Quellmodule — hier dem größten geschriebenen —, und der 705-kB-Chunk hieß
`omnibox-*.js`. Aber `src/shared/url/omnibox.ts` ist 184 Zeilen lang und enthält null
Vorkommen von `zod`. Der Name zeigte auf eine kleine, unschuldige Datei. Gefunden wurde die Ursache
durch einen Grep im *Inhalt* des Chunks nach bibliotheksinternen Symbolen
(`ZodString`, `ZodObject`, `safeParse`) — nicht durch Lesen des Dateinamens.

**Einen React-Development-Build vermuten.** Die naheliegende Erklärung für eine
aufgeblähte React-Anwendung ist ein versehentlich gebündelter Dev-Build. Ein Grep
nach `react-dom.development`, `__DEV__` und `checkPropTypes` ergab jeweils 0 Treffer
— der Production-Build war bereits korrekt gewählt. Eine Sackgasse, aber eine nötige
Ausschlussprüfung: sie schloss die häufigste Ursache aus und erzwang die Suche
woanders.

**Annehmen, Minifizierung sei an, weil es ein Production-Build ist.**
`electron.vite.config.ts` hatte für keinen der drei Builds eine `minify`-Einstellung,
und electron-vite aktivierte esbuild-Minify in dieser Konfiguration nicht von selbst.
Die 12.842 Zeilen vollständig lesbarer Ausgabe widerlegten die Annahme — ein
Production-Bundle, das man bequem lesen kann, ist nicht minifiziert.

**Ein Browser-Target für den Preload-Build setzen.** Ein erster Versuch setzte
`target: CHROMIUM_TARGET` auch für das Preload, mit der Begründung, ein Preload laufe
neben der Seite. electron-vite lehnte das ab: `The electron vite preload config
build.target must be "node?"`. Ein Preload wird über Node's Modulsystem geladen,
obwohl es neben Web-Inhalt ausgeführt wird, braucht also ein Node-Target. Das steht
jetzt in `electron.vite.config.ts:53-56`:

```ts
// Node target, not the Chromium one: a preload is loaded through Node's
// module system even though it runs alongside the page, and electron-vite
// rejects anything else here.
target: NODE_TARGET,
```

## Solution

### 1. Reine Helfer von den Schemata trennen

`src/shared/quicklinks/model.ts` hat jetzt genau einen Import, und der ist nicht zod
(`src/shared/quicklinks/model.ts:1`):

```ts
import { classifyOmniboxInput } from '../url/omnibox.js'
```

Vorher trug dieselbe Datei sowohl die reinen Helfer, die der Renderer braucht
(`childrenOf`, `countChildren`, `findLink`, `titleFromUrl`), als auch
`import { z } from 'zod'` für ihre Schemata. Die Schemata liegen jetzt in einer neuen
Datei, `src/shared/quicklinks/schema.ts:1-3`:

```ts
import { z } from 'zod'
import { MAX_QUICK_LINKS, MAX_TITLE_LENGTH, QUICK_LINK_KINDS } from './model.js'
import type { QuickLink, QuickLinkDocument } from './model.js'
```

**Die Richtung der Abhängigkeit ist der Punkt:** `schema.ts` importiert die
Konstanten aus `model.ts`, niemals umgekehrt. Das schwere Modul hängt am leichten,
also zahlt ein Konsument des leichten nichts.

Dieselbe Trennung wurde auf den Nachrichtenkatalog angewandt:
`src/shared/i18n/catalog.ts` ist jetzt abhängigkeitsfrei, und `localeSchema` liegt
allein in `src/shared/i18n/schema.ts:12`. Konsumenten, die tatsächlich Validierung
brauchen, importieren aus den neuen Dateien — `src/shared/ipc/contract.ts:13-14`:

```ts
import { localeSchema } from '../i18n/schema.js'
import { quickLinkKindSchema, quickLinkSchema } from '../quicklinks/schema.js'
```

Ein Schema von seinem Interface zu trennen schafft eine neue Driftmöglichkeit, also
nagelt `schema.ts` beide zusammen — vier typisierte Zuweisungen, zwei pro Form, je
eine in jede Richtung (`src/shared/quicklinks/schema.ts:37-43`):

```ts
type SchemaLink = z.output<typeof quickLinkSchema>

const _linkMatchesModel: SchemaLink = null as unknown as QuickLink
const _modelMatchesLink: QuickLink = null as unknown as SchemaLink
```

Eine einzelne Zuweisung würde Drift nur in einer Richtung fangen.

### 2. Minifizierung einschalten

`electron.vite.config.ts` setzt jetzt `minify: 'esbuild'` für alle drei Builds — Main
(`:31`), Preload (`:57`), Renderer (`:74`) — und verwirft Lizenztexte von
Abhängigkeiten im Renderer (`:105-109`).

Build-Ziele sind auf das gepinnt, was Electron tatsächlich mitbringt, statt
herunterzustufen (`electron.vite.config.ts:21-22`):

```ts
const CHROMIUM_TARGET = 'chrome150'
const NODE_TARGET = 'node24'
```

Verifiziert am ausgelieferten Framework-Binary statt aus Release Notes angenommen:

```
strings node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron\ Framework.framework/Electron\ Framework \
  | grep -oE "Chrome/1[0-9]{2}\.0\.[0-9]+\.[0-9]+"
# Chrome/150.0.7871.129
```

Der Main-Prozess bündelt seine Abhängigkeiten außerdem nicht mehr und nutzt die
aktuelle Option anstelle des veralteten `externalizeDepsPlugin`
(`electron.vite.config.ts:32-35`).

### 3. React einen geteilten Chunk geben

Beide HTML-Einstiege ziehen React jetzt aus einem einzigen Chunk
(`electron.vite.config.ts:96-101`):

```ts
manualChunks: (id: string) => {
  if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
    return 'vendor-react'
  }
  return undefined
}
```

Zusätzlich gibt `reportCompressedSize: true` (`electron.vite.config.ts:77`) gzip-Zahlen
im Build-Log aus, damit eine Regression sofort sichtbar ist.

### Ergebnis

Die vollständige Vorher/Nachher-Tabelle steht in
[README → Performance](../../../README.md) und wird hier absichtlich nicht wiederholt
— zwei Kopien derselben Zahlen driften auseinander. Die zwei Werte, die die Ursache
belegen:

- Der `omnibox`-Chunk fiel von **705 kB auf 13,9 kB**.
- Vorkommen von `ZodString` im Renderer-Bundle: **64 → 0**.

Beide Werte sind aus dem aktuellen Baum reproduzierbar. Die Chunk-Größe steht in
`ls -l out/renderer/assets/`; `node scripts/metrics.mjs` prüft nur die **Summe** aller
Renderer-Chunks (aktuell 227 kB gegen ein Budget von 320 kB, dezimale kB) und gibt keine Einzelgrößen
aus. Ein Grep über `out/renderer/assets/**/*.js` nach `zod` liefert in jedem Chunk 0
Treffer.

## Why This Works

**Ein Wert-Import ist eine Abhängigkeit auf einen ganzen Modulgraphen, nicht auf die
Namen, die man aufgelistet hat.** TypeScript löscht `import type`, ein reiner
Typ-Import kostet zur Laufzeit also nichts. Ein *Wert*-Import bekommt diese Behandlung
nicht: um `childrenOf` zu liefern, muss der Bundler das definierende Modul auswerten
— und damit alles, was dieses Modul auf oberster Ebene importiert. Das
`import { z } from 'zod'` über den Schemata in derselben Datei war deshalb eine harte
Laufzeit-Abhängigkeit von `childrenOf`.

**Tree-Shaking kann das im Allgemeinen nicht retten.** Einen Top-Level-Import zu
eliminieren erfordert den Nachweis, dass das Modul keine erhaltungswürdigen
Seiteneffekte hat, und eine Bibliothek von zods Größe baut Objekte und Prototypen auf
Modulebene auf. Die sichere Antwort eines Bundlers ist, sie zu behalten. Die Lösung ist
also keine Bundler-Einstellung, sondern das Verschieben der Grenze, damit der vom
Renderer erreichbare Graph die Bibliothek nie berührt.

**Deshalb führte der Chunk-*Name* in die Irre.** Rollup benennt einen Chunk nach
*einem* seiner Quellmodule — hier dem größten geschriebenen. Der Name misst also
geschriebene Zeilen, nicht ausgelieferte Bytes.
`omnibox.ts` war das Größte, was der Renderer *geschrieben* hatte; zod war das Größte,
was er *auslieferte*. Grep die Bytes, nicht den Dateinamen.

Die beiden anderen Ursachen sind unabhängige Multiplikatoren auf dieselbe Rechnung.
Ohne `minify` wird jeder Bezeichner, Kommentar und Lizenzblock im Graphen wörtlich
ausgeliefert — was gleichzeitig das Erkennungsmerkmal ist. Ohne `manualChunks` hat
Rollup keinen Grund, ein Modul zwischen zwei Einstiegen zu teilen, die sich nicht
gegenseitig importieren, also bettet jede HTML-Seite ihr eigenes React ein: dieselben
Bytes, und V8 parst und kompiliert sie zweimal pro Fenster statt die zweite Seite aus
dem Code-Cache zu bedienen. Nur die zod-Trennung hätte rund 140 kB dupliziertes React
und ein unminifiziertes Bundle übrig gelassen.

## Prevention

Drei Schichten. Die Details der Teststrategie stehen in
[TESTING.md → Architekturtests](../../TESTING.md); hier steht, warum die Tests so
konstruiert sind.

**1. Eine Fitness-Funktion, die den Wert-Import-Graphen des Renderers abläuft.**
Entscheidend ist, dass sie Wert-Importe von gelöschten unterscheidet — ein Test, der
`import type { QuickLink }` anmeckert, wäre falsch, und falsch zu sein ist der Weg,
auf dem eine Fitness-Funktion gelöscht wird. Der Helfer in
`tests/architecture.test.ts:88-108` überspringt `import type` und auch
`import { type A, type B } from`, weil beide vollständig gelöscht werden.

Der Test läuft dann transitiv von jeder Renderer-Datei nach `src/shared/` und stellt
sicher, dass nichts Erreichbares zod wert-importiert
(`tests/architecture.test.ts:161-195`):

```ts
for (const file of rendererFiles) visit(file)
expect(reachable.size, 'expected the renderer to import something from shared').toBeGreaterThan(0)

for (const module of reachable) {
  const text = readFileSync(join(ROOT, module), 'utf8')
  expect(valueImportsOf(text), `${module} is reachable from the renderer`).not.toContain('zod')
}
```

Die Absicherung `reachable.size > 0` ist wesentlich: ohne sie würde ein defekter Alias
dazu führen, dass der Lauf nichts findet und der Test für immer leer durchläuft.

**2. Größenbudgets auf der gebauten Ausgabe** (`tests/architecture.test.ts:197-230`).
Liegt kein Build vor, läuft der Test trivial durch statt fehlzuschlagen — so verlangt
`pnpm test` keinen Build, aber ein Lauf nach dem Build hält die Grenze.

Der Test budgetiert drei Muster: den Chrome-Einstieg (`index-*.js`, 60 kB), den
React-Chunk (`vendor-react-*.js`, 240 kB) und Stylesheets (24 kB). **Bekannte Lücke:**
der `omnibox-*.js`-Chunk — genau der, um den es hier geht — passt auf keines dieser
Muster und ist damit nur durch das Summenbudget von 320 kB gedeckt, aktuell mit rund
98 kB Luft. Wer diese Lücke schließt, sollte ein Muster für die geteilten
`shared`-Chunks ergänzen.

Ein Geschwistertest in derselben Datei, `keeps the preload bundle self-contained`,
stellt sicher, dass das gebaute Preload kein relatives `require("./…")` enthält — genau
der Fehlerfall mit dem geteilten Chunk, den ein aufgeteilter Preload-Build wieder
einführen würde.

**3. Harte Budgets im Metriken-Befehl, der mit Exit-Code ungleich 0 endet.**
`scripts/metrics.mjs` prüft Renderer-JavaScript, Preload und Main-Prozess gegen
Obergrenzen; `check` schreibt Überschreitungen in `failures`, und das Skript endet mit
`process.exit(failures.length > 0 ? 1 : 0)`. Das ist also ein Gate, kein Bericht. Es
läuft als Teil von `pnpm quality`.

### Die übertragbaren Regeln

- **Einen reinen Helfer neben den Schemata einer schweren Abhängigkeit zu platzieren
  vergiftet jeden Konsumenten dieses Helfers.** Trenne nach *Abhängigkeitsgewicht*,
  nicht nach Domäne: `model.ts` für Interfaces, Fehler und reine Funktionen,
  `schema.ts` für Laufzeit-Validierung — und die schwere Datei importiert die leichte,
  nie umgekehrt.
- Wenn ein Bundle unerwartet groß ist, **grep seine Bytes** nach bibliotheksinternen
  Symbolen. Diagnostiziere nie aus dem Dateinamen eines Chunks — der Name kommt von
  einem *geschriebenen* Modul darin, nicht vom größten *ausgelieferten* Anteil.
- Ist ein Production-Bundle bequem lesbar, ist Minifizierung aus. Schließe das nicht
  daraus, dass „es ein Production-Build ist".
- Verifiziere Engine-Ziele durch Auslesen der Version aus dem ausgelieferten Binary,
  nicht aus Release Notes.
- Kodiere den Fix als Fitness-Funktion über den *Import-Graphen*, nicht als Grep nach
  einem Bibliotheksnamen in einem Verzeichnis. Ein Grep über `src/shared` nach `zod`
  würde für immer fehlschlagen, weil der Kern zod legitim braucht — nur der vom
  Renderer erreichbare Teilgraph ist die Invariante.

## Related Issues

- [ARCHITECTURE.md → Performance auf schwacher Hardware](../../ARCHITECTURE.md) —
  warum Parse-Zeit in diesem Projekt überhaupt zählt, und die architektonische
  Begründung der Modultrennung.
- [ARCHITECTURE.md → Die UI/Kern-Grenze](../../ARCHITECTURE.md) — dieselbe Regel war
  für `channels.ts` und `contract.ts` bereits bewusst umgesetzt („die Schemata landen
  nie im Renderer-Bundle"). Der hier beschriebene Fehler ist dieselbe Regel, in einem
  anderen Verzeichnis gebrochen.
- [TESTING.md → Metriken](../../TESTING.md) — die durchgesetzten Budgets und warum sie
  existieren.
- [QA.md → Schwache Hardware](../../QA.md) — die manuellen Prüfungen, für die die
  Bundle-Reduktion letztlich gemacht wurde.
- Kein Git-Repository zum Zeitpunkt der Dokumentation, daher keine Commit- oder
  PR-Referenzen.
