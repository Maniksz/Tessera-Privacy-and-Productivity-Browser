# Spike: Bild und Ton zusammenführen

Beantwortet **Q1** und **Q3** aus [`docs/plans/2026-08-09-001-feat-media-recorder-plan.md`](../../docs/plans/2026-08-09-001-feat-media-recorder-plan.md), und liefert nebenbei einen Beleg für **Q5**.

Dieser Ordner ist ein Wegwerfstück. Er hat eine eigene `package.json`, damit die Abhängigkeit **nicht** in die zwei Laufzeitabhängigkeiten des Hauptprojekts wandert. Wenn die Frage beantwortet ist, kann er gelöscht werden.

## Ausführen

```bash
cd scripts/spike-mux
npm install
node merge-spike.mjs --help
```

Der Spike braucht zwei Dateien oder zwei Adressen: eine mit **nur Bild**, eine mit **nur Ton**. So kommst du dran:

1. Video im Browser starten.
2. Entwicklerwerkzeuge, Netzwerk-Tab, nach Medien filtern.
3. Bei getrennten Spuren siehst du zwei Ströme. Rechtsklick, „als cURL kopieren" — daraus liest du die Adresse **und** die Header ab.
4. Beides übergeben:

```bash
node merge-spike.mjs \
  --video "https://…" \
  --audio "https://…" \
  --header "Referer: https://www.example.com/" \
  --header "Origin: https://www.example.com"
```

Für Q3 denselben Lauf mit WebM-Quellen und `--format webm` wiederholen — bei YouTube ist das alles oberhalb von 1080p.

## Was welches Ergebnis bedeutet

| Ausgang | Für den Plan |
|---|---|
| „JA", Datei spielt mit Bild und Ton | Q1 trägt. Die Key Decision zum JavaScript-Weg wird von Richtung zu Entscheidung. |
| „JA", Datei spielt ohne Ton oder asynchron | Q1 fällt negativ aus. Eine Datei, die sich öffnen lässt, ist noch keine, die stimmt. |
| Codec passt nicht in den Container | Q3-Antwort für diesen Fall: dieser Codec verlangt einen anderen Zielcontainer. |
| HTTP-Fehler beim Abruf | Q5-Antwort: der mitgegebene Kontext genügt der Quelle nicht. Header ergänzen und wiederholen — was am Ende nötig war, ist das Ergebnis. |
| Spitzen-RSS in der Größenordnung der Datei | Relevant für R14: das Zusammenführen braucht dann benannte Speichergrenzen. |

Das Urteil des Skripts ist nur die halbe Antwort. **Die Datei danach wirklich abspielen** — Ton da, Bild synchron, Player springt nicht.

## Was dieser Spike ausdrücklich nicht zeigt

Er lädt mit Nodes globalem `fetch` und geht damit an Chromiums Netzwerkstack vorbei. In der Anwendung ist genau das verboten: jeder Byte läuft über die session-gebundene Schnittstelle, siehe R8 im Plan und den Kopfkommentar von [`src/main/media/fetch.ts`](../../src/main/media/fetch.ts). Hier ist es zulässig, weil nichts aus diesem Ordner in die Anwendung wandert.

Er sagt auch nichts über die Live-Hälfte: kein Polling, keine wachsende Segmentliste, keine Diskontinuität. Das ist Q4.
