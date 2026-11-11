/**
 * Dailymotion play-time resolution via the MOBILE (iOS app) GraphQL API.
 *
 * Why this path exists: Dailymotion's web-player CDN (`cdndirector.dailymotion.com`,
 * and the `/cdn/manifest` route for browser UAs) rejects non-browser TLS clients with
 * 403 `x-error-code: E005` — that kills MediaFlow's rustls client AND every previous
 * server-side chain (the ytdlp bridge was built for exactly this and is now gone).
 *
 * The mobile app API is a different surface entirely:
 *   1. `graphql.api.dailymotion.com/oauth/token` — client_credentials with the iOS app's
 *      public Basic credential (same one cobalt uses).
 *   2. `graphql.api.dailymotion.com` Media query → `media.hlsURL` — a master manifest on
 *      `www.dailymotion.com/cdn/...` whose variants/segments live on `vod*.cf.dmcdn.net`.
 *
 * Verified against Dailymotion (Nov 2026):
 *   • node fetch CAN read `www.dailymotion.com/cdn/manifest/...` when it sends the iOS app
 *     User-Agent (a browser UA gets 403 there), and CAN read the dmcdn variant/segment hosts.
 *   • MediaFlow's rustls client CANNOT read the `/cdn/manifest` master (403) but CAN read
 *     `vod*.cf.dmcdn.net` variants and segments — so THIS add-on fetches only the master and
 *     rewrites every variant URI into a MediaFlow HLS-proxy URL; the proxy streams everything
 *     else. Players (Tizen included) only ever see plain, header-free URLs on this add-on's
 *     own origin.
 *
 * The oauth token is cached until shortly before its JWT `exp` — one token fetch per hour,
 * one Media query per actual playback.
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

/**
 * Resolve `videoId` to the mobile-API master HLS manifest URL (`media.hlsURL`).
 * Works for embed-restricted ("private" in the web UI) uploads as long as the
 * site's player can embed them. Returns undefined when the API refuses the video.
 */
export async function fetchDailymotionAppHlsUrl(videoId: string): Promise<string | undefined> {
  const token = await getAppToken();
  if (!token) return undefined;

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'User-Agent': DAILYMOTION_APP_UA,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-DM-AppInfo-Version': '7.16.0_240213162706',
      'X-DM-AppInfo-Type': 'iosapp',
      'X-DM-AppInfo-Id': 'com.dailymotion.dailymotion',
    },
    body: JSON.stringify({
      operationName: 'Media',
      query: 'query Media($xid: String!, $password: String) { media(xid: $xid, password: $password) { __typename ... on Video { xid hlsURL } } }',
      variables: { xid: videoId },
    }),
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
export async function fetchDailymotionText(url: string): Promise<{ status: number; text: string } | undefined> {
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
