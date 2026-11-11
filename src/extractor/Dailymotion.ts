import { Context, Format, InternalUrlResult, Meta } from '../types';
import { supportsMediaFlowProxy } from '../utils';
import { Extractor } from './Extractor';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const DAILYMOTION_METADATA_HEADERS = { 'User-Agent': BROWSER_UA, 'Referer': 'https://www.dailymotion.com/' };

/**
 * Dailymotion streams are served through the MediaFlow Proxy (bundled sidecar) so the result is
 * playable by normal players (libvlc on mobile, mpv, Stremio native) WITHOUT yt-dlp or custom
 * header support.
 *
 * Why the proxy is required: Dailymotion's manifest CDN (`cdndirector.dailymotion.com`) rejects
 * non-browser TLS clients with a 403 `x-error-code: E005`, and the signed `sec=` token in the
 * manifest URL is short-lived. A canonical `.../video/{id}` page URL (the old behaviour) only
 * plays in players with yt-dlp integration, never in libvlc/ExoPlayer.
 *
 * Why resolution happens at PLAY time (not at /stream time): the `sec=` token inside the master
 * manifest URL expires within minutes, and Dailymotion rate-limits repeated fetches per video.
 * A manifest URL baked into the stream response at /stream time is usually already dead by the
 * time the player presses play ("works once, then never again"). Instead the extractor returns a
 * lightweight play-time resolver URL on this add-on (`/dm/<videoId>.m3u8`, served by
 * MediaFlowProxyController). When the player requests it, the add-on resolves the video through
 * Dailymotion's mobile app API (no yt-dlp) and serves a REWRITTEN master playlist whose variants
 * stream through MediaFlow — every play gets a fresh manifest, and the player only ever touches
 * this add-on's origin with plain, header-free HLS.
 */
export class Dailymotion extends Extractor {
  public readonly id = 'dailymotion';
  public readonly label = 'Dailymotion';
  public override viaMediaFlowProxy = true;

  public override supports(ctx: Context, url: URL): boolean {
    const hostMatches = url.host === 'dailymotion.com' || url.host.endsWith('.dailymotion.com');
    return hostMatches && supportsMediaFlowProxy(ctx);
  }

  protected async extractInternal(ctx: Context, url: URL, meta: Meta): Promise<InternalUrlResult[]> {
    // Two embed URL formats:
    // 1. https://www.dailymotion.com/video/{id}                 (pathname)
    // 2. https://geo.dailymotion.com/player/x....html?video={id} (query param)
    let videoId = url.pathname.match(/\/video\/([a-zA-Z0-9_-]+)/)?.[1];
    if (!videoId) {
      videoId = url.searchParams.get('video') || undefined;
    }
    if (!videoId) {
      return [];
    }

    // No Dailymotion calls here — the manifest token would be stale by play
    // time (and every /stream poll would burn the per-link rate limit). The
    // play-time resolver route (MediaFlowProxyController /dm/:id) fetches a
    // fresh token when the player actually requests this URL.
    return [{
      url: new URL(`/dm/${encodeURIComponent(videoId)}.m3u8`, ctx.hostUrl),
      format: Format.hls,
      meta: { ...meta, extractorId: this.id },
    }];
  }
}

/**
 * Fetch the player metadata for `videoId` and return the best master HLS manifest URL.
 * Shared by the play-time resolver route in MediaFlowProxyController.
 *
 * Walks `metadata.qualities` (a map of quality -> [{ type, url }]). The `auto` entry is
 * Dailymotion's adaptive master playlist (it lists every quality tier), so it is preferred.
 * Note that JS objects iterate integer-like keys (e.g. "1080") BEFORE string keys (e.g. "auto"),
 * so we cannot rely on plain `Object.values` ordering to surface the master first — we check
 * `auto` explicitly and only fall back to a single-quality ladder otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickDailymotionMasterHls(metadata: any): URL | undefined {
  const qualities = (metadata?.qualities ?? {}) as Record<string, unknown>;

  // 1. Prefer the adaptive `auto` master playlist.
  const fromAuto = firstHls(qualities['auto']);
  if (fromAuto) return fromAuto;

  // 2. Otherwise pick the highest single-quality HLS ladder (e.g. "1440" before "720").
  let best: URL | undefined;
  let bestRank = -1;
  for (const [quality, entries] of Object.entries(qualities)) {
    const url = firstHls(entries);
    if (!url) continue;
    const rank = Number.parseInt(quality, 10);
    const value = Number.isNaN(rank) ? 0 : rank; // "auto"/labeled tiers sort as 0
    if (value > bestRank) {
      bestRank = value;
      best = url;
    }
  }

  return best;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstHls(entries: any): URL | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const candidate = entry as { type?: unknown; url?: unknown };
    if (candidate.type === 'application/x-mpegURL' && typeof candidate.url === 'string') {
      try {
        return new URL(candidate.url);
      } catch {
        // not an absolute URL — skip
      }
    }
  }
  return undefined;
}
