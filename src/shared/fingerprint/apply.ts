/**
 * The masking as it runs inside the page's own JavaScript world (spec 4).
 *
 * The nine measures live in four files by subject — identity, media, environment,
 * time — and this is the door to all of them. Everything that is true of all nine
 * is written here rather than four times; each part file says which subject it
 * covers and points back.
 *
 * ## Why every measure is self-contained
 *
 * Context isolation means the preload runs in a *different* world from the page:
 * patching `HTMLCanvasElement.prototype` there changes nothing a page can see. The
 * only sanctioned way across is `contextBridge.executeInMainWorld`, which
 * **serialises the function** — it is re-compiled in the page's world from its own
 * source text, with no closure and no module scope.
 *
 * So each exported function may reference nothing but its own parameters, its own
 * locals, and page globals. A call to a shared helper, or to a constant at the top
 * of its file, would compile, bundle and pass review — and then throw
 * `ReferenceError` in the page, because the identifier does not exist over there.
 * That is why the small property-redefining helper is written out again inside each
 * function instead of being factored out, and why a plan arrives as plain data
 * rather than as an object with methods.
 *
 * The rule is per *function*, not per file: splitting the measures across files
 * costs nothing, because nothing was ever shared between them. What holds the rule
 * is a test that compiles each measure from its own source in an empty context —
 * `tests/fingerprint-masking.test.ts`.
 *
 * Types are exempt: `import type` is erased before that source ever exists, which
 * is why `page.ts` may hold the two shapes all four parts need.
 *
 * ## Why it is a set of functions rather than one
 *
 * Each setting maps to one function, so `fingerprint.maskCanvas` off means one
 * function is never called — not a flag threaded through a monolith. It also keeps
 * each piece small enough to test against a fabricated page.
 *
 * ## What this approach cannot reach
 *
 * A preload runs in the main frame of its renderer. It does not run in iframes
 * (`nodeIntegrationInSubFrames` is deliberately false) and it does not run in
 * workers, so measurements taken there see the real values. Closing that gap needs
 * the masking below Blink rather than above it, which is the acknowledged price of
 * not forking Chromium — stated in the README rather than hidden here.
 *
 * A determined script can also detect *that* masking is present, because a replaced
 * accessor does not stringify like a native one. Making the values consistent is
 * worth more than making the patch invisible: a consistent lie puts the user in a
 * crowd, while an inconsistent one leaves them alone in it.
 *
 * Every function is written not to throw on a page that lacks the API it patches. A
 * masking measure that breaks a page is a measure the user switches off.
 */

export { maskLocale, maskUserAgent } from './mask-identity.js'
export { maskAudio, maskCanvas, maskWebgl } from './mask-media.js'
export { maskDeviceApis, maskFonts, maskScreen } from './mask-environment.js'
export { maskTimeZone } from './mask-time.js'
