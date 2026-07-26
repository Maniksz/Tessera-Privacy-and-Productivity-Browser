/**
 * Tracking-parameter removal (spec 4).
 *
 * Applied to navigations *and* to link clicks, so a copied link is clean too.
 * Pure and shared, because the same rule has to hold in the network layer, in
 * the context menu's "copy link" and in the address bar's displayed URL.
 */

/** Exact parameter names to drop, matched case-insensitively. */
const EXACT_PARAMS: readonly string[] = [
  // Google Analytics / generic campaign tagging
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_cid',
  'utm_reader',
  'utm_referrer',
  'utm_social',
  'utm_social-type',
  'utm_brand',
  'utm_pubreferrer',
  'utm_swu',
  'utm_viz_id',
  // Google Ads / Analytics click ids
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'gad_source',
  'gad_campaignid',
  '_ga',
  '_gl',
  // Microsoft / Bing
  'msclkid',
  // Meta
  'fbclid',
  'fb_action_ids',
  'fb_action_types',
  'fb_source',
  'fb_ref',
  // TikTok / Twitter / LinkedIn / Reddit / Pinterest
  'ttclid',
  'tt_medium',
  'tt_content',
  'twclid',
  'li_fat_id',
  'trk',
  'trkCampaign',
  'rdt_cid',
  'epik',
  // Yandex / VK / Mail.ru
  'yclid',
  '_openstat',
  'vero_conv',
  'vero_id',
  // Mailchimp / HubSpot / Marketo / Klaviyo
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'hsCtaTracking',
  '__hssc',
  '__hstc',
  '__hsfp',
  'mkt_tok',
  '_kx',
  // Amazon
  'ref_',
  'pd_rd_r',
  'pd_rd_w',
  'pd_rd_wg',
  'pf_rd_i',
  'pf_rd_m',
  'pf_rd_p',
  'pf_rd_r',
  'pf_rd_s',
  'pf_rd_t',
  '_encoding',
  'psc',
  // Instagram / YouTube / Spotify / Apple
  'igshid',
  'igsh',
  'si',
  'feature',
  'kwcid',
  // Misc analytics
  'icid',
  'ncid',
  'cmpid',
  'campaign_id',
  'oly_anon_id',
  'oly_enc_id',
  'wickedid',
  's_kwcid',
  'ef_id',
  'sc_campaign',
  'sc_channel',
  'sc_content',
  'sc_medium',
  'sc_outcome',
  'sc_geo',
  'sc_country',
  'guccounter',
  'guce_referrer',
  'guce_referrer_sig'
]

/**
 * Prefix rules for families of parameters. Kept separate from the exact list so
 * the intent stays readable and so a prefix can never accidentally swallow a
 * functional parameter by being too short.
 */
const PARAM_PREFIXES: readonly string[] = ['utm_', 'pk_', 'piwik_', 'matomo_', 'ga_', 'hsa_']

/**
 * Parameters that look like tracking but carry meaning on specific sites.
 * Host-scoped exceptions, so removing them elsewhere still works.
 *
 * `si` on Spotify, for instance, is part of how a shared track link resolves;
 * on YouTube it is a share-attribution token and safe to drop.
 */
const HOST_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  'open.spotify.com': ['si'],
  'www.amazon.com': ['psc'],
  'www.youtube.com': ['feature'],
  'youtu.be': []
}

const exactSet = new Set(EXACT_PARAMS.map((p) => p.toLowerCase()))

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase()
  if (exactSet.has(lower)) return true
  return PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

export interface StripResult {
  url: string
  /** Names actually removed, for the per-site panel and for tests. */
  removed: string[]
}

/**
 * Removes tracking parameters from a URL.
 *
 * Leaves anything it cannot parse untouched and reports no removals — silently
 * rewriting a URL we do not understand risks breaking navigation, which is
 * worse than one surviving parameter.
 */
export function stripTrackingParams(rawUrl: string): StripResult {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { url: rawUrl, removed: [] }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: rawUrl, removed: [] }
  }
  if (parsed.search === '') return { url: rawUrl, removed: [] }

  const host = parsed.hostname.toLowerCase()
  const exceptions = new Set((HOST_EXCEPTIONS[host] ?? []).map((p) => p.toLowerCase()))

  const removed: string[] = []
  const keys = [...new Set(parsed.searchParams.keys())]
  for (const key of keys) {
    if (exceptions.has(key.toLowerCase())) continue
    if (!isTrackingParam(key)) continue
    parsed.searchParams.delete(key)
    removed.push(key)
  }

  if (removed.length === 0) return { url: rawUrl, removed: [] }

  // `URL.search` keeps a lone "?" behind when every parameter is gone.
  if ([...parsed.searchParams.keys()].length === 0) parsed.search = ''

  return { url: parsed.toString(), removed }
}

/** Convenience wrapper for callers that only need the cleaned URL. */
export function cleanUrl(rawUrl: string): string {
  return stripTrackingParams(rawUrl).url
}
