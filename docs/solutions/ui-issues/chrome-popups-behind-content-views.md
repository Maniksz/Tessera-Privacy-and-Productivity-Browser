---
title: "Toolbar-Dropdown lag hinter der Seite, weil Chrome-UI die unterste Schicht ist"
date: 2026-07-25
category: ui-issues
module: window-layering
problem_type: bug
component: ui
symptoms:
  - "Das Layout-Dropdown öffnete sich sichtbar, reagierte aber auf keinen Mausklick"
  - "184 von 187 Pixeln des Menüs lagen unterhalb der Chrome-Höhe, also im Bereich der nativen Inhalts-View"
  - "Jede DOM-Prüfung war korrekt: Menü vorhanden, fünf Einträge, ein aktiver Eintrag"
  - "Der DevTools-Protokoll-Test bestand, weil ein programmatischer .click() unabhängig von Sichtbarkeit feuert"
  - "Der Smoke-Test prüfte zusätzlich noch Selektoren einer längst entfernten Toolbar-Variante"
root_cause: design_flaw
resolution_type: refactor
severity: high
related_components:
  - src/main/browser/OverlayLayer.ts
  - src/main/browser/BrowserWindowController.ts
  - src/renderer/src/surfaces/OverlaySurface.tsx
  - src/renderer/src/components/LayoutMenu.tsx
  - src/shared/ui/anchor.ts
  - scripts/smoke.mjs
---

# Toolbar-Dropdown lag hinter der Seite

## Problem

Das Layout-Dropdown in der Toolbar ließ sich öffnen, war zu sehen — und nahm keinen Klick an.
Der Nutzer berichtete es als „der Button klappt nicht".

## Ursache

Die Fensterschichtung, nicht das Menü.

Die Chrome-UI (Tab-Leiste, Toolbar) ist das `webContents` des Fensters selbst und damit die
**unterste** Schicht. Jeder Tab ist eine `WebContentsView`, die als Kindview **darüber**
gestapelt wird. Eine native View ist gegenüber dem DOM darunter nicht nur optisch dicht,
sondern auch beim Hit-Testing: Klicks landen auf der Seite, nicht auf dem darunterliegenden
DOM-Element.

Ein Dropdown, das in der Toolbar nach unten aufklappt, ragt damit zwangsläufig in fremdes
Gebiet. Gemessen im laufenden Fenster:

```
chromeBottom: 81
menuTop:      78
menuBottom:   265
pixelsHiddenBehindContentView: 184
```

Das ist kein `z-index`-Problem. `z-index` ordnet Elemente innerhalb eines DOM-Stacking-Contexts;
native Views liegen vollständig außerhalb des DOM und sind immer darüber. Die Pixel eines
Popups **müssen** von einer Schicht über den Views kommen. Dafür gibt es genau drei Wege:
ein natives Menü, ein eigenes Fenster, oder eine eigene View.

## Warum die Tests es nicht gefunden haben

Das ist der teurere Teil des Fehlers.

Ein `element.click()` über das DevTools-Protokoll durchläuft nicht den Treffer-Test des
Compositors. Er feuert den Handler direkt am Element, egal was darüber gezeichnet ist. Der
Test, mit dem „in der laufenden App verifiziert" berichtet wurde, konnte die kaputte
Eigenschaft also gar nicht sehen — er prüfte Existenz, nicht Erreichbarkeit.

Zusätzlich prüfte `scripts/smoke.mjs` noch `.layouts__button`, einen Selektor der vorherigen
Toolbar mit fünf Einzelknöpfen. Diese Prüfung war seit dem Umbau tot und fiel nicht auf, weil
sie in einem separaten Skript und nicht im vitest-Lauf steckt.

## Lösung

Eine **Overlay-Schicht**: eine transparente `WebContentsView` als oberste Kindview des
Fensters, erst bei Bedarf erzeugt.

- `src/main/browser/OverlayLayer.ts` — besitzt die View, hält sie unsichtbar und
  `setBackgroundColor('#00000000')`-transparent, bis etwas präsentiert wird. Seiten bleiben
  hinter einem Menü sichtbar, statt für 190 Pixel Liste ausgeblendet zu werden.
- Tab-Views werden mit `addChildView(tab.view, 0)` eingefügt, also am **unteren** Ende des
  Stapels. Angehängt würde der jeweils neueste Tab über dem Overlay landen und dessen Klicks
  schlucken.
- Die Chrome-UI rendert das Menü nicht mehr selbst, sondern **beschreibt** es: Kind, Anker-Rect
  und aktueller Zustand gehen über `overlay:present` an den Kern, der es an die Overlay-Schicht
  weiterreicht. `aria-expanded` kommt aus dem Kern zurück, damit der Button kein Menü behaupten
  kann, das längst verworfen wurde.
- `src/shared/ui/anchor.ts` platziert die Fläche am Anker: reine Geometrie, damit
  Randfälle prüfbar sind statt durch Fensterziehen gesucht.

Nicht gewählt und warum:

- **Natives Menü** (`Menu.popup`) hätte genau ein Menü gelöst. Snap-Indikator für Drag & Drop,
  Berechtigungsdialoge und Pro-Kachel-Navigationsleisten brauchen beliebige UI über Inhalten,
  und keins davon ist ein Menü.
- **Chrome-UI über die Views legen** würde `-webkit-app-region: drag` (styles.css) in eine
  `WebContentsView` verschieben und damit riskieren, dass das Fenster nicht mehr an der
  Tab-Leiste zu ziehen ist — eine Kerninteraktion, eingetauscht gegen ein Dropdown.
- **Views ausblenden**, wie `window:setOverlay` es für die Vollfenster-Panels tut, ist für ein
  Panel richtig und für ein Menü falsch.

## Vorbeugung

Vier Prüfungen, die den Fehler jeweils allein gefunden hätten:

1. **Erreichbarkeit statt Existenz** (`scripts/smoke.mjs`): kein interaktives Element der
   Chrome-UI darf unter die gemeldete Chrome-Höhe ragen. Ausnahmen sind namentlich mit ihrem
   Mechanismus aufgeführt — `.overlay` (Views sind suspendiert) und `.divider` (die Kacheln
   haben genau dafür eine Fuge).
2. **Schichtregel als Fitness-Funktion** (`tests/architecture.test.ts`): `role="menu"`,
   `role="menuitem*"` und `className="menu"` sind in `src/renderer/src/components/` verboten
   und gehören nach `src/renderer/src/surfaces/`.
3. **Stapelreihenfolge** wird im Quelltext geprüft: `addChildView(tab.view, 0)` muss dort
   stehen.
4. **Transparenz** wird auf das Literal geprüft. Electron liest Hex-Alpha als `AARRGGBB` —
   Alpha zuerst. Verdreht ergibt es deckendes Schwarz über jeder Seite.

## Nebenbefund

`codeOnly()` in den Architektur-Tests entfernt Kommentare *und* String-Literale. Eine Prüfung,
deren Gegenstand ein Literal ist, geht damit ins Leere. Dafür gibt es jetzt `withoutComments()`.
Derselbe Fallstrick traf `declaredInvokeChannelCount()` in `scripts/smoke.mjs`: ein Apostroph
in Prosa („the window's topmost layer") paart sich mit dem nächsten öffnenden Anführungszeichen
und verschluckt einen echten Kanalnamen.

Und die zuvor nur dokumentierte Budget-Lücke ist geschlossen: die Chunk-Budgets haben jetzt
einen Auffang-Eintrag, sodass kein gebautes Asset ohne Grenze bleibt.
