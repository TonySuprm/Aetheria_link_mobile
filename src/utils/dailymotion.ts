/**
 * Dailymotion play-time resolution via the MOBILE (iOS app) GraphQL API.
 *
 * Why this path exists: Dailymotion's web-player surface is hostile to server-side
 * clients — `cdndirector.dailymotion.com` 403s every non-browser TLS client with
 * `x-error-code: E005` (rustls, node, curl — all blocked), which killed the original
 * metadata-API chain and motivated the (now gone) ytdlp bridge.
 *
 * The mobile app API is a different surface entirely:
 *   1. `graphql.api.dailymotion.com/oauth/token` — client_credentials with the iOS app's
 *      public Basic credential (same one cobalt uses). The bearer token is NOT IP-bound.
 *   2. `graphql.api.dailymotion.com` Media query → `media.hlsURL` — a master manifest on
 *      `www.dailymotion.com/cdn/...` whose variants/segments live on `vod*.cf.dmcdn.net`.
 *
 * CATCH: the `sec=` token inside `hlsURL` is bound to the IP THAT MADE THE GRAPHQL
 * CALL — verified: the same URL+headers fetch 200s via MediaFlow's rustls client when
 * the token was minted for that client's IP, and 403s when minted elsewhere. So when
 * the add-on and MediaFlow run on different hosts, BOTH the GraphQL call and the
 * master fetch must be relayed through MediaFlow (see {@link DailymotionViaMediaFlow}).
 * The `vod*.cf.dmcdn.net` variant/segment `sec2(...)` tokens are minted at master-fetch
 * time for the master-fetcher's IP — also MediaFlow when `via` is used, matching its
 * variant/segment fetches. Players (Tizen included) only ever see plain, header-free
 * URLs on MediaFlow / the add-on.
 *
 * The oauth token is cached until shortly before its JWT `exp` — one token fetch per
 * hour, one Media query per actual playback.
 */

const DAILYMOTION_APP_UA = 'dailymotion/240213162706 CFNetwork/1492.0.1 Darwin/23.3.0';
// Public client credential of the official iOS app (as shipped in cobalt's dailymotion
// module). Rotated by Dailymotion occasionally — when resolution starts failing with
// `not_authorized`, refresh this string from cobalt's repo.
const DAILYMOTION_APP_BASIC = 'MGQyZDgyNjQwOWFmOWU3MmRiNWQ6ODcxNmJmYTVjYmEwMmUwMGJkYTVmYTg1NTliNDIwMzQ3NzIyYWMzYQ==';
const OAUTH_TOKEN_URL = 'https://graphql.api.dailymotion.com/oauth/token';
const GRAPHQL_URL = 'https://graphql.api.dailymotion.com/';

export const DAILYMOTION_APP_HEADERS: Record<string, string> = {
  'User-Agent': DAILYMOTION_APP_UA,
  'Referer': 'https://www.dailymotion.com/',
};

/**
 * Route the IP-SENSITIVE Dailymotion calls through a MediaFlow instance.
 *
 * The `sec=` token inside the GraphQL-issued `hlsURL` is bound to the IP that
 * made the GraphQL call. When the add-on and the MediaFlow proxy run on
 * DIFFERENT hosts (e.g. two separate Render services), the add-on calling the
 * API itself mints a token for the add-on's IP — and MediaFlow's master fetch
 * then 403s. Routing the GraphQL call AND the master fetch through MediaFlow
 * (`/proxy/forward` + `/proxy/stream`) makes MediaFlow's IP the single
 * identity for the whole chain: token mint, master, variants and segments.
 */
export interface DailymotionViaMediaFlow {
  /** Base URL of the MediaFlow instance, e.g. `https://mediaflow…onrender.com`. */
  baseUrl: string;
  /** Its `api_password`. */
  password: string;
}

let cachedToken: { token: string; expiresAt: number } | undefined;

async function getAppToken(): Promise<string | undefined> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'User-Agent': DAILYMOTION_APP_UA,
      'Authorization': `Basic ${DAILYMOTION_APP_BASIC}`,
    },
    body: 'traffic_segment=&grant_type=client_credentials',
  }).catch(() => undefined);
  const json = res?.ok ? (await res.json().catch(() => undefined) as { access_token?: string } | undefined) : undefined;
  const token: string | undefined = json?.access_token;
  if (!token) return undefined;

  let expiresAt = Date.now() + 3600_000;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf8'));
    if (typeof payload.exp === 'number') expiresAt = payload.exp * 1000;
  } catch { /* opaque token — keep the default lifetime */ }

  cachedToken = { token, expiresAt };
  return token;
}

const MEDIA_QUERY = 'query Media($xid: String!, $password: String) { media(xid: $xid, password: $password) { __typename ... on Video { xid hlsURL } } }';

function mediaRequestBody(videoId: string): string {
  return JSON.stringify({
    operationName: 'Media',
    query: MEDIA_QUERY,
    variables: { xid: videoId },
  });
}

function mediaRequestHeaders(token: string): Record<string, string> {
  return {
    'User-Agent': DAILYMOTION_APP_UA,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-DM-AppInfo-Version': '7.16.0_240213162706',
    'X-DM-AppInfo-Type': 'iosapp',
    'X-DM-AppInfo-Id': 'com.dailymotion.dailymotion',
  };
}

/**
 * Query string for MediaFlow's `/proxy/forward` and `/proxy/stream`.
 * Built with `encodeURIComponent` (NOT URLSearchParams): MediaFlow decodes
 * %-escapes but treats `+` literally, so a URLSearchParams-encoded space in
 * e.g. `Bearer <token>` would arrive upstream as `Bearer+<token>`.
 */
function mediaFlowQuery(via: DailymotionViaMediaFlow, params: Record<string, string>): string {
  const all: [string, string][] = [
    ['api_password', via.password],
    ...Object.entries(params),
  ];
  return all.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

/**
 * Resolve `videoId` to the mobile-API master HLS manifest URL (`media.hlsURL`).
 * Works for embed-restricted ("private" in the web UI) uploads as long as the
 * site's player can embed them. Returns undefined when the API refuses the video.
 *
 * With `via`, the GraphQL call is POSTed through MediaFlow's `/proxy/forward`
 * so the issued `sec=` token is bound to MEDIAFLOW's IP (the whole chain must
 * share one IP — see {@link DailymotionViaMediaFlow}). Falls back to a direct
 * call (add-on's own IP) when the relay route is unavailable (older MFP builds
 * have no `/proxy/forward`) — correct whenever both run on the same host.
 */
export async function fetchDailymotionAppHlsUrl(videoId: string, via?: DailymotionViaMediaFlow): Promise<string | undefined> {
  const token = await getAppToken();
  if (!token) return undefined;

  if (via) {
    try {
      const relayUrl = `${via.baseUrl.replace(/\/+$/, '')}/proxy/forward?${mediaFlowQuery(via, {
        'd': GRAPHQL_URL,
        'h_user-agent': DAILYMOTION_APP_UA,
        'h_content-type': 'application/json',
        'h_authorization': `Bearer ${token}`,
        'h_x-dm-appinfo-version': '7.16.0_240213162706',
        'h_x-dm-appinfo-type': 'iosapp',
        'h_x-dm-appinfo-id': 'com.dailymotion.dailymotion',
      })}`;
      const res = await fetch(relayUrl, { method: 'POST', body: mediaRequestBody(videoId) }).catch(() => undefined);
      const json = res?.ok
        ? (await res.json().catch(() => undefined) as {
            data?: { media?: { __typename?: string; xid?: string; hlsURL?: string } };
          } | undefined)
        : undefined;
      const media = json?.data?.media;
      if (media?.__typename === 'Video' && typeof media.hlsURL === 'string' && media.hlsURL) {
        return media.hlsURL;
      }
      // Relay refused the video (private/geo/removed) — a direct retry would get
      // the same answer, just minted for a useless IP. Stop here.
      if (json?.data?.media || res?.ok) return undefined;
    } catch { /* relay unreachable — fall through to the direct call */ }
  }

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: mediaRequestHeaders(token),
    body: mediaRequestBody(videoId),
  }).catch(() => undefined);
  const json = res?.ok
    ? (await res.json().catch(() => undefined) as {
        data?: { media?: { __typename?: string; xid?: string; hlsURL?: string } };
      } | undefined)
    : undefined;
  const media = json?.data?.media;
  if (media?.__typename !== 'Video' || typeof media.hlsURL !== 'string' || !media.hlsURL) return undefined;
  return media.hlsURL;
}

/** GET a text resource with the iOS-app headers (one redirect hop max). */
export async function fetchDailymotionTextDirect(url: string): Promise<{ status: number; text: string } | undefined> {
  for (let hop = 0; hop < 2; hop++) {
    const res = await fetch(url, { headers: DAILYMOTION_APP_HEADERS, redirect: 'manual' }).catch(() => undefined);
    if (!res) return undefined;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        url = new URL(location, url).href;
        continue;
      }
    }
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  }
  return undefined;
}

/**
 * GET `url` with the iOS-app headers. With `via`, the fetch is relayed through
 * MediaFlow's `/proxy/stream` so the request shares the IP that minted the
 * manifest's `sec=` token; a failed relay falls back to the direct fetch.
 */
export async function fetchDailymotionText(url: string, via?: DailymotionViaMediaFlow): Promise<{ status: number; text: string } | undefined> {
  if (via) {
    try {
      const relayUrl = `${via.baseUrl.replace(/\/+$/, '')}/proxy/stream?${mediaFlowQuery(via, { d: url })}`;
      const res = await fetch(relayUrl, { headers: DAILYMOTION_APP_HEADERS }).catch(() => undefined);
      if (res?.ok) {
        const text = await res.text().catch(() => '');
        return { status: res.status, text };
      }
    } catch { /* relay unreachable — fall through to the direct fetch */ }
  }
  return fetchDailymotionTextDirect(url);
}

export interface DailymotionMasterEntry {
  /** The `#EXT-X-STREAM-INF:...` line preceding the URI line. */
  infLine: string;
  /** Absolute URI of the variant media playlist. */
  url: URL;
  bandwidth: number;
  /** Vertical resolution from RESOLUTION=WxH, when present. */
  height?: number | undefined;
}

export interface RewriteDailymotionMasterOptions {
  /** Master playlist text as served by `www.dailymotion.com/cdn/manifest/...`. */
  master: string;
  /** The master's own URL — resolves relative variant URIs. */
  hlsUrl: string;
  /** Keep only variants at or below this height; 0 disables the cap. */
  maxHeight?: number;
  /** Keep only the top-bandwidth variant (fast 4K start, no ladder evaluation). */
  flat?: boolean;
  /** Wraps a variant/media URI into the player-facing proxy URL. */
  rewriteUrl: (url: URL) => URL;
}

/**
 * Parse the DM master playlist and rebuild it:
 *   • every variant URI is passed through `rewriteUrl` (→ MediaFlow HLS proxy);
 *   • `#EXT-X-MEDIA` renditions (subtitles) get their `URI="..."` rewritten too;
 *   • variants are sorted by bandwidth DESCENDING — the 4K tier is served first,
 *     so "pick the first entry" players default to the best quality;
 *   • `maxHeight` drops taller tiers (DM_MAX_HEIGHT knob, 2160 default keeps 4K);
 *   • `flat` keeps only the top variant — the player starts at 4K immediately
 *     instead of evaluating the ladder (the old DM_FLAT=1 bridge behaviour).
 *
 * Everything else (version header, comments, media groups) is passed through
 * verbatim so Dailymotion playlist semantics are preserved.
 */
export function rewriteDailymotionMaster(options: RewriteDailymotionMasterOptions): string {
  const { master, hlsUrl, maxHeight = 0, flat = false, rewriteUrl } = options;

  const lines = master.split('\n');
  const head: string[] = [];
  const mediaLines: string[] = [];
  const entries: DailymotionMasterEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const uriLine = lines[i + 1]?.trim();
      if (!uriLine || uriLine.startsWith('#')) continue;
      const bandwidth = Number.parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? '0', 10);
      const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/);
      entries.push({
        infLine: line,
        url: new URL(uriLine, hlsUrl),
        bandwidth,
        height: resolution ? Number.parseInt(resolution[2] ?? '', 10) : undefined,
      });
      i++; // consumed the URI line
      continue;
    }

    if (line.startsWith('#')) {
      (line.startsWith('#EXT-X-MEDIA') ? mediaLines : head).push(line);
      continue;
    }

    // A bare URI outside a STREAM-INF pair (standalone rendition playlist).
    head.push(rewriteUrl(new URL(line, hlsUrl)).href);
  }

  const capped = maxHeight > 0
    ? entries.filter(entry => entry.height === undefined || entry.height <= maxHeight)
    : entries;
  const kept = (capped.length ? capped : entries)
    .sort((a, b) => b.bandwidth - a.bandwidth);
  const top = kept[0];
  const finalEntries = flat && top ? [top] : kept;

  const rewrittenMedia = mediaLines.map(line =>
    line.replace(/URI="([^"]+)"/, (_, uri: string) => `URI="${rewriteUrl(new URL(uri, hlsUrl)).href}"`),
  );

  const body: string[] = [];
  for (const entry of finalEntries) {
    body.push(entry.infLine);
    body.push(rewriteUrl(entry.url).href);
  }

  return [...head, ...rewrittenMedia, ...body, '']
    .join('\n');
}
