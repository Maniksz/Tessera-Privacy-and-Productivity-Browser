/**
 * Spike für Q1 und Q3 des Medien-Recorder-Plans.
 *
 * Beantwortet in einem Lauf:
 *   Q1 — Führt eine reine JavaScript-Bibliothek getrennte Bild- und Tonspuren
 *        ohne Neukodieren zu einer abspielbaren Datei zusammen?
 *   Q3 — Geht WebM (Matroska) auf demselben Weg mit, oder braucht es einen
 *        zweiten Weg?
 *
 * Und liefert nebenbei Belege für Q5: welche Anfrage-Header eine Zielquelle
 * verlangt, damit sie einen zweiten Abruf annimmt.
 *
 * WICHTIG — dieser Spike ist kein Vorbild für die Umsetzung. Er lädt mit Nodes
 * globalem `fetch`, geht also an Chromiums Netzwerkstack vorbei. In der
 * Anwendung muss jeder Byte über die session-gebundene Schnittstelle laufen;
 * siehe R8 im Plan und den Kopfkommentar von `src/main/media/fetch.ts`. Hier ist
 * das zulässig, weil nichts davon in die Anwendung wandert.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { argv, exit, memoryUsage } from 'node:process'
import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  FilePathSource,
  FilePathTarget,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat
} from 'mediabunny'

const WORK_DIR = 'spike-out'

function parseArgs(args) {
  const out = { headers: {}, format: 'mp4', out: null, video: null, audio: null }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = () => {
      const value = args[++i]
      if (value === undefined) fail(`${arg} braucht einen Wert`)
      return value
    }
    if (arg === '--video') out.video = next()
    else if (arg === '--audio') out.audio = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--format') out.format = next()
    else if (arg === '--header') {
      const raw = next()
      const colon = raw.indexOf(':')
      if (colon === -1) fail(`--header erwartet "Name: Wert", bekam "${raw}"`)
      out.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim()
    } else if (arg === '--help' || arg === '-h') out.help = true
    else fail(`unbekanntes Argument: ${arg}`)
  }
  return out
}

function fail(message) {
  console.error(`\nFehler: ${message}\n`)
  exit(2)
}

const USAGE = `
Nutzung:
  node merge-spike.mjs --video <URL|Pfad> --audio <URL|Pfad> [Optionen]

Optionen:
  --format mp4|webm     Zielcontainer (Vorgabe: mp4)
  --out <Pfad>          Zieldatei (Vorgabe: ${WORK_DIR}/merged.<ext>)
  --header "N: V"       Anfrage-Header, mehrfach angebbar. Nur für URLs.

So kommst du an die beiden Adressen:
  Video im Browser starten, Entwicklerwerkzeuge, Netzwerk-Tab, nach dem
  Manifest oder nach Segmenten filtern. Bei getrennten Spuren siehst du zwei
  Ströme — einen ohne Ton, einen ohne Bild. Rechtsklick, "als cURL kopieren"
  zeigt dir zugleich, welche Header mitgehen; die interessanten sind Referer,
  Origin, Cookie und Authorization.

Beispiel:
  node merge-spike.mjs \\
    --video "https://…/videoplayback?…" \\
    --audio "https://…/videoplayback?…" \\
    --header "Referer: https://www.example.com/" \\
    --header "Origin: https://www.example.com"
`

/** Holt eine Adresse und legt sie ab, oder reicht einen lokalen Pfad durch. */
async function materialize(ref, headers, label) {
  if (!/^https?:\/\//i.test(ref)) {
    const info = await stat(ref).catch(() => null)
    if (info === null) fail(`${label}: Datei nicht gefunden — ${ref}`)
    return { path: ref, bytes: info.size, fetched: false }
  }

  await mkdir(WORK_DIR, { recursive: true })
  const target = join(WORK_DIR, `${label}.bin`)
  const started = Date.now()
  const response = await fetch(ref, { headers }).catch((error) => {
    fail(`${label}: Abruf fehlgeschlagen — ${error.message}`)
  })

  if (!response.ok) {
    const sent = Object.keys(headers)
    fail(
      `${label}: HTTP ${response.status} ${response.statusText}\n` +
        `  Gesendete Header: ${sent.length === 0 ? '(keine)' : sent.join(', ')}\n` +
        `  Das ist eine Antwort auf Q5: der Kontext genügt der Quelle nicht.`
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(target, buffer)
  return {
    path: target,
    bytes: buffer.byteLength,
    fetched: true,
    contentType: response.headers.get('content-type'),
    ms: Date.now() - started,
    sentHeaders: Object.keys(headers)
  }
}

/** Öffnet eine Datei und beschreibt die eine Spur, die sie tragen soll. */
async function describe(path, kind) {
  const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS })
  const format = await input.getFormat()
  const track =
    kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack()

  if (track === null) {
    const others = kind === 'video' ? await input.getAudioTracks() : await input.getVideoTracks()
    fail(
      `${path}: keine ${kind === 'video' ? 'Bild' : 'Ton'}spur gefunden` +
        (others.length > 0
          ? ` — die Datei trägt stattdessen ${others.length} ${kind === 'video' ? 'Ton' : 'Bild'}spur(en). Sind --video und --audio vertauscht?`
          : '')
    )
  }

  const codec = await track.getCodec()
  const config = await track.getDecoderConfig()
  const detail =
    kind === 'video'
      ? `${await track.getDisplayWidth()}x${await track.getDisplayHeight()}`
      : `${await track.getSampleRate()} Hz, ${await track.getNumberOfChannels()} Kanäle`

  return { input, track, codec, config, detail, formatName: format.name, kind }
}

/** Schreibt die Pakete beider Spuren in einen Container. Ohne Neukodieren. */
async function remux(video, audio, outPath, containerFormat) {
  const output = new Output({
    format: containerFormat,
    target: new FilePathTarget(outPath)
  })

  const videoSource = new EncodedVideoPacketSource(video.codec)
  const audioSource = new EncodedAudioPacketSource(audio.codec)
  output.addVideoTrack(videoSource)
  output.addAudioTrack(audioSource)

  await output.start()

  const counts = { video: 0, audio: 0 }
  for (const [side, source, counterKey] of [
    [video, videoSource, 'video'],
    [audio, audioSource, 'audio']
  ]) {
    const sink = new EncodedPacketSink(side.track)
    let first = true
    for await (const packet of sink.packets()) {
      await source.add(packet, first ? { decoderConfig: side.config } : undefined)
      counts[counterKey]++
      first = false
    }
  }

  await output.finalize()
  return counts
}

/** Öffnet das Ergebnis erneut: eine Datei, die sich nicht lesen lässt, zählt nicht. */
async function verify(outPath) {
  const input = new Input({ source: new FilePathSource(outPath), formats: ALL_FORMATS })
  const videoTracks = await input.getVideoTracks()
  const audioTracks = await input.getAudioTracks()
  const duration = await input.computeDuration()
  const size = (await stat(outPath)).size
  input.dispose()
  return { videoTracks: videoTracks.length, audioTracks: audioTracks.length, duration, size }
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

async function main() {
  const args = parseArgs(argv.slice(2))
  if (args.help || args.video === null || args.audio === null) {
    console.log(USAGE)
    exit(args.help ? 0 : 2)
  }
  if (args.format !== 'mp4' && args.format !== 'webm') {
    fail(`--format kennt nur mp4 und webm, bekam "${args.format}"`)
  }

  const containerFormat = args.format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat()
  const outPath = args.out ?? join(WORK_DIR, `merged.${args.format === 'webm' ? 'webm' : 'mp4'}`)
  await mkdir(WORK_DIR, { recursive: true })

  console.log('\n=== Eingaben ===')
  const videoFile = await materialize(args.video, args.headers, 'video')
  const audioFile = await materialize(args.audio, args.headers, 'audio')
  for (const [label, file] of [
    ['Bild', videoFile],
    ['Ton', audioFile]
  ]) {
    console.log(
      `${label}: ${basename(file.path)} — ${mib(file.bytes)}` +
        (file.fetched ? ` (${file.contentType ?? 'ohne Content-Type'}, ${file.ms} ms)` : ' (lokal)')
    )
  }
  if (videoFile.fetched) {
    const sent = videoFile.sentHeaders
    console.log(
      `Q5-Beleg: Abruf angenommen mit ${sent.length === 0 ? 'ganz ohne Zusatz-Header' : sent.join(', ')}.`
    )
  }

  console.log('\n=== Erkannte Spuren ===')
  const video = await describe(videoFile.path, 'video')
  const audio = await describe(audioFile.path, 'audio')
  console.log(`Bild: ${video.formatName} / ${video.codec} / ${video.detail}`)
  console.log(`Ton:  ${audio.formatName} / ${audio.codec} / ${audio.detail}`)

  const supported = containerFormat.getSupportedCodecs()
  for (const side of [video, audio]) {
    if (!supported.includes(side.codec)) {
      fail(
        `${side.codec} passt nicht in ${args.format}. Unterstützt: ${supported.join(', ')}.\n` +
          `  Das ist eine Antwort auf Q3: dieser Codec verlangt einen anderen Zielcontainer.`
      )
    }
  }

  console.log('\n=== Zusammenführen ===')
  const startedAt = Date.now()
  const counts = await remux(video, audio, outPath, containerFormat)
  const elapsed = Date.now() - startedAt
  const peak = memoryUsage().rss
  video.input.dispose()
  audio.input.dispose()

  const result = await verify(outPath)

  console.log(`Pakete: ${counts.video} Bild, ${counts.audio} Ton`)
  console.log(`Dauer: ${elapsed} ms`)
  console.log(`Spitzen-RSS: ${mib(peak)}`)
  console.log(`Ergebnis: ${outPath} — ${mib(result.size)}`)

  console.log('\n=== Befund ===')
  const ok = result.videoTracks === 1 && result.audioTracks === 1 && result.duration > 0
  if (!ok) {
    console.log(
      `NEIN — das Ergebnis hat ${result.videoTracks} Bild- und ${result.audioTracks} Tonspur(en), ` +
        `Dauer ${result.duration}s. Q1 fällt für diese Bibliothek negativ aus.`
    )
    exit(1)
  }
  console.log(
    `JA — eine Datei mit Bild und Ton, ${result.duration.toFixed(1)}s, ohne Neukodieren.\n` +
      `Q1 trägt für ${video.codec}/${audio.codec} in ${args.format}.\n` +
      `Q3: ${args.format === 'webm' ? 'WebM geht auf demselben Weg mit.' : 'für WebM denselben Lauf mit --format webm und WebM-Quellen wiederholen.'}\n\n` +
      `Jetzt abspielen und hinsehen: hat es Ton, läuft Bild synchron, springt der Player?\n` +
      `Eine Datei, die sich öffnen lässt, ist noch keine, die stimmt.`
  )
}

main().catch((error) => {
  console.error(`\nAbbruch: ${error?.stack ?? error}\n`)
  exit(1)
})
