import { describe, expect, it } from 'vitest'
import { isFetchableMediaUrl, mediaUrlVerdict } from '@shared/media/url-guard.js'

/**
 * Which addresses the media feature may fetch on a page's behalf (media plan R25).
 *
 * A playlist is text from the network, and every address in it is somebody else's choice. Fetched
 * without a check, a public page could have the browser read `http://192.168.0.1/admin` or a
 * service on `127.0.0.1` and write the answer into the downloads folder, with the user's own
 * network position as the credential. So only `http(s)` to a public address passes; each case below
 * is one of the ways an address can name this machine or the local network.
 */

describe('the schemes the media feature fetches', () => {
  it('lets http and https to a public host through', () => {
    expect(isFetchableMediaUrl('https://cdn.example.com/v/clip.mp4')).toBe(true)
    expect(isFetchableMediaUrl('http://93.184.216.34/segment.ts')).toBe(true)
    expect(isFetchableMediaUrl('https://[2606:4700::1111]/index.m3u8')).toBe(true)
  })

  it.each(['file:///etc/passwd', 'data:video/mp4;base64,AAAA', 'blob:https://example.com/9d2f'])(
    'refuses %s',
    (url) => {
      expect(mediaUrlVerdict(url)).toMatchObject({ ok: false, reason: 'scheme' })
    }
  )

  it('refuses what is not an address at all', () => {
    expect(mediaUrlVerdict('segment.ts')).toMatchObject({ ok: false, reason: 'unparsable' })
  })

  it('names what it refused, for the diagnostic line', () => {
    expect(mediaUrlVerdict('ftp://example.com/a.ts')).toEqual({
      ok: false,
      reason: 'scheme',
      detail: 'ftp: is not fetched'
    })
    expect(mediaUrlVerdict('http://10.0.0.1/a.ts')).toEqual({
      ok: false,
      reason: 'local-address',
      detail: '10.0.0.1 is on this computer or the local network'
    })
  })
})

describe('the addresses the media feature refuses', () => {
  it.each([
    ['loopback', 'http://127.0.0.1/segment.ts'],
    ['loopback, anywhere in the block', 'http://127.255.0.9/segment.ts'],
    ['the unspecified address', 'http://0.0.0.0:8080/segment.ts'],
    ['a private /8', 'http://10.0.0.1/segment.ts'],
    ['a private /12, low end', 'http://172.16.0.1/segment.ts'],
    ['a private /12, high end', 'http://172.31.255.254/segment.ts'],
    ['a private /16', 'http://192.168.1.1/segment.ts'],
    ['link-local', 'http://169.254.169.254/latest/meta-data'],
    ['shared address space, low end', 'http://100.64.0.1/segment.ts'],
    ['shared address space, high end', 'http://100.127.255.1/segment.ts'],
    ['multicast', 'http://224.0.0.1/segment.ts'],
    ['the broadcast address', 'http://255.255.255.255/segment.ts'],
    // The URL parser writes every IPv4 spelling as dotted decimal before the check reads it.
    ['loopback as one decimal number', 'http://2130706433/segment.ts'],
    ['loopback in hex', 'http://0x7f.0.0.1/segment.ts'],
    ['a private address in octal', 'http://012.0.0.1/segment.ts'],
    ['localhost', 'http://localhost:9000/segment.ts'],
    ['localhost in capitals, with the root dot', 'http://LOCALHOST./segment.ts'],
    ['a name under .localhost', 'http://media.localhost/segment.ts'],
    ['IPv6 loopback', 'http://[::1]/segment.ts'],
    ['the IPv6 unspecified address', 'http://[::]/segment.ts'],
    ['IPv6 link-local', 'http://[fe80::1]/segment.ts'],
    ['IPv6 link-local, top of the block', 'http://[febf::1]/segment.ts'],
    ['IPv6 site-local', 'http://[fec0::1]/segment.ts'],
    ['IPv6 unique local, fc', 'http://[fc00::1]/segment.ts'],
    ['IPv6 unique local, fd', 'http://[fd12:3456::1]/segment.ts'],
    ['IPv6 multicast', 'http://[ff02::1]/segment.ts'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/segment.ts'],
    ['IPv4-mapped private', 'http://[::ffff:192.168.0.1]/segment.ts'],
    ['IPv4-compatible loopback', 'http://[::127.0.0.1]/segment.ts'],
    ['NAT64 of a private address', 'http://[64:ff9b::10.0.0.1]/segment.ts']
  ])('%s', (_name, url) => {
    expect(mediaUrlVerdict(url)).toMatchObject({ ok: false, reason: 'local-address' })
    expect(isFetchableMediaUrl(url)).toBe(false)
  })

  it.each([
    ['just outside the private /12, below', 'http://172.15.255.255/a.ts'],
    ['just outside the private /12, above', 'http://172.32.0.1/a.ts'],
    ['just outside shared address space, below', 'http://100.63.255.255/a.ts'],
    ['just outside shared address space, above', 'http://100.128.0.1/a.ts'],
    ['192.169, not 192.168', 'http://192.169.0.1/a.ts'],
    ['169.253, not 169.254', 'http://169.253.0.1/a.ts'],
    ['the last unicast block', 'http://223.255.255.1/a.ts'],
    ['a name that merely contains localhost', 'http://localhost.example.com/a.ts'],
    ['a name ending in localhost without the dot', 'http://notlocalhost/a.ts'],
    ['a public IPv6 address', 'http://[2001:db8::1]/a.ts'],
    ['IPv6 just below link-local', 'http://[fe7f::1]/a.ts'],
    ['IPv6 just below unique local', 'http://[fbff::1]/a.ts'],
    ['IPv4-mapped public', 'http://[::ffff:93.184.216.34]/a.ts'],
    ['NAT64 of a public address', 'http://[64:ff9b::93.184.216.34]/a.ts'],
    [
      'an IPv6 address with a prefix like NAT64 but a different second group',
      'http://[64:ff9a::a00:1]/a.ts'
    ],
    [
      'an IPv6 address whose low groups look private but whose top is public',
      'http://[2001::a00:1]/a.ts'
    ],
    [
      'an IPv6 address with a mapped-looking tail after a non-zero group',
      'http://[1::ffff:a00:1]/a.ts'
    ]
  ])('lets %s through', (_name, url) => {
    expect(mediaUrlVerdict(url)).toEqual({ ok: true })
  })
})
