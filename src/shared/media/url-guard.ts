/**
 * Which addresses the media feature may fetch on a page's behalf (media plan R25).
 *
 * ## Why a guard at all, given the page fetched them first
 *
 * It did not, in the case that matters. A playlist is text from the network, and every variant and
 * segment address in it is the author's choice: `http://192.168.0.1/admin` in an HLS playlist costs
 * nothing to write. The page's player may never request it — and if it did, Chromium's private
 * network rules would stand between a public page and the local network. A download the browser runs
 * itself has no such rule unless this module is one. Without it, a public page could have the browser
 * read a router's admin page, or a service on `127.0.0.1`, with the user's own network position as
 * the credential, and write the answer into the downloads folder.
 *
 * So only `http:` and `https:` to a public address pass: `file:`, `data:` and `blob:` cannot be
 * re-requested through a session, and loopback, link-local, private and the other non-public blocks
 * name this machine or its network.
 *
 * ## What it cannot see
 *
 * A host *name* that resolves to a private address. Resolving here would be a second DNS lookup next
 * to Chromium's, racing it, and still wrong under rebinding; the name is passed and the network stack
 * decides where it goes. Every IP literal is checked, in every spelling the URL parser accepts — it
 * writes `2130706433`, `0x7f.0.0.1` and `[::ffff:127.0.0.1]` in canonical form before this module
 * reads them, which is why nothing below parses octal or hex.
 */

export type MediaUrlVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'unparsable' | 'scheme' | 'local-address'
      /** For the diagnostic line; never shown as the refusal sentence. */
      readonly detail: string
    }

const FETCHABLE: MediaUrlVerdict = { ok: true }

/** Whether `url` may be fetched, and if not, why. */
export function mediaUrlVerdict(url: string): MediaUrlVerdict {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'unparsable', detail: 'not an absolute address' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme', detail: `${parsed.protocol} is not fetched` }
  }
  // Already lowercase: the URL parser folds the case of an http(s) host.
  const host = parsed.hostname.replace(/\.$/, '')
  if (!isLocalHost(host)) return FETCHABLE
  return {
    ok: false,
    reason: 'local-address',
    detail: `${host} is on this computer or the local network`
  }
}

export function isFetchableMediaUrl(url: string): boolean {
  return mediaUrlVerdict(url).ok
}

function isLocalHost(host: string): boolean {
  // RFC 6761: `localhost` and every name under it is loopback, whatever a resolver would say.
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.startsWith('[')) return isLocalIpv6(host.slice(1, -1))
  const octets = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (octets === null) return false
  return isLocalIpv4(Number(octets[1]), Number(octets[2]))
}

/** By the first two octets, which is all any of these blocks needs. */
function isLocalIpv4(a: number, b: number): boolean {
  return (
    a === 0 || // "this network", including the unspecified address
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (carrier-grade NAT)
    (a === 169 && b === 254) || // link-local, where cloud metadata services live
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved and broadcast: nothing a stream is served from
  )
}

/**
 * A canonical IPv6 address as its 32 hex digits.
 *
 * Canonical as the URL parser writes one: lowercase, at most one `::`, no dotted tail. So filling in
 * the `::` is the whole job, and the prefix checks below become string prefixes of fixed width.
 */
function hexDigitsOf(address: string): string {
  const present = address.split(':').filter((group) => group !== '').length
  const filled = address.replace('::', `:${'0:'.repeat(8 - present)}`)
  return filled
    .split(':')
    .filter((group) => group !== '')
    .map((group) => group.padStart(4, '0'))
    .join('')
}

function isLocalIpv6(address: string): boolean {
  const hex = hexDigitsOf(address)
  // Link-local (fe80::/10), site-local (fec0::/10), unique local (fc00::/7) and multicast (ff00::/8).
  if (/^(fe[89a-f]|f[cd]|ff)/.test(hex)) return true
  /*
    An IPv4 address carried inside an IPv6 one: compatible (`::a.b.c.d`, which also covers `::` and
    `::1` as 0.0.0.0 and 0.0.0.1), mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`). Each is
    judged by the address it carries, which is where the packet ends up.
  */
  if (!/^(0{20}(0{4}|ffff)|0064ff9b0{16})/.test(hex)) return false
  return isLocalIpv4(Number.parseInt(hex.slice(24, 26), 16), Number.parseInt(hex.slice(26, 28), 16))
}
